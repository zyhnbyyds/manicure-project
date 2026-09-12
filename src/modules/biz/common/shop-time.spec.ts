import { describe, expect, it } from 'vitest';
import {
  addLocalDays,
  daysBetween,
  formatShopDateTime,
  listLocalDates,
  minutesToTime,
  shopDateOf,
  shopDayRange,
  shopLocalToUtc,
  shopToday,
  shopWeekday,
  timeToMinutes,
  timeZoneOffsetMs,
} from './shop-time.js';

describe('shop-time', () => {
  it('把店内本地日换成绝对时刻区间（时区验收的基准断言）', () => {
    const { start, end } = shopDayRange('2026-09-11');
    expect(start.toISOString()).toBe('2026-09-10T16:00:00.000Z');
    expect(end.toISOString()).toBe('2026-09-11T16:00:00.000Z');
  });

  it('结果只由时区参数决定，与进程 TZ 无关', () => {
    const original = process.env.TZ;
    const results: string[] = [];
    for (const tz of ['UTC', 'America/New_York', 'Asia/Tokyo']) {
      process.env.TZ = tz;
      results.push(shopDayRange('2026-09-11').start.toISOString());
      results.push(shopLocalToUtc('2026-09-11', '10:00:00').toISOString());
    }
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
    expect(new Set(results)).toEqual(
      new Set(['2026-09-10T16:00:00.000Z', '2026-09-11T02:00:00.000Z']),
    );
  });

  it('墙钟换算支持 HH:MM 与 HH:MM:SS，秒级精度不丢', () => {
    expect(shopLocalToUtc('2026-09-11', '10:00').toISOString()).toBe(
      '2026-09-11T02:00:00.000Z',
    );
    expect(shopLocalToUtc('2026-09-11', '23:59:59').toISOString()).toBe(
      '2026-09-11T15:59:59.000Z',
    );
  });

  it('非法本地日期直接抛错（不静默回落，避免算错时段）', () => {
    expect(() => shopDayRange('2026-9-11')).toThrow(RangeError);
    expect(() => shopDayRange('20260911')).toThrow(RangeError);
    expect(() => shopLocalToUtc('2026-09-11', '10时')).toThrow(RangeError);
  });

  it('格式化成带偏移的 ISO8601', () => {
    expect(formatShopDateTime(new Date('2026-09-11T02:00:00.000Z'))).toBe(
      '2026-09-11T10:00:00+08:00',
    );
  });

  it('shopDateOf 是 shopLocalToUtc 的逆运算', () => {
    expect(shopDateOf(new Date('2026-09-11T02:00:00.000Z'))).toBe('2026-09-11');
    // 边界：UTC 15:59 仍是店内当天，UTC 16:00 已经是次日
    expect(shopDateOf(new Date('2026-09-11T15:59:59.000Z'))).toBe('2026-09-11');
    expect(shopDateOf(new Date('2026-09-11T16:00:00.000Z'))).toBe('2026-09-12');
  });

  it('日期加减与天数差是纯日历运算', () => {
    expect(addLocalDays('2026-09-11', 3)).toBe('2026-09-14');
    expect(addLocalDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addLocalDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(daysBetween('2026-09-11', '2026-10-11')).toBe(30);
    expect(listLocalDates('2026-09-11', '2026-09-14')).toEqual([
      '2026-09-11',
      '2026-09-12',
      '2026-09-13',
      '2026-09-14',
    ]);
  });

  it('ISO 星期：1=周一 … 7=周日', () => {
    expect(shopWeekday('2026-09-11')).toBe(5); // 周五
    expect(shopWeekday('2026-09-13')).toBe(7); // 周日
    expect(shopWeekday('2026-09-14')).toBe(1); // 周一
  });

  it('时间字符串与分钟数互转', () => {
    expect(timeToMinutes('10:30:00')).toBe(630);
    expect(minutesToTime(630)).toBe('10:30:00');
    expect(minutesToTime(timeToMinutes('00:05:00'))).toBe('00:05:00');
  });

  it('时区偏移推导正确', () => {
    expect(timeZoneOffsetMs(new Date('2026-09-11T02:00:00.000Z'))).toBe(
      8 * 3600 * 1000,
    );
    expect(timeZoneOffsetMs(new Date('2026-09-11T02:00:00.000Z'), 'UTC')).toBe(
      0,
    );
  });

  it('shopToday 落在店内当天（UTC 16:00 之后算次日）', () => {
    expect(
      shopToday('Asia/Shanghai', new Date('2026-09-11T15:59:59.000Z')),
    ).toBe('2026-09-11');
    expect(
      shopToday('Asia/Shanghai', new Date('2026-09-11T16:00:00.000Z')),
    ).toBe('2026-09-12');
  });
});
