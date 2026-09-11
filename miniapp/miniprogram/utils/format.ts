/**
 * 展示口径工具。
 *
 * 两条与后端铁律对齐的约定：
 * 1. **金额一律整数「分」**，只在展示层 ÷100，不做四舍五入的二次加工；
 * 2. **本地日绝不能由 `toISOString()` 反推**（会按 UTC 零点解析，整体偏 8 小时，
 *    对应后端铁律 §3「日界统一走 `shopDayRange()`」）。
 */

export interface YuanParts {
  /** 整数元部分，如 "128" */
  yuan: string;
  /** 两位小数部分，如 "00" */
  cent: string;
}

/** 分 → 元（字符串，保留两位）。`12800` → `"128.00"` */
export function fenToYuan(fen: number): string {
  const safe = Number.isFinite(fen) ? Math.round(fen) : 0;
  const negative = safe < 0;
  const abs = Math.abs(safe);
  const yuan = Math.floor(abs / 100);
  const cent = abs % 100;
  return `${negative ? '-' : ''}${yuan}.${String(cent).padStart(2, '0')}`;
}

/** 分 → 整数元 + 小数两部分，方便 WXML 里把「元」放大显示 */
export function fenToYuanParts(fen: number): YuanParts {
  const text = fenToYuan(fen);
  const [yuan, cent = '00'] = text.split('.');
  return { yuan, cent };
}

/** 分钟 → 时长文案：`90` → `"1小时30分"` */
export function formatDuration(minutes: number): string {
  const safe = Math.max(0, Math.round(minutes));
  const hours = Math.floor(safe / 60);
  const mins = safe % 60;
  if (hours === 0) return `${mins}分钟`;
  if (mins === 0) return `${hours}小时`;
  return `${hours}小时${mins}分`;
}

/** 本地日 `YYYY-MM-DD`（**不能用 toISOString**，会按 UTC 偏移一天） */
export function toLocalDateString(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function addDays(date: Date, days: number): Date {
  const next = new Date(date.getTime());
  next.setDate(next.getDate() + days);
  return next;
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

export interface DateChip {
  /** `YYYY-MM-DD`，直接作为可约时段接口的 `date` 参数 */
  value: string;
  /** 星期，如「周五」 */
  weekday: string;
  /** 日，如「11」 */
  day: string;
  /** 今天 / 明天 / 月-日 */
  label: string;
  isToday: boolean;
}

/** 生成从今天起的日期条（默认 14 天，够覆盖「最多提前 30 天」的常用区间） */
export function buildDateChips(days = 14, base = new Date()): DateChip[] {
  const chips: DateChip[] = [];
  for (let index = 0; index < days; index += 1) {
    const date = addDays(base, index);
    const value = toLocalDateString(date);
    const label =
      index === 0
        ? '今天'
        : index === 1
          ? '明天'
          : `${date.getMonth() + 1}-${date.getDate()}`;
    chips.push({
      value,
      weekday: WEEKDAYS[date.getDay()],
      day: String(date.getDate()),
      label,
      isToday: index === 0,
    });
  }
  return chips;
}

/**
 * 取 ISO 时刻里的**店内钟点**（`HH:mm`）。
 *
 * 后端所有时刻都是「店内时区的绝对时刻」（带 `+08:00` 偏移），例如
 * `2026-09-11T10:00:00+08:00`。若用 `new Date(iso)` 再按设备时区格式化，
 * 顾客手机时区一变时间就跟着漂。这里直接读字符串里的钟点，
 * 保证「约的 10:00」在任何设备上都显示 10:00。
 */
export function isoClockTime(iso: string): string {
  const matched = /T(\d{2}):(\d{2})/.exec(iso);
  if (!matched) return '';
  return `${matched[1]}:${matched[2]}`;
}

/** `14:00 - 15:30` */
export function formatTimeRange(startIso: string, endIso: string): string {
  const start = isoClockTime(startIso);
  const end = isoClockTime(endIso);
  if (!start) return '';
  return end ? `${start} - ${end}` : start;
}

/** ISO 时刻 → `9月11日 周五 14:00`（同样只读字符串口径，避免时区漂移） */
export function formatDateTimeLabel(iso: string): string {
  const matched = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso);
  if (!matched) return iso;
  const [, , month, day, hour, minute] = matched;
  return `${Number(month)}月${Number(day)}日 ${hour}:${minute}`;
}

/** 折扣率（千分比）→ 中文折扣，`950` → `"9.5折"`；`1000` → `"无折扣"` */
export function formatDiscount(permille: number): string {
  if (!Number.isFinite(permille) || permille >= 1000) return '无折扣';
  const discount = permille / 100;
  return `${Number(discount.toFixed(2))}折`;
}

/** 预约状态 → 文案 + 主题色语义（色值由页面按当前主题派生） */
export type BookingStatus =
  | 'pending'
  | 'confirmed'
  | 'arrived'
  | 'completed'
  | 'cancelled'
  | 'no_show';

const BOOKING_STATUS_TEXT: Record<BookingStatus, string> = {
  pending: '待确认',
  confirmed: '已确认',
  arrived: '已到店',
  completed: '已完成',
  cancelled: '已取消',
  no_show: '未到店',
};

export function formatBookingStatus(status: string): string {
  return BOOKING_STATUS_TEXT[status as BookingStatus] ?? status;
}

/** 资金状态 → 文案 */
const PAY_STATUS_TEXT: Record<string, string> = {
  unpaid: '未付款',
  partial: '已付定金',
  paid: '已结清',
  refunded: '已退款',
  credit: '挂账',
};

export function formatPayStatus(status: string): string {
  return PAY_STATUS_TEXT[status] ?? status;
}

/** 时段为空时的原因文案（与后端 `reason` 枚举一一对应） */
const SLOT_REASON_TEXT: Record<string, string> = {
  off: '这天美甲师休息啦，换一天看看～',
  no_shift: '这天还没有排班，换一天试试～',
  staff_cannot_do: '这位美甲师暂时不做所选项目，换人或换项目吧～',
  fully_booked: '这天已经约满啦，看看别的日期～',
  out_of_window: '这个时间超出可预约范围（需提前 1 小时以上）',
};

export function formatSlotReason(reason?: string | null): string {
  if (!reason) return '暂无可约时段';
  return SLOT_REASON_TEXT[reason] ?? '暂无可约时段';
}
