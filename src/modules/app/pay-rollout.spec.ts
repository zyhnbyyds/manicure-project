import { describe, expect, it } from 'vitest';
import { bucketOf, inPayRollout } from './pay-rollout.js';

/**
 * 灰度分桶的回归。
 *
 * 这组用例守的是三件很容易「看起来对、实际不生效」的事：
 * 1. **稳定性** —— 同一身份必须永远得到同一答案（不能刷新一次跳一次）；
 * 2. **比例真的对得上** —— 30% 就该约等于 30% 的人，而不是全放或全不放；
 * 3. **两端一致** —— `bucketOf` 只有一个实现，`/app/member/me` 与
 *    `/app/bookings/:id/settle` 必然同一个结论（可见却付不了是最难查的一类 bug）。
 */
describe('小程序自助支付灰度分桶', () => {
  it('桶值恒在 0..99（含边界，不能出现负数桶）', () => {
    for (let id = 1; id <= 5000; id += 1) {
      const bucket = bucketOf(String(id));
      expect(bucket).toBeGreaterThanOrEqual(0);
      expect(bucket).toBeLessThan(100);
    }
    // 极端键也不能越界
    for (const key of ['', 'openid-😀-很长的中文键', 'x'.repeat(4096)]) {
      expect(bucketOf(key)).toBeGreaterThanOrEqual(0);
      expect(bucketOf(key)).toBeLessThan(100);
    }
  });

  it('同一身份结果恒定（这是灰度能用下去的前提）', () => {
    for (const id of [1, 42, 999, 123456]) {
      const first = bucketOf(String(id));
      for (let round = 0; round < 5; round += 1) {
        expect(bucketOf(String(id))).toBe(first);
      }
    }
  });

  it('percent=0 → 谁都不放（只预约模式）；percent=100 → 全放', () => {
    for (let id = 1; id <= 200; id += 1) {
      expect(inPayRollout(id, 0)).toBe(false);
      expect(inPayRollout(id, 100)).toBe(true);
    }
    // 边界外的值也不该反过来
    expect(inPayRollout(1, -10)).toBe(false);
    expect(inPayRollout(1, 1000)).toBe(true);
  });

  it('比例真的约等于配置值（容差 ±3 个百分点，样本 2 万）', () => {
    const total = 20000;
    for (const percent of [10, 30, 50]) {
      let hit = 0;
      for (let id = 1; id <= total; id += 1) {
        if (inPayRollout(id, percent)) hit += 1;
      }
      const actual = (hit / total) * 100;
      expect(
        Math.abs(actual - percent),
        `${percent}% 实际放量 ${actual.toFixed(2)}%`,
      ).toBeLessThanOrEqual(3);
    }
  });

  it('放量是单调的：调高比例只会让更多人进来，不会把已放量的人踢出去', () => {
    const at30 = new Set<number>();
    for (let id = 1; id <= 2000; id += 1) {
      if (inPayRollout(id, 30)) at30.add(id);
    }
    for (const id of at30) {
      expect(inPayRollout(id, 50)).toBe(true);
      expect(inPayRollout(id, 100)).toBe(true);
    }
  });
});
