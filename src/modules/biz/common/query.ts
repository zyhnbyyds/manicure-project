import { and, gte, like, lt, type SQL } from 'drizzle-orm';
import type { MySqlColumn } from 'drizzle-orm/mysql-core';
import {
  DEFAULT_SHOP_TIMEZONE,
  addLocalDays,
  shopDayRange,
} from './shop-time.js';

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

/** 列表分页统一口径：返回 `{ items, page, pageSize }`，**没有 total**（§3 约定 4） */
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
