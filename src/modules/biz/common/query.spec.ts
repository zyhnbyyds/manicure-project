import { describe, expect, it } from 'vitest';
import { Param, type SQL } from 'drizzle-orm';
import { configs } from '../../../database/schema/index.js';
import {
  andConditions,
  DEFAULT_PAGE_SIZE,
  keywordLike,
  localDateRange,
  MAX_PAGE_SIZE,
  parsePagination,
} from './query.js';

/**
 * 递归取出 SQL 条件里的绑定参数值。
 *
 * `and()` 会把子条件嵌成新的 SQL 节点，所以必须递归。drizzle 的 `like()`
 * 把字符串参数直接放进 chunk（生成 SQL 时仍会参数化成 `?`），
 * 因此除 `Param` 实例外还要收集裸字符串/数字。
 */
function boundValues(condition: SQL): unknown[] {
  const collected: unknown[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === 'string' || typeof node === 'number') {
      collected.push(node);
      return;
    }
    if (!node || typeof node !== 'object') return;
    if (node instanceof Param) {
      collected.push(node.value);
      return;
    }
    const chunks = (node as { queryChunks?: unknown[] }).queryChunks;
    if (Array.isArray(chunks)) chunks.forEach(walk);
  };
  walk(condition);
  return collected;
}

describe('biz/common/query', () => {
  describe('parsePagination（§3 约定 4：返回 items/page/pageSize，没有 total）', () => {
    it('缺省时回落到第 1 页、每页 20 条', () => {
      expect(parsePagination()).toEqual({
        page: 1,
        pageSize: DEFAULT_PAGE_SIZE,
        offset: 0,
      });
      expect(parsePagination(undefined, undefined)).toEqual({
        page: 1,
        pageSize: DEFAULT_PAGE_SIZE,
        offset: 0,
      });
    });

    it('字符串入参按数字解析，offset 由页码推导', () => {
      expect(parsePagination('3', '50')).toEqual({
        page: 3,
        pageSize: 50,
        offset: 100,
      });
      expect(parsePagination(2, 10)).toEqual({
        page: 2,
        pageSize: 10,
        offset: 10,
      });
    });

    it('页码下限为 1，非法页码回落', () => {
      expect(parsePagination('0').page).toBe(1);
      expect(parsePagination('-5').page).toBe(1);
      expect(parsePagination('abc').page).toBe(1);
    });

    it('每页条数被夹在 [1, MAX_PAGE_SIZE]', () => {
      expect(parsePagination(1, 0).pageSize).toBe(DEFAULT_PAGE_SIZE);
      expect(parsePagination(1, -3).pageSize).toBe(1);
      expect(parsePagination(1, 1000).pageSize).toBe(MAX_PAGE_SIZE);
      expect(parsePagination(1, 'abc').pageSize).toBe(DEFAULT_PAGE_SIZE);
    });

    it('小数一律向下取整', () => {
      expect(parsePagination('3.9', '50.8')).toEqual({
        page: 3,
        pageSize: 50,
        offset: 100,
      });
    });
  });

  describe('keywordLike', () => {
    it('空关键字（含纯空白）返回 undefined，便于条件数组占位过滤', () => {
      expect(keywordLike(configs.key)).toBeUndefined();
      expect(keywordLike(configs.key, '')).toBeUndefined();
      expect(keywordLike(configs.key, '   ')).toBeUndefined();
    });

    it('关键字去首尾空格后按 %kw% 模糊匹配', () => {
      const condition = keywordLike(configs.key, '  门店  ');
      expect(condition).toBeDefined();
      expect(boundValues(condition!)).toContain('%门店%');
    });
  });

  describe('localDateRange（店内本地日 → 绝对时刻区间）', () => {
    it('只给 from：生成左闭下界', () => {
      const condition = localDateRange(configs.key, '2026-09-11');
      expect(boundValues(condition!)).toEqual([
        new Date('2026-09-10T16:00:00.000Z'),
      ]);
    });

    it('只给 to：右边界取 to+1 天的 00:00，保证 to 当天全部包含', () => {
      const condition = localDateRange(configs.key, undefined, '2026-09-11');
      expect(boundValues(condition!)).toEqual([
        new Date('2026-09-11T16:00:00.000Z'),
      ]);
    });

    it('给区间：两端都是店内本地日 00:00 的 UTC 换算结果', () => {
      const condition = localDateRange(configs.key, '2026-09-11', '2026-09-13');
      expect(boundValues(condition!)).toEqual([
        new Date('2026-09-10T16:00:00.000Z'),
        new Date('2026-09-13T16:00:00.000Z'),
      ]);
    });

    it('两端都缺省时返回 undefined', () => {
      expect(localDateRange(configs.key)).toBeUndefined();
      expect(localDateRange(configs.key, '', '')).toBeUndefined();
    });

    it('时区参数可覆盖默认店内时区（同一本地日 → 不同绝对时刻）', () => {
      const condition = localDateRange(
        configs.key,
        '2026-09-11',
        undefined,
        'UTC',
      );
      expect(boundValues(condition!)).toEqual([
        new Date('2026-09-11T00:00:00.000Z'),
      ]);
    });
  });

  describe('andConditions', () => {
    it('过滤掉 undefined；无条件时返回 undefined（不产生空 AND）', () => {
      expect(andConditions([])).toBeUndefined();
      expect(andConditions([undefined, undefined])).toBeUndefined();
    });

    it('有有效条件时拼成 AND，且只保留有效条件的参数', () => {
      const condition = andConditions([
        keywordLike(configs.key, '门店'),
        localDateRange(configs.key, '2026-09-11'),
        undefined,
      ]);
      expect(condition).toBeDefined();
      expect(boundValues(condition!)).toEqual([
        '%门店%',
        new Date('2026-09-10T16:00:00.000Z'),
      ]);
    });
  });
});
