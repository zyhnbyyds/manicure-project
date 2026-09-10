import type { PageResult } from '~/types/api';
import { del, get, patch, post } from '~/request';

/** 挂账主体类型（§18.1） */
export type CreditAccountType = 'customer' | 'company' | 'staff';
export type CreditAccountStatus = 'active' | 'disabled';

/**
 * 挂账主体（`biz_credit_account`）
 * 金额单位一律为「分」；`creditLimit = 0` 表示不限额度。
 */
export interface CreditAccount {
  id: number;
  name: string;
  type: CreditAccountType;
  /** 关联顾客（`type='customer'` 时使用） */
  customerId: number | null;
  /** 关联顾客姓名（列表关联查询返回，可选） */
  customerName?: string | null;
  contact: string | null;
  phone: string | null;
  /** 额度（分），0 = 不限 */
  creditLimit: number;
  /** 已挂未结（分） */
  usedAmount: number;
  /** 月结日 1..28；0 = 不定期（due_date 为 NULL） */
  settleDay: number;
  status: CreditAccountStatus;
  remark: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreditAccountListQuery {
  keyword?: string;
  type?: CreditAccountType | '';
  status?: CreditAccountStatus | '';
  page?: number;
  pageSize?: number;
}

export interface CreditAccountBody {
  name: string;
  type: CreditAccountType;
  customerId?: number | null;
  contact?: string | null;
  phone?: string | null;
  /** 额度（分） */
  creditLimit: number;
  settleDay: number;
  status: CreditAccountStatus;
  remark?: string | null;
}

/** 挂账主体列表（分页） */
export function listCreditAccounts(params: CreditAccountListQuery = {}) {
  return get<PageResult<CreditAccount>>('/biz/credit-accounts', params);
}

/** 挂账主体详情 */
export function getCreditAccount(id: number) {
  return get<CreditAccount>(`/biz/credit-accounts/${id}`);
}

/** 新增挂账主体 */
export function createCreditAccount(body: CreditAccountBody) {
  return post<{ id: number }>('/biz/credit-accounts', body);
}

/** 修改挂账主体 */
export function updateCreditAccount(
  id: number,
  body: Partial<CreditAccountBody>,
) {
  return patch<void>(`/biz/credit-accounts/${id}`, body);
}

/** 删除挂账主体（软删；有未结应收时后端返回 409） */
export function deleteCreditAccount(id: number) {
  return del<void>(`/biz/credit-accounts/${id}`);
}

/** 挂账主体下拉选项（仅启用，取前 200 条） */
export function listCreditAccountOptions() {
  return get<PageResult<CreditAccount>>('/biz/credit-accounts', {
    page: 1,
    pageSize: 200,
    status: 'active',
  });
}

/** 顾客下拉选项（关联顾客用，取前 200 条） */
export interface CreditCustomerOption {
  id: number;
  name: string;
  phone: string | null;
}

export function listCustomerOptions(keyword?: string) {
  return get<PageResult<CreditCustomerOption>>('/biz/customers', {
    page: 1,
    pageSize: 200,
    keyword,
  });
}
