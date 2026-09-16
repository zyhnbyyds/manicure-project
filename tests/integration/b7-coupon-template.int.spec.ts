/**
 * 券模板维护（后台）：`/api/v1/biz/coupon-templates`。
 *
 * 守四条：
 * 1. CRUD 正常，且**同名 → 409**（不是把 1062 抛给前端）；
 * 2. 业务校验：面额大于门槛 → 400；
 * 3. **停用/删除模板不影响已发出的券** —— 面额与门槛在发券时已快照，
 *    模板只是「以后还发不发」的开关。这条最容易在重构时被破坏；
 * 4. 列表给出 `claimedCount`，让运营看得见停用的影响面。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './harness';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
}, 120_000);

beforeEach(async () => {
  await ctx.resetBusinessData();
}, 60_000);

afterAll(async () => {
  await ctx.close();
});

describe('券模板维护（后台，本目标新增）', () => {
  it('新增 → 详情可查；同名再建 → 409', async () => {
    const created = await ctx.request('POST', '/api/v1/biz/coupon-templates', {
      body: {
        name: '满 100 减 20',
        thresholdAmount: 10000,
        discountAmount: 2000,
        validDays: 30,
      },
    });
    expect(created.status).toBe(201);
    const id = (created.body as { id: number }).id;
    expect(id).toBeGreaterThan(0);

    const detail = await ctx.request(
      'GET',
      `/api/v1/biz/coupon-templates/${id}`,
    );
    expect(detail.status).toBe(200);
    expect((detail.body as { name: string }).name).toBe('满 100 减 20');
    expect((detail.body as { discountAmount: number }).discountAmount).toBe(
      2000,
    );

    // 同名：靠 uq_coupon_template_name 兜底，映射成 409 而不是 500
    const dup = await ctx.request('POST', '/api/v1/biz/coupon-templates', {
      body: { name: '满 100 减 20', discountAmount: 1000 },
    });
    expect(dup.status).toBe(409);
  });

  it('业务校验：面额大于门槛 → 400', async () => {
    const res = await ctx.request('POST', '/api/v1/biz/coupon-templates', {
      body: { name: '不合理券', thresholdAmount: 5000, discountAmount: 8000 },
    });
    expect(res.status).toBe(400);
  });

  it('列表：按状态筛选，并给出 claimedCount', async () => {
    await ctx.request('POST', '/api/v1/biz/coupon-templates', {
      body: { name: '上架券', discountAmount: 1000 },
    });
    const disabled = await ctx.request('POST', '/api/v1/biz/coupon-templates', {
      body: { name: '停用券', discountAmount: 1000, status: 'disabled' },
    });
    expect(disabled.status).toBe(201);

    const all = await ctx.request('GET', '/api/v1/biz/coupon-templates');
    expect(all.status).toBe(200);
    expect((all.body as { items: unknown[] }).items).toHaveLength(2);

    const active = await ctx.request(
      'GET',
      '/api/v1/biz/coupon-templates?status=active',
    );
    const names = (active.body as { items: { name: string }[] }).items.map(
      (item) => item.name,
    );
    expect(names).toEqual(['上架券']);

    // 没发过券时 claimedCount 为 0
    expect(
      (all.body as { items: { claimedCount: number }[] }).items[0].claimedCount,
    ).toBe(0);
  });

  it('修改模板', async () => {
    const created = await ctx.request('POST', '/api/v1/biz/coupon-templates', {
      body: { name: '待改券', discountAmount: 1000 },
    });
    const id = (created.body as { id: number }).id;

    const updated = await ctx.request(
      'PATCH',
      `/api/v1/biz/coupon-templates/${id}`,
      { body: { discountAmount: 3000, thresholdAmount: 10000 } },
    );
    expect(updated.status).toBe(200);
    expect((updated.body as { discountAmount: number }).discountAmount).toBe(
      3000,
    );

    // 只改一个字段不该把别的字段清掉（合并语义）
    expect((updated.body as { name: string }).name).toBe('待改券');
  });

  it('**停用模板不影响已发出的券**（面额/门槛在发券时已快照）', async () => {
    // 造顾客 + 模板 + 发一张券
    const customer = await ctx.sql<{ insertId: number }>(
      `INSERT INTO biz_customer (name) VALUES ('持券顾客')`,
    );
    const created = await ctx.request('POST', '/api/v1/biz/coupon-templates', {
      body: {
        name: '要停用的券',
        thresholdAmount: 10000,
        discountAmount: 2000,
        validDays: 30,
      },
    });
    const templateId = (created.body as { id: number }).id;

    // 用 service 发券（后台发券接口还没做，见待办）
    const coupons = ctx.app.get(
      (await import('../../src/modules/biz/membership/coupons/coupons.service'))
        .CouponsService,
    );
    const issued = await coupons.issue({
      customerId: customer.insertId,
      templateId,
      actorId: null,
    });
    expect(issued.discountAmount).toBe(2000);

    // 列表里 claimedCount 看得到
    const list = await ctx.request('GET', '/api/v1/biz/coupon-templates');
    expect(
      (list.body as { items: { claimedCount: number }[] }).items[0]
        .claimedCount,
    ).toBe(1);

    // 停用（软删）
    const removed = await ctx.request(
      'DELETE',
      `/api/v1/biz/coupon-templates/${templateId}`,
    );
    expect(removed.status).toBe(200);

    // 模板从列表消失
    const after = await ctx.request('GET', '/api/v1/biz/coupon-templates');
    expect((after.body as { items: unknown[] }).items).toHaveLength(0);

    // **但顾客手里那张券完好、可用、面额不变** —— 这是本节最关键的断言
    const rows = await ctx.sql<{
      status: string;
      discount_amount: number;
      threshold_amount: number;
    }>(
      `SELECT status, discount_amount, threshold_amount FROM biz_customer_coupon WHERE id = ?`,
      [issued.id],
    );
    expect(rows[0].status).toBe('usable');
    expect(rows[0].discount_amount).toBe(2000);
    expect(rows[0].threshold_amount).toBe(10000);
  });
});
