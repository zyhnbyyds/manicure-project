/**
 * 列表分页的 `total`（2026-09-16 起：后端返回 total，前端 `useTable` 用它算页数）。
 *
 * 这一组只盯一件事：**`total` 与 `items` 必须是同一套 `where` 算出来的**。
 * 分页器的页数、跳页、空态文案全都建立在它上面，所以用真 SQL 验三条：
 * 1. 翻页不改 total（页码只影响 items）；
 * 2. 过滤会把 total 一起收窄（少写一个条件 → 前端显示的页数就是假的）；
 * 3. 软删的行不计入（软删是默认过滤，不能只在 items 上生效）。
 *
 * 为什么非要有集成用例：service 单测里跑的是 mock，`readCount()` 永远拿到空结果 →
 * total 恒为 0，压根验不到「count 的 where 与 items 一致」这件事。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './harness';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await ctx.resetBusinessData();
});

async function seedCustomer(name: string, phone: string): Promise<number> {
  const res = await ctx.request('POST', '/api/v1/biz/customers', {
    body: { name, phone },
  });
  expect(res.status).toBe(201);
  return res.body.id as number;
}

describe('列表响应带 total（/biz/customers）', () => {
  it('total 是过滤后的总数：翻页不变、关键字收窄、软删后减少', async () => {
    const ids = [
      await seedCustomer('张三', '13800001001'),
      await seedCustomer('李四', '13800001002'),
      await seedCustomer('王五', '13800001003'),
    ];

    // 第 1 页：items 受 pageSize 限制，total 是全部
    const first = await ctx.request(
      'GET',
      '/api/v1/biz/customers?page=1&pageSize=2',
    );
    expect(first.status).toBe(200);
    expect(first.body.items).toHaveLength(2);
    expect(first.body.total).toBe(3);
    expect(first.body.page).toBe(1);
    expect(first.body.pageSize).toBe(2);

    // 第 2 页：只剩 1 条，但 total 不变（页码不影响总数）
    const second = await ctx.request(
      'GET',
      '/api/v1/biz/customers?page=2&pageSize=2',
    );
    expect(second.body.items).toHaveLength(1);
    expect(second.body.total).toBe(3);

    // 关键字过滤：total 与 items 同口径
    const filtered = await ctx.request(
      'GET',
      `/api/v1/biz/customers?keyword=${encodeURIComponent('张三')}`,
    );
    expect(filtered.body.items).toHaveLength(1);
    expect(filtered.body.total).toBe(1);

    // 软删一条：默认列表不该再把它算进 total
    const removed = await ctx.request(
      'DELETE',
      `/api/v1/biz/customers/${ids[0]}`,
    );
    expect([200, 204]).toContain(removed.status);
    const afterDelete = await ctx.request('GET', '/api/v1/biz/customers');
    expect(afterDelete.body.total).toBe(2);

    // 而 status=deleted 这一档能查到它（total 与 items 依旧同口径）
    const deleted = await ctx.request(
      'GET',
      '/api/v1/biz/customers?status=deleted',
    );
    expect(deleted.body.items).toHaveLength(1);
    expect(deleted.body.total).toBe(1);
  });
});
