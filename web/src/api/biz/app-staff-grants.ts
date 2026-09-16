import type { PageResult } from '~/types/api';
import { get, post } from '~/request';

/** 开通申请状态（与 `app_wx_user.staff_status` 对齐，`none` 不进店长待办） */
export type GrantStatus = 'pending' | 'active' | 'rejected';

/** 一条小程序工作台开通申请（app_wx_user + 匹配到的 biz_staff） */
export interface AppStaffGrant {
  /** 申请ID＝`app_wx_user.id`，通过 / 驳回都用它 */
  id: number;
  openid: string;
  nickname: string | null;
  phone: string | null;
  staffId: number | null;
  staffName: string | null;
  /** 档案在职状态；null = 匹配到的档案已被删除 */
  staffArchivedStatus: 'active' | 'disabled' | null;
  staffStatus: GrantStatus | 'none';
  staffRequestedAt: string | null;
  staffDecidedAt: string | null;
  /** 驳回原因（小程序端可见） */
  staffRejectReason: string | null;
}

export interface GrantDecision {
  id: number;
  staffId: number | null;
  staffStatus: GrantStatus;
  staffDecidedAt: string | null;
}

/** 申请列表（分页） */
export function listAppStaffGrants(
  page = 1,
  pageSize = 20,
  query: { status?: GrantStatus } = {},
) {
  return get<PageResult<AppStaffGrant>>('/biz/app-staff-grants', {
    page,
    pageSize,
    ...query,
  });
}

/** 通过（幂等；档案停用 / 已删除时 409） */
export function approveAppStaffGrant(id: number) {
  return post<GrantDecision>(`/biz/app-staff-grants/${id}/approve`);
}

/** 驳回（必须填原因，申请人可见） */
export function rejectAppStaffGrant(id: number, reason: string) {
  return post<GrantDecision>(`/biz/app-staff-grants/${id}/reject`, {
    reason,
  });
}
