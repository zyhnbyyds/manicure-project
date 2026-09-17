import { Injectable } from '@nestjs/common';
import { ApprovalPolicy, RiskLevel } from '../../ai.types';
import type { AiTool, ToolContext } from '../tool.interface';
import { READ_ONLY_LIMITS, actorOf } from '../biz-common/biz-tool.util';
import { ReportsService } from '../../../modules/biz/reports/analytics/reports.service';

/**
 * 报表域的 AI 只读工具。
 *
 * 报表的数**只能从 ReportsService 拿**：营收口径（净营收 = 成功支付 − 成功退款、
 * 挂账不计营收、次卡核销单列）都封在 service 里，AI 绝不能自己拿 payment.list
 * 加总去「算」营收 —— 那样出来的数字和报表页对不上，是最容易被当成真数据信以为真的错误。
 */

type ReportQueryInput = Parameters<ReportsService['revenue']>[0];
type HomeQueryInput = Parameters<ReportsService['home']>[0];

/** report.revenue —— 营收报表 */
@Injectable()
export class ReportRevenueTool implements AiTool<{
  dateFrom?: string;
  dateTo?: string;
  staffId?: number;
  channel?: ReportQueryInput['channel'];
  purpose?: ReportQueryInput['purpose'];
  granularity?: ReportQueryInput['granularity'];
  storeId?: number;
}> {
  name = 'report.revenue';
  description =
    '查营收报表（按天 / 周 / 月粒度）。口径已由后端固定：**净营收 = 成功支付 − 成功退款**，' +
    '**挂账不计营收（销账才计入）**，次卡核销单列不混进营收。' +
    '任何「这个月赚了多少」都必须用它，不要拿 payment.list 自己加总。' +
    'granularity 不传时按后端默认粒度。' +
    '**返回的金额字段单位一律是「分」**，向用户汇报前先换算成「元」（÷100）。';
  permission = 'biz:report:view';
  riskLevel = RiskLevel.L0;
  approvalPolicy = ApprovalPolicy.NONE;
  inputSchema = {
    type: 'object',
    properties: {
      dateFrom: { type: 'string', description: '起始日 YYYY-MM-DD（含）' },
      dateTo: { type: 'string', description: '结束日 YYYY-MM-DD（含）' },
      staffId: { type: 'number', description: '只看某位美甲师的业绩' },
      channel: { type: 'string', description: '支付渠道筛选' },
      purpose: { type: 'string', description: '款项用途筛选' },
      granularity: {
        type: 'string',
        enum: ['day', 'week', 'month'],
        description: '统计粒度',
      },
      storeId: {
        type: 'number',
        description: '门店 id；不传按你的数据权限范围',
      },
    },
  };
  limits = READ_ONLY_LIMITS;

  constructor(private readonly reports: ReportsService) {}

  async execute(
    input: {
      dateFrom?: string;
      dateTo?: string;
      staffId?: number;
      channel?: ReportQueryInput['channel'];
      purpose?: ReportQueryInput['purpose'];
      granularity?: ReportQueryInput['granularity'];
      storeId?: number;
    },
    context: ToolContext,
  ) {
    return this.reports.revenue(
      {
        dateFrom: input.dateFrom,
        dateTo: input.dateTo,
        staffId: input.staffId,
        channel: input.channel,
        purpose: input.purpose,
        granularity: input.granularity,
        storeId: input.storeId,
      },
      actorOf(context),
    );
  }
}

/** report.overview —— 经营总览 */
@Injectable()
export class ReportOverviewTool implements AiTool<{
  dateFrom?: string;
  dateTo?: string;
  staffId?: number;
  channel?: ReportQueryInput['channel'];
  purpose?: ReportQueryInput['purpose'];
  granularity?: ReportQueryInput['granularity'];
  storeId?: number;
}> {
  name = 'report.overview';
  description =
    '查经营总览（区间汇总）：营收、单量、客单价、项目与美甲师排行等一整套指标，口径与报表页完全一致。' +
    '回答「最近生意怎么样」先用它拿到全景，再按需下钻 report.revenue（时间序列）。' +
    '**返回的金额字段单位一律是「分」**，向用户汇报前先换算成「元」（÷100）。';
  permission = 'biz:report:view';
  riskLevel = RiskLevel.L0;
  approvalPolicy = ApprovalPolicy.NONE;
  inputSchema = {
    type: 'object',
    properties: {
      dateFrom: { type: 'string', description: '起始日 YYYY-MM-DD（含）' },
      dateTo: { type: 'string', description: '结束日 YYYY-MM-DD（含）' },
      staffId: { type: 'number', description: '只看某位美甲师' },
      channel: { type: 'string', description: '支付渠道筛选' },
      purpose: { type: 'string', description: '款项用途筛选' },
      granularity: {
        type: 'string',
        enum: ['day', 'week', 'month'],
        description: '统计粒度',
      },
      storeId: { type: 'number', description: '门店 id' },
    },
  };
  limits = READ_ONLY_LIMITS;

  constructor(private readonly reports: ReportsService) {}

  async execute(
    input: {
      dateFrom?: string;
      dateTo?: string;
      staffId?: number;
      channel?: ReportQueryInput['channel'];
      purpose?: ReportQueryInput['purpose'];
      granularity?: ReportQueryInput['granularity'];
      storeId?: number;
    },
    context: ToolContext,
  ) {
    return this.reports.overview(
      {
        dateFrom: input.dateFrom,
        dateTo: input.dateTo,
        staffId: input.staffId,
        channel: input.channel,
        purpose: input.purpose,
        granularity: input.granularity,
        storeId: input.storeId,
      },
      actorOf(context),
    );
  }
}

/** report.home —— 首页看板 */
@Injectable()
export class ReportHomeTool implements AiTool<{
  range?: HomeQueryInput['range'];
  storeId?: number;
}> {
  name = 'report.home';
  description =
    '查首页看板（今天的营业额与单量、待办提醒、近几日趋势等），就是后台首页那张卡片的数据。' +
    'range 可选 today / 7d / 30d / month，不传按后端默认。' +
    '**返回的金额字段单位一律是「分」**，向用户汇报前先换算成「元」（÷100）。' +
    '注意首页看板对**没有金额权限**的账号会自动隐藏金额部分 —— ' +
    '如果返回里没有金额字段，那是权限问题，不是数据丢了。';
  permission = 'biz:report:view';
  riskLevel = RiskLevel.L0;
  approvalPolicy = ApprovalPolicy.NONE;
  inputSchema = {
    type: 'object',
    properties: {
      range: {
        type: 'string',
        enum: ['today', '7d', '30d', 'month'],
        description: '统计区间',
      },
      storeId: { type: 'number', description: '门店 id' },
    },
  };
  limits = READ_ONLY_LIMITS;

  constructor(private readonly reports: ReportsService) {}

  async execute(
    input: { range?: HomeQueryInput['range']; storeId?: number },
    context: ToolContext,
  ) {
    return this.reports.home(
      { range: input.range, storeId: input.storeId },
      actorOf(context),
    );
  }
}
