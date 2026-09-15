import dayjs from 'dayjs';
// 副作用导入：这里设置 dayjs 默认时区为东八区（与全站展示口径一致）
import '~/composables/useFormat';

/**
 * 日历面板的共享类型与纯函数。
 *
 * 排班管理页与预约管理页共用同一套日历渲染，两边各自负责去后端取数：
 * - 排班页只有班次（`cells`）；
 * - 预约页既有班次又有预约块（`cells` + `bookings`）。
 */

/** 日历视图模式：周视图（列=7 天）/ 日视图（单日纵向时间轴） */
export type CalendarMode = 'week' | 'day';

/** 日历行标签用的美甲师 */
export interface CalendarStaff {
  id: number;
  nickname: string;
}

/** 日历上用的一天 */
export interface CalendarDay {
  /** `YYYY-MM-DD` */
  date: string;
  /** 1=周一 … 7=周日 */
  weekday: number;
}

/** 某美甲师某天的实际生效班次（来自 `GET /biz/schedules/calendar`） */
export interface CalendarScheduleCell {
  staffId: number;
  date: string;
  off: boolean;
  /** `override` 当天例外 / `store` 本店专属模板 / `shared` 通用模板 */
  source: 'override' | 'store' | 'shared';
  /** 墙钟时间 `HH:MM:SS`（店内本地时间，无需时区转换） */
  segments: { startTime: string; endTime: string }[];
}

/** 日历块（来自 `GET /biz/bookings/calendar`） */
export interface CalendarBookingBlock {
  id: number;
  bookingNo: string;
  staffId: number;
  staffName: string | null;
  customerName: string;
  /** ISO 时刻（UTC 序列化），按东八区换算 */
  startAt: string;
  endAt: string;
  status: string;
  payStatus: string;
  payableAmount: number;
  dueAmount: number;
}

export const WEEKDAY_LABELS = [
  '周一',
  '周二',
  '周三',
  '周四',
  '周五',
  '周六',
  '周日',
] as const;

/** 1=周一 … 7=周日 */
export function isoWeekday(date: string): number {
  const weekday = dayjs(date).day();
  return weekday === 0 ? 7 : weekday;
}

/** `2026-09-15` → `2026-09-15`（周一） */
export function weekdayLabel(weekday: number): string {
  return WEEKDAY_LABELS[weekday - 1] ?? '';
}

/** 锚点日期所在周的周一 */
export function weekStartOf(anchor: string): string {
  const date = dayjs(anchor);
  const offset = (date.day() + 6) % 7;
  return date.subtract(offset, 'day').format('YYYY-MM-DD');
}

/** 周视图的 7 天（周一 → 周日） */
export function buildWeekDays(anchor: string): CalendarDay[] {
  const start = dayjs(weekStartOf(anchor));
  return Array.from({ length: 7 }, (_, index) => {
    const date = start.add(index, 'day');
    return {
      date: date.format('YYYY-MM-DD'),
      weekday: ((date.day() + 6) % 7) + 1,
    };
  });
}

/** 日视图的 1 天 */
export function buildDay(anchor: string): CalendarDay[] {
  return [{ date: anchor, weekday: isoWeekday(anchor) }];
}

/** 按模式算出要展示、也要请求的日期区间 */
export function buildRange(
  anchor: string,
  mode: CalendarMode,
): { from: string; to: string; days: CalendarDay[] } {
  if (mode === 'day') {
    return { from: anchor, to: anchor, days: buildDay(anchor) };
  }
  const days = buildWeekDays(anchor);
  return {
    from: days[0]?.date ?? anchor,
    to: days[6]?.date ?? anchor,
    days,
  };
}

export function todayString(): string {
  return dayjs().format('YYYY-MM-DD');
}

/** `HH:MM:SS` / `HH:MM` → 当天 0 点起的分钟数 */
export function timeToMinutes(value: string): number {
  const [hour, minute] = value.split(':').map(Number);
  return (hour ?? 0) * 60 + (minute ?? 0);
}

/** `HH:MM:SS` → `HH:mm` */
export function shortTime(value: string | null | undefined): string {
  if (!value) return '--:--';
  return value.slice(0, 5);
}

/** ISO 时刻 → 店内本地日 `YYYY-MM-DD` */
export function shopDateOf(iso: string): string {
  return dayjs(iso).tz().format('YYYY-MM-DD');
}

/** ISO 时刻 → 当天 0 点起的分钟数（店内本地时间） */
export function shopMinutesOf(iso: string): number {
  const local = dayjs(iso).tz();
  return local.hour() * 60 + local.minute();
}

/** ISO 时刻 → `HH:mm` */
export function shopTimeOf(iso: string): string {
  return dayjs(iso).tz().format('HH:mm');
}

/** 分钟数 → `HH:mm` */
export function minutesLabel(minutes: number): string {
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/** 分 → `¥ 12.00` */
export function centsToYuanText(cents: number | null | undefined): string {
  return `¥ ${((cents ?? 0) / 100).toFixed(2)}`;
}

/** 服务状态 → 展示名 */
export const STATUS_LABELS: Record<string, string> = {
  pending: '待确认',
  confirmed: '已确认',
  arrived: '已到店',
  completed: '已完成',
  cancelled: '已取消',
  no_show: '已爽约',
};

export function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

/**
 * 服务状态 → 色值。
 *
 * 与预约列表 `statusColor` 保持同一套口径（同一个状态在列表和日历里颜色一致），
 * 日历块只用它画左边框，底色统一走 `--app-bg-hover`：一屏可能几十个块，
 * 块块实心会糊成一片，细边框既能区分状态又不抢眼。
 */
const STATUS_COLORS: Record<string, string> = {
  pending: 'var(--lew-color-warning)',
  confirmed: 'var(--lew-color-primary)',
  arrived: 'var(--lew-color-primary)',
  completed: 'var(--lew-color-success)',
  cancelled: 'var(--app-text-muted)',
  no_show: 'var(--lew-color-error)',
};

export function statusColor(status: string): string {
  return STATUS_COLORS[status] ?? 'var(--lew-color-primary)';
}

/** 「已取消 / 已爽约」这类块不该让人误以为还要服务，整体降调 */
export function isDeadStatus(status: string): boolean {
  return status === 'cancelled' || status === 'no_show';
}
