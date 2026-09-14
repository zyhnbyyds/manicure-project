/**
 * app 域（`/api/v1/app/**`）的时刻序列化**唯一入口**。
 *
 * 契约（见 `dto/app-vo.ts` 的 `isoDateTime`）：app 域所有时刻都是
 * **带店内偏移的 ISO8601**，例如 `2026-09-11T10:00:00+08:00`。
 *
 * 为什么必须是「带偏移」而不是 `toISOString()`（`...Z`）：
 * 小程序端**直读字符串**来显示时间（`isoClockTime()` 取 `T` 后的 `HH:mm`、
 * `.slice(0, 10)` 取日期），刻意不做设备时区换算 —— 这样顾客手机时区一变，
 * 「约的 10:00」也还是 10:00。返回 UTC 会让所有时刻在东八区**整体偏 8 小时**，
 * 跨日时日期还会**差一天**（本地 09-16 00:30 = UTC 09-15 16:30）。
 *
 * 所以：app 域**禁止**再用 `date.toISOString()` 输出时刻，一律走这里。
 */
import { BizConfigService } from '../../biz/common/biz-config.service.js';
import {
  DEFAULT_SHOP_TIMEZONE,
  formatShopDateTime,
} from '../../biz/common/shop-time.js';

/** 绝对时刻 → 带店内偏移的 ISO8601（`2026-09-11T10:00:00+08:00`） */
export function appIso(
  value: Date,
  timeZone: string = DEFAULT_SHOP_TIMEZONE,
): string {
  return formatShopDateTime(value, timeZone);
}

/** 同上，`null` / `undefined` 原样返回 `null`（可空字段用） */
export function appIsoOrNull(
  value: Date | null | undefined,
  timeZone: string = DEFAULT_SHOP_TIMEZONE,
): string | null {
  return value ? formatShopDateTime(value, timeZone) : null;
}

/**
 * 读门店配置里的店内时区（`biz.booking.timezone`，默认 `Asia/Shanghai`）。
 *
 * 各 service 自己再用一行私有方法包一层即可（`return appShopTimeZone(this.bizConfig)`），
 * 这样时区**只有一个读取入口**，也不会每处调用都写一遍 `(await ...).timezone`。
 * `BizConfigService` 内部有 10s 缓存，逐次调用不会打库。
 */
export async function appShopTimeZone(
  config: BizConfigService,
): Promise<string> {
  return (await config.booking()).timezone;
}
