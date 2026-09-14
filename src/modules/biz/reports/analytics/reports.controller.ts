/**
 * 报表中心（§9.11 / §20.2）：6 张表 + CSV 导出。
 *
 * **全部只读**（权限 `biz:report:view`；导出 `biz:report:export`），
 * 一律按店内本地日 `dateFrom`/`dateTo`（含两端）过滤，支持 `staffId` / `channel` 维度。
 *
 * **门店维度**（阶段 1.8）：与业务列表**同一套门店上下文** —— 显式 `?storeId=` 优先，
 * 否则用顶栏切换器的 `x-store-id` 头；店长**不传参数也自动只统计自己的门店**（数据权限），
 * 超管不传则是全部门店合并。会员资产类指标（储值/积分/结存/次卡发售/新增会员）恒为全店口径。
 */
import { Controller, Get, Query, Req, Res } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { z } from 'zod';
import { RequirePermissions } from '../../../../common/auth/permissions.decorator.js';
import type { RequestActor } from '../../../../common/data-scope/data-scope.js';
import {
  DEFAULT_REPORT_RANGE_DAYS,
  HOME_LIGHT_PERMISSION,
  HOME_MONEY_PERMISSION,
  PAYMENT_CHANNEL_VALUES,
  ReportsService,
  type HomeQuery,
  type ReportQuery,
} from './reports.service.js';

type CsvReply = {
  header(name: string, value: string): unknown;
  send(payload: unknown): unknown;
};

type AuthRequest = { user: RequestActor };

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
  storeId: optional(z.coerce.number().int().positive()),
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

/** 首页概览：区间是**档位**（不是日期区间），环比由服务端按档位算 */
const homeQuerySchema = z.object({
  range: optional(z.enum(['today', '7d', '30d', 'month'])),
  storeId: optional(z.coerce.number().int().positive()),
});

function toHomeInput(query: z.infer<typeof homeQuerySchema>): HomeQuery {
  return { range: query.range, storeId: query.storeId };
}

const STORE_DOC =
  '门店维度（连锁直营）：超管可传任意门店；普通账号只能传自己可见的门店（传别的门店 403）。' +
  '不传 = 用顶栏切换器选中的门店；都没选则 = 按账号可见范围（店长限本店 / 超管全部门店合并）';

function toInput(query: z.infer<typeof reportQuerySchema>): ReportQuery {
  return {
    dateFrom: query.dateFrom,
    dateTo: query.dateTo,
    staffId: query.staffId,
    channel: query.channel,
    purpose: query.purpose,
    granularity: query.granularity,
    storeId: query.storeId,
  };
}

@ApiTags('报表中心')
@ApiBearerAuth('access-token')
@Controller('biz/reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('home')
  @RequirePermissions(HOME_MONEY_PERMISSION, HOME_LIGHT_PERMISSION)
  @ApiOperation({
    summary:
      '首页经营概览（按店：净营收 / 单量 / 成单率 / 退款率 / 门店对比 / 待办）',
    description:
      '权限二选一：\n' +
      `- \`${HOME_MONEY_PERMISSION}\`（店长及以上）→ **全量版**，含金额类指标；\n` +
      `- \`${HOME_LIGHT_PERMISSION}\`（前台）→ **轻量版**，只有单量/转化率/待办，` +
      '**响应里不含任何金额字段**（不是前端隐藏，是服务端不下发）。\n\n' +
      '门店口径：汇总/趋势/待办按顶栏切换器选中的门店收窄，**门店对比表恒看可见门店全量**；' +
      '店长不传任何参数也只统计自己门店（数据权限）。\n' +
      '区间是档位（today / 7d / 30d / month，默认 today），环比同日历上的上一个等长区间。',
  })
  @ApiQuery({
    name: 'range',
    required: false,
    description: 'today | 7d | 30d | month（默认 today）',
  })
  @ApiQuery({ name: 'storeId', required: false, description: STORE_DOC })
  @ApiResponse({ status: 200, description: '成功' })
  home(@Query() raw: Record<string, unknown>, @Req() request: AuthRequest) {
    return this.reports.home(
      toHomeInput(homeQuerySchema.parse({ ...raw })),
      request.user,
    );
  }

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
  @ApiQuery({ name: 'storeId', required: false, description: STORE_DOC })
  @ApiResponse({ status: 200, description: '成功' })
  overview(@Query() raw: Record<string, unknown>, @Req() request: AuthRequest) {
    return this.reports.overview(
      toInput(reportQuerySchema.parse({ ...raw })),
      request.user,
    );
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
  @ApiQuery({ name: 'storeId', required: false, description: STORE_DOC })
  @ApiResponse({ status: 200, description: '成功' })
  revenue(@Query() raw: Record<string, unknown>, @Req() request: AuthRequest) {
    return this.reports.revenue(
      toInput(reportQuerySchema.parse({ ...raw })),
      request.user,
    );
  }

  @Get('services')
  @RequirePermissions('biz:report:view')
  @ApiOperation({ summary: '项目排行（次数 / 金额 / 次卡核销占比）' })
  @ApiQuery({ name: 'dateFrom', required: false, description: RANGE_DOC })
  @ApiQuery({ name: 'dateTo', required: false, description: RANGE_DOC })
  @ApiQuery({ name: 'staffId', required: false, description: '美甲师维度' })
  @ApiQuery({ name: 'channel', required: false, description: '支付渠道维度' })
  @ApiQuery({ name: 'storeId', required: false, description: STORE_DOC })
  @ApiResponse({ status: 200, description: '成功' })
  services(@Query() raw: Record<string, unknown>, @Req() request: AuthRequest) {
    return this.reports.services(
      toInput(reportQuerySchema.parse({ ...raw })),
      request.user,
    );
  }

  @Get('staffs')
  @RequirePermissions('biz:report:view')
  @ApiOperation({
    summary: '美甲师业绩（单量 / 净营收分摊 / 提成 / 平均评分）',
  })
  @ApiQuery({ name: 'dateFrom', required: false, description: RANGE_DOC })
  @ApiQuery({ name: 'dateTo', required: false, description: RANGE_DOC })
  @ApiQuery({ name: 'staffId', required: false, description: '只看某位美甲师' })
  @ApiQuery({ name: 'storeId', required: false, description: STORE_DOC })
  @ApiResponse({ status: 200, description: '成功' })
  staffs(@Query() raw: Record<string, unknown>, @Req() request: AuthRequest) {
    return this.reports.staffs(
      toInput(reportQuerySchema.parse({ ...raw })),
      request.user,
    );
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
  @ApiQuery({ name: 'storeId', required: false, description: STORE_DOC })
  @ApiResponse({ status: 200, description: '成功' })
  members(@Query() raw: Record<string, unknown>, @Req() request: AuthRequest) {
    return this.reports.members(
      toInput(reportQuerySchema.parse({ ...raw })),
      request.user,
    );
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
  @ApiQuery({ name: 'storeId', required: false, description: STORE_DOC })
  @ApiResponse({ status: 200, description: '成功' })
  receivables(
    @Query() raw: Record<string, unknown>,
    @Req() request: AuthRequest,
  ) {
    return this.reports.receivables(
      toInput(reportQuerySchema.parse({ ...raw })),
      request.user,
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
  @ApiQuery({ name: 'storeId', required: false, description: STORE_DOC })
  @ApiResponse({
    status: 200,
    description: 'text/csv; charset=utf-8（含 UTF-8 BOM）',
  })
  async export(
    @Query() raw: Record<string, unknown>,
    @Req() request: AuthRequest,
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
      request.user,
    );
    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
    );
    reply.send(content);
  }
}
