import type { PageResult } from '~/types/api';
import { get, post } from '~/request';

/** 支付通道（§17.1） */
export type PaymentChannel =
  | 'wxpay_native'
  | 'alipay_qr'
  | 'cash'
  | 'wechat_offline'
  | 'alipay_offline'
  | 'balance'
  | 'card'
  | 'credit';

/** 在线扫码渠道（需要生成 code_url + 轮询 + 5 分钟失效） */
export const ONLINE_CHANNELS: PaymentChannel[] = ['wxpay_native', 'alipay_qr'];

/** 这笔钱在干什么（§4.5） */
export type PaymentPurpose =
  | 'deposit'
  | 'final'
  | 'recharge'
  | 'card_buy'
  | 'credit_settle';

/** 支付单状态（§7.4） */
export type PaymentStatus =
  | 'pending'
  | 'success'
  | 'failed'
  | 'closed'
  | 'refunded'
  | 'partial_refunded';

/** 支付单（biz_payment） */
export interface Payment {
  id: number;
  /** P{yyyyMMdd}{id} */
  paymentNo: string;
  /** 提交给渠道的商户订单号（回调按它匹配） */
  outTradeNo: string;
  bookingId: number | null;
  bookingNo?: string | null;
  customerId: number;
  customerName?: string | null;
  purpose: PaymentPurpose;
  channel: PaymentChannel;
  /** 应收金额（分） */
  amount: number;
  /** 实收金额（分，现金找零后可能小于 amount） */
  receivedAmount: number;
  status: PaymentStatus;
  /** Native 二维码内容 */
  codeUrl: string | null;
  transactionId: string | null;
  paidAt: string | null;
  expireAt: string | null;
  refundedAmount: number;
  callbackAt: string | null;
  remark: string | null;
  createdAt: string;
}

/** 支付过程日志（只追加，渠道轨迹） */
export interface PaymentLog {
  id: number;
  paymentId: number;
  event:
    | 'create'
    | 'callback'
    | 'query'
    | 'close'
    | 'refund'
    | 'callback_invalid';
  httpStatus: number | null;
  raw: unknown;
  createdAt: string;
}

export interface PaymentDetail extends Payment {
  logs: PaymentLog[];
}

export interface PaymentQuery {
  channel?: string;
  status?: string;
  purpose?: string;
  dateFrom?: string;
  dateTo?: string;
  bookingNo?: string;
  customerId?: string | number;
}

/** 新建支付单入参（§2.3 PaymentDraft） */
export interface PaymentDraftBody {
  customerId: number;
  bookingId?: number | null;
  purpose: PaymentPurpose;
  channel: PaymentChannel;
  amount: number;
  receivedAmount?: number;
  memberCardId?: number | null;
  remark?: string | null;
}

/** 支付单落库结果（§2.3 PaymentOutcome） */
export interface PaymentOutcome {
  paymentId: number;
  paymentNo: string;
  outTradeNo: string;
  status: 'pending' | 'success';
  channel: PaymentChannel;
  amount: number;
  receivedAmount: number;
  codeUrl?: string | null;
  expireAt?: string | null;
}

/** 支付单列表（分页） */
export function listPayments(
  page = 1,
  pageSize = 20,
  query: PaymentQuery = {},
) {
  return get<PageResult<Payment>>('/biz/payments', {
    page,
    pageSize,
    ...query,
  });
}

/** 支付单详情（含 payment_log 渠道轨迹） */
export function getPayment(id: number) {
  return get<PaymentDetail>(`/biz/payments/${id}`);
}

/** 发起收款（现金 / 线下扫码直接 success；在线渠道返回 codeUrl） */
export function createPayment(body: PaymentDraftBody) {
  return post<PaymentOutcome>('/biz/payments', body);
}

/** 收银台轮询支付状态（轻量接口） */
export function getPaymentStatus(id: number) {
  return get<{ id: number; status: PaymentStatus; paidAt: string | null }>(
    `/biz/payments/${id}/status`,
  );
}

/** 主动向渠道查单（回调丢失时兜底，权限 biz:payment:create） */
export function queryPayment(id: number) {
  return post<{ status: PaymentStatus }>(`/biz/payments/${id}/query`);
}

/** 关单（仅 pending，权限 biz:payment:close） */
export function closePayment(id: number, body: { reason?: string } = {}) {
  return post<void>(`/biz/payments/${id}/close`, body);
}

// ============================================================
// 收银台（§10.5 / §17.2）所需的预约侧接口
// 归属 `/biz/bookings`，由预约模块实现；这里只做收银视角的薄封装。
// ============================================================

/** 预约项目明细快照（biz_booking_item） */
export interface CashierBookingItem {
  id: number;
  serviceItemId: number;
  name: string;
  durationMinutes: number;
  /** 快照价（分） */
  price: number;
  sort?: number;
}

/** 待收款队列条目 / 单据金额明细（biz_booking） */
export interface CashierBooking {
  id: number;
  bookingNo: string;
  customerId: number;
  customerName: string;
  customerPhone: string | null;
  staffId: number;
  staffName?: string | null;
  startAt: string;
  endAt: string;
  durationMinutes: number;
  /** 原价快照（分） */
  originalPrice: number;
  /** 等级折扣率快照（千分比，1000 = 无折扣） */
  levelDiscountPermille: number;
  /** 等级优惠金额（分） */
  levelDiscountAmount: number;
  /** 积分抵扣金额（分） */
  pointsDiscountAmount: number;
  /** 手动改价差额（分，可正可负） */
  adjustAmount: number;
  adjustReason?: string | null;
  /** 应付金额（分） */
  payableAmount: number;
  /** 下单应收金额（分） */
  depositAmount: number;
  /** 已收金额（分） */
  paidAmount: number;
  /** 尾款 = payable − paid（分） */
  dueAmount: number;
  payStatus: 'unpaid' | 'partial' | 'paid' | 'refunded' | 'credit';
  payChannelSummary: string | null;
  settledAt: string | null;
  creditAccountId: number | null;
  memberCardId: number | null;
  refundAmount: number;
  status:
    | 'pending'
    | 'confirmed'
    | 'arrived'
    | 'completed'
    | 'cancelled'
    | 'no_show';
  remark: string | null;
  items: CashierBookingItem[];
}

export interface CashierBookingQuery {
  /** 待收款队列筛选：unpaid / partial / credit */
  payStatus?: string;
  status?: string;
  date?: string;
  keyword?: string;
  customerId?: string | number;
}

/** 结算/补收入参（POST /biz/bookings/:id/settle，§17.2） */
export interface SettleBookingBody {
  payments: {
    channel: PaymentChannel;
    /** 应收金额（分） */
    amount: number;
    /** 实收金额（分，默认 = amount；现金找零时可改） */
    receivedAmount?: number;
    /** channel=card 时必填：核销的次卡 */
    memberCardId?: number;
  }[];
  /** 使用积分数（服务端复算上限） */
  pointsUsed?: number;
  /** channel=credit 时必填：挂账主体 */
  creditAccountId?: number;
  remark?: string;
}

/** 结算结果：预约资金快照 + 本次各笔支付结果（后端 = `{ ...recalc(), payableAmount, payments }`） */
export interface SettleBookingResult {
  id?: number;
  bookingNo?: string;
  paidAmount: number;
  dueAmount: number;
  payableAmount?: number;
  refundAmount?: number;
  payStatus: 'unpaid' | 'partial' | 'paid' | 'refunded' | 'credit';
  /** 已收渠道汇总（如 `cash,balance`）。后端字段名是 `channelSummary`，不是 `payChannelSummary` */
  channelSummary?: string | null;
  settledAt?: string | null;
  payments?: PaymentOutcome[];
}

/** 待收款队列（按 payStatus 分组拉取） */
export function listCashierBookings(
  page = 1,
  pageSize = 20,
  query: CashierBookingQuery = {},
) {
  return get<PageResult<CashierBooking>>('/biz/bookings', {
    page,
    pageSize,
    ...query,
  });
}

/** 单据详情（含项目明细，用于中栏金额明细） */
export function getCashierBooking(id: number) {
  return get<CashierBooking>(`/biz/bookings/${id}`);
}

/** 结算尾款 / 挂账 / 补收（混合支付，权限 biz:payment:create） */
export function settleBooking(id: number, body: SettleBookingBody) {
  return post<SettleBookingResult>(`/biz/bookings/${id}/settle`, body);
}

/** 挂账主体（收银台 channel=credit 时选择，§18.1） */
export interface CreditAccountOption {
  id: number;
  name: string;
  type: 'customer' | 'company' | 'staff';
  /** 挂账额度（分，0 = 不限） */
  creditLimit: number;
  /** 已挂未结金额（分） */
  usedAmount: number;
  status: 'active' | 'disabled';
}

/** 挂账主体列表（收银台下拉用；页面由挂账模块负责） */
export async function listCreditAccountOptions() {
  const data = await get<PageResult<CreditAccountOption>>(
    '/biz/credit-accounts',
    {
      page: 1,
      pageSize: 100,
      status: 'active',
    },
  );
  return data.items;
}
