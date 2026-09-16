import { and, gte, like, lt, type SQL } from 'drizzle-orm';
import type { MySqlColumn } from 'drizzle-orm/mysql-core';
import { DEFAULT_SHOP_TIMEZONE, addLocalDays, shopDayRange } from './shop-time';

export const DEFAULT_PAGE_SIZE = 20;

/**
 * 单页条数硬上限。
 *
 * 这只是一个**防误用**的闸门（有人手拼 `?pageSize=100000` 时不要把服务拉爆），
 * 不是业务约束：列表响应现在带 `total`，前端不再需要「多取一条」判下一页，
 * 所以不必再给前端预留那一条的余量。
 * 各 controller 的 `pageSize` zod schema 必须引用本常量，别再写死数字。
 */
export const MAX_PAGE_SIZE = 200;

/**
 * 列表分页统一口径：返回 `{ items, page, pageSize, total }`（§3 约定 4）。
 *
 * ## `total` 怎么算（新增，别再把它当估算值）
 *
 * 与 `items` 用**完全相同的 `from` / `join` / `where`** 再跑一次
 * `select({ value: count() })`，只去掉 `orderBy / limit / offset`：
 *
 * ```ts
 * const where = andConditions([...]);
 * const [rows, counted] = await Promise.all([
 *   db.select()...where(where).orderBy(...).limit(pageSize).offset(offset),
 *   db.select({ value: count() }).from(x)...where(where),
 * ]);
 * return { items: rows.map(toItem), total: readCount(counted), page, pageSize };
 * ```
 *
 * 两条查询的 from/join 必须**一字不差**：少一个 join，`where` 里引用那张表的列会直接报错；
 * 多一个 join，`total` 与 `items` 就对不上（一对多 join 会放大行数）。
 * 软删标记、门店范围、关键字等**所有过滤条件只能写一份**（先拼进 `where` 变量再两处复用）。
 */
export function parsePagination(
  rawPage?: string | number,
  rawPageSize?: string | number,
): { page: number; pageSize: number; offset: number } {
  const page = Math.max(Math.trunc(Number(rawPage)) || 1, 1);
  const pageSize = Math.min(
    Math.max(Math.trunc(Number(rawPageSize)) || DEFAULT_PAGE_SIZE, 1),
    MAX_PAGE_SIZE,
  );
  return { page, pageSize, offset: (page - 1) * pageSize };
}

/**
 * 从 `select({ value: count() })` 的结果里取数字。
 *
 * `COUNT(*)` 是 BIGINT，mysql2 为免精度丢失会回**字符串**，
 * 所以统一在这里 `Number()` —— 否则 `total` 会以 `"42"` 形式跑到前端，
 * `page * pageSize < total` 这类比较就会因为隐式转换写出奇怪的 bug。
 */
export function readCount(rows: { value: unknown }[] | undefined): number {
  const value = Number(rows?.[0]?.value ?? 0);
  return Number.isFinite(value) ? value : 0;
}

/** 关键字模糊匹配（`%kw%`）；空关键字返回 undefined，便于条件数组占位过滤 */
export function keywordLike(
  column: MySqlColumn,
  keyword?: string,
): SQL | undefined {
  const value = keyword?.trim();
  if (!value) return undefined;
  return like(column, `%${value}%`);
}

/**
 * 「店内本地日 → 绝对时刻区间」的列表筛选条件。
 *
 * `from` / `to` 均为**店内本地日**（含两端）；`to` 当天全部包含，
 * 因此右边界取 `to + 1 天` 的 00:00。
 */
export function localDateRange(
  column: MySqlColumn,
  from?: string,
  to?: string,
  timeZone: string = DEFAULT_SHOP_TIMEZONE,
): SQL | undefined {
  if (!from && !to) return undefined;
  const start = from ? shopDayRange(from, timeZone).start : undefined;
  const end = to
    ? shopDayRange(addLocalDays(to, 1), timeZone).start
    : undefined;
  if (start && end) return and(gte(column, start), lt(column, end));
  if (start) return gte(column, start);
  return end ? lt(column, end) : undefined;
}

/** 过滤 undefined 条件，拼成 AND（无条件时返回 undefined） */
export function andConditions(
  conditions: (SQL | undefined)[],
): SQL | undefined {
  const list = conditions.filter((item): item is SQL => item !== undefined);
  if (!list.length) return undefined;
  return and(...list);
}
