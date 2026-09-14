/**
 * 首页经营概览的**纯计算**部分（§20.2 口径，和 `reports.service.ts` 同源）。
 *
 * 为什么单独一个文件：首页概览的每个数字都要能**手工复核**，而区间换算、环比、
 * 成单率/退款率的分母约定最容易算错 —— 那些是纯函数，抽出来就能被单测钉住
 * （service 里只剩「查库 + 套用」）。
 *
 * 三条口径约定（改之前先看这里）：
 * 1. **比例一律返回千分比整数**（`permille`），分母为 0 时返回 `null` —— 前端显示
 *    「—」。刻意不返回 0：新店开业当天「退款率 0%」和「还没有营收」是两件事。
 * 2. **成单率**（= 首页的「下单率」）= 完成 ÷ (完成 + 取消 + 爽约)。
 *    分母**不含**待确认/进行中的单：那些还没到能判成败的时候。
 * 3. **到店率** = (到店 + 完成) ÷ (全部 − 取消)。取消是顾客主动的行为，
 *    不算「没来」，所以从分母里剔除。
 */
import { addLocalDays, daysBetween } from '../../common/shop-time.js';

/** 首页区间档位（默认「今日」——店长每天第一眼想知道的就是今天） */
export type HomeRange = 'today' | '7d' | '30d' | 'month';

export const HOME_RANGES: readonly HomeRange[] = [
  'today',
  '7d',
  '30d',
  'month',
] as const;

/** 首页趋势图固定看近 14 个店内本地日（与所选区间无关：区间换的是汇总口径） */
export const HOME_TREND_DAYS = 14;

export type HomeRangeWindow = {
  dateFrom: string;
  dateTo: string;
  /** 环比区间（上一个等长区间；本月 = 上月同期） */
  prevDateFrom: string;
  prevDateTo: string;
  /** 环比区间与主区间是否等长（月档的上月同期不一定等长，前端据此调整文案） */
  prevSameLength: boolean;
};

/**
 * 区间 → 店内本地日窗口（含两端）。
 *
 * `today` 由调用方按店内时区算好传进来（`shopToday(timeZone)`）——
 * 纯函数里不取「现在」，否则跨零点跑测试会随机失败。
 */
export function resolveHomeRange(
  range: HomeRange,
  today: string,
): HomeRangeWindow {
  if (range === 'today')
    return {
      dateFrom: today,
      dateTo: today,
      prevDateFrom: addLocalDays(today, -1),
      prevDateTo: addLocalDays(today, -1),
      prevSameLength: true,
    };

  if (range === '7d' || range === '30d') {
    const span = range === '7d' ? 7 : 30;
    const dateFrom = addLocalDays(today, -(span - 1));
    return {
      dateFrom,
      dateTo: today,
      prevDateFrom: addLocalDays(dateFrom, -span),
      prevDateTo: addLocalDays(dateFrom, -1),
      prevSameLength: true,
    };
  }

  // 本月：环比「上月同期」（上月 1 号 → 上月的同一天号，月末不足则夹到月末）。
  // 用「上月整月」对比是常见的错法 —— 月中看板会把半个月跟一整个月比。
  const dateFrom = `${today.slice(0, 7)}-01`;
  const prevMonthLastDay = addLocalDays(dateFrom, -1);
  const prevDateFrom = `${prevMonthLastDay.slice(0, 7)}-01`;
  const dayOfMonth = daysBetween(dateFrom, today);
  const prevSameDay = addLocalDays(prevDateFrom, dayOfMonth);
  return {
    dateFrom,
    dateTo: today,
    prevDateFrom,
    prevDateTo: prevSameDay > prevMonthLastDay ? prevMonthLastDay : prevSameDay,
    prevSameLength: prevSameDay <= prevMonthLastDay,
  };
}

/** 首页趋势窗口：截至今天的近 `HOME_TREND_DAYS` 个本地日 */
export function resolveTrendWindow(today: string): {
  dateFrom: string;
  dateTo: string;
} {
  return {
    dateFrom: addLocalDays(today, -(HOME_TREND_DAYS - 1)),
    dateTo: today,
  };
}

/**
 * 千分比整数；分母 ≤ 0 → `null`（=「无从谈起」，不是 0%）。
 *
 * 取整方向**向下**：与项目「金额一律向下取整、少算不多算」的既有取向一致。
 */
export function permille(
  numerator: number,
  denominator: number,
): number | null {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) return null;
  if (denominator <= 0) return null;
  return Math.floor((numerator * 1000) / denominator);
}

/** 预约单状态计数（区间内，业务日锚点 = `start_at`） */
export type BookingStatusCounts = {
  total: number;
  completed: number;
  cancelled: number;
  noShow: number;
  /** 待处理 = pending + confirmed + arrived */
  pending: number;
  arrived: number;
};

export function countBookingStatuses(
  rows: readonly { status: string }[],
): BookingStatusCounts {
  const counts: BookingStatusCounts = {
    total: rows.length,
    completed: 0,
    cancelled: 0,
    noShow: 0,
    pending: 0,
    arrived: 0,
  };
  for (const row of rows) {
    if (row.status === 'completed') counts.completed += 1;
    else if (row.status === 'cancelled') counts.cancelled += 1;
    else if (row.status === 'no_show') counts.noShow += 1;
    if (row.status === 'arrived') counts.arrived += 1;
    if (
      row.status === 'pending' ||
      row.status === 'confirmed' ||
      row.status === 'arrived'
    )
      counts.pending += 1;
  }
  return counts;
}

export type BookingRates = {
  /** 成单率 = 完成 ÷ (完成 + 取消 + 爽约) */
  completedRate: number | null;
  /** 到店率 = (到店 + 完成) ÷ (全部 − 取消) */
  arriveRate: number | null;
  /** 爽约率 = 爽约 ÷ (完成 + 取消 + 爽约) */
  noShowRate: number | null;
  /** 取消率 = 取消 ÷ 全部 */
  cancelRate: number | null;
};

export function bookingRates(counts: BookingStatusCounts): BookingRates {
  const settled = counts.completed + counts.cancelled + counts.noShow;
  return {
    completedRate: permille(counts.completed, settled),
    arriveRate: permille(
      counts.arrived + counts.completed,
      counts.total - counts.cancelled,
    ),
    noShowRate: permille(counts.noShow, settled),
    cancelRate: permille(counts.cancelled, counts.total),
  };
}

/**
 * 按 key 累加（门店分组、按日分桶都用它）。
 *
 * `keyOf` 返回 `null` 的行**直接丢弃**：无门店的历史流水在按店视角下
 * 「宁少不多」—— 塞进任何一家店都是串账（见 `store-scope` 技能）。
 */
export function sumBy<Row, K extends string | number>(
  rows: readonly Row[],
  keyOf: (row: Row) => K | null,
  valueOf: (row: Row) => number,
): Map<K, number> {
  const totals = new Map<K, number>();
  for (const row of rows) {
    const key = keyOf(row);
    if (key === null) continue;
    totals.set(key, (totals.get(key) ?? 0) + valueOf(row));
  }
  return totals;
}

/** 按 key 计数（同上，`null` 丢弃） */
export function countBy<Row, K extends string | number>(
  rows: readonly Row[],
  keyOf: (row: Row) => K | null,
): Map<K, number> {
  const totals = new Map<K, number>();
  for (const row of rows) {
    const key = keyOf(row);
    if (key === null) continue;
    totals.set(key, (totals.get(key) ?? 0) + 1);
  }
  return totals;
}

/** 环比差额与原值（`prev` 缺失 = 没有可比区间，前端显示「—」） */
export function delta(
  current: number,
  previous: number | null,
): { delta: number | null; previous: number | null } {
  if (previous === null) return { delta: null, previous: null };
  return { delta: current - previous, previous };
}
