import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNull, lte, sql } from 'drizzle-orm';
import { DatabaseService } from '../../../../database/database.service.js';
import {
  bizBookings,
  bizCustomers,
  bizPaymentLogs,
  bizPayments,
  bizRefundPolicies,
  bizRefunds,
  users,
} from '../../../../database/schema/index.js';
import type { RequestActor } from '../../../../common/data-scope/data-scope.js';
import {
  resolveStoreScope,
  storeConditions,
} from '../../../../common/data-scope/store-scope.js';
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
/**
 * 列表项 = 表行 + 联查出来的展示名。
 *
 * `biz_refund` 只存外键，列表直接返回表行会只剩 `#10` / `#9` 这种内部主键，
 * 店长看不懂是哪一单、哪位顾客，所以这里 leftJoin 出单号与姓名。
 */
export type RefundListItem = RefundRow & {
  bookingNo: string | null;
  customerName: string | null;
  applyByName: string | null;
  paymentNo: string | null;
};
export type RefundPolicyRow = typeof bizRefundPolicies.$inferSelect;
export type Liable = 'store' | 'customer' | 'force_majeure';
export type RefundMode = 'original' | 'cash' | 'balance';

/**
 * 退款阶段（判定基准是「实际退款时点 vs 预约开始时间」，不看预约状态）：
 *
 * - `before_start`：服务开始前 —— **无理由全额退**。有 `biz:refund:apply` 权限即可，
 *   不需要审批，金额锁定为支付单剩余可退全额（前端传值一律忽略）；
 * - `in_service`：服务开始后（含已完成）—— **是否退、退多少由店长手动决定**，
 *   金额必须手动填写，且需要 `biz:refund:approve` 权限。
 */
export type RefundStage = 'before_start' | 'in_service';

/** 阶段展示名：口径只写一份，后台与 app 域都取这里的值 */
export const REFUND_STAGE_LABELS: Record<RefundStage, string> = {
  before_start: '服务开始前',
  in_service: '服务中',
};

/**
 * 判定退款阶段。
 *
 * 没有预约开始时间（如独立收款的退款）时按「服务开始前」处理：
 * 没有服务时间就谈不上「服务中」，按最宽松的一侧兜底。
 */
export function resolveRefundStage(
  startAt: Date | null,
  at: Date,
): RefundStage {
  if (!startAt) return 'before_start';
  return at.getTime() < startAt.getTime() ? 'before_start' : 'in_service';
}

const ONLINE_CHANNELS: OnlineChannel[] = ['wxpay_native', 'alipay_qr'];

/** 服务中退款（店长手动退）所需的权限点 */
const APPROVE_PERMISSION = 'biz:refund:approve';

export type RefundPreviewInput = {
  bookingId: number;
  /** 判定时点（ISO8601，缺省取当前时间）；决定「服务开始前 / 服务中」 */
  cancelAt?: string | undefined;
  /** 仅影响规则参考值（`policySuggestAmount`），不再决定实际可退金额 */
  liable?: Liable | undefined;
};

export type RefundPreview = {
  bookingId: number;
  bookingNo: string;
  startAt: Date;
  cancelAt: Date;
  /** 实际提前小时数（可为负 = 已过预约开始时间），等价于端口里的 `hoursToStart` */
  hoursToStart: number;
  /** 退款阶段：服务开始前（无理由全额退）/ 服务中（店长手动退） */
  stage: RefundStage;
  /** 阶段展示名（服务开始前 / 服务中） */
  stageLabel: string;
  /** 试算采用的责任归属（新流程下只影响规则参考值） */
  liable: Liable;
  policyId: number | null;
  policyName: string | null;
  /** 命中的规则阈值（小时）；未命中为 null */
  hoursBefore: number | null;
  refundPermille: number;
  /** 借约毛实收（Σ成功支付单 received_amount） */
  paidAmount: number;
  refundedAmount: number;
  /** 剩余可退 = paidAmount − refundedAmount */
  refundableAmount: number;
  /** 建议退款额：服务开始前 = 剩余可退全额；服务中 = 0（由店长手动填） */
  suggestAmount: number;
  /** 金额是否锁定（服务开始前 = true，前端金额框应当只读） */
  lockedAmount: boolean;
  /** 规则**参考**金额：老规则会退多少，仅供店长比对，不参与任何账务 */
  policySuggestAmount: number;
  /** 规则参考扣减 = refundableAmount − policySuggestAmount */
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
  /** 退款金额（分）：服务开始前忽略（强制全额）；服务中为店长手动填写的金额 */
  amount?: number | undefined;
  /** 同 `amount`（保留字段：两条路径下申请额 = 实退额，不存在判责扣减） */
  actualAmount?: number | undefined;
  mode: RefundMode;
  reason: string;
  /** 责任归属：服务开始前固定 `store`；服务中由店长指定（默认 `store`） */
  liable?: Liable | undefined;
  /** @deprecated 规则不再决定金额，仅在试算里作为参考值展示 */
  policyId?: number | undefined;
  remark?: string | undefined;
};

/** 申请结果 = 退款单 + 是否已就地执行（新流程两条路径都是一步到位） */
export type RefundApplyResult = RefundRow & {
  /** true = 本次发起已经执行完（成功落地为 `success`） */
  executed: boolean;
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
  /** 门店筛选（连锁直营）：口径同支付单列表 */
  storeId?: number | undefined;
  status?: RefundRow['status'] | undefined;
  mode?: RefundMode | undefined;
  stage?: RefundStage | undefined;
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
 * 退款（按**服务阶段**分流，一步执行到位）。
 *
 * | 阶段               | 判定                      | 谁能退                        | 金额                          |
 * | ------------------ | ------------------------- | ----------------------------- | ----------------------------- |
 * | 服务开始前         | `now < booking.start_at`  | 持 `biz:refund:apply` 即可     | 无理由全额退，**锁定不可改**  |
 * | 服务中（含已完成） | `now >= booking.start_at` | 仅店长（`biz:refund:approve`） | 店长**手动填写**，≤ 剩余可退   |
 *
 * - `apply()` 建单后**立刻**执行，不再有「等审批」的中间态；`approve()` / `reject()` 保留，
 *   用于处理历史 `pending` 单与渠道失败（`failed`）的重试；
 * - 判责规则（`biz_refund_policy`）**降级为参考**：试算仍返回 `policySuggestAmount` 供店长比对，
 *   但不再决定实际退款金额（废弃「系统按提前小时数自动扣钱」的旧口径）；
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

  /**
   * `POST /biz/refunds/preview`：判定阶段 + 建议退款额（只读，不改账）。
   *
   * - 服务开始前 → `suggestAmount` = 剩余可退全额，`lockedAmount = true`；
   * - 服务中 → `suggestAmount = 0`、`lockedAmount = false`，金额由店长手动填。
   *
   * 老判责规则仍在 `policySuggestAmount` 里返回，**仅供店长参考**。
   */
  async preview(input: RefundPreviewInput): Promise<RefundPreview> {
    const booking = await this.requireBooking(input.bookingId);
    const cancelAt = parseInstant(input.cancelAt) ?? new Date();
    const liable = input.liable ?? 'customer';
    const money = await this.bookingMoney(booking.id);
    const remaining = Math.max(money.paidAmount - money.refundedAmount, 0);
    const payments = await this.refundableBreakdown(booking.id);
    const stage = resolveRefundStage(booking.startAt, cancelAt);
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
      stage,
      stageLabel: REFUND_STAGE_LABELS[stage],
      liable,
      policyId: assessment.policy?.id ?? null,
      policyName: assessment.policy?.name ?? null,
      hoursBefore: assessment.policy?.hoursBefore ?? null,
      refundPermille: assessment.refundPermille,
      paidAmount: money.paidAmount,
      refundedAmount: money.refundedAmount,
      refundableAmount: remaining,
      // 服务开始前＝无理由全额退；服务中不自动带出金额（店长手动填）
      suggestAmount: stage === 'before_start' ? remaining : 0,
      lockedAmount: stage === 'before_start',
      policySuggestAmount: assessment.suggestAmount,
      deductAmount: Math.max(remaining - assessment.suggestAmount, 0),
      payments,
    };
  }

  /* ------------------------------------------------------------------ *
   * 申请
   * ------------------------------------------------------------------ */

  /**
   * `POST /biz/refunds`：**一步到底**发起并执行退款。
   *
   * - 服务开始前：无理由全额退。金额锁定为支付单剩余可退全额（**忽略前端传值**，
   *   防止用旧参数绕过锁定），有 `biz:refund:apply` 权限即可，不需要审批；
   * - 服务中：只有持 `biz:refund:approve` 的店长能发起，金额必须手动填写，
   *   上限是该支付单剩余可退。
   *
   * 建单后直接调 `approve()`：执行链路（预留额度 → 打渠道 → 同事务落地）一行都没复制
   * —— 资金逻辑只能有一份（money-invariants 第 1 条）。
   *
   * `biz_refund.amount` = `actual_amount` = 实退额，`deduct_amount` 恒为 0（新流程无判责扣减）。
   */
  async apply(
    input: RefundApplyInput,
    actor: RequestActor,
  ): Promise<RefundApplyResult> {
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

    const now = new Date();
    const stage = resolveRefundStage(booking?.startAt ?? null, now);

    let amount: number;
    let liable: Liable;
    if (stage === 'before_start') {
      // 服务开始前：无理由全额退，金额由服务端锁定（不信任前端传值）
      amount = remaining;
      liable = 'store';
    } else {
      // 服务中：是否退、退多少由店长判断
      if (!this.hasPermission(actor, APPROVE_PERMISSION))
        throw new ForbiddenException(
          '预约已开始，退款需店长处理（权限 biz:refund:approve）',
        );
      const manual = input.actualAmount ?? input.amount;
      if (manual === undefined || manual === null)
        throw new BadRequestException('服务开始后退款必须手动填写退款金额');
      amount = Math.trunc(manual);
      if (amount <= 0) throw new BadRequestException('退款金额必须大于 0');
      if (amount > remaining)
        throw new BadRequestException(
          `退款金额不得超过该支付单剩余可退金额 ${remaining} 分`,
        );
      liable = input.liable ?? 'store';
    }
    const actualAmount = amount;

    const timezone = (await this.bizConfig.booking()).timezone;
    const inserted = await this.database.db.insert(bizRefunds).values({
      refundNo: temporaryToken(),
      // 退款门店跟随原支付单：钱收在哪家店，就退在哪家店
      storeId: payment.storeId,
      paymentId: payment.id,
      bookingId: booking?.id ?? null,
      customerId: payment.customerId,
      amount,
      actualAmount,
      deductAmount: 0,
      mode: input.mode,
      // 规则不再参与金额计算，落库一律不记规则 id（留 null 以示「非按规则退」）
      policyId: null,
      refundStage: stage,
      liable,
      reason,
      status: 'pending',
      applyBy: actor.id,
      applyAt: now,
      remark: input.remark ?? null,
      createdBy: actor.id,
      updatedBy: actor.id,
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
      mode: input.mode,
      liable,
      stage,
      reason,
      operator: actor.id,
    });

    // 一步执行：复用审批链路（含「先占额度、再打渠道」的资金安全顺序）
    await this.approve(id, actor.id);
    const latest = await this.requireRefund(id);
    return { ...latest, executed: latest.status === 'success' };
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
    /** 传操作人时按可见门店过滤（店长只看本店退款） */
    actor?: RequestActor,
  ): Promise<{ items: RefundListItem[]; page: number; pageSize: number }> {
    const timezone = (await this.bizConfig.booking()).timezone;
    const conditions = [isNull(bizRefunds.deletedAt)];
    if (actor) {
      const store = await resolveStoreScope(
        this.database.db,
        actor,
        filter.storeId ?? null,
      );
      conditions.push(
        ...storeConditions(bizRefunds.storeId, store, filter.storeId),
      );
    }
    if (filter.status) conditions.push(eq(bizRefunds.status, filter.status));
    if (filter.mode) conditions.push(eq(bizRefunds.mode, filter.mode));
    if (filter.stage) conditions.push(eq(bizRefunds.refundStage, filter.stage));
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
      .select({
        refund: bizRefunds,
        bookingNo: bizBookings.bookingNo,
        customerName: bizCustomers.name,
        applyByName: users.displayName,
        paymentNo: bizPayments.paymentNo,
      })
      .from(bizRefunds)
      .leftJoin(bizBookings, eq(bizBookings.id, bizRefunds.bookingId))
      .leftJoin(bizCustomers, eq(bizCustomers.id, bizRefunds.customerId))
      .leftJoin(users, eq(users.id, bizRefunds.applyBy))
      .leftJoin(bizPayments, eq(bizPayments.id, bizRefunds.paymentId))
      .where(and(...conditions))
      .orderBy(desc(bizRefunds.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize);
    return {
      items: items.map((row) => ({
        ...row.refund,
        bookingNo: row.bookingNo,
        customerName: row.customerName,
        applyByName: row.applyByName,
        paymentNo: row.paymentNo,
      })),
      page,
      pageSize,
    };
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

  /** 权限判断：支持超管通配 `*:*:*`（与 `AccessTokenGuard` 同一口径） */
  private hasPermission(actor: RequestActor, permission: string): boolean {
    return (
      actor.permissions.includes('*:*:*') ||
      actor.permissions.includes(permission)
    );
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
