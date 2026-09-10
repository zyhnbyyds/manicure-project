import type { PageResult } from '~/types/api';
import { del, get, patch, post } from '~/request';

/** 充值方案（biz_recharge_plan，§4.4 / §15.4） */
export interface RechargePlan {
  id: number;
  name: string;
  /** 顾客**实付**金额（分） */
  payAmount: number;
  /** **赠送**金额（分，进 balance_bonus，不可退） */
  bonusAmount: number;
  status: 'active' | 'disabled';
  sort: number;
  remark: string | null;
  createdAt: string;
  updatedAt?: string;
}

export interface RechargePlanQuery {
  status?: string;
}

export interface RechargePlanBody {
  name?: string;
  payAmount?: number;
  bonusAmount?: number;
  status?: 'active' | 'disabled';
  sort?: number;
  remark?: string | null;
}

/** 充值方案列表（分页） */
export function listRechargePlans(
  page = 1,
  pageSize = 20,
  query: RechargePlanQuery = {},
) {
  return get<PageResult<RechargePlan>>('/biz/recharge-plans', {
    page,
    pageSize,
    ...query,
  });
}

/** 全部启用方案（充值弹窗下拉用） */
export async function listActiveRechargePlans() {
  const data = await listRechargePlans(1, 100, { status: 'active' });
  return data.items;
}

/** 新增方案（赠送比例上限 biz.member.maxBonusPermille，超出后端拒绝） */
export function createRechargePlan(body: RechargePlanBody) {
  return post<{ id: number }>('/biz/recharge-plans', body);
}

/** 修改方案 */
export function updateRechargePlan(id: number, body: RechargePlanBody) {
  return patch<void>(`/biz/recharge-plans/${id}`, body);
}

/** 删除方案（软删） */
export function deleteRechargePlan(id: number) {
  return del<void>(`/biz/recharge-plans/${id}`);
}
