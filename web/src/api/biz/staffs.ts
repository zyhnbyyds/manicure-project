import type { EntityStatus, PageResult } from '~/types/api';
import { del, get, patch, post, put } from '~/request';

/** 美甲师档案（biz_staff，§9.2） */
export interface Staff {
  id: number;
  /** 关联后台账号（可空；一个账号只能绑定一位美甲师） */
  userId: number | null;
  nickname: string;
  avatar: string | null;
  phone: string | null;
  /** 简介 / 擅长 */
  bio: string | null;
  status: EntityStatus;
  sort: number;
  remark: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  createdBy: number | null;
  updatedBy: number | null;
}

export interface CreateStaffBody {
  userId?: number | null;
  nickname: string;
  avatar?: string | null;
  phone?: string | null;
  bio?: string | null;
  status?: EntityStatus;
  sort?: number;
  remark?: string | null;
}

export type UpdateStaffBody = Partial<CreateStaffBody>;

export interface StaffListQuery {
  /** 昵称 / 手机号 */
  keyword?: string;
  status?: EntityStatus;
}

/** 美甲师可做项目（GET 返回；空数组 = 可做全部，§22） */
export interface StaffServiceItemRef {
  id: number;
  name: string;
}

/** 美甲师列表（分页，响应无 total） */
export function listStaffs(
  page = 1,
  pageSize = 20,
  query: StaffListQuery = {},
) {
  return get<PageResult<Staff>>('/biz/staffs', { page, pageSize, ...query });
}

/** 启用中的美甲师（排班 / 预约弹窗下拉用） */
export function listActiveStaffs(pageSize = 200) {
  return listStaffs(1, pageSize, { status: 'active' });
}

/** 美甲师详情 */
export function getStaff(id: number) {
  return get<Staff>(`/biz/staffs/${id}`);
}

/** 新增美甲师 */
export function createStaff(body: CreateStaffBody) {
  return post<{ id: number }>('/biz/staffs', body);
}

/** 修改美甲师 */
export function updateStaff(id: number, body: UpdateStaffBody) {
  return patch<void>(`/biz/staffs/${id}`, body);
}

/** 删除美甲师（软删；存在未完成预约时 409） */
export function deleteStaff(id: number) {
  return del<void>(`/biz/staffs/${id}`);
}

/** 查询美甲师可做项目（空数组 = 可做全部） */
export function getStaffServiceItems(id: number) {
  return get<StaffServiceItemRef[]>(`/biz/staffs/${id}/service-items`);
}

/** 整体替换美甲师可做项目（空数组 = 恢复「可做全部」） */
export function setStaffServiceItems(id: number, serviceItemIds: number[]) {
  return put<{ success: boolean; count: number }>(
    `/biz/staffs/${id}/service-items`,
    { serviceItemIds },
  );
}
