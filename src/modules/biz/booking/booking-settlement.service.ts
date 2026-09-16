import { Injectable } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import {
  bizBookings,
  bizPayments,
  bizRefunds,
} from '../../../database/schema/index';
import {
  type PayStatus,
  type RecountResult,
  SettlementPort,
} from '../common/ports';
import type { BizTx } from '../common/tx';

/**
 * 已发生过退款的支付单也要计入 `paid_amount`。
 *
 * `paid_amount` 是**毛收入**（§15.7 不变量 4：净营收 = paid_amount − refund_amount），
 * 退款只体现在 `refund_amount` 上。若这里只认 `status='success'`，
 * 退款后（支付单被置为 `partial_refunded` / `refunded`）`paid_amount` 会被清零，
 * `due_amount` 变回全额、`pay_status` 退回 `unpaid`，列表与报表口径全错。
 */
const COUNTED_PAYMENT_STATUS = [
  'success',
  'partial_refunded',
  'refunded',
] as const;

/**
 * 预约资金字段的唯一重算入口（§15.7 不变量 4）。
 *
 * ```
 * paid_amount   = Σ 成功支付单的 received_amount（毛收入，不扣退款）
 * refund_amount = Σ 成功退款单的 actual_amount
 * due_amount    = max(payable_amount − paid_amount, 0)
 * 净营收        = paid_amount − refund_amount
 * ```
 *
 * **禁止任何接口自己写这几个字段**，否则列表、收银台、报表三处口径必然对不上。
 */
@Injectable()
export class BookingSettlementService extends SettlementPort {
  constructor() {
    super();
  }

  async recalc(tx: BizTx, bookingId: number): Promise<RecountResult> {
    const [booking] = await tx
      .select({
        id: bizBookings.id,
        payableAmount: bizBookings.payableAmount,
        creditAccountId: bizBookings.creditAccountId,
        settledAt: bizBookings.settledAt,
      })
      .from(bizBookings)
      .where(eq(bizBookings.id, bookingId))
      .limit(1);
    if (!booking) throw new Error(`预约不存在：${bookingId}`);

    const payments = await tx
      .select({
        channel: bizPayments.channel,
        receivedAmount: bizPayments.receivedAmount,
      })
      .from(bizPayments)
      .where(
        and(
          eq(bizPayments.bookingId, bookingId),
          inArray(bizPayments.status, COUNTED_PAYMENT_STATUS),
        ),
      );

    const refunds = await tx
      .select({ actualAmount: bizRefunds.actualAmount })
      .from(bizRefunds)
      .where(
        and(
          eq(bizRefunds.bookingId, bookingId),
          eq(bizRefunds.status, 'success'),
        ),
      );

    const paidAmount = payments.reduce(
      (total, row) => total + row.receivedAmount,
      0,
    );
    const refundAmount = refunds.reduce(
      (total, row) => total + row.actualAmount,
      0,
    );
    const dueAmount = Math.max(booking.payableAmount - paidAmount, 0);

    let payStatus: PayStatus;
    if (paidAmount > 0 && refundAmount >= paidAmount) {
      // 收的钱全退回去了（含部分退到等于已收）
      payStatus = 'refunded';
    } else if (paidAmount >= booking.payableAmount) {
      // 应付为 0（次卡核销）时 paid(0) >= 0 也落到 paid
      payStatus = 'paid';
    } else if (booking.creditAccountId !== null) {
      // 还有未收部分挂在挂账主体上（含「现金 + 挂账」混合支付）：
      // 收银台的挂账队列正是按这个状态筛的，必须优先于 partial
      payStatus = 'credit';
    } else if (paidAmount > 0) {
      payStatus = 'partial';
    } else {
      payStatus = 'unpaid';
    }

    const channelSummary = summarizeChannels(
      payments.map((row) => row.channel),
    );

    // 判定顺序要紧：全额退款后 `due_amount` 同样是 0，若先判 `due === 0`，
    // `refunded` 的清空分支永远走不到，退款的单子会被一直标成「已结算」。
    let settledAt: Date | null = booking.settledAt;
    if (payStatus === 'refunded' || paidAmount === 0) {
      settledAt = null;
    } else if (dueAmount === 0) {
      settledAt = booking.settledAt ?? new Date();
    }

    await tx
      .update(bizBookings)
      .set({
        paidAmount,
        refundAmount,
        dueAmount,
        payStatus,
        payChannelSummary: channelSummary,
        settledAt,
      })
      .where(eq(bizBookings.id, bookingId));

    return {
      paidAmount,
      dueAmount,
      refundAmount,
      payStatus,
      channelSummary,
      settledAt,
    };
  }
}

/** 渠道汇总：去重后按字母序拼接（如 `balance,cash`），只作列表展示用 */
function summarizeChannels(channels: string[]): string | null {
  const unique = [...new Set(channels)].sort();
  return unique.length ? unique.join(',') : null;
}
