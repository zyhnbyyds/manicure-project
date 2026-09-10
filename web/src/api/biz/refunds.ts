import type { PageResult } from '~/types/api';
import { get, post } from '~/request';

/** 退款去向（§17.4）：原路退回 / 现金退 / 退入储值余额 */
export type RefundMode = 'original' | 'cash' | 'balance';

/** 责任归属：店家 / 顾客 / 不可抗力 */
export type RefundLiable = 'store' | 'customer' | 'force_majeure';

/** 退款单状态（§7.4）：pending → approved → success / rejected / failed */
export type RefundStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'success'
  | 'failed';

/** 退款单（biz_refund） */
export interface Refund {
  id: number;
  /** R{yyyyMMdd}{id} */
  refundNo: string;
  paymentId: number;
  paymentNo?: string | null;
  bookingId: number | null;
  bookingNo?: string | null;
  customerId: number;
  customerName?: string | null;
  /** 申请退款金额（分） */
  amount: number;
  /** 实际退款金额（分，判责扣减后） */
  actualAmount: number;
  /** 判责扣减金额（分）= amount − actualAmount */
  deductAmount: number;
  mode: RefundMode;
  policyId: number | null;
  /** 命中的判责规则名 */
  policyName?: string | null;
  liable: RefundLiable;
  /** 退款原因（必填） */
  reason: string;
  status: RefundStatus;
  applyBy: number;
  applyByName?: string | null;
  applyAt: string;
  approveBy: number | null;
  approveByName?: string | null;
  approveAt: string | null;
  rejectReason: string | null;
  channelRefundId: string | null;
  refundedAt: string | null;
  remark: string | null;
  createdAt: string;
}

/**
 * 判责试算结果（POST /biz/refunds/preview）
 * 展示判责依据：命中规则名 / 规则阈值 / 实际提前小时数 / 可退比例 / 建议退款额 / 扣减额。
 * 规则只给**建议**，最终金额由店员确认并必填原因（§17.4）。
 */
export interface RefundPreview {
  bookingId: number;
  bookingNo: string;
  /** 预约开始时间（UTC ISO） */
  startAt: string;
  /** 试算所用的取消时间（默认当前时间） */
  cancelAt: string;
  /** 距离预约开始的**实际**小时数（可为负 = 已过开始时间）。后端字段名是 `hoursToStart` */
  hoursToStart: number;
  /** 兼容别名（历史文档写作 hoursUntilStart，后端不返回该字段） */
  hoursUntilStart?: number | null;
  /** 本次试算采用的责任归属 */
  liable: RefundLiable;
  /** 命中的判责规则 id（都不命中 = null） */
  policyId: number | null;
  /** 命中规则名，如「提前 24 小时以上」 */
  policyName: string | null;
  /** 规则阈值：提前小时数（未命中为 null） */
  hoursBefore: number | null;
  /** 可退比例（千分比，1000 = 全退，0 = 不退） */
  refundPermille: number;
  /** 预约毛实收（分）= Σ 成功支付单 received_amount */
  paidAmount: number;
  /** 已退金额（分） */
  refundedAmount: number;
  /** 剩余可退（分）= paidAmount − refundedAmount */
  refundableAmount: number;
  /** 建议退款额（分） */
  suggestAmount: number;
  /** 判责扣减额（分） */
  deductAmount: number;
  /**
   * 逐笔可退明细。退款单**必须挂在具体支付单上**，
   * 所以混合支付的预约要按支付单分别申请 / 审批。
   */
  payments?: {
    paymentId: number;
    paymentNo: string;
    channel: string;
    amount: number;
    refundedAmount: number;
    refundableAmount: number;
  }[];
}

export interface RefundQuery {
  status?: string;
  mode?: string;
  liable?: string;
  dateFrom?: string;
  dateTo?: string;
  customerId?: string | number;
}

/** 退款单列表（分页） */
export function listRefunds(page = 1, pageSize = 20, query: RefundQuery = {}) {
  return get<PageResult<Refund>>('/biz/refunds', {
    page,
    pageSize,
    ...query,
  });
}

/** 判责试算（权限 biz:refund:apply） */
export function previewRefund(body: { bookingId: number; cancelAt?: string }) {
  return post<RefundPreview>('/biz/refunds/preview', body);
}

/** 发起退款（权限 biz:refund:apply）：生成**待审批**退款单；改金额必须填原因 */
export function createRefund(body: {
  bookingId?: number;
  paymentId?: number;
  /** 覆盖建议金额（分） */
  amount?: number;
  mode: RefundMode;
  /** 必填原因 */
  reason: string;
  liable?: RefundLiable;
}) {
  return post<{ id: number; refundNo: string; status: RefundStatus }>(
    '/biz/refunds',
    body,
  );
}

/** 审批通过并执行（权限 biz:refund:approve，只给店长） */
export function approveRefund(id: number, body: { remark?: string } = {}) {
  return post<{ id: number; status: RefundStatus; actualAmount?: number }>(
    `/biz/refunds/${id}/approve`,
    body,
  );
}

/** 驳回（权限 biz:refund:approve，**必填原因**） */
export function rejectRefund(id: number, body: { reason: string }) {
  return post<void>(`/biz/refunds/${id}/reject`, body);
}
