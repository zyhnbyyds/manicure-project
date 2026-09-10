import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import {
  bizBookings,
  bizPayments,
  bizRefunds,
} from '../../../database/schema/index';
import {
  type PayStatus,
  type RecountResult,
  SettlementPort,
} from '../common/ports.js';
import type { BizTx } from '../common/tx.js';

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
          eq(bizPayments.status, 'success'),
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
    } else if (paidAmount > 0) {
      payStatus = 'partial';
    } else if (booking.creditAccountId !== null) {
      payStatus = 'credit';
    } else {
      payStatus = 'unpaid';
    }

    const channelSummary = summarizeChannels(
      payments.map((row) => row.channel),
    );

    let settledAt: Date | null = booking.settledAt;
    if (dueAmount === 0 && paidAmount > 0) {
      settledAt = booking.settledAt ?? new Date();
    } else if (payStatus === 'refunded' || paidAmount === 0) {
      settledAt = null;
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
