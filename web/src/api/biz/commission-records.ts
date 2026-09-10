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

/** 结算前二次确认所需的期间汇总 */
export interface CommissionPeriodSummary {
  period: string;
  /** 期间计提总额（分） */
  amount: number;
  /** 涉及人数 */
  staffCount: number;
  /** 计提笔数 */
  count: number;
  /** 是否因单页上限而截断（截断则金额为下界） */
  truncated: boolean;
}

/**
 * 期间汇总。
 *
 * 接口契约（§9.11）未提供 `/biz/commission-records/summary`，因此这里用列表接口
 * `status=accrued` 拉取（单页上限 200）在前端聚合出「总额 / 人数」供结算前二次确认。
 * TODO(contract): 若后端补充 summary 接口，应改为直接调用以避免 200 条上限截断。
 */
export async function fetchCommissionPeriodSummary(
  period: string,
): Promise<CommissionPeriodSummary> {
  const data = await listCommissionRecords({
    period,
    status: 'accrued',
    page: 1,
    pageSize: 200,
  });
  const staffIds = new Set<number>();
  let amount = 0;
  for (const record of data.items) {
    amount += record.amount;
    staffIds.add(record.staffId);
  }
  return {
    period,
    amount,
    staffCount: staffIds.size,
    count: data.items.length,
    truncated: data.items.length >= 200,
  };
}
