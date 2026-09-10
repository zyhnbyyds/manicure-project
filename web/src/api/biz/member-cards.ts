import type { PageResult } from '~/types/api';
import { get, post } from '~/request';

/** 次卡状态（§4.4 biz_member_card.status） */
export type MemberCardStatus = 'active' | 'used_up' | 'expired' | 'refunded';

/** 购卡支付方式（biz_member_card.pay_channel；不允许再用次卡买卡） */
export type CardPayChannel = 'cash' | 'wechat' | 'alipay' | 'balance';

/** 会员卡实例 + 核销记录（biz_member_card / biz_member_card_log） */
export interface MemberCard {
  id: number;
  /** 卡号 C{yyyyMMdd}{id} */
  cardNo: string;
  customerId: number;
  /** 会员姓名（列表联查返回） */
  customerName?: string | null;
  customerPhone?: string | null;
  cardTypeId: number;
  /** 卡种名快照 */
  cardName: string;
  totalTimes: number;
  usedTimes: number;
  /** 剩余次数（后端计算，缺失时前端用 total - used） */
  remainTimes?: number;
  /** 购卡价快照（分） */
  price: number;
  payChannel: CardPayChannel;
  /** 购买时间（有效期起点） */
  purchasedAt: string;
  /** NULL = 永久 */
  expireAt: string | null;
  status: MemberCardStatus;
  remark: string | null;
  createdAt: string;
}

/** 次卡核销记录（只追加，type=revert 为撤销核销） */
export interface MemberCardLog {
  id: number;
  cardId: number;
  bookingId: number | null;
  bookingNo?: string | null;
  serviceItemId: number;
  serviceItemName?: string | null;
  type: 'use' | 'revert';
  times: number;
  operatorId: number | null;
  createdAt: string;
}

export interface MemberCardQuery {
  customerId?: string | number;
  status?: string;
  cardTypeId?: string | number;
}

/** 次卡列表（分页） */
export function listMemberCards(
  page = 1,
  pageSize = 20,
  query: MemberCardQuery = {},
) {
  return get<PageResult<MemberCard>>('/biz/member-cards', {
    page,
    pageSize,
    ...query,
  });
}

/** 次卡详情（含核销记录） */
export function getMemberCard(id: number) {
  return get<MemberCard & { logs: MemberCardLog[] }>(`/biz/member-cards/${id}`);
}

/** 发卡（权限 biz:card:issue；可改价） */
export function issueMemberCard(body: {
  customerId: number;
  cardTypeId: number;
  payChannel: CardPayChannel;
  /** 改价（分），不传取卡种售价 */
  price?: number;
  remark?: string;
}) {
  return post<{ id: number; cardNo: string; expireAt: string | null }>(
    '/biz/member-cards',
    body,
  );
}

/** 撤销一次核销（权限 biz:card:revoke，**必填原因**，回补次数） */
export function revertMemberCardUse(id: number, body: { reason: string }) {
  return post<void>(`/biz/member-cards/${id}/revert`, body);
}

/** 退卡（权限 biz:card:refund，按剩余次数人工填写退款金额，必填原因） */
export function refundMemberCard(
  id: number,
  body: { amount: number; reason: string },
) {
  return post<void>(`/biz/member-cards/${id}/refund`, body);
}
