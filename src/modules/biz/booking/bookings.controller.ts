import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { z } from 'zod';
import type { RequestActor } from '../../../common/data-scope/data-scope.js';
import { RequirePermissions } from '../../../common/auth/permissions.decorator.js';
import { registerComponent } from '../../../common/swagger/zod-schema.helper.js';
import { parsePagination } from '../common/query.js';
import {
  BookingsService,
  type BookingListFilter,
  type BookingPayStatus,
  type BookingStatus,
  type CreateBookingInput,
  type SettleBookingInput,
  type UpdateBookingInput,
} from './bookings.service.js';

type AuthRequest = { user: RequestActor };

const payChannelSchema = z.enum([
  'wxpay_native',
  'alipay_qr',
  'cash',
  'wechat_offline',
  'alipay_offline',
  'balance',
  'card',
  'credit',
]);

const paymentSchema = z.object({
  channel: payChannelSchema.openapi({ description: '支付渠道' }),
  amount: z
    .number()
    .int()
    .min(0)
    .openapi({ example: 3000, description: '金额（分）' }),
  receivedAmount: z
    .number()
    .int()
    .min(0)
    .optional()
    .openapi({ description: '实收（分，现金找零时可小于 amount）' }),
  memberCardId: z
    .number()
    .int()
    .positive()
    .optional()
    .openapi({ description: '次卡核销时的卡 id' }),
});

const createSchema = z.object({
  customerId: z
    .number()
    .int()
    .positive()
    .openapi({ description: '顾客 id（须已存在）' }),
  staffId: z.number().int().positive().openapi({ description: '美甲师 id' }),
  startAt: z
    .string()
    .regex(/Z$|[+-]\d{2}:\d{2}$/)
    .openapi({
      example: '2026-09-11T10:00:00+08:00',
      description: '期望开始时间（带偏移的 ISO8601，服务端有权拒绝）',
    }),
  serviceItemIds: z
    .array(z.number().int().positive())
    .min(1)
    .max(3)
    .openapi({ description: '服务项目 id，1~3 个' }),
  payMode: z.enum(['full', 'deposit']).openapi({ description: '全款 / 定金' }),
  depositAmount: z.number().int().min(0).optional().openapi({
    description: '定金金额（分）；不传按 biz.booking.depositPermille 计算',
  }),
  payments: z
    .array(paymentSchema)
    .optional()
    .openapi({ description: '实收明细（支持混合支付）' }),
  pointsUsed: z
    .number()
    .int()
    .min(0)
    .optional()
    .openapi({ description: '使用积分数' }),
  adjustAmount: z
    .number()
    .int()
    .optional()
    .openapi({ description: '手动改价差额（分，可正可负）' }),
  adjustReason: z
    .string()
    .max(200)
    .optional()
    .openapi({ description: '改价原因' }),
  creditAccountId: z
    .number()
    .int()
    .positive()
    .optional()
    .openapi({ description: '挂账主体 id' }),
  remark: z
    .string()
    .max(500)
    .optional()
    .openapi({ description: '顾客需求备注' }),
  force: z
    .boolean()
    .optional()
    .openapi({ description: '顾客同时段已有预约时是否强制创建' }),
});

const updateSchema = z.object({
  staffId: z.number().int().positive().optional(),
  startAt: z
    .string()
    .regex(/Z$|[+-]\d{2}:\d{2}$/)
    .optional(),
  serviceItemIds: z.array(z.number().int().positive()).min(1).max(3).optional(),
  adjustAmount: z.number().int().optional(),
  adjustReason: z.string().max(200).optional(),
  remark: z.string().max(500).optional(),
  force: z.boolean().optional(),
});

const settleSchema = z.object({
  payments: z
    .array(paymentSchema)
    .optional()
    .openapi({ description: '本次收款明细' }),
  pointsUsed: z
    .number()
    .int()
    .min(0)
    .optional()
    .openapi({ description: '累计使用积分数（只能增加）' }),
  creditAccountId: z.number().int().positive().optional(),
  remark: z.string().max(500).optional(),
  memberCardId: z
    .number()
    .int()
    .positive()
    .optional()
    .openapi({
      description:
        '到店用次卡核销（下单没选卡时在结算补上）。服务端会重算应付：次卡 → payable = 0。' +
        '只写 memberCardId 不传 card 支付行，等于「按次卡重新算价并核销」。',
    }),
});

const reasonSchema = z.object({
  reason: z.string().min(1).max(200).openapi({ description: '原因（必填）' }),
});

const refundSchema = z.object({
  amount: z
    .number()
    .int()
    .min(0)
    .optional()
    .openapi({ description: '申请退款金额（分），默认取判责建议值' }),
  mode: z
    .enum(['original', 'cash', 'balance'])
    .openapi({ description: '原路退回 / 现金 / 退入储值' }),
  reason: z.string().min(1).max(200),
  liable: z.enum(['store', 'customer', 'force_majeure']).optional(),
  remark: z.string().max(200).optional(),
});

registerComponent('CreateBookingRequest', createSchema);
registerComponent('UpdateBookingRequest', updateSchema);
registerComponent('SettleBookingRequest', settleSchema);
registerComponent('ApplyRefundRequest', refundSchema);

@ApiTags('预约管理')
@ApiBearerAuth('access-token')
@Controller('biz/bookings')
export class BookingsController {
  constructor(private readonly bookings: BookingsService) {}

  @Get('available-slots')
  @RequirePermissions('biz:booking:list')
  @ApiOperation({ summary: '查询可约时段（店内本地日）' })
  @ApiQuery({ name: 'staffId', required: true, description: '美甲师 id' })
  @ApiQuery({
    name: 'date',
    required: true,
    example: '2026-09-11',
    description: '店内本地日',
  })
  @ApiQuery({
    name: 'serviceItemIds',
    required: true,
    description: '服务项目 id，逗号分隔或重复传参',
  })
  @ApiQuery({ name: 'channel', required: false, enum: ['admin', 'miniapp'] })
  @ApiResponse({
    status: 200,
    description: '{ slots, reason?, durationMinutes, bufferMinutes }',
  })
  availableSlots(
    @Query('staffId') rawStaffId: string,
    @Query('date') date: string,
    @Query('serviceItemIds') rawServiceItemIds: string | string[],
    @Req() request: AuthRequest,
    @Query('channel') channel?: 'admin' | 'miniapp',
  ) {
    return this.bookings.availableSlots(
      {
        staffId: Number(rawStaffId),
        date,
        serviceItemIds: parseIdList(rawServiceItemIds),
        channel: channel ?? 'admin',
      },
      request.user,
    );
  }

  @Get()
  @RequirePermissions('biz:booking:list')
  @ApiOperation({ summary: '预约列表（无 total，前端多取一条判 hasMore）' })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'pageSize', required: false })
  @ApiQuery({ name: 'date', required: false, description: '店内本地日' })
  @ApiQuery({ name: 'dateFrom', required: false })
  @ApiQuery({ name: 'dateTo', required: false })
  @ApiQuery({ name: 'staffId', required: false })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: [
      'pending',
      'confirmed',
      'arrived',
      'completed',
      'cancelled',
      'no_show',
    ],
  })
  @ApiQuery({
    name: 'payStatus',
    required: false,
    enum: ['unpaid', 'partial', 'paid', 'refunded', 'credit'],
  })
  @ApiQuery({ name: 'customerId', required: false })
  @ApiQuery({
    name: 'collectable',
    required: false,
    description:
      '只看还能收款的单据（服务状态不含 cancelled / no_show）；收银台队列专用，预约列表不要传',
  })
  @ApiQuery({
    name: 'keyword',
    required: false,
    description: '单号 / 顾客姓名 / 手机号',
  })
  @ApiResponse({ status: 200, description: '成功' })
  list(
    @Req() request: AuthRequest,
    @Query('page') rawPage?: string,
    @Query('pageSize') rawPageSize?: string,
    @Query('date') date?: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
    @Query('staffId') rawStaffId?: string,
    @Query('status') status?: BookingStatus,
    @Query('payStatus') payStatus?: BookingPayStatus,
    @Query('customerId') rawCustomerId?: string,
    @Query('collectable') rawCollectable?: string,
    @Query('keyword') keyword?: string,
  ) {
    const { page, pageSize } = parsePagination(rawPage, rawPageSize);
    const filter: BookingListFilter = {
      date,
      dateFrom,
      dateTo,
      staffId: rawStaffId ? Number(rawStaffId) : undefined,
      status,
      payStatus,
      customerId: rawCustomerId ? Number(rawCustomerId) : undefined,
      collectable: rawCollectable === 'true' || rawCollectable === '1',
      keyword,
    };
    return this.bookings.list(page, pageSize, filter, request.user);
  }

  @Get('customers/:customerId/brief')
  @RequirePermissions('biz:booking:list')
  @ApiOperation({ summary: '顾客账务摘要（创建预约弹窗展示折扣与余额）' })
  @ApiParam({ name: 'customerId', description: '顾客 id' })
  customerBrief(@Param('customerId', ParseIntPipe) customerId: number) {
    return this.bookings.customerBrief(customerId);
  }

  @Get(':id')
  @RequirePermissions('biz:booking:list')
  @ApiOperation({ summary: '预约详情（含项目明细与支付单）' })
  @ApiParam({ name: 'id', description: '预约 id' })
  findOne(@Param('id', ParseIntPipe) id: number, @Req() request: AuthRequest) {
    return this.bookings.findOne(id, request.user);
  }

  @Post()
  @RequirePermissions('biz:booking:create')
  @ApiOperation({ summary: '创建预约（建单 + 收定/全款，同一事务）' })
  @ApiBody({ schema: { $ref: '#/components/schemas/CreateBookingRequest' } })
  @ApiResponse({
    status: 409,
    description: '时段已被占用 / 顾客同时段已有预约',
  })
  create(@Body() body: unknown, @Req() request: AuthRequest) {
    return this.bookings.create(
      createSchema.parse(body) as CreateBookingInput,
      request.user,
    );
  }

  @Patch(':id')
  @RequirePermissions('biz:booking:update')
  @ApiOperation({ summary: '改期 / 改美甲师 / 改项目（锁 + 复检）' })
  @ApiBody({ schema: { $ref: '#/components/schemas/UpdateBookingRequest' } })
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: unknown,
    @Req() request: AuthRequest,
  ) {
    return this.bookings.update(
      id,
      updateSchema.parse(body) as UpdateBookingInput,
      request.user,
    );
  }

  @Post(':id/confirm')
  @RequirePermissions('biz:booking:update')
  @ApiOperation({ summary: '确认预约（pending → confirmed）' })
  confirm(@Param('id', ParseIntPipe) id: number, @Req() request: AuthRequest) {
    return this.bookings.confirm(id, request.user);
  }

  @Post(':id/arrive')
  @RequirePermissions('biz:booking:arrive')
  @ApiOperation({ summary: '顾客到店（confirmed → arrived）' })
  arrive(@Param('id', ParseIntPipe) id: number, @Req() request: AuthRequest) {
    return this.bookings.arrive(id, request.user);
  }

  @Post(':id/complete')
  @RequirePermissions('biz:booking:complete')
  @ApiOperation({
    summary: '服务完成（arrived → completed，累加到店统计并计提提成）',
  })
  complete(@Param('id', ParseIntPipe) id: number, @Req() request: AuthRequest) {
    return this.bookings.complete(id, request.user);
  }

  @Post(':id/settle')
  @RequirePermissions('biz:payment:create')
  @ApiOperation({ summary: '结算尾款 / 挂账 / 补收（支持混合支付）' })
  @ApiBody({ schema: { $ref: '#/components/schemas/SettleBookingRequest' } })
  settle(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: unknown,
    @Req() request: AuthRequest,
  ) {
    return this.bookings.settle(
      id,
      settleSchema.parse(body) as SettleBookingInput,
      request.user,
    );
  }

  @Post(':id/no-show')
  @RequirePermissions('biz:booking:noshow')
  @ApiOperation({ summary: '标记爽约（confirmed → no_show）' })
  noShow(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: unknown,
    @Req() request: AuthRequest,
  ) {
    return this.bookings.noShow(
      id,
      reasonSchema.parse(body).reason,
      request.user,
    );
  }

  @Post(':id/cancel')
  @RequirePermissions('biz:booking:cancel')
  @ApiOperation({ summary: '取消预约（有实收时提示走退款流程）' })
  cancel(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: unknown,
    @Req() request: AuthRequest,
  ) {
    return this.bookings.cancel(
      id,
      reasonSchema.parse(body).reason,
      request.user,
    );
  }

  @Get(':id/refund-preview')
  @RequirePermissions('biz:refund:apply')
  @ApiOperation({ summary: '退款判责试算' })
  refundPreview(
    @Param('id', ParseIntPipe) id: number,
    @Req() request: AuthRequest,
  ) {
    return this.bookings.refundPreview(id, request.user);
  }

  @Post(':id/refund')
  @RequirePermissions('biz:refund:apply')
  @ApiOperation({ summary: '发起退款（生成待审批退款单）' })
  @ApiBody({ schema: { $ref: '#/components/schemas/ApplyRefundRequest' } })
  applyRefund(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: unknown,
    @Req() request: AuthRequest,
  ) {
    return this.bookings.applyRefund(
      id,
      refundSchema.parse(body),
      request.user,
    );
  }

  @Post(':id/recount')
  @RequirePermissions('biz:booking:update')
  @ApiOperation({ summary: '对账修复：重算时长 / 结束时间与资金字段' })
  recount(@Param('id', ParseIntPipe) id: number, @Req() request: AuthRequest) {
    return this.bookings.recount(id, request.user);
  }

  @Delete(':id')
  @RequirePermissions('biz:booking:delete')
  @ApiOperation({ summary: '软删（仅误录清理；有实收时拒绝，须先退款）' })
  remove(@Param('id', ParseIntPipe) id: number, @Req() request: AuthRequest) {
    return this.bookings.remove(id, request.user);
  }
}

/** `serviceItemIds=1,2` 与 `serviceItemIds=1&serviceItemIds=2` 两种写法都支持 */
function parseIdList(raw: string | string[] | undefined): number[] {
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : raw.split(',');
  return [
    ...new Set(
      list
        .flatMap((item) => String(item).split(','))
        .map((item) => Number(item.trim()))
        .filter((id) => Number.isSafeInteger(id) && id > 0),
    ),
  ];
}
