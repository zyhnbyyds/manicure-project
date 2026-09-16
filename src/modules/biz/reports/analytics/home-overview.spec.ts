import { describe, expect, it } from 'vitest';
import {
  bookingRates,
  countBookingStatuses,
  countBy,
  permille,
  resolveHomeRange,
  resolveTrendWindow,
  sumBy,
} from './home-overview';

/**
 * 首页经营概览的口径回归。
 *
 * 这些是纯函数，但**错误方式极其隐蔽**：区间差一天、环比拿整月对比半个月、
 * 退款率分母取错，页面上都只是「数字看起来有点怪」，没人能一眼看出来。
 * 所以把口径钉成断言 —— 与 §20.2「每个数字都要能手工复核」同一个理由。
 */
describe('首页概览区间（含环比）', () => {
  it('今日：主区间 = 当天，环比 = 昨天', () => {
    expect(resolveHomeRange('today', '2026-09-15')).toEqual({
      dateFrom: '2026-09-15',
      dateTo: '2026-09-15',
      prevDateFrom: '2026-09-14',
      prevDateTo: '2026-09-14',
      prevSameLength: true,
    });
  });

  it('近 7 日：含当天共 7 天，环比是紧邻的上一段 7 天（不重叠）', () => {
    expect(resolveHomeRange('7d', '2026-09-15')).toEqual({
      dateFrom: '2026-09-09',
      dateTo: '2026-09-15',
      prevDateFrom: '2026-09-02',
      prevDateTo: '2026-09-08',
      prevSameLength: true,
    });
  });

  it('近 30 日：含当天共 30 天，环比不重叠', () => {
    const window = resolveHomeRange('30d', '2026-09-15');
    expect(window.dateFrom).toBe('2026-08-17');
    expect(window.prevDateTo).toBe('2026-08-16');
    expect(window.prevSameLength).toBe(true);
  });

  it('本月：环比是**上月同期**，不是上月整月（月中不能拿半个月比一个月）', () => {
    expect(resolveHomeRange('month', '2026-09-15')).toEqual({
      dateFrom: '2026-09-01',
      dateTo: '2026-09-15',
      prevDateFrom: '2026-08-01',
      prevDateTo: '2026-08-15',
      prevSameLength: true,
    });
  });

  it('本月：跨月天数不足时（3/31 → 2 月没有 31 号）夹到上月最后一天并标记不等长', () => {
    expect(resolveHomeRange('month', '2026-03-31')).toEqual({
      dateFrom: '2026-03-01',
      dateTo: '2026-03-31',
      prevDateFrom: '2026-02-01',
      prevDateTo: '2026-02-28',
      prevSameLength: false,
    });
  });

  it('趋势窗口固定近 14 天（与所选区间无关）', () => {
    expect(resolveTrendWindow('2026-09-15')).toEqual({
      dateFrom: '2026-09-02',
      dateTo: '2026-09-15',
    });
  });
});

describe('千分比口径', () => {
  it('分母为 0 → null（「还没有营收」和「退款率 0%」是两件事）', () => {
    expect(permille(0, 0)).toBeNull();
    expect(permille(5, 0)).toBeNull();
  });

  it('向下取整，不四舍五入（少算不多算）', () => {
    expect(permille(1, 3)).toBe(333);
    expect(permille(2, 3)).toBe(666);
    expect(permille(1, 1)).toBe(1000);
    expect(permille(0, 10)).toBe(0);
  });
});

describe('预约单转化率', () => {
  const rows = [
    { status: 'completed' },
    { status: 'completed' },
    { status: 'completed' },
    { status: 'cancelled' },
    { status: 'no_show' },
    { status: 'arrived' },
    { status: 'confirmed' },
    { status: 'pending' },
  ];

  it('计数：待处理 = pending + confirmed + arrived，取消/爽约单列', () => {
    expect(countBookingStatuses(rows)).toEqual({
      total: 8,
      completed: 3,
      cancelled: 1,
      noShow: 1,
      arrived: 1,
      pending: 3,
    });
  });

  it('成单率 = 完成 ÷ (完成+取消+爽约)，**待确认/进行中的单不进分母**', () => {
    const rates = bookingRates(countBookingStatuses(rows));
    // 3 / (3+1+1) = 600‰
    expect(rates.completedRate).toBe(600);
    expect(rates.noShowRate).toBe(200);
  });

  it('到店率 = (到店+完成) ÷ (全部 − 取消)：取消是顾客主动行为，不算「没来」', () => {
    const rates = bookingRates(countBookingStatuses(rows));
    // (1 + 3) / (8 - 1) = 571‰
    expect(rates.arriveRate).toBe(571);
  });

  it('一张单都没有时全是 null，不是 0%（前端显示「—」）', () => {
    const rates = bookingRates(countBookingStatuses([]));
    expect(rates.completedRate).toBeNull();
    expect(rates.arriveRate).toBeNull();
    expect(rates.noShowRate).toBeNull();
    expect(rates.cancelRate).toBeNull();
  });
});

describe('分组累加', () => {
  const rows = [
    { storeId: 1 as number | null, amount: 100 },
    { storeId: 1, amount: 200 },
    { storeId: 2, amount: 50 },
    // 无门店的历史流水：按店视角下**宁少不多**，不进任何门店
    { storeId: null, amount: 999 },
  ];

  it('sumBy：按门店累加，`storeId = null` 的行被丢弃', () => {
    const totals = sumBy(
      rows,
      (row) => (row.storeId === null ? null : String(row.storeId)),
      (row) => row.amount,
    );
    expect(totals.get('1')).toBe(300);
    expect(totals.get('2')).toBe(50);
    expect(totals.size).toBe(2);
  });

  it('countBy：按日计数（趋势零填充靠它）', () => {
    const byDay = countBy(
      [{ day: '2026-09-15' }, { day: '2026-09-15' }, { day: '2026-09-16' }],
      (row) => row.day,
    );
    expect(byDay.get('2026-09-15')).toBe(2);
    expect(byDay.get('2026-09-16')).toBe(1);
    expect(byDay.get('2026-09-17')).toBeUndefined();
  });
});
