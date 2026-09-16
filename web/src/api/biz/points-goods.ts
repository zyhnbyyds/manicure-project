import type { PageResult } from '~/types/api';
import { del, get, patch, post } from '~/request';

/** 积分兑换品（biz_points_goods，直接指向卡种，§4.6 / §15.3） */
export interface PointsGoods {
  id: number;
  name: string;
  /** 兑换即发一张该卡种的次卡 */
  cardTypeId: number;
  cardTypeName?: string | null;
  /** 所需积分 */
  points: number;
  /** 库存，**-1 = 不限** */
  stock: number;
  /** 每人限兑次数，**0 = 不限** */
  perLimit: number;
  status: 'active' | 'disabled';
  sort: number;
  remark: string | null;
  createdAt: string;
}

export interface PointsGoodsBody {
  name?: string;
  cardTypeId?: number;
  points?: number;
  stock?: number;
  perLimit?: number;
  status?: 'active' | 'disabled';
  sort?: number;
  remark?: string | null;
}

/**
 * 积分兑换记录（biz_points_redeem）
 * `GET /biz/points-redeems` 会联查返回 `customerName` / `customerPhone` / `goodsName`，
 * **但不返回卡号**（只有 `memberCardId`）。
 */
export interface PointsRedeem {
  id: number;
  redeemNo: string;
  customerId: number;
  customerName?: string | null;
  customerPhone?: string | null;
  goodsId: number;
  goodsName?: string | null;
  points: number;
  memberCardId: number | null;
  status: 'success' | 'reverted';
  remark: string | null;
  createdBy?: number | null;
  createdAt: string;
}

/**
 * 积分抵扣试算结果（POST /biz/points/preview，金额单位「分」）
 * 字段与后端 `PointsGoodsService.preview()` 的返回一一对应。
 * `serviceItemIds` 必须是 **1~3 个**（后端 zod 上限 3）。
 */
export interface PointsPreview {
  customerId?: number;
  /** 会员当前积分余额 */
  points?: number;
  /** 项目原价合计（分） */
  originalPrice?: number;
  /** 等级折扣率千分比（1000 = 不打折） */
  levelDiscountPermille?: number;
  /** 等级优惠金额（分） */
  levelDiscountAmount?: number;
  /** 本单最多可用的积分数 */
  maxPoints: number;
  /** 最多可抵扣金额（分） */
  maxDiscountAmount: number;
  /** 受「折后金额 × maxPointsPermille」限制的积分数上限 */
  capPoints?: number;
  /** 受比例上限限制的抵扣金额（分） */
  capDiscountAmount?: number;
  /** 汇率：多少积分抵 1 元 */
  pointsDiscountPerYuan?: number;
  /** 单笔抵扣上限（千分比） */
  maxPointsPermille?: number;
  /** 抵扣后的应付金额（分） */
  payableAmount?: number;
}

export interface PointsGoodsQuery {
  status?: string;
  keyword?: string;
}

/** 兑换品列表（分页） */
export function listPointsGoods(
  page = 1,
  pageSize = 20,
  query: PointsGoodsQuery = {},
) {
  return get<PageResult<PointsGoods>>('/biz/points-goods', {
    page,
    pageSize,
    ...query,
  });
}

/** 新增兑换品（权限 biz:pointsgoods:create） */
export function createPointsGoods(body: PointsGoodsBody) {
  return post<{ id: number }>('/biz/points-goods', body);
}

/** 修改兑换品（权限 biz:pointsgoods:update） */
export function updatePointsGoods(id: number, body: PointsGoodsBody) {
  return patch<void>(`/biz/points-goods/${id}`, body);
}

/** 删除兑换品（软删，权限 biz:pointsgoods:delete） */
export function deletePointsGoods(id: number) {
  return del<void>(`/biz/points-goods/${id}`);
}

/**
 * 积分抵扣试算（POST /biz/points/preview）
 * 金额由**服务端**复算，前端只做展示与二次确认（§5.7）。
 */
export function previewPoints(body: {
  customerId: number;
  serviceItemIds: number[];
}) {
  return post<PointsPreview>('/biz/points/preview', body);
}

/**
 * 积分兑换（POST /biz/members/:id/redeem，权限 biz:points:redeem）
 * 同一事务内扣积分 + 发次卡。
 */
export function redeemPoints(
  memberId: number,
  body: { goodsId: number; remark?: string },
) {
  return post<{
    redeemId: number;
    redeemNo: string;
    points: number;
    pointsAfter: number;
    memberCardId: number;
    cardNo: string;
  }>(`/biz/members/${memberId}/redeem`, body);
}

/** 兑换记录列表（权限 biz:points:redeem） */
export function listPointsRedeems(
  page = 1,
  pageSize = 20,
  query: {
    customerId?: string | number;
    goodsId?: string | number;
    status?: string;
  } = {},
) {
  return get<PageResult<PointsRedeem>>('/biz/points-redeems', {
    page,
    pageSize,
    ...query,
  });
}

/** 撤销兑换（权限 biz:points:revert，**必填原因**，回补积分 + 废卡） */
export function revertPointsRedeem(id: number, body: { reason: string }) {
  return post<void>(`/biz/points-redeems/${id}/revert`, body);
}
