import { Injectable } from '@nestjs/common';
import { ApprovalPolicy, RiskLevel } from '../../ai.types';
import type { AiTool, ToolContext } from '../tool.interface';
import {
  READ_ONLY_LIMITS,
  actorOf,
  clampPage,
} from '../biz-common/biz-tool.util';
import { BookingsService } from '../../../modules/biz/booking/bookings.service';
import { SlotsService } from '../../../modules/biz/booking/slots.service';
import type {
  BookingPayStatus,
  BookingStatus,
} from '../../../modules/biz/booking/bookings.service';

/**
 * 预约域的 AI 只读工具。
 *
 * 全部是 **L0 + NONE**：查数据不改数据，不需要人工确认。
 * 写操作（建单 / 改期 / 取消 / 结算 / 退款）**一律不做成 AI 工具** ——
 * 钱和单据的出口只在收银台与退款审批（见 docs/admin/ai-assistant.md）。
 */

const STATUS_VALUES = [
  'pending',
  'confirmed',
  'arrived',
  'completed',
  'cancelled',
  'no_show',
] as const;

const PAY_STATUS_VALUES = [
  'unpaid',
  'partial',
  'paid',
  'refunded',
  'credit',
] as const;

interface BookingListInput {
  dateFrom?: string;
  dateTo?: string;
  date?: string;
  staffId?: number;
  status?: BookingStatus;
  payStatus?: BookingPayStatus;
  customerId?: number;
  keyword?: string;
  collectable?: boolean;
  page?: number;
  pageSize?: number;
}

/** booking.list —— 预约列表（分页 + 筛选） */
@Injectable()
export class BookingListTool implements AiTool<BookingListInput> {
  name = 'booking.list';
  description =
    '查询预约单列表，可按店内日期（YYYY-MM-DD）、美甲师、服务状态、资金状态、顾客、关键字筛选。' +
    '返回 { items, page, pageSize, hasMore }；**响应里没有 total**（接口口径如此），' +
    '要判断还有没有下一页请看 hasMore。collectable=true 只查「还能收款」的单（未结清且未取消）。';
  permission = 'biz:booking:list';
  riskLevel = RiskLevel.L0;
  approvalPolicy = ApprovalPolicy.NONE;
  inputSchema = {
    type: 'object',
    properties: {
      date: {
        type: 'string',
        description: '精确到某一天（店内本地日 YYYY-MM-DD）',
      },
      dateFrom: { type: 'string', description: '起始日（含），YYYY-MM-DD' },
      dateTo: { type: 'string', description: '结束日（含），YYYY-MM-DD' },
      staffId: { type: 'number', description: '美甲师 id' },
      status: { type: 'string', enum: STATUS_VALUES, description: '服务状态' },
      payStatus: {
        type: 'string',
        enum: PAY_STATUS_VALUES,
        description: '资金状态',
      },
      customerId: { type: 'number', description: '顾客 id' },
      keyword: {
        type: 'string',
        description: '单号 / 顾客姓名 / 手机号 模糊匹配',
      },
      collectable: { type: 'boolean', description: '只看还能收款的单' },
      page: { type: 'number', description: '页码，从 1 开始，默认 1' },
      pageSize: { type: 'number', description: '每页条数，默认 20，最多 100' },
    },
  };
  limits = READ_ONLY_LIMITS;

  constructor(private readonly bookings: BookingsService) {}

  async execute(input: BookingListInput, context: ToolContext) {
    const { page, pageSize } = clampPage(input.page, input.pageSize);
    const result = await this.bookings.list(
      page,
      pageSize,
      {
        date: input.date,
        dateFrom: input.dateFrom,
        dateTo: input.dateTo,
        staffId: input.staffId,
        status: input.status,
        payStatus: input.payStatus,
        customerId: input.customerId,
        keyword: input.keyword,
        collectable: input.collectable,
      },
      actorOf(context),
    );
    return {
      ...result,
      hasMore: result.items.length >= pageSize,
      hint: '接口不做总数统计，hasMore 由「本页是否塞满」推断',
    };
  }
}

/** booking.get —— 预约详情（含项目明细与支付单） */
@Injectable()
export class BookingGetTool implements AiTool<{ id: number }> {
  name = 'booking.get';
  description =
    '按预约 id 查单条预约的完整详情：项目明细快照、算价明细（原价 / 等级优惠 / 积分抵扣 / 改价）、' +
    '支付单与退款记录。回答「这单收了多少、还差多少、为什么是这个价」时必须用它。';
  permission = 'biz:booking:list';
  riskLevel = RiskLevel.L0;
  approvalPolicy = ApprovalPolicy.NONE;
  inputSchema = {
    type: 'object',
    properties: {
      id: { type: 'number', description: '预约 id（不是单号字符串）' },
    },
    required: ['id'],
  };
  limits = READ_ONLY_LIMITS;

  constructor(private readonly bookings: BookingsService) {}

  async execute(input: { id: number }, context: ToolContext) {
    return this.bookings.findOne(Number(input.id), actorOf(context));
  }
}

/** booking.calendar —— 日历区间块（一次拿一整屏） */
@Injectable()
export class BookingCalendarTool implements AiTool<{
  dateFrom?: string;
  dateTo?: string;
  staffId?: number;
  storeId?: number;
  status?: BookingStatus;
}> {
  name = 'booking.calendar';
  description =
    '按日期区间一次性取出全部预约块（不分页，按开始时间升序，后端硬上限 1000 条）。' +
    '回答「这周谁最忙」「某天还有哪些空档」这类**整体占用**问题用它；' +
    '只要看某一天的单子用 booking.list 更省。返回的 truncated=true 表示超了 1000 条被截断。';
  permission = 'biz:booking:list';
  riskLevel = RiskLevel.L0;
  approvalPolicy = ApprovalPolicy.NONE;
  inputSchema = {
    type: 'object',
    properties: {
      dateFrom: { type: 'string', description: '起始日 YYYY-MM-DD（含）' },
      dateTo: { type: 'string', description: '结束日 YYYY-MM-DD（含）' },
      staffId: { type: 'number', description: '只看某位美甲师' },
      storeId: {
        type: 'number',
        description: '门店 id，不传则按你的数据权限范围',
      },
      status: {
        type: 'string',
        enum: STATUS_VALUES,
        description: '只看某个服务状态',
      },
    },
  };
  limits = READ_ONLY_LIMITS;

  constructor(private readonly bookings: BookingsService) {}

  async execute(
    input: {
      dateFrom?: string;
      dateTo?: string;
      staffId?: number;
      storeId?: number;
      status?: BookingStatus;
    },
    context: ToolContext,
  ) {
    return this.bookings.calendar(
      {
        dateFrom: input.dateFrom,
        dateTo: input.dateTo,
        staffId: input.staffId,
        storeId: input.storeId,
        status: input.status,
      },
      actorOf(context),
    );
  }
}

/** booking.available-slots —— 可约时段（算出来的，不是查出来的） */
@Injectable()
export class BookingAvailableSlotsTool implements AiTool<{
  staffId: number;
  date: string;
  serviceItemIds: number[];
  storeId?: number;
}> {
  name = 'booking.available-slots';
  description =
    '计算某位美甲师在某天还能约哪些时段（输入项目时长 + 班次 − 已有预约 − 缓冲，' +
    '与下单时的算法完全同一套）。返回 slots 列表与 durationMinutes / bufferMinutes；' +
    'slots 为空时 reason 会说明原因（休息 off / 当天无班 no_shift / 做不了该项目 staff_cannot_do / 已排满 fully_booked / 超出可约窗口 out_of_window）。' +
    '顾客问「明天还能约吗」必须用它，不要自己推算。';
  permission = 'biz:booking:list';
  riskLevel = RiskLevel.L0;
  approvalPolicy = ApprovalPolicy.NONE;
  inputSchema = {
    type: 'object',
    properties: {
      staffId: { type: 'number', description: '美甲师 id' },
      date: { type: 'string', description: '要查的店内日期 YYYY-MM-DD' },
      serviceItemIds: {
        type: 'array',
        items: { type: 'number' },
        description: '本次项目的服务项目 id 列表（决定总时长）',
      },
      storeId: { type: 'number', description: '门店 id，多店时建议传' },
    },
    required: ['staffId', 'date', 'serviceItemIds'],
  };
  limits = READ_ONLY_LIMITS;

  constructor(private readonly slots: SlotsService) {}

  async execute(input: {
    staffId: number;
    date: string;
    serviceItemIds: number[];
    storeId?: number;
  }) {
    return this.slots.availableSlots({
      staffId: Number(input.staffId),
      date: input.date,
      serviceItemIds: input.serviceItemIds.map(Number),
      channel: 'admin',
      storeId: input.storeId,
    });
  }
}
