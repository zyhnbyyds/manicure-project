import request, { get } from '~/request';

/**
 * 排班（§9.3 / §6.4）。
 *
 * 周模板 PUT 与日期例外的增删都会在「既有预约落在新班次之外」时返回 **409 + `conflicts` 清单**，
 * 而 `request.ts` 的错误拦截器只把 message 弹出来、**丢弃了响应体**。
 * 因此本模块对这几个接口自行放行 409（`validateStatus`），把冲突清单原样交给页面，
 * 由页面弹清单 + 二次确认后再带 `force=true` 重试。
 */

/** 周模板班次（时间列为墙钟 `HH:MM:SS`） */
export interface WeeklyShift {
  id: number;
  /** 1=周一 … 7=周日 */
  weekday: number;
  startTime: string;
  endTime: string;
}

/** 周模板整体替换的入参（PUT body `{ shifts: [...] }`） */
export interface WeeklyShiftInput {
  weekday: number;
  startTime: string;
  endTime: string;
}

/** 日期例外（off 整天休息 / custom 自定义时段） */
export interface ScheduleOverride {
  id: number;
  /** `YYYY-MM-DD` */
  date: string;
  type: 'off' | 'custom';
  startTime: string | null;
  endTime: string | null;
  reason: string | null;
}

export interface CreateOverrideBody {
  date: string;
  type: 'off' | 'custom';
  startTime?: string | null;
  endTime?: string | null;
  reason?: string | null;
}

export interface OverrideListQuery {
  from?: string;
  to?: string;
}

/** 受影响的既有预约（409 响应体里的 `conflicts`） */
export interface ScheduleConflictItem {
  id: number;
  bookingNo: string;
  /** 后端返回 ISO 时刻（UTC 序列化），展示时按东八区转换 */
  startAt: string;
  endAt: string;
  customerName?: string;
  staffId?: number;
}

/** 冲突感知的保存结果：`ok=false` 表示 409，页面需展示清单并二次确认 */
export type ScheduleSaveOutcome<TData> =
  | { ok: true; data: TData }
  | { ok: false; message: string; conflicts: ScheduleConflictItem[] };

/** 放行 409，让冲突清单能被读到（其它状态码仍走统一错误处理） */
function acceptConflict(status: number): boolean {
  return (status >= 200 && status < 300) || status === 409;
}

/** 后端 409 体可能是 `{ message, conflicts }`（对象）或纯字符串 */
function readMessage(data: unknown, fallback: string): string {
  if (typeof data === 'string' && data) return data;
  if (data && typeof data === 'object') {
    const message = (data as { message?: unknown }).message;
    if (typeof message === 'string' && message) return message;
    if (Array.isArray(message)) {
      const joined = message
        .filter((item): item is string => typeof item === 'string')
        .join('；');
      if (joined) return joined;
    }
  }
  return fallback;
}

function readConflicts(data: unknown): ScheduleConflictItem[] {
  if (!data || typeof data !== 'object') return [];
  const conflicts = (data as { conflicts?: unknown }).conflicts;
  return Array.isArray(conflicts) ? (conflicts as ScheduleConflictItem[]) : [];
}

/** 周模板（7 天全部段） */
export function getWeeklyShifts(staffId: number) {
  return get<WeeklyShift[]>(`/biz/staffs/${staffId}/weekly-shifts`);
}

/**
 * 整体替换周模板。
 *
 * 该接口**不提供 force**（§6.4：未来 30 天内的既有预约越界时必须先改期），
 * 409 时只把冲突清单交给页面展示。
 */
export async function replaceWeeklyShifts(
  staffId: number,
  shifts: WeeklyShiftInput[],
): Promise<ScheduleSaveOutcome<{ success: boolean; count: number }>> {
  const response = await request.put(
    `/biz/staffs/${staffId}/weekly-shifts`,
    { shifts },
    { validateStatus: acceptConflict },
  );
  if (response.status === 409) {
    return {
      ok: false,
      message: readMessage(response.data, '保存失败：既有预约会落在新班次之外'),
      conflicts: readConflicts(response.data),
    };
  }
  return {
    ok: true,
    data: response.data as { success: boolean; count: number },
  };
}

/** 日期例外列表（from / to 为店内本地日 `YYYY-MM-DD`） */
export function listOverrides(staffId: number, query: OverrideListQuery = {}) {
  return get<ScheduleOverride[]>(`/biz/staffs/${staffId}/overrides`, {
    ...query,
  });
}

/** 新增日期例外；默认 409（带清单），`force=true` 才落库 */
export async function createOverride(
  staffId: number,
  body: CreateOverrideBody,
  force = false,
): Promise<ScheduleSaveOutcome<{ id: number }>> {
  const response = await request.post(
    `/biz/staffs/${staffId}/overrides`,
    { ...body, force },
    { validateStatus: acceptConflict },
  );
  if (response.status === 409) {
    return {
      ok: false,
      message: readMessage(response.data, '该日已有预约落在新班次之外'),
      conflicts: readConflicts(response.data),
    };
  }
  return { ok: true, data: response.data as { id: number } };
}

/** 删除日期例外；默认 409（带清单），`force=true` 才删除 */
export async function deleteOverride(
  staffId: number,
  overrideId: number,
  force = false,
): Promise<ScheduleSaveOutcome<null>> {
  const response = await request.delete(
    `/biz/staffs/${staffId}/overrides/${overrideId}`,
    { params: { force }, validateStatus: acceptConflict },
  );
  if (response.status === 409) {
    return {
      ok: false,
      message: readMessage(response.data, '删除后有预约落在班次之外'),
      conflicts: readConflicts(response.data),
    };
  }
  return { ok: true, data: null };
}
