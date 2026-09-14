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
  /** 等级名（**列表接口**联查返回；详情接口改用 `level.name`） */
  levelName?: string | null;
  /** 等级折扣率千分比（**列表接口**联查返回，1000 = 不打折） */
  levelDiscountPermille?: number;
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
  /** 等级对象（**详情接口**返回；列表接口给的是扁平的 levelName / levelDiscountPermille） */
  level?: {
    id: number;
    name: string;
    discountPermille: number;
    upgradeAmount: number;
  } | null;
  cards?: MemberCard[];
}

/** 账务流水（biz_member_transaction，**只追加、界面只读**） */
export interface MemberTransaction {
  id: number;
  customerId: number;
  /** 流水发生门店；历史/系统流水可能为空 */
  storeId: number | null;
  storeName: string | null;
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
export function listMembers(page = 1, pageSize = 20, query: MemberQuery = {}) {
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

/**
 * 充值收款方式（**与后端 `RechargeMemberRequest` 的 zod 枚举逐字一致**）
 * 注意：这**不等于**支付单的 `PaymentChannel`——后端充值只接受这 5 个值，
 * `wxpay_native` / `alipay_qr` 不在其中（传了会 400）。
 */
export type RechargeChannel =
  | 'cash'
  | 'wechat'
  | 'wechat_offline'
  | 'alipay'
  | 'alipay_offline';

/**
 * 充值：走充值方案或自定义实付金额（赠送比例超上限后端拒绝）
 *
 * 后端额外校验：会员必须有手机号；实付不得低于配置项
 * `biz.member.minRechargeAmount`（默认 10000 分 = 100 元）。
 * 首次充值会自动入会（建会员号 + 置最低启用等级）。
 */
export function rechargeMember(
  id: number,
  body: {
    planId?: number;
    /** 自定义实付金额（分），不传 planId 时必填 */
    payAmount?: number;
    payChannel: RechargeChannel;
    /** 备注（§15.4 要求必填；后端 schema 允许省略，前端强制填） */
    remark: string;
  },
) {
  return post<{
    transactionId: number;
    payAmount: number;
    bonusAmount: number;
    balancePrincipal: number;
    balanceBonus: number;
    memberNo: string | null;
  }>(`/biz/members/${id}/recharge`, body);
}

/**
 * 储值冲正 / 退款（`POST /biz/members/:id/refund`，权限 `biz:member:refund`）
 *
 * `mode` 的真实语义（对齐后端 `MemberAccountsService.refundMember`）：
 * - `cash`：只写一笔 `adjust` 冲正流水（`amount`），**不改动储值余额**（现金退给顾客）；
 * - `balance`：按 `biz.member.bonusDeductMode` 顺序**从储值余额扣减** `amount`，写负数 delta 流水；
 *   余额不足后端返回 409，不做部分扣减。
 *
 * 该接口**不生成退款单、不走审批**（与 §15.4「走退款单 + 审批」的写法不一致）；
 * 需要审批链路的退款请用 `/biz/refunds`。
 */
export function refundMember(
  id: number,
  body: {
    /** 冲正金额（分），必须大于 0 */
    amount: number;
    mode: 'cash' | 'balance';
    /** 原因（`biz.member.refundNeedReason=true` 时后端强制必填） */
    reason: string;
    /** 指向被冲正的原流水 id（可选） */
    reversalOf?: number | null;
  },
) {
  return post<{
    transactionId: number;
    mode: 'cash' | 'balance';
    amount: number;
  }>(`/biz/members/${id}/refund`, body);
}

/** 手工调级 / 调积分（权限 biz:member:adjust，**必须填原因**，写流水） */
export function adjustMember(
  id: number,
  body: {
    /** 目标等级 id；**不传 = 不调级**（传了就会写 level_change 流水）；null = 退会 */
    levelId?: number | null;
    /** 积分增减量（可正可负） */
    pointsDelta?: number;
    /** 本金余额增减量（分，可正可负，后端支持） */
    balancePrincipalDelta?: number;
    /** 赠送余额增减量（分，可正可负，后端支持） */
    balanceBonusDelta?: number;
    reason: string;
  },
) {
  return post<{ transactionId: number | null; levelChanged: boolean }>(
    `/biz/members/${id}/adjust`,
    body,
  );
}

/** 按流水重算余额 / 积分 / 累计消费 / 等级（对账修复，权限 biz:member:recount） */
export function recountMember(id: number, body: { reason?: string } = {}) {
  return post<{ ok: boolean }>(`/biz/members/${id}/recount`, body);
}

/**
 * 把已有顾客纳为会员（建会员号、置 member_since），权限 `biz:member:update`
 * 后端要求顾客必须已有手机号，否则 400。
 */
export function enrollMember(body: { customerId: number }) {
  return post<{
    memberNo: string;
    memberSince: string;
    levelId: number | null;
  }>('/biz/members', body);
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
  /** 项目名快照拼接（若后端直接返回拼接串） */
  itemNames?: string | null;
  /** 兼容别名（若后端返回 { id, name }[]） */
  serviceItems?: { id: number; name: string }[];
  /** 后端 `/biz/customers/:id/bookings` 实际返回的项目明细（biz_booking_item 投影） */
  items?: {
    bookingId?: number;
    serviceItemId: number;
    name: string;
    durationMinutes?: number;
    price?: number;
    sort?: number;
  }[];
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
