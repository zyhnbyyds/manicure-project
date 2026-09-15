import type { PageResult } from '~/types/api';
import { get, post } from '~/request';

export type CommissionRecordStatus = 'accrued' | 'settled' | 'reversed';

/** 提成计提记录（`biz_commission_record`，只追加） */
export interface CommissionRecord {
  id: number;
  bookingId: number;
  bookingItemId: number;
  staffId: number;
  /** 美甲师姓名（关联查询返回，可选） */
  staffName?: string | null;
  /** 命中的规则 id；未命中任何规则 → 不提成（不会有记录） */
  ruleId: number | null;
  ruleName?: string | null;
  /** 计提基数金额（分） */
  baseAmount: number;
  /** 计提金额（分） */
  amount: number;
  /** 期间 YYYYMM */
  period: string;
  status: CommissionRecordStatus;
  settledAt: string | null;
  settleBatch: string | null;
  remark: string | null;
  createdAt: string;
}

/** 列表查询（用 type 而非 interface：对象字面量类型才能满足 request 的 Record 约束） */
export type CommissionRecordListQuery = {
  staffId?: number | string;
  /** YYYYMM */
  period?: string;
  status?: CommissionRecordStatus | '';
  page?: number;
  pageSize?: number;
};

/** 计提记录列表（分页） */
export function listCommissionRecords(params: CommissionRecordListQuery = {}) {
  return get<PageResult<CommissionRecord>>('/biz/commission-records', params);
}

/** 按期间结算：生成批次号并把 accrued 置 settled */
export function settleCommission(period: string) {
  return post<{ batch: string; count: number; amount: number }>(
    '/biz/commission-settle',
    { period },
  );
}

/** 单笔冲销（必填原因；已结算期间的冲销进下一期为负数） */
export function reverseCommissionRecord(id: number, reason: string) {
  return post<void>(`/biz/commission-records/${id}/reverse`, { reason });
}

/** 计提记录按状态聚合出的一格 */
export interface CommissionRecordStatusSummary {
  /** 金额（分）。reversed 桶里是负数 */
  amount: number;
  count: number;
  staffCount: number;
}

/** 计提记录期间汇总（按状态分桶） */
export interface CommissionRecordSummary {
  period: string | null;
  accrued: CommissionRecordStatusSummary;
  settled: CommissionRecordStatusSummary;
  reversed: CommissionRecordStatusSummary;
}

/**
 * 期间汇总（服务端聚合）。
 *
 * **不要**再用 `listCommissionRecords({ pageSize: 200 })` 在前端求和 ——
 * 单页上限 200 会在记录更多时静默少算，金额却照常当作完整值展示。
 */
export function fetchCommissionRecordSummary(period: string) {
  return get<CommissionRecordSummary>('/biz/commission-records/summary', {
    period,
  });
}
