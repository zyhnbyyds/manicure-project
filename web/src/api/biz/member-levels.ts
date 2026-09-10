import type { PageResult } from '~/types/api';
import { del, get, patch, post } from '~/request';

/** 会员等级（biz_member_level，§4.4 / §15.2） */
export interface MemberLevel {
  id: number;
  name: string;
  /** 折扣率**千分比**：1000 = 不打折，950 = 9.5 折，880 = 8.8 折 */
  discountPermille: number;
  /** 升级门槛（分）：total_spent 达到即自动升级 */
  upgradeAmount: number;
  /** 等级由低到高，upgradeAmount 必须随 sort 单调不减 */
  sort: number;
  status: 'active' | 'disabled';
  remark: string | null;
  createdAt: string;
  updatedAt?: string;
}

export interface MemberLevelQuery {
  status?: string;
}

export interface MemberLevelBody {
  name?: string;
  discountPermille?: number;
  upgradeAmount?: number;
  sort?: number;
  status?: 'active' | 'disabled';
  remark?: string | null;
}

/** 等级列表（分页） */
export function listMemberLevels(
  page = 1,
  pageSize = 20,
  query: MemberLevelQuery = {},
) {
  return get<PageResult<MemberLevel>>('/biz/member-levels', {
    page,
    pageSize,
    ...query,
  });
}

/** 全部启用等级（下拉选项用，一次取全量） */
export async function listActiveMemberLevels() {
  const data = await listMemberLevels(1, 100, { status: 'active' });
  return data.items;
}

/** 新增等级 */
export function createMemberLevel(body: MemberLevelBody) {
  return post<{ id: number }>('/biz/member-levels', body);
}

/** 修改等级（不影响历史单据） */
export function updateMemberLevel(id: number, body: MemberLevelBody) {
  return patch<void>(`/biz/member-levels/${id}`, body);
}

/** 删除等级（软删；有会员在该等级时后端拒绝） */
export function deleteMemberLevel(id: number) {
  return del<void>(`/biz/member-levels/${id}`);
}
