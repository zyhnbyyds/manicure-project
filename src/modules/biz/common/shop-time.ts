/**
 * 店内时间换算（§3 约定、§5.2 步骤 0）。
 *
 * 全库时间列都是 UTC 存储，唯一允许的「店内本地日 → 绝对时刻区间」转换入口是
 * `shopDayRange()`。禁止 `new Date('2026-09-11')`（会按 UTC 零点解析，整体偏 8 小时）。
 */

/** 默认店内时区，可被 `biz.booking.timezone` 覆盖 */
export const DEFAULT_SHOP_TIMEZONE = 'Asia/Shanghai';

const LOCAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const LOCAL_TIME_PATTERN = /^\d{2}:\d{2}(:\d{2})?$/;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function pad(value: number, length = 2): string {
  return String(value).padStart(length, '0');
}

/** 某时刻在指定时区的 UTC 偏移（毫秒，东八区为 +28800000） */
export function timeZoneOffsetMs(
  instant: Date,
  timeZone: string = DEFAULT_SHOP_TIMEZONE,
): number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = formatter.formatToParts(instant);
  const field: Record<string, number> = {};
  for (const part of parts) {
    if (part.type !== 'literal') field[part.type] = Number(part.value);
  }
  const asUtc = Date.UTC(
    field.year ?? 1970,
    (field.month ?? 1) - 1,
    field.day ?? 1,
    field.hour ?? 0,
    field.minute ?? 0,
    field.second ?? 0,
  );
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * 把「店内墙钟」解释成绝对时刻。
 *
 * `date` = `YYYY-MM-DD`，`timeText` = `HH:MM` 或 `HH:MM:SS`；
 * 二者都按 `timeZone` 的墙钟理解，返回对应的 UTC `Date`。
 */
export function shopLocalToUtc(
  date: string,
  timeText: string,
  timeZone: string = DEFAULT_SHOP_TIMEZONE,
): Date {
  assertLocalDate(date);
  if (!LOCAL_TIME_PATTERN.test(timeText))
    throw new RangeError(`非法时间：${timeText}`);
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute, second = 0] = timeText.split(':').map(Number);
  const wallAsUtc = Date.UTC(
    year as number,
    (month as number) - 1,
    day as number,
    hour as number,
    minute as number,
    second as number,
  );
  // 两轮修正：第一轮用「墙钟当作 UTC」猜偏移，第二轮用真实时刻复核（跨 DST 时必要）
  let offset = timeZoneOffsetMs(new Date(wallAsUtc), timeZone);
  offset = timeZoneOffsetMs(new Date(wallAsUtc - offset), timeZone);
  return new Date(wallAsUtc - offset);
}

/** 店内本地日 `[00:00, 次日 00:00)` 对应的绝对时刻区间 */
export function shopDayRange(
  date: string,
  timeZone: string = DEFAULT_SHOP_TIMEZONE,
): { start: Date; end: Date } {
  assertLocalDate(date);
  return {
    start: shopLocalToUtc(date, '00:00:00', timeZone),
    end: shopLocalToUtc(addLocalDays(date, 1), '00:00:00', timeZone),
  };
}

/** 把绝对时刻格式化成带偏移的 ISO8601（如 `2026-09-11T10:00:00+08:00`） */
export function formatShopDateTime(
  value: Date,
  timeZone: string = DEFAULT_SHOP_TIMEZONE,
): string {
  const offset = timeZoneOffsetMs(value, timeZone);
  const wall = new Date(value.getTime() + offset);
  const sign = offset >= 0 ? '+' : '-';
  const absOffset = Math.abs(offset);
  const offsetText = `${sign}${pad(Math.floor(absOffset / 3600000))}:${pad(
    Math.floor((absOffset % 3600000) / 60000),
  )}`;
  return (
    `${wall.getUTCFullYear()}-${pad(wall.getUTCMonth() + 1)}-${pad(wall.getUTCDate())}` +
    `T${pad(wall.getUTCHours())}:${pad(wall.getUTCMinutes())}:${pad(wall.getUTCSeconds())}` +
    offsetText
  );
}

/** 绝对时刻落在哪个店内本地日（`YYYY-MM-DD`） */
export function shopDateOf(
  value: Date,
  timeZone: string = DEFAULT_SHOP_TIMEZONE,
): string {
  const offset = timeZoneOffsetMs(value, timeZone);
  const wall = new Date(value.getTime() + offset);
  return `${wall.getUTCFullYear()}-${pad(wall.getUTCMonth() + 1)}-${pad(
    wall.getUTCDate(),
  )}`;
}

/** 店内「今天」 */
export function shopToday(
  timeZone: string = DEFAULT_SHOP_TIMEZONE,
  now: Date = new Date(),
): string {
  return shopDateOf(now, timeZone);
}

/** 本地日加减天数（纯日历运算，与时刻无关） */
export function addLocalDays(date: string, days: number): string {
  assertLocalDate(date);
  const [year, month, day] = date.split('-').map(Number);
  const shifted = new Date(
    Date.UTC(year as number, (month as number) - 1, (day as number) + days),
  );
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(
    shifted.getUTCDate(),
  )}`;
}

/** ISO 8601 星期：1=周一 … 7=周日 */
export function shopWeekday(date: string): number {
  assertLocalDate(date);
  const [year, month, day] = date.split('-').map(Number);
  const weekday = new Date(
    Date.UTC(year as number, (month as number) - 1, day as number),
  ).getUTCDay();
  return weekday === 0 ? 7 : weekday;
}

/** 两个本地日之间的天数差（`to - from`） */
export function daysBetween(from: string, to: string): number {
  assertLocalDate(from);
  assertLocalDate(to);
  const parse = (value: string): number => {
    const [year, month, day] = value.split('-').map(Number);
    return Date.UTC(year as number, (month as number) - 1, day as number);
  };
  return Math.round((parse(to) - parse(from)) / MS_PER_DAY);
}

/** 本地日区间（含两端）内的所有日期 */
export function listLocalDates(from: string, to: string): string[] {
  const total = daysBetween(from, to);
  if (total < 0) return [];
  return Array.from({ length: total + 1 }, (_, index) =>
    addLocalDays(from, index),
  );
}

/** 校验 `YYYY-MM-DD`，非法直接抛错（不静默回落，避免算错时段） */
export function assertLocalDate(date: string): void {
  if (!LOCAL_DATE_PATTERN.test(date))
    throw new RangeError(`非法本地日期：${date}（应为 YYYY-MM-DD）`);
}

/** `HH:MM:SS` → 当天 0 点起的分钟数 */
export function timeToMinutes(timeText: string): number {
  const [hour, minute] = timeText.split(':').map(Number);
  return (hour as number) * 60 + (minute as number);
}

/** 分钟数 → `HH:MM:SS` */
export function minutesToTime(minutes: number): string {
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}:00`;
}
