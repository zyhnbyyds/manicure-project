import { describe, expect, it } from 'vitest';
import { distanceMeters, formatDistance, sortByDistance } from './geo';

/**
 * 门店距离：只测「能一眼判断对错」的几件事 ——
 * 坐标缺失不报错、量级对得上、缺坐标的排最后且不改动入参。
 */
describe('distanceMeters', () => {
  it('任一坐标缺失 / 非法 → null（门店没配经纬度是常态，不是错误）', () => {
    expect(distanceMeters(null, { latitude: 31, longitude: 121 })).toBeNull();
    expect(
      distanceMeters(
        { latitude: 31, longitude: 121 },
        { latitude: null, longitude: null },
      ),
    ).toBeNull();
    expect(
      distanceMeters(
        { latitude: Number.NaN, longitude: 121 },
        { latitude: 31, longitude: 121 },
      ),
    ).toBeNull();
  });

  it('同一个点距离为 0', () => {
    expect(
      distanceMeters(
        { latitude: 31.23, longitude: 121.47 },
        { latitude: 31.23, longitude: 121.47 },
      ),
    ).toBe(0);
  });

  it('量级对得上：人民广场 → 徐家汇约 6~9km', () => {
    const meters = distanceMeters(
      { latitude: 31.2304, longitude: 121.4737 },
      { latitude: 31.1837, longitude: 121.4369 },
    );
    expect(meters).not.toBeNull();
    expect(meters!).toBeGreaterThan(6000);
    expect(meters!).toBeLessThan(9000);
  });

  it('纬度差 1 度 ≈ 111km（定标，防止公式写错还「看起来像」）', () => {
    const meters = distanceMeters(
      { latitude: 0, longitude: 0 },
      { latitude: 1, longitude: 0 },
    );
    expect(meters!).toBeGreaterThan(110_000);
    expect(meters!).toBeLessThan(112_000);
  });
});

describe('formatDistance', () => {
  it('千米以内按十米取整；999m 归到 1.0km 而不是「1000m」', () => {
    expect(formatDistance(0)).toBe('0m');
    expect(formatDistance(324)).toBe('320m');
    expect(formatDistance(990)).toBe('990m');
    expect(formatDistance(999)).toBe('1.0km');
    expect(formatDistance(1420)).toBe('1.4km');
  });

  it('null（没定位或门店没坐标）→ 空串，调用方据此不显示这一行', () => {
    expect(formatDistance(null)).toBe('');
  });
});

describe('sortByDistance', () => {
  it('由近到远；缺坐标的排最后且保持原相对顺序', () => {
    const list = [
      { id: 'far', latitude: 31.2, longitude: 121.9 },
      { id: 'no-coord-1', latitude: null, longitude: null },
      { id: 'near', latitude: 31.2305, longitude: 121.474 },
      { id: 'no-coord-2', latitude: null, longitude: null },
    ];
    const sorted = sortByDistance(list, {
      latitude: 31.2304,
      longitude: 121.4737,
    });
    expect(sorted.map((item) => item.id)).toEqual([
      'near',
      'far',
      'no-coord-1',
      'no-coord-2',
    ]);
    expect(sorted[0]!.distance).toBeLessThan(100);
    expect(sorted[2]!.distance).toBeNull();
  });

  it('没定位（from = null）→ 原序返回，distance 全为 null（列表照常显示）', () => {
    const list = [
      { id: 'a', latitude: 31.2, longitude: 121.4 },
      { id: 'b', latitude: 31.1, longitude: 121.3 },
    ];
    const sorted = sortByDistance(list, null);
    expect(sorted.map((item) => item.id)).toEqual(['a', 'b']);
    expect(sorted.every((item) => item.distance === null)).toBe(true);
  });

  it('不改动入参（页面里 data 上的列表不能被就地打乱）', () => {
    const list = [
      { id: 'b', latitude: 31.3, longitude: 121.5 },
      { id: 'a', latitude: 31.2305, longitude: 121.474 },
    ];
    const before = list.map((item) => item.id);
    sortByDistance(list, { latitude: 31.2304, longitude: 121.4737 });
    expect(list.map((item) => item.id)).toEqual(before);
  });
});
