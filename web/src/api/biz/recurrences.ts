import type { PageResult } from '~/types/api';
import { del, get, patch, post } from '~/request';

export type RecurrenceStatus = 'active' | 'paused' | 'stopped';
/** 冲突策略：skip = 跳过并记通知；notify = 照旧生成 + 标记待人工处理 */
export type RecurrenceConflictPolicy = 'skip' | 'notify';

/** 周期预约规则（`biz_booking_recurrence`） */
export interface Recurrence {
  id: number;
  name: string | null;
  customerId: number;
  customerName?: string | null;
  staffId: number;
  staffName?: string | null;
  serviceItemIds: number[];
  serviceItemNames?: string[] | null;
  /** 星期几：1=周一 … 7=周日 */
  weekday: number;
  /** HH:mm:ss */
  startTime: string;
  durationMinutes: number;
  startDate: string;
  endDate: string | null;
  /** 滚动窗口天数 */
  generateDays: number;
  /** 幂等游标：已生成到哪一天 */
  generatedUntil: string | null;
  /** 下次生成日（后端计算返回，可选） */
  nextGenerateDate?: string | null;
  status: RecurrenceStatus;
  lastRunAt: string | null;
  conflictPolicy: RecurrenceConflictPolicy;
  remark: string | null;
  createdAt: string;
}

/** 列表查询（用 type 而非 interface：对象字面量类型才能满足 request 的 Record 约束） */
export type RecurrenceListQuery = {
  customerId?: number | string;
  staffId?: number | string;
  status?: RecurrenceStatus | '';
  page?: number;
  pageSize?: number;
};

export interface RecurrenceBody {
  name?: string | null;
  customerId: number;
  staffId: number;
  serviceItemIds: number[];
  /** 1=周一 … 7=周日 */
  weekday: number;
  /** HH:mm 或 HH:mm:ss */
  startTime: string;
  startDate: string;
  endDate?: string | null;
  generateDays: number;
  conflictPolicy: RecurrenceConflictPolicy;
  remark?: string | null;
}

/** 创建规则返回：立即生成第一个窗口的结果 */
export interface RecurrenceCreateResult {
  id: number;
  generated: number;
  skipped: number;
}

/** 规则已生成的预约 */
export interface RecurrenceBooking {
  id: number;
  bookingNo: string;
  startAt: string;
  endAt: string;
  status: string;
  payStatus: string;
  customerName?: string | null;
}

/** 规则列表（分页） */
export function listRecurrences(params: RecurrenceListQuery = {}) {
  return get<PageResult<Recurrence>>('/biz/recurrences', params);
}

/** 创建规则（立即生成第一个窗口，返回 generated / skipped） */
export function createRecurrence(body: RecurrenceBody) {
  return post<RecurrenceCreateResult>('/biz/recurrences', body);
}

/** 修改规则（只影响未来生成，不回溯已生成的单） */
export function updateRecurrence(id: number, body: Partial<RecurrenceBody>) {
  return patch<void>(`/biz/recurrences/${id}`, body);
}

/** 暂停生成 */
export function pauseRecurrence(id: number) {
  return post<void>(`/biz/recurrences/${id}/pause`);
}

/** 恢复生成 */
export function resumeRecurrence(id: number) {
  return post<void>(`/biz/recurrences/${id}/resume`);
}

/** 停止（终态） */
export function stopRecurrence(id: number) {
  return post<void>(`/biz/recurrences/${id}/stop`);
}

/** 停止并软删规则（已生成的预约保留，recurrence_id 置空） */
export function deleteRecurrence(id: number) {
  return del<void>(`/biz/recurrences/${id}`);
}

/** 该规则已生成的预约 */
export function listRecurrenceBookings(id: number, page = 1, pageSize = 50) {
  return get<PageResult<RecurrenceBooking>>(`/biz/recurrences/${id}/bookings`, {
    page,
    pageSize,
  });
}

/* ---------------- 表单下拉数据源 ---------------- */

export interface RecurrenceCustomerOption {
  id: number;
  name: string;
  phone: string | null;
}

export function listRecurrenceCustomerOptions(keyword?: string) {
  return get<PageResult<RecurrenceCustomerOption>>('/biz/customers', {
    page: 1,
    pageSize: 200,
    keyword,
  });
}

export interface RecurrenceStaffOption {
  id: number;
  nickname: string;
}

export function listRecurrenceStaffOptions() {
  return get<PageResult<RecurrenceStaffOption>>('/biz/staffs', {
    page: 1,
    pageSize: 200,
    status: 'active',
  });
}

export interface RecurrenceServiceItemOption {
  id: number;
  name: string;
  durationMinutes: number;
  price: number;
}

export function listRecurrenceServiceItemOptions() {
  return get<PageResult<RecurrenceServiceItemOption>>('/biz/service-items', {
    page: 1,
    pageSize: 200,
    status: 'active',
  });
}
