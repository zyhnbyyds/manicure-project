/**
 * 报表中心（§9.11 / §20.2）：6 张表 + CSV 导出。
 *
 * **全部只读**（权限 `biz:report:view`；导出 `biz:report:export`），
 * 一律按店内本地日 `dateFrom`/`dateTo`（含两端）过滤，支持 `staffId` / `channel` 维度。
 */
import { Controller, Get, Query, Res } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { z } from 'zod';
import { RequirePermissions } from '../../../../common/auth/permissions.decorator.js';
import {
  DEFAULT_REPORT_RANGE_DAYS,
  PAYMENT_CHANNEL_VALUES,
  ReportsService,
  type ReportQuery,
} from './reports.service.js';

type CsvReply = {
  header(name: string, value: string): unknown;
  send(payload: unknown): unknown;
};

/** 空字符串一律当「没传」（前端清空筛选项时常见） */
function emptyToUndefined(value: unknown): unknown {
  return value === '' || value === undefined ? undefined : value;
}

const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess(emptyToUndefined, schema.optional());

/** `wechat` / `alipay` 是聚合标签（分别覆盖 Native + 线下两种渠道） */
const CHANNEL_VALUES = [...PAYMENT_CHANNEL_VALUES, 'wechat', 'alipay'] as const;

const reportQuerySchema = z.object({
  dateFrom: optional(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
  dateTo: optional(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
  staffId: optional(z.coerce.number().int().positive()),
  channel: optional(z.enum(CHANNEL_VALUES)),
  purpose: optional(
    z.enum(['deposit', 'final', 'recharge', 'card_buy', 'credit_settle']),
  ),
  granularity: optional(z.enum(['day', 'week', 'month'])),
});

const exportQuerySchema = reportQuerySchema.extend({
  type: z.enum([
    'overview',
    'revenue',
    'services',
    'staffs',
    'members',
    'receivables',
  ]),
  format: z.enum(['csv']).default('csv'),
});

const RANGE_DOC = `店内本地日 YYYY-MM-DD（含两端）；缺省 = 最近 ${DEFAULT_REPORT_RANGE_DAYS} 天`;

function toInput(query: z.infer<typeof reportQuerySchema>): ReportQuery {
  return {
    dateFrom: query.dateFrom,
    dateTo: query.dateTo,
    staffId: query.staffId,
    channel: query.channel,
    purpose: query.purpose,
    granularity: query.granularity,
  };
}

@ApiTags('报表中心')
@ApiBearerAuth('access-token')
@Controller('biz/reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('overview')
  @RequirePermissions('biz:report:view')
  @ApiOperation({
    summary:
      '经营概览（实收营收 / 单量 / 客单价 / 新客回头客 / 会员与储值变动）',
  })
  @ApiQuery({ name: 'dateFrom', required: false, description: RANGE_DOC })
  @ApiQuery({ name: 'dateTo', required: false, description: RANGE_DOC })
  @ApiQuery({ name: 'staffId', required: false, description: '美甲师维度' })
  @ApiQuery({
    name: 'channel',
    required: false,
    description: '支付渠道维度（cash/wxpay_native/…）',
  })
  @ApiQuery({
    name: 'purpose',
    required: false,
    description: '支付用途维度（可选，默认不筛选）',
  })
  @ApiResponse({ status: 200, description: '成功' })
  overview(@Query() raw: Record<string, unknown>) {
    return this.reports.overview(toInput(reportQuerySchema.parse({ ...raw })));
  }

  @Get('revenue')
  @RequirePermissions('biz:report:view')
  @ApiOperation({ summary: '营收明细（按日/周/月拆渠道，退款冲减）' })
  @ApiQuery({ name: 'dateFrom', required: false, description: RANGE_DOC })
  @ApiQuery({ name: 'dateTo', required: false, description: RANGE_DOC })
  @ApiQuery({ name: 'staffId', required: false, description: '美甲师维度' })
  @ApiQuery({ name: 'channel', required: false, description: '支付渠道维度' })
  @ApiQuery({
    name: 'granularity',
    required: false,
    description: 'day | week | month（默认 day）',
  })
  @ApiResponse({ status: 200, description: '成功' })
  revenue(@Query() raw: Record<string, unknown>) {
    return this.reports.revenue(toInput(reportQuerySchema.parse({ ...raw })));
  }

  @Get('services')
  @RequirePermissions('biz:report:view')
  @ApiOperation({ summary: '项目排行（次数 / 金额 / 次卡核销占比）' })
  @ApiQuery({ name: 'dateFrom', required: false, description: RANGE_DOC })
  @ApiQuery({ name: 'dateTo', required: false, description: RANGE_DOC })
  @ApiQuery({ name: 'staffId', required: false, description: '美甲师维度' })
  @ApiQuery({ name: 'channel', required: false, description: '支付渠道维度' })
  @ApiResponse({ status: 200, description: '成功' })
  services(@Query() raw: Record<string, unknown>) {
    return this.reports.services(toInput(reportQuerySchema.parse({ ...raw })));
  }

  @Get('staffs')
  @RequirePermissions('biz:report:view')
  @ApiOperation({
    summary: '美甲师业绩（单量 / 净营收分摊 / 提成 / 平均评分）',
  })
  @ApiQuery({ name: 'dateFrom', required: false, description: RANGE_DOC })
  @ApiQuery({ name: 'dateTo', required: false, description: RANGE_DOC })
  @ApiQuery({ name: 'staffId', required: false, description: '只看某位美甲师' })
  @ApiResponse({ status: 200, description: '成功' })
  staffs(@Query() raw: Record<string, unknown>) {
    return this.reports.staffs(toInput(reportQuerySchema.parse({ ...raw })));
  }

  @Get('members')
  @RequirePermissions('biz:report:view')
  @ApiOperation({
    summary: '会员报表（新增 / 储值充退 / 余额结存 / 积分 / 次卡核销）',
  })
  @ApiQuery({ name: 'dateFrom', required: false, description: RANGE_DOC })
  @ApiQuery({ name: 'dateTo', required: false, description: RANGE_DOC })
  @ApiQuery({
    name: 'granularity',
    required: false,
    description: 'day | week | month（默认 day）',
  })
  @ApiResponse({ status: 200, description: '成功' })
  members(@Query() raw: Record<string, unknown>) {
    return this.reports.members(toInput(reportQuerySchema.parse({ ...raw })));
  }

  @Get('receivables')
  @RequirePermissions('biz:report:view')
  @ApiOperation({
    summary: '挂账与应收账龄（0-30 / 31-60 / 60+、逾期、按主体）',
  })
  @ApiQuery({
    name: 'dateFrom',
    required: false,
    description: '挂账日区间起点（缺省 = 全部未结，账龄是「截至今天」的快照）',
  })
  @ApiQuery({
    name: 'dateTo',
    required: false,
    description: '挂账日区间终点（缺省 = 全部未结）',
  })
  @ApiQuery({ name: 'staffId', required: false, description: '预留维度' })
  @ApiResponse({ status: 200, description: '成功' })
  receivables(@Query() raw: Record<string, unknown>) {
    return this.reports.receivables(
      toInput(reportQuerySchema.parse({ ...raw })),
    );
  }

  @Get('export')
  @RequirePermissions('biz:report:export')
  @ApiOperation({
    summary: '导出报表 CSV（≤1 万行同步返回；超过提示走异步任务）',
  })
  @ApiQuery({
    name: 'type',
    required: true,
    description:
      'overview | revenue | services | staffs | members | receivables',
  })
  @ApiQuery({ name: 'format', required: false, description: 'csv（默认）' })
  @ApiQuery({ name: 'dateFrom', required: false, description: RANGE_DOC })
  @ApiQuery({ name: 'dateTo', required: false, description: RANGE_DOC })
  @ApiQuery({ name: 'staffId', required: false, description: '美甲师维度' })
  @ApiQuery({ name: 'channel', required: false, description: '支付渠道维度' })
  @ApiQuery({
    name: 'granularity',
    required: false,
    description: 'day | week | month（默认 day）',
  })
  @ApiResponse({
    status: 200,
    description: 'text/csv; charset=utf-8（含 UTF-8 BOM）',
  })
  async export(
    @Query() raw: Record<string, unknown>,
    @Res() reply: CsvReply,
  ): Promise<void> {
    const query = exportQuerySchema.parse({ ...raw });
    /*
     * TODO（本期不做）：超过 1 万行的异步导出。
     * 计划复用 `src/modules/jobs` + 文件模块：落一条导出任务 → 生成文件 → 通知中心提示下载。
     * 本期超过上限直接 400，提示缩小时间范围（见 ReportsService.exportCsv）。
     */
    const { filename, content } = await this.reports.exportCsv(
      query.type,
      toInput(query),
    );
    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
    );
    reply.send(content);
  }
}
