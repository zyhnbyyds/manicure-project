import type { PageResult } from '~/types/api';
import { del, get, patch, post } from '~/request';

/**
 * 优惠券模板（biz_coupon_template）。
 *
 * 术语：**模板**是「以后还发不发」的开关，**券**是顾客手里那张
 * （`biz_customer_coupon`）。停用/删除模板**不影响已发出的券** ——
 * 面额与门槛在发券时就快照到持有行了。
 *
 * 金额单位一律是**分**（与后端一致），页面展示与录入时换算成元。
 */
export interface CouponTemplate {
  id: number;
  name: string;
  /** 使用门槛（分）；0 = 无门槛 */
  thresholdAmount: number;
  /** 面额（分） */
  discountAmount: number;
  /** 领取后有效天数；0 = 长期有效（或用 validTo 的绝对区间） */
  validDays: number;
  validFrom: string | null;
  validTo: string | null;
  status: 'active' | 'disabled';
  sort: number;
  remark: string | null;
  /** 已发出的券张数（列表联查给出，用于评估停用影响面） */
  claimedCount: number;
  createdAt: string;
}

export interface CouponTemplateBody {
  name?: string;
  thresholdAmount?: number;
  discountAmount?: number;
  validDays?: number;
  validFrom?: string | null;
  validTo?: string | null;
  status?: 'active' | 'disabled';
  sort?: number;
  remark?: string | null;
}

export interface CouponTemplateQuery {
  status?: string;
  keyword?: string;
}

/** 券模板列表（分页；无 total，与其它列表一致） */
export function listCouponTemplates(
  page = 1,
  pageSize = 20,
  query: CouponTemplateQuery = {},
) {
  return get<PageResult<CouponTemplate>>('/biz/coupon-templates', {
    page,
    pageSize,
    ...query,
  });
}

/** 新增券模板（权限 biz:coupon:create） */
export function createCouponTemplate(body: CouponTemplateBody) {
  return post<{ id: number }>('/biz/coupon-templates', body);
}

/** 修改券模板（权限 biz:coupon:update） */
export function updateCouponTemplate(id: number, body: CouponTemplateBody) {
  return patch<void>(`/biz/coupon-templates/${id}`, body);
}

/**
 * 停用券模板（软删，权限 biz:coupon:delete）。
 *
 * **不影响已发出的券**；若只想「不再让新顾客领到」，改成
 * `updateCouponTemplate(id, { status: 'disabled' })` 更合适。
 */
export function deleteCouponTemplate(id: number) {
  return del<void>(`/biz/coupon-templates/${id}`);
}


/**
 * 顾客持有的券（biz_customer_coupon）。
 * 面额与门槛是**发券时的快照**，与当前模板可能不同 —— 以这里的值为准。
 */
export interface CustomerCoupon {
  id: number;
  couponNo: string;
  customerId: number;
  templateId: number;
  discountAmount: number;
  thresholdAmount: number;
  status: 'usable' | 'used' | 'expired' | 'void';
  expireAt: string | null;
  usedBookingId: number | null;
  usedAt: string | null;
  source: string;
  remark: string | null;
  createdAt: string;
}

/** 启用中的券模板（发券下拉用） */
export function listActiveCouponTemplates() {
  return get<PageResult<CouponTemplate>>('/biz/coupon-templates', {
    page: 1,
    pageSize: 100,
    status: 'active',
  });
}

/**
 * 给指定顾客发券（权限 `biz:member:coupon`）。
 *
 * **允许重复发放**（补偿/补发是正常诉求），服务端不会因为「已持有」而拒绝 ——
 * 与顾客自助领券（一次一张）是两条不同口径。
 */
export function issueCouponToMember(memberId: number, templateId: number) {
  return post<CustomerCoupon>(`/biz/members/${memberId}/coupons`, {
    templateId,
  });
}

/** 某位顾客持有的券（权限 biz:member:list） */
export function listMemberCoupons(memberId: number, page = 1, pageSize = 20) {
  return get<PageResult<CustomerCoupon>>(`/biz/members/${memberId}/coupons`, {
    page,
    pageSize,
  });
}