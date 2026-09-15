import { Injectable } from '@nestjs/common';
import { ApprovalPolicy, RiskLevel } from '../../ai.types';
import type { AiTool, ToolContext } from '../tool.interface';
import {
  READ_ONLY_LIMITS,
  actorOf,
  clampPage,
} from '../biz-common/biz-tool.util';
import { PaymentsService } from '../../../modules/biz/payment/payments/payments.service';
import { RefundsService } from '../../../modules/biz/payment/refunds/refunds.service';
import { ReceivablesService } from '../../../modules/biz/credit/receivables/receivables.service';

/**
 * 收银 / 退款 / 应收域的 AI 只读工具。
 *
 * **这里永远只读**：收银、退款、销账的写入口只存在于收银台与退款审批
 * （见 docs/admin/ai-assistant.md「AI 不碰钱」），AI 工具连「发起收款」这种
 * L2 工具都不提供 —— 一旦提供，模型就有机会在用户没看清楚时把钱收错。
 *
 * 入参类型的 filter 部分直接取 service 签名（`Parameters<...>`），
 * 保证枚举值与后端永远同步。
 */

type PaymentListFilter = Parameters<PaymentsService['list']>[2];
type RefundListFilter = Parameters<RefundsService['list']>[2];
type ReceivableListFilter = Parameters<ReceivablesService['list']>[2];

/** payment.list —— 支付流水 */
@Injectable()
export class PaymentListTool implements AiTool<
  Partial<PaymentListFilter> & { page?: number; pageSize?: number }
> {
  name = 'payment.list';
  description =
    '查支付流水（分页）：支付单号、用途（定金 deposit / 尾款 final / 充值 recharge / 买卡 card_buy / ' +
    '销账 credit_settle）、渠道、金额、实收、状态、支付时间，并带出单号与顾客名。' +
    '按金额和渠道核对时非常有用。注意：**挂账不产生支付单** —— 挂账的单在这里查不到，要去 receivable.list。';
  permission = 'biz:payment:list';
  riskLevel = RiskLevel.L0;
  approvalPolicy = ApprovalPolicy.NONE;
  inputSchema = {
    type: 'object',
    properties: {
      storeId: { type: 'number', description: '门店 id' },
      channel: {
        type: 'string',
        enum: [
          'wxpay_native',
          'alipay_qr',
          'cash',
          'wechat_offline',
          'alipay_offline',
          'balance',
          'card',
          'credit',
        ],
        description: '支付渠道',
      },
      status: {
        type: 'string',
        enum: [
          'pending',
          'success',
          'failed',
          'closed',
          'refunded',
          'partial_refunded',
        ],
        description: '支付状态；算营收只看 success',
      },
      purpose: {
        type: 'string',
        enum: ['deposit', 'final', 'recharge', 'card_buy', 'credit_settle'],
        description: '款项用途',
      },
      bookingNo: { type: 'string', description: '预约单号' },
      customerId: { type: 'number', description: '顾客 id' },
      bookingId: { type: 'number', description: '预约 id' },
      dateFrom: { type: 'string', description: '起始日 YYYY-MM-DD（含）' },
      dateTo: { type: 'string', description: '结束日 YYYY-MM-DD（含）' },
      page: { type: 'number', description: '页码，默认 1' },
      pageSize: { type: 'number', description: '每页条数，默认 20，最多 100' },
    },
  };
  limits = READ_ONLY_LIMITS;

  constructor(private readonly payments: PaymentsService) {}

  async execute(
    input: Partial<PaymentListFilter> & { page?: number; pageSize?: number },
    context: ToolContext,
  ) {
    const { page, pageSize } = clampPage(input.page, input.pageSize);
    return this.payments.list(
      page,
      pageSize,
      {
        storeId: input.storeId,
        channel: input.channel,
        status: input.status,
        purpose: input.purpose,
        bookingNo: input.bookingNo,
        customerId: input.customerId,
        bookingId: input.bookingId,
        dateFrom: input.dateFrom,
        dateTo: input.dateTo,
      },
      actorOf(context),
    );
  }
}

/** refund.list —— 退款单列表 */
@Injectable()
export class RefundListTool implements AiTool<
  Partial<RefundListFilter> & { page?: number; pageSize?: number }
> {
  name = 'refund.list';
  description =
    '查退款单列表（分页）：退给谁、退多少、走哪个渠道、责任方、以及**退款阶段**。' +
    'stage=before_start 表示服务开始前（无理由，按规则直接退），' +
    'stage=in_service 表示服务开始后（需店长判断、手动审批）。' +
    'status 反映审批与打款进度。回答「这单退了没有 / 为什么只退一半」用它。';
  permission = 'biz:refund:list';
  riskLevel = RiskLevel.L0;
  approvalPolicy = ApprovalPolicy.NONE;
  inputSchema = {
    type: 'object',
    properties: {
      storeId: { type: 'number', description: '门店 id' },
      status: { type: 'string', description: '退款单状态' },
      mode: {
        type: 'string',
        enum: ['original', 'cash', 'balance'],
        description: '退款方式',
      },
      stage: {
        type: 'string',
        enum: ['before_start', 'in_service'],
        description: '退款阶段：服务开始前 / 服务中',
      },
      liable: {
        type: 'string',
        enum: ['store', 'customer', 'force_majeure'],
        description: '责任方',
      },
      paymentId: { type: 'number', description: '按原支付单 id 过滤' },
      bookingId: { type: 'number', description: '预约 id' },
      customerId: { type: 'number', description: '顾客 id' },
      dateFrom: { type: 'string', description: '起始日 YYYY-MM-DD（含）' },
      dateTo: { type: 'string', description: '结束日 YYYY-MM-DD（含）' },
      page: { type: 'number', description: '页码，默认 1' },
      pageSize: { type: 'number', description: '每页条数，默认 20，最多 100' },
    },
  };
  limits = READ_ONLY_LIMITS;

  constructor(private readonly refunds: RefundsService) {}

  async execute(
    input: Partial<RefundListFilter> & { page?: number; pageSize?: number },
    context: ToolContext,
  ) {
    const { page, pageSize } = clampPage(input.page, input.pageSize);
    return this.refunds.list(
      page,
      pageSize,
      {
        storeId: input.storeId,
        status: input.status,
        mode: input.mode,
        stage: input.stage,
        liable: input.liable,
        paymentId: input.paymentId,
        bookingId: input.bookingId,
        customerId: input.customerId,
        dateFrom: input.dateFrom,
        dateTo: input.dateTo,
      },
      actorOf(context),
    );
  }
}

/** receivable.list —— 应收台账 */
@Injectable()
export class ReceivableListTool implements AiTool<
  Partial<ReceivableListFilter> & { page?: number; pageSize?: number }
> {
  name = 'receivable.list';
  description =
    '查应收（挂账）台账（分页）：挂账主体、原始金额、已销账、剩余未收 remainingAmount、账期与状态。' +
    'overdue=true 只看**已逾期**的。关键口径：**挂账不计营收，销账才计入** —— ' +
    '所以「这个月营收」不能拿这里的合计去加。';
  permission = 'biz:receivable:list';
  riskLevel = RiskLevel.L0;
  approvalPolicy = ApprovalPolicy.NONE;
  inputSchema = {
    type: 'object',
    properties: {
      storeId: { type: 'number', description: '门店 id' },
      creditAccountId: { type: 'number', description: '挂账主体 id' },
      status: {
        type: 'string',
        enum: ['open', 'partial', 'settled', 'overdue', 'cancelled'],
        description: '应收状态',
      },
      overdue: { type: 'boolean', description: 'true 只看已逾期' },
      dueDateFrom: { type: 'string', description: '到期日起 YYYY-MM-DD（含）' },
      dueDateTo: { type: 'string', description: '到期日止 YYYY-MM-DD（含）' },
      page: { type: 'number', description: '页码，默认 1' },
      pageSize: { type: 'number', description: '每页条数，默认 20，最多 100' },
    },
  };
  limits = READ_ONLY_LIMITS;

  constructor(private readonly receivables: ReceivablesService) {}

  async execute(
    input: Partial<ReceivableListFilter> & { page?: number; pageSize?: number },
    context: ToolContext,
  ) {
    const { page, pageSize } = clampPage(input.page, input.pageSize);
    return this.receivables.list(
      page,
      pageSize,
      {
        storeId: input.storeId,
        creditAccountId: input.creditAccountId,
        status: input.status,
        overdue: input.overdue,
        dueDateFrom: input.dueDateFrom,
        dueDateTo: input.dueDateTo,
      },
      actorOf(context),
    );
  }
}

/** receivable.summary —— 应收汇总（按挂账主体） */
@Injectable()
export class ReceivableSummaryTool implements AiTool<Record<string, never>> {
  name = 'receivable.summary';
  description =
    '按挂账主体汇总应收：每家还欠多少、有多少已逾期。回答「谁欠我们钱 / 总共应收多少」用它 —— ' +
    '别用 receivable.list 逐页加总（列表分页且只返回单页）。';
  permission = 'biz:receivable:list';
  riskLevel = RiskLevel.L0;
  approvalPolicy = ApprovalPolicy.NONE;
  inputSchema = { type: 'object', properties: {} };
  limits = READ_ONLY_LIMITS;

  constructor(private readonly receivables: ReceivablesService) {}

  async execute() {
    const items = await this.receivables.summary();
    return { items, page: 1, pageSize: items.length };
  }
}
