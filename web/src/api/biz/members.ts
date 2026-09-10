import type { PageResult } from '~/types/api';
import { get, post } from '~/request';
import type { MemberCard } from './member-cards';

/**
 * 会员（= 顾客 + 会员字段，§15.1「顾客即会员」，不引入第二个 id）
 * 字段口径见 §4.3 `biz_customer`。
 */
export interface Member {
  id: number;
  name: string;
  phone: string | null;
  gender: 'unknown' | 'male' | 'female';
  birthday: string | null;
  remark: string | null;
  visitCount: number;
  lastVisitAt: string | null;
  /** NULL = 非会员（散客） */
  levelId: number | null;
  /** 等级名（列表联查返回） */
  levelName?: string | null;
  /** 等级折扣率千分比（联查返回，1000 = 不打折） */
  discountPermille?: number | null;
  memberNo: string | null;
  memberSince: string | null;
  /** 累计实付消费（分），决定等级 */
  totalSpent: number;
  points: number;
  pointsTotal: number;
  /** 储值**本金**余额（分，可退） */
  balancePrincipal: number;
  /** 储值**赠送**余额（分，不可退） */
  balanceBonus: number;
  createdAt: string;
  updatedAt?: string;
}

/** 会员详情：档案 + 等级 + 余额 + 积分 + 次卡 */
export interface MemberDetail extends Member {
  cards?: MemberCard[];
}

/** 账务流水（biz_member_transaction，**只追加、界面只读**） */
export interface MemberTransaction {
  id: number;
  customerId: number;
  type:
    | 'recharge'
    | 'consume'
    | 'refund'
    | 'card_buy'
    | 'card_use'
    | 'card_revert'
    | 'points_earn'
    | 'points_spend'
    | 'points_redeem'
    | 'level_change'
    | 'adjust';
  /** 业务金额（分）：消费为正、退款为负、充值 = 实付 + 赠送 */
  amount: number;
  balanceDeltaPrincipal: number;
  balanceDeltaBonus: number;
  balancePrincipalAfter: number;
  balanceBonusAfter: number;
  pointsDelta: number;
  pointsAfter: number;
  payChannel: 'cash' | 'wechat' | 'alipay' | 'balance' | 'card' | null;
  bookingId: number | null;
  cardId: number | null;
  planId: number | null;
  /** 指向被冲正的原流水 */
  reversalOf: number | null;
  remark: string | null;
  createdAt: string;
}

export interface MemberQuery {
  /** 姓名 / 手机号 / 会员号 */
  keyword?: string;
  levelId?: string | number;
  /** true = 只看有储值余额的会员 */
  hasBalance?: string | boolean;
}

export interface MemberTransactionQuery {
  type?: string;
}

/** 会员列表（分页）：keyword / levelId / hasBalance */
export function listMembers(
  page = 1,
  pageSize = 20,
  query: MemberQuery = {},
) {
  return get<PageResult<Member>>('/biz/members', {
    page,
    pageSize,
    ...query,
  });
}

/** 会员详情（档案 + 等级 + 余额 + 积分 + 次卡） */
export function getMember(id: number) {
  return get<MemberDetail>(`/biz/members/${id}`);
}

/** 账务流水（分页，**只读**） */
export function listMemberTransactions(
  id: number,
  page = 1,
  pageSize = 20,
  query: MemberTransactionQuery = {},
) {
  return get<PageResult<MemberTransaction>>(`/biz/members/${id}/transactions`, {
    page,
    pageSize,
    ...query,
  });
}

/** 充值收款方式（走 biz_payment(purpose=recharge)，§15.4） */
export type RechargeChannel =
  | 'cash'
  | 'wechat_offline'
  | 'alipay_offline'
  | 'wxpay_native'
  | 'alipay_qr';

/** 充值：走充值方案或自定义实付金额（赠送比例超上限后端拒绝） */
export function rechargeMember(
  id: number,
  body: {
    planId?: number;
    /** 自定义实付金额（分），不传 planId 时必填 */
    payAmount?: number;
    payChannel: RechargeChannel;
    /** 必填备注（§15.4） */
    remark: string;
  },
) {
  return post<{
    transactionId: number;
    principal: number;
    bonus: number;
    balancePrincipal: number;
    balanceBonus: number;
  }>(`/biz/members/${id}/recharge`, body);
}

/** 储值冲正退款：只退**实付本金**，赠送部分不可退（§15.4） */
export function refundMember(
  id: number,
  body: {
    /** 退款金额（分），不得超过本金余额 */
    amount: number;
    mode: 'cash' | 'balance';
    /** 必填原因 */
    reason: string;
  },
) {
  return post<{ transactionId: number; refundId?: number }>(
    `/biz/members/${id}/refund`,
    body,
  );
}

/** 手工调级 / 调积分（权限 biz:member:adjust，**必须填原因**，写流水） */
export function adjustMember(
  id: number,
  body: {
    /** 目标等级 id；null = 退会（置空） */
    levelId?: number | null;
    /** 积分增减量（可正可负） */
    pointsDelta?: number;
    reason: string;
  },
) {
  return post<{ transactionId: number }>(`/biz/members/${id}/adjust`, body);
}

/** 按流水重算余额 / 积分 / 累计消费 / 等级（对账修复，权限 biz:member:recount） */
export function recountMember(id: number, body: { reason?: string } = {}) {
  return post<{
    balancePrincipal: number;
    balanceBonus: number;
    points: number;
    totalSpent: number;
    levelId: number | null;
  }>(`/biz/members/${id}/recount`, body);
}

/** 把已有顾客纳为会员（建会员号、置 member_since），权限 biz:member:update */
export function enrollMember(body: { customerId: number }) {
  return post<{ id: number; memberNo: string; memberSince: string }>(
    '/biz/members',
    body,
  );
}

/**
 * 顾客历史预约（会员详情「预约历史」Tab 用）
 * 归属 `/biz/customers/:id/bookings`（基础数据模块实现），这里只做会员视角的薄封装。
 */
export interface CustomerBookingBrief {
  id: number;
  bookingNo: string;
  startAt: string;
  endAt: string;
  durationMinutes?: number;
  status:
    | 'pending'
    | 'confirmed'
    | 'arrived'
    | 'completed'
    | 'cancelled'
    | 'no_show';
  staffId?: number;
  staffName?: string | null;
  /** 项目名快照拼接（后端联查返回） */
  itemNames?: string | null;
  serviceItems?: { id: number; name: string }[];
  originalPrice: number;
  levelDiscountAmount?: number;
  pointsDiscountAmount?: number;
  payableAmount: number;
  paidAmount: number;
  dueAmount: number;
  payStatus: 'unpaid' | 'partial' | 'paid' | 'refunded' | 'credit';
  createdAt?: string;
}

/** 顾客历史预约（分页） */
export function listCustomerBookings(
  customerId: number,
  page = 1,
  pageSize = 10,
) {
  return get<PageResult<CustomerBookingBrief>>(
    `/biz/customers/${customerId}/bookings`,
    { page, pageSize },
  );
}
