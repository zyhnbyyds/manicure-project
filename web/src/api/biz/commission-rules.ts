import type { PageResult } from '~/types/api';
import { del, get, patch, post } from '~/request';

/** 提成维度：优先级 service_item > category > staff（§20.3） */
export type CommissionScope = 'staff' | 'category' | 'service_item';

/** 计提基数：默认 paid（实收，防挂账提前计提） */
export type CommissionBase = 'payable' | 'paid' | 'original';

export type CommissionRuleStatus = 'active' | 'disabled';

/** 提成规则（`biz_commission_rule`） */
export interface CommissionRule {
  id: number;
  name: string;
  scope: CommissionScope;
  /** 维度命中目标：`service_item` → 项目 id；`staff`/`category` 时可为空 */
  targetId: number | null;
  staffId: number | null;
  category: string | null;
  /** 比例（千分比） */
  permille: number;
  /** 固定额（分）；与 permille 同时存在时取「比例 + 固定」之和 */
  fixedAmount: number;
  base: CommissionBase;
  effectiveFrom: string;
  effectiveTo: string | null;
  status: CommissionRuleStatus;
  /** 同维度取 sort 最小的一条 */
  sort: number;
  remark: string | null;
  createdAt: string;
}

export interface CommissionRuleListQuery {
  scope?: CommissionScope | '';
  status?: CommissionRuleStatus | '';
  page?: number;
  pageSize?: number;
}

export interface CommissionRuleBody {
  name: string;
  scope: CommissionScope;
  targetId?: number | null;
  staffId?: number | null;
  category?: string | null;
  permille: number;
  fixedAmount: number;
  base: CommissionBase;
  effectiveFrom: string;
  effectiveTo?: string | null;
  status: CommissionRuleStatus;
  sort: number;
  remark?: string | null;
}

/** 提成规则列表（分页） */
export function listCommissionRules(params: CommissionRuleListQuery = {}) {
  return get<PageResult<CommissionRule>>('/biz/commission-rules', params);
}

/** 新增提成规则 */
export function createCommissionRule(body: CommissionRuleBody) {
  return post<{ id: number }>('/biz/commission-rules', body);
}

/** 修改提成规则（只影响之后计提） */
export function updateCommissionRule(
  id: number,
  body: Partial<CommissionRuleBody>,
) {
  return patch<void>(`/biz/commission-rules/${id}`, body);
}

/** 软删提成规则 */
export function deleteCommissionRule(id: number) {
  return del<void>(`/biz/commission-rules/${id}`);
}

/** 服务项目下拉（`service_item` 维度与分类维度的数据源） */
export interface ServiceItemOption {
  id: number;
  name: string;
  category: string | null;
  price: number;
}

export function listServiceItemOptions() {
  return get<PageResult<ServiceItemOption>>('/biz/service-items', {
    page: 1,
    pageSize: 200,
    status: 'active',
  });
}

/** 美甲师下拉（`staff` 维度） */
export interface CommissionStaffOption {
  id: number;
  nickname: string;
}

export function listCommissionStaffOptions() {
  return get<PageResult<CommissionStaffOption>>('/biz/staffs', {
    page: 1,
    pageSize: 200,
    status: 'active',
  });
}
