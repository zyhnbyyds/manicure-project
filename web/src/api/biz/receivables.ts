import type { PageResult } from '~/types/api';
import { get, post } from '~/request';

/** 应收单状态（`biz_receivable.status`） */
export type ReceivableStatus =
  | 'open'
  | 'partial'
  | 'settled'
  | 'overdue'
  | 'cancelled';

/** 销账可用渠道（`biz_receivable_payment.pay_channel`，不含 credit） */
export type ReceivablePayChannel =
  | 'cash'
  | 'wechat_offline'
  | 'alipay_offline'
  | 'balance'
  | 'wxpay_native'
  | 'alipay_qr';

/** 在线渠道（销账时后端返回二维码 codeUrl） */
export const ONLINE_PAY_CHANNELS: ReceivablePayChannel[] = [
  'wxpay_native',
  'alipay_qr',
];

/** 应收单（`biz_receivable`），金额单位「分」 */
export interface Receivable {
  id: number;
  receivableNo: string;
  creditAccountId: number;
  /** 主体名称（列表关联查询返回，可选） */
  creditAccountName?: string | null;
  bookingId: number | null;
  bookingNo?: string | null;
  customerId: number | null;
  customerName?: string | null;
  /** 应收金额（分） */
  amount: number;
  /** 已销账金额（分） */
  settledAmount: number;
  /** 到期日 YYYY-MM-DD；账期不定期时为 null */
  dueDate: string | null;
  status: ReceivableStatus;
  settledAt: string | null;
  remark: string | null;
  createdAt: string;
}

/** 销账记录（只追加） */
export interface ReceivablePayment {
  id: number;
  receivableId: number;
  /** 分 */
  amount: number;
  payChannel: ReceivablePayChannel;
  paymentId: number | null;
  paidAt: string;
  remark: string | null;
  createdAt: string;
}

export interface ReceivableDetail extends Receivable {
  payments: ReceivablePayment[];
}

/** 账龄汇总行（`GET /biz/receivables/summary`，按主体聚合） */
export interface ReceivableSummaryRow {
  creditAccountId: number;
  creditAccountName: string;
  type: 'customer' | 'company' | 'staff';
  /** 额度（分），0 = 不限 */
  creditLimit: number;
  /** 已挂未结（分） */
  usedAmount: number;
  /** 应收余额合计（分） */
  unsettledAmount: number;
  /** 逾期金额（分） */
  overdueAmount: number;
  /** 账龄 0-30 天（分） */
  age0to30: number;
  /** 账龄 31-60 天（分） */
  age31to60: number;
  /** 账龄 60 天以上（分） */
  age60plus: number;
  /** 未结单数 */
  count: number;
}

/** 列表查询（用 type 而非 interface：对象字面量类型才能满足 request 的 Record 约束） */
export type ReceivableListQuery = {
  creditAccountId?: number | string;
  status?: ReceivableStatus | '';
  dueDateFrom?: string;
  dueDateTo?: string;
  /** 只看逾期 */
  overdue?: boolean | string;
  page?: number;
  pageSize?: number;
};

/** 销账单笔入参 */
export interface SettlePaymentInput {
  channel: ReceivablePayChannel;
  /** 分 */
  amount: number;
  /** 储值 / 次卡支付时的会员卡 id */
  memberCardId?: number | null;
  remark?: string | null;
}

/** 销账请求体 */
export interface SettleReceivableBody {
  payments: SettlePaymentInput[];
  remark?: string;
}

/** 销账结果：在线渠道附带二维码 */
export interface SettleReceivableResult {
  /** 已销账总额（分） */
  settledAmount: number;
  status: ReceivableStatus;
  /** 在线渠道二维码内容（web 端无内置二维码库，见页面 TODO） */
  codeUrl?: string | null;
  expireAt?: string | null;
  paymentId?: number | null;
}

/** 应收台账列表（分页） */
export function listReceivables(params: ReceivableListQuery = {}) {
  return get<PageResult<Receivable>>('/biz/receivables', params);
}

/** 应收单详情（含销账记录） */
export function getReceivable(id: number) {
  return get<ReceivableDetail>(`/biz/receivables/${id}`);
}

/** 按主体聚合的账龄汇总 */
export function getReceivableSummary() {
  return get<ReceivableSummaryRow[]>('/biz/receivables/summary');
}

/** 销账（多笔混合；在线渠道返回二维码） */
export function settleReceivable(id: number, body: SettleReceivableBody) {
  return post<SettleReceivableResult>(`/biz/receivables/${id}/settle`, body);
}

/** 作废（仅未销账时，必填原因） */
export function cancelReceivable(id: number, reason: string) {
  return post<void>(`/biz/receivables/${id}/cancel`, { reason });
}
