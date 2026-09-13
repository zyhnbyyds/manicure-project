import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNull, lte, sql } from 'drizzle-orm';
import { DatabaseService } from '../../../../database/database.service.js';
import {
  bizBookings,
  bizPaymentLogs,
  bizPayments,
  bizRefundPolicies,
  bizRefunds,
} from '../../../../database/schema/index.js';
import { BizConfigService } from '../../common/biz-config.service.js';
import { buildDocNo } from '../../common/doc-no.js';
import { permilleOf } from '../../common/money.js';
import { localDateRange } from '../../common/query.js';
import {
  CommissionPort,
  MemberAccountPort,
  RefundPort,
  SettlementPort,
} from '../../common/ports.js';
import type { BizTx } from '../../common/tx.js';
import type { OnlineChannel } from '../channels/channel.interface.js';
import { AlipayQrProvider } from '../channels/alipay-qr.provider.js';
import { WxpayNativeProvider } from '../channels/wxpay-native.provider.js';
import {
  PaymentsService,
  type PaymentRow,
} from '../payments/payments.service.js';

export type RefundRow = typeof bizRefunds.$inferSelect;
export type RefundPolicyRow = typeof bizRefundPolicies.$inferSelect;
export type Liable = 'store' | 'customer' | 'force_majeure';
export type RefundMode = 'original' | 'cash' | 'balance';

const ONLINE_CHANNELS: OnlineChannel[] = ['wxpay_native', 'alipay_qr'];

export type RefundPreviewInput = {
  bookingId: number;
  /** 取消时点（ISO8601，缺省取当前时间）；用于算「距预约开始小时数」 */
  cancelAt?: string | undefined;
  liable?: Liable | undefined;
};

export type RefundPreview = {
  bookingId: number;
  bookingNo: string;
  startAt: Date;
  cancelAt: Date;
  /** 实际提前小时数（可为负 = 已过预约开始时间），等价于端口里的 `hoursToStart` */
  hoursToStart: number;
  liable: Liable;
  policyId: number | null;
  policyName: string | null;
  /** 命中的规则阈值（小时）；未命中为 null */
  hoursBefore: number | null;
  refundPermille: number;
  /** 预约毛实收（Σ成功支付单 received_amount） */
  paidAmount: number;
  refundedAmount: number;
  /** 剩余可退 = paidAmount − refundedAmount */
  refundableAmount: number;
  /** 建议退款额（判责后实际应退） */
  suggestAmount: number;
  /** 判责扣减 = 判责基数 − 建议退款额 */
  deductAmount: number;
  /**
   * 逐笔可退明细。
   *
   * 退款单**必须挂在具体支付单上**（`biz_refund.payment_id` NOT NULL），所以混合支付的预约
   * 要一次退完需按支付单分别申请 / 审批；这里把明细吐给前端便于逐笔操作。
   */
  payments: {
    paymentId: number;
    paymentNo: string;
    channel: string;
    amount: number;
    refundedAmount: number;
    refundableAmount: number;
  }[];
};

export type RefundApplyInput = {
  paymentId?: number | undefined;
  bookingId?: number | undefined;
  /** 申请退款金额（判责基数），默认 = 该支付单剩余可退 */
  amount?: number | undefined;
  /** 实际退款额，默认 = 判责建议值；与建议值不同即视为人工改额（必须填原因） */
  actualAmount?: number | undefined;
  mode: RefundMode;
  reason: string;
  liable?: Liable | undefined;
  policyId?: number | undefined;
  remark?: string | undefined;
};

export type RefundApproveResult = {
  id: number;
  refundNo: string;
  status: RefundRow['status'];
  /** true = 本次调用没有执行（重复审批 / 已处理） */
  handled: boolean;
  actualAmount: number;
  channelRefundId: string | null;
  message: string | null;
};

export type RefundListFilter = {
  status?: RefundRow['status'] | undefined;
  mode?: RefundMode | undefined;
  liable?: Liable | undefined;
  paymentId?: number | undefined;
  bookingId?: number | undefined;
  customerId?: number | undefined;
  dateFrom?: string | undefined;
  dateTo?: string | undefined;
};

/** 并发下「另一个执行者已经落地」的内部信号：抛出让事务回滚，再对外返回「已处理」 */
class AlreadyHandledError extends Error {}

/**
 * 退款：判责试算 + 申请 / 审批分离 + 只执行一次（§17.4 / §6.6 第 5 条）。
 *
 * - 规则只给**建议**：`liable=customer` 按「`hours_before ≤ 提前小时数` 中最大的一条」扣减，
 *   都不命中 → 1000‰ 全退；`liable=store` / `force_majeure` → 全退；
 * - 去向：`original` 原路退回（只有在线支付可以）、`cash` 现金退、`balance` 退入储值余额；
 * - 执行闸门是 `biz_refund` 的条件更新，成功后同事务回写 `biz_payment.refunded_amount` /
 *   `status`、重算预约资金、按比例回减 `total_spent` 与积分、冲销提成。
 */
@Injectable()
export class RefundsService extends RefundPort {
  private readonly logger = new Logger(RefundsService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly bizConfig: BizConfigService,
    private readonly payments: PaymentsService,
    private readonly settlement: SettlementPort,
    private readonly members: MemberAccountPort,
    private readonly commission: CommissionPort,
    private readonly wxpayNative: WxpayNativeProvider,
    private readonly alipayQr: AlipayQrProvider,
  ) {
    super();
  }

  /* ------------------------------------------------------------------ *
   * 判责试算
   * ------------------------------------------------------------------ */

  /** `POST /biz/refunds/preview`：命中规则 + 建议退款额（只读，不改账） */
  async preview(input: RefundPreviewInput): Promise<RefundPreview> {
    const booking = await this.requireBooking(input.bookingId);
    const cancelAt = parseInstant(input.cancelAt) ?? new Date();
    const liable = input.liable ?? 'customer';
    const money = await this.bookingMoney(booking.id);
    const remaining = Math.max(money.paidAmount - money.refundedAmount, 0);
    const payments = await this.refundableBreakdown(booking.id);
    const assessment = await this.assess({
      startAt: booking.startAt,
      cancelAt,
      liable,
      base: remaining,
      policyId: undefined,
    });
    return {
      bookingId: booking.id,
      bookingNo: booking.bookingNo,
      startAt: booking.startAt,
      cancelAt,
      hoursToStart: round2(hoursBetween(booking.startAt, cancelAt)),
      liable,
      policyId: assessment.policy?.id ?? null,
      policyName: assessment.policy?.name ?? null,
      hoursBefore: assessment.policy?.hoursBefore ?? null,
      refundPermille: assessment.refundPermille,
      paidAmount: money.paidAmount,
      refundedAmount: money.refundedAmount,
      refundableAmount: remaining,
      suggestAmount: assessment.suggestAmount,
      deductAmount: Math.max(remaining - assessment.suggestAmount, 0),
      payments,
    };
  }

  /* ------------------------------------------------------------------ *
   * 申请
   * ------------------------------------------------------------------ */

  /**
   * `POST /biz/refunds`：生成**待审批**退款单（金额默认取建议值，可改但必须填原因）。
   *
   * `biz_refund.amount` = 判责基数（申请退款金额），`actual_amount` = 实际退款额，
   * `deduct_amount = amount − actual_amount`（§4.5 字段口径）。
   */
  async apply(input: RefundApplyInput, actorId: number): Promise<RefundRow> {
    const reason = input.reason?.trim();
    if (!reason) throw new BadRequestException('退款原因必填');
    if (reason.length < 2) throw new BadRequestException('退款原因过于简单');

    const payment = await this.resolvePayment(input);
    const bookingId = input.bookingId ?? payment.bookingId;
    const booking =
      bookingId === null ? null : await this.requireBooking(bookingId);
    if (
      input.mode === 'original' &&
      !ONLINE_CHANNELS.includes(payment.channel as OnlineChannel)
    )
      throw new BadRequestException(
        '该支付单不是在线支付，原路退回不可用，请选择现金退或退入储值余额',
      );

    const remaining = payment.amount - payment.refundedAmount;
    if (remaining <= 0) throw new ConflictException('该支付单已无可退金额');

    const liable = input.liable ?? 'customer';
    const assessment = await this.assess({
      startAt: booking?.startAt ?? null,
      cancelAt: new Date(),
      liable,
      base: remaining,
      policyId: input.policyId,
    });

    const amount = Math.trunc(input.amount ?? remaining);
    if (amount <= 0) throw new BadRequestException('申请退款金额必须大于 0');
    if (amount > remaining)
      throw new BadRequestException(
        `申请退款金额不得超过该支付单剩余可退金额 ${remaining} 分`,
      );
    // 实际退款额默认取判责建议；人工改额时同样必须给出原因（原因本来就必填）
    const suggested =
      amount === remaining
        ? assessment.suggestAmount
        : assessment.revalue(amount);
    const actualAmount = Math.trunc(input.actualAmount ?? suggested);
    if (actualAmount < 0) throw new BadRequestException('实际退款金额不合法');
    if (actualAmount > amount)
      throw new BadRequestException('实际退款金额不得超过申请退款金额');

    const timezone = (await this.bizConfig.booking()).timezone;
    const now = new Date();
    const inserted = await this.database.db.insert(bizRefunds).values({
      refundNo: temporaryToken(),
      // 退款门店跟随原支付单：钱收在哪家店，就退在哪家店
      storeId: payment.storeId,
      paymentId: payment.id,
      bookingId: booking?.id ?? null,
      customerId: payment.customerId,
      amount,
      actualAmount,
      deductAmount: amount - actualAmount,
      mode: input.mode,
      policyId: assessment.policy?.id ?? null,
      liable,
      reason,
      status: 'pending',
      applyBy: actorId,
      applyAt: now,
      remark: input.remark ?? null,
      createdBy: actorId,
      updatedBy: actorId,
    });
    const id = Number(inserted[0].insertId);
    const refundNo = buildDocNo('R', id, timezone, now);
    await this.database.db
      .update(bizRefunds)
      .set({ refundNo })
      .where(eq(bizRefunds.id, id));

    await this.insertLog(payment.id, 'refund', {
      action: 'apply',
      refundNo,
      paymentNo: payment.paymentNo,
      amount,
      actualAmount,
      deductAmount: amount - actualAmount,
      mode: input.mode,
      liable,
      policyId: assessment.policy?.id ?? null,
      reason,
      operator: actorId,
    });

    return this.requireRefund(id);
  }

  /* ------------------------------------------------------------------ *
   * 审批 / 执行 / 驳回
   * ------------------------------------------------------------------ */

  /**
   * `POST /biz/refunds/:id/approve`：审批通过并执行，**只能执行一次**。
   *
   * 两次条件更新：
   * 1. `pending|failed → approved`（抢占执行权）；
   * 2. `approved → success`（唯一落地闸门，影响行数 0 → 返回「已处理」，不报错）。
   *
   * 渠道退款是网络 IO，**不在事务内**；`cash` / `balance` 无网络 IO，落地走同一段事务。
   */
  async approve(id: number, actorId: number): Promise<RefundApproveResult> {
    let refund = await this.requireRefund(id);
    if (refund.status === 'success') return this.handled(refund);
    if (refund.status === 'rejected')
      throw new ConflictException('退款单已被驳回，不能执行');
    if (refund.actualAmount <= 0)
      throw new ConflictException('实际退款金额为 0，无需执行');

    const payment = await this.payments.requirePayment(refund.paymentId);

    // 闸门 1：抢占执行权（failed 允许重试，§7.4）
    const grabbed = await this.database.db
      .update(bizRefunds)
      .set({ status: 'approved', approveBy: actorId, approveAt: new Date() })
      .where(
        and(
          eq(bizRefunds.id, id),
          inArray(bizRefunds.status, ['pending', 'failed']),
        ),
      );
    refund = await this.requireRefund(id);
    if (refund.status === 'success') return this.handled(refund);
    if (refund.status === 'rejected')
      throw new ConflictException('退款单已被驳回，不能执行');
    if (!grabbed[0].affectedRows)
      throw new ConflictException('该退款单正在处理中，请稍后刷新列表');

    // 闸门 2：**先占额度，再打渠道**（理由见 reserveRefundAmount 注释）
    await this.reserveRefundAmount(refund, actorId);

    // 渠道退款：事务外网络 IO；商户退款单号 = refund_no，渠道侧天然幂等
    let channelRefundId: string | null = null;
    let channelRaw: unknown = null;
    if (refund.mode === 'original') {
      try {
        // `providerFor` 也放进 try：它抛错（渠道不支持/未配置）时同样要走
        // 「释放预留 + 标记失败」，否则额度会被白占
        const provider = this.providerFor(payment.channel);
        const result = await provider.refund({
          outTradeNo: payment.outTradeNo,
          outRefundNo: refund.refundNo,
          totalAmount: payment.amount,
          refundAmount: refund.actualAmount,
          reason: refund.reason,
        });
        if (result.status === 'failed') {
          await this.releaseRefundAmount(refund, actorId);
          await this.markFailed(refund.id, result.raw);
          throw new ConflictException('渠道退款失败，可重试或改为现金退');
        }
        channelRefundId = result.channelRefundId;
        channelRaw = result.raw;
      } catch (error) {
        if (error instanceof ConflictException) throw error;
        await this.releaseRefundAmount(refund, actorId);
        await this.markFailed(refund.id, { message: messageOf(error) });
        throw new ConflictException(`渠道退款失败：${messageOf(error)}`);
      }
    }

    try {
      const current = await this.database.db.transaction(async (tx) =>
        this.executeRefund(tx, refund, payment, {
          actorId,
          channelRefundId,
          channelRaw,
        }),
      );
      return {
        id: current.id,
        refundNo: current.refundNo,
        status: current.status,
        handled: false,
        actualAmount: current.actualAmount,
        channelRefundId: current.channelRefundId,
        message: null,
      };
    } catch (error) {
      if (error instanceof AlreadyHandledError) {
        const latest = await this.requireRefund(id);
        return this.handled(latest);
      }
      if (refund.mode !== 'original') {
        // 非原路退款没有渠道调用，落地失败就把刚占的额度退回去
        await this.releaseRefundAmount(refund, actorId);
      } else {
        // 原路退款：渠道的钱**已经出去了**，额度必须占着（释放会导致重试再退一次）。
        // 这种单子会停在 approved 等人工/对账跟进，日志里留下明确线索。
        this.logger.error(
          `退款单 ${refund.refundNo} 渠道已退款成功但本地落地失败，需人工核对（支付单 ${payment.paymentNo}）`,
        );
      }
      throw error;
    }
  }

  /** 落地：条件更新 + 支付单已退金额 + 预约重算 + 会员回减 + 提成冲销（同一事务） */
  private async executeRefund(
    tx: BizTx,
    refund: RefundRow,
    payment: PaymentRow,
    context: {
      actorId: number;
      channelRefundId: string | null;
      channelRaw: unknown;
    },
  ): Promise<RefundRow> {
    const affected = await tx
      .update(bizRefunds)
      .set({
        status: 'success',
        channelRefundId: context.channelRefundId,
        refundedAt: new Date(),
        updatedBy: context.actorId,
      })
      .where(
        and(eq(bizRefunds.id, refund.id), eq(bizRefunds.status, 'approved')),
      );
    if (!affected[0].affectedRows) throw new AlreadyHandledError();

    // 已退金额**已在闸门 2 预留**（`reserveRefundAmount`），这里不再累加：
    // 累加必须在打渠道之前完成，否则会出现「钱已退出、本地闸门失败」的窗口。

    const [after] = await tx
      .select({
        amount: bizPayments.amount,
        refundedAmount: bizPayments.refundedAmount,
      })
      .from(bizPayments)
      .where(eq(bizPayments.id, payment.id))
      .limit(1);
    const fullyRefunded = (after?.refundedAmount ?? 0) >= (after?.amount ?? 0);
    await tx
      .update(bizPayments)
      .set({ status: fullyRefunded ? 'refunded' : 'partial_refunded' })
      .where(eq(bizPayments.id, payment.id));

    await tx.insert(bizPaymentLogs).values({
      paymentId: payment.id,
      event: 'refund',
      raw: {
        action: 'success',
        refundNo: refund.refundNo,
        actualAmount: refund.actualAmount,
        mode: refund.mode,
        channelRefundId: context.channelRefundId,
        channel: context.channelRaw,
      },
    });

    if (refund.bookingId !== null) {
      await this.settlement.recalc(tx, refund.bookingId);
      await this.commission.reverseForBooking(
        tx,
        refund.bookingId,
        `退款 ${refund.refundNo}`,
        context.actorId,
      );
    }
    await this.members.reverseConsumption(tx, {
      customerId: refund.customerId,
      amount: refund.actualAmount,
      bookingId: refund.bookingId,
      remark: `退款单 ${refund.refundNo}`,
      actorId: context.actorId,
    });
    if (refund.mode === 'balance') {
      // 退入储值：只回补实付本金，赠送不退、不可提现（§15.4）
      await this.members.creditBalance(tx, {
        customerId: refund.customerId,
        principal: refund.actualAmount,
        bookingId: refund.bookingId,
        remark: `退款单 ${refund.refundNo} 退入储值`,
        actorId: context.actorId,
      });
    }
    return { ...refund, status: 'success' };
  }

  /** `POST /biz/refunds/:id/reject`：必填原因，仅待审批可驳回 */
  async reject(id: number, reason: string, actorId: number): Promise<void> {
    const trimmed = reason?.trim();
    if (!trimmed) throw new BadRequestException('驳回原因必填');
    const refund = await this.requireRefund(id);
    if (refund.status === 'rejected')
      throw new ConflictException('退款单已驳回');
    const affected = await this.database.db
      .update(bizRefunds)
      .set({
        status: 'rejected',
        rejectReason: trimmed.slice(0, 200),
        approveBy: actorId,
        approveAt: new Date(),
        updatedBy: actorId,
      })
      .where(and(eq(bizRefunds.id, id), eq(bizRefunds.status, 'pending')));
    if (!affected[0].affectedRows)
      throw new ConflictException('只有待审批的退款单可以驳回');
    await this.insertLog(refund.paymentId, 'refund', {
      action: 'reject',
      refundNo: refund.refundNo,
      reason: trimmed,
      operator: actorId,
    });
  }

  /* ------------------------------------------------------------------ *
   * 查询
   * ------------------------------------------------------------------ */

  async list(
    page: number,
    pageSize: number,
    filter: RefundListFilter,
  ): Promise<{ items: RefundRow[]; page: number; pageSize: number }> {
    const timezone = (await this.bizConfig.booking()).timezone;
    const conditions = [isNull(bizRefunds.deletedAt)];
    if (filter.status) conditions.push(eq(bizRefunds.status, filter.status));
    if (filter.mode) conditions.push(eq(bizRefunds.mode, filter.mode));
    if (filter.liable) conditions.push(eq(bizRefunds.liable, filter.liable));
    if (filter.paymentId)
      conditions.push(eq(bizRefunds.paymentId, filter.paymentId));
    if (filter.bookingId)
      conditions.push(eq(bizRefunds.bookingId, filter.bookingId));
    if (filter.customerId)
      conditions.push(eq(bizRefunds.customerId, filter.customerId));
    const range = localDateRange(
      bizRefunds.createdAt,
      filter.dateFrom,
      filter.dateTo,
      timezone,
    );
    if (range) conditions.push(range);
    const items = await this.database.db
      .select()
      .from(bizRefunds)
      .where(and(...conditions))
      .orderBy(desc(bizRefunds.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize);
    return { items, page, pageSize };
  }

  async findOne(id: number): Promise<RefundRow> {
    return this.requireRefund(id);
  }

  async requireRefund(id: number): Promise<RefundRow> {
    const [refund] = await this.database.db
      .select()
      .from(bizRefunds)
      .where(and(eq(bizRefunds.id, id), isNull(bizRefunds.deletedAt)))
      .limit(1);
    if (!refund) throw new NotFoundException('退款单不存在');
    return refund;
  }

  /* ------------------------------------------------------------------ *
   * 内部工具
   * ------------------------------------------------------------------ */

  /** 解析目标支付单：显式 `paymentId` 优先，否则取该预约「最近一笔仍可退」的支付单 */
  private async resolvePayment(input: RefundApplyInput): Promise<PaymentRow> {
    if (input.paymentId) {
      const payment = await this.payments.requirePayment(input.paymentId);
      if (payment.status !== 'success' && payment.status !== 'partial_refunded')
        throw new BadRequestException('只有支付成功的支付单可以退款');
      return payment;
    }
    if (!input.bookingId)
      throw new BadRequestException('paymentId 与 bookingId 至少填一个');
    const candidates = await this.database.db
      .select()
      .from(bizPayments)
      .where(
        and(
          eq(bizPayments.bookingId, input.bookingId),
          inArray(bizPayments.status, ['success', 'partial_refunded']),
          isNull(bizPayments.deletedAt),
        ),
      )
      .orderBy(desc(bizPayments.id));
    const payment = candidates.find(
      (row) => row.amount - row.refundedAmount > 0,
    );
    if (!payment) throw new ConflictException('该预约没有可退款的支付单');
    return payment;
  }

  private async requireBooking(
    id: number,
  ): Promise<typeof bizBookings.$inferSelect> {
    const [booking] = await this.database.db
      .select()
      .from(bizBookings)
      .where(and(eq(bizBookings.id, id), isNull(bizBookings.deletedAt)))
      .limit(1);
    if (!booking) throw new NotFoundException('预约不存在');
    return booking;
  }

  /** 预约毛实收与已退金额（只读派生，事实来源是支付单与退款单） */
  private async bookingMoney(
    bookingId: number,
  ): Promise<{ paidAmount: number; refundedAmount: number }> {
    const payments = await this.database.db
      .select({ receivedAmount: bizPayments.receivedAmount })
      .from(bizPayments)
      .where(
        and(
          eq(bizPayments.bookingId, bookingId),
          inArray(bizPayments.status, [
            'success',
            'partial_refunded',
            'refunded',
          ]),
        ),
      );
    const refunds = await this.database.db
      .select({ actualAmount: bizRefunds.actualAmount })
      .from(bizRefunds)
      .where(
        and(
          eq(bizRefunds.bookingId, bookingId),
          eq(bizRefunds.status, 'success'),
        ),
      );
    return {
      paidAmount: payments.reduce(
        (total, row) => total + row.receivedAmount,
        0,
      ),
      refundedAmount: refunds.reduce(
        (total, row) => total + row.actualAmount,
        0,
      ),
    };
  }

  /** 逐笔可退明细（退款单必须挂在具体支付单上，混合支付需按笔申请） */
  private async refundableBreakdown(bookingId: number): Promise<
    {
      paymentId: number;
      paymentNo: string;
      channel: string;
      amount: number;
      refundedAmount: number;
      refundableAmount: number;
    }[]
  > {
    const rows = await this.database.db
      .select({
        paymentId: bizPayments.id,
        paymentNo: bizPayments.paymentNo,
        channel: bizPayments.channel,
        amount: bizPayments.amount,
        refundedAmount: bizPayments.refundedAmount,
      })
      .from(bizPayments)
      .where(
        and(
          eq(bizPayments.bookingId, bookingId),
          inArray(bizPayments.status, [
            'success',
            'partial_refunded',
            'refunded',
          ]),
          isNull(bizPayments.deletedAt),
        ),
      )
      .orderBy(desc(bizPayments.id));
    return rows.map((row) => ({
      ...row,
      refundableAmount: Math.max(row.amount - row.refundedAmount, 0),
    }));
  }

  /**
   * 判责评估：命中规则 → 1000‰ − permille；`liable != customer` → 全退。
   *
   * 提前小时数取「取消时点 → 预约开始」的小时数（可负）；负值时按 0 小时匹配，
   * 以便「0 小时 / 不退」的档位能覆盖已过开始时间的场景。
   */
  private async assess(input: {
    startAt: Date | null;
    cancelAt: Date;
    liable: Liable;
    base: number;
    policyId: number | undefined;
  }): Promise<{
    policy: RefundPolicyRow | null;
    refundPermille: number;
    suggestAmount: number;
    revalue: (base: number) => number;
  }> {
    const policy =
      input.liable === 'customer' && input.startAt
        ? await this.matchPolicy(input.cancelAt, input.startAt, input.policyId)
        : null;
    const refundPermille =
      input.liable === 'customer' ? (policy?.refundPermille ?? 1000) : 1000;
    const revalue = (base: number): number => {
      if (base <= 0) return 0;
      const amount = Math.min(permilleOf(base, refundPermille), base);
      const floor = policy?.minAmount ?? 0;
      return Math.max(Math.min(Math.max(amount, floor), base), 0);
    };
    return {
      policy,
      refundPermille,
      suggestAmount: revalue(input.base),
      revalue,
    };
  }

  /** 取 `hours_before ≤ 实际提前小时数` 中最大的那条 */
  private async matchPolicy(
    cancelAt: Date,
    startAt: Date,
    policyId: number | undefined,
  ): Promise<RefundPolicyRow | null> {
    if (policyId) {
      const [pinned] = await this.database.db
        .select()
        .from(bizRefundPolicies)
        .where(
          and(
            eq(bizRefundPolicies.id, policyId),
            isNull(bizRefundPolicies.deletedAt),
          ),
        )
        .limit(1);
      return pinned ?? null;
    }
    const hours = Math.max(hoursBetween(startAt, cancelAt), 0);
    const [policy] = await this.database.db
      .select()
      .from(bizRefundPolicies)
      .where(
        and(
          eq(bizRefundPolicies.status, 'active'),
          isNull(bizRefundPolicies.deletedAt),
          lte(bizRefundPolicies.hoursBefore, Math.floor(hours)),
        ),
      )
      .orderBy(
        desc(bizRefundPolicies.hoursBefore),
        asc(bizRefundPolicies.sort),
        asc(bizRefundPolicies.id),
      )
      .limit(1);
    return policy ?? null;
  }

  private providerFor(channel: string) {
    if (channel === 'wxpay_native') {
      if (!this.wxpayNative.configured)
        throw new ConflictException('微信支付通道未启用');
      return this.wxpayNative;
    }
    if (channel === 'alipay_qr') {
      if (!this.alipayQr.configured)
        throw new ConflictException('支付宝通道未启用');
      return this.alipayQr;
    }
    throw new BadRequestException(`该支付单不支持原路退回：${channel}`);
  }

  /**
   * 闸门 2：**预留可退额度**（必须在调渠道**之前**）。
   *
   * 为什么不能只在落地时做条件更新：渠道退款是**已经发生的资金事实**。
   * 如果「已退金额不得超过支付单总额」的条件更新在渠道退款**成功之后**才失败，
   * 就会变成「钱已经退出去了、本地账上没记」—— 顾客收到了钱，我们却只在对账里
   * 才能发现，且 `biz_refund` 还停在中间态。
   *
   * 所以顺序改成：**先本地占额度 → 再调渠道 → 成功后落地；渠道失败则释放**。
   * 这样任何时刻「渠道已退的钱」都不会超过「本地已占的额度」。
   */
  private async reserveRefundAmount(
    refund: RefundRow,
    actorId: number,
  ): Promise<void> {
    const reserved = await this.database.db
      .update(bizPayments)
      .set({
        refundedAmount: sql`${bizPayments.refundedAmount} + ${refund.actualAmount}`,
        updatedBy: actorId,
      })
      .where(
        and(
          eq(bizPayments.id, refund.paymentId),
          sql`${bizPayments.refundedAmount} + ${refund.actualAmount} <= ${bizPayments.amount}`,
        ),
      );
    if (!reserved[0].affectedRows)
      throw new ConflictException('退款金额超出该支付单可退余额');
  }

  /**
   * 释放预留（渠道退款失败、或非原路退款落地失败时调用）。
   *
   * **原路退款在渠道成功之后不能释放** —— 钱已经出去了，把额度放回去会导致
   * 下一次重试再退一次。只有「确认没有资金流出」才释放。
   */
  private async releaseRefundAmount(
    refund: RefundRow,
    actorId: number,
  ): Promise<void> {
    await this.database.db
      .update(bizPayments)
      .set({
        refundedAmount: sql`${bizPayments.refundedAmount} - ${refund.actualAmount}`,
        updatedBy: actorId,
      })
      .where(
        and(
          eq(bizPayments.id, refund.paymentId),
          sql`${bizPayments.refundedAmount} >= ${refund.actualAmount}`,
        ),
      );
  }

  private async markFailed(id: number, raw: unknown): Promise<void> {
    await this.database.db
      .update(bizRefunds)
      .set({ status: 'failed' })
      .where(and(eq(bizRefunds.id, id), eq(bizRefunds.status, 'approved')));
    this.logger.warn(`退款单 ${id} 渠道退款失败：${JSON.stringify(raw)}`);
  }

  private handled(refund: RefundRow): RefundApproveResult {
    return {
      id: refund.id,
      refundNo: refund.refundNo,
      status: refund.status,
      handled: true,
      actualAmount: refund.actualAmount,
      channelRefundId: refund.channelRefundId,
      message: '该退款单已处理',
    };
  }

  private async insertLog(
    paymentId: number,
    event: 'refund',
    raw: unknown,
  ): Promise<void> {
    await this.database.db
      .insert(bizPaymentLogs)
      .values({ paymentId, event, raw });
  }
}

function temporaryToken(): string {
  return globalThis.crypto.randomUUID().replaceAll('-', '');
}

function parseInstant(value: string | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** 距预约开始的小时数（`startAt − cancelAt`，负值 = 已过开始时间） */
function hoursBetween(startAt: Date, cancelAt: Date): number {
  return (startAt.getTime() - cancelAt.getTime()) / 3_600_000;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
