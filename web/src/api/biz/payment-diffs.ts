import type { PageResult } from '~/types/api';
import { get, patch, post } from '~/request';

/** 对账差异类型（§17.5，四类） */
export type PaymentDiffType =
  | 'missing_in_system'
  | 'missing_in_channel'
  | 'amount_mismatch'
  | 'status_mismatch';

/** 差异处理状态：**必须人工处理并填备注**，不允许静默忽略 */
export type PaymentDiffStatus = 'pending' | 'resolved' | 'ignored';

/** 对账渠道（只对在线渠道对账，§17.5） */
export type PaymentDiffChannel = 'wxpay_native' | 'alipay_qr';

/** 渠道对账差异（biz_payment_diff） */
export interface PaymentDiff {
  id: number;
  /** 对账日（渠道账单日期，YYYY-MM-DD） */
  billDate: string;
  channel: PaymentDiffChannel;
  /** 系统侧单号（渠道缺单时为空） */
  outTradeNo: string | null;
  /** 渠道侧单号（系统缺单时为空） */
  transactionId: string | null;
  /** 系统金额（分） */
  systemAmount: number;
  /** 渠道金额（分） */
  channelAmount: number;
  diffType: PaymentDiffType;
  status: PaymentDiffStatus;
  handleBy: number | null;
  handleByName?: string | null;
  handledAt: string | null;
  remark: string | null;
  createdAt: string;
}

export interface PaymentDiffQuery {
  billDate?: string;
  channel?: string;
  status?: string;
  diffType?: string;
}

/** 对账差异列表（分页） */
export function listPaymentDiffs(
  page = 1,
  pageSize = 20,
  query: PaymentDiffQuery = {},
) {
  return get<PageResult<PaymentDiff>>('/biz/payment-diffs', {
    page,
    pageSize,
    ...query,
  });
}

/**
 * 触发指定日期对账（权限 biz:payment:reconcile）
 * 下载渠道账单 + 逐笔比对；差异只落库不自动改账（§17.5）。
 */
export function reconcilePayments(body: {
  billDate: string;
  channel?: PaymentDiffChannel;
}) {
  return post<{ diffs: number }>('/biz/payment-diffs/reconcile', body);
}

/**
 * 标记差异已处理 / 忽略（权限 biz:payment:reconcile）
 * **remark 必填**（不允许静默忽略）。
 */
export function handlePaymentDiff(
  id: number,
  body: { status: 'resolved' | 'ignored'; remark: string },
) {
  return patch<void>(`/biz/payment-diffs/${id}`, body);
}
