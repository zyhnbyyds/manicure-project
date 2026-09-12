/**
 * 给顾客发券（后台）：`POST /api/v1/biz/members/:id/coupons`。
 *
 * 三条口径：
 * 1. **允许重复发放** —— 补偿、活动补发都是正常诉求，所以不做「已持有就拒绝」
 *    （顾客侧的自助领券才是「一次一张」，那是另一回事）。这里用测试**固定住**这个差异，
 *    免得以后有人"顺手"加上去重把合法诉求挡掉；
 * 2. 停用模板不能发放（404/409）；
 * 3. **并发发券不重号**：单号是「主键回填」，并发下必须各自唯一。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './harness.js';

let ctx: TestContext;

async function seedCustomer(name: string): Promise<number> {
  const inserted = await ctx.sql<{ insertId: number }>(
    `INSERT INTO biz_customer (name) VALUES (?)`,
    [name],
  );
  return inserted.insertId;
}

async function seedTemplate(input: {
  name: string;
  discountAmount: number;
  thresholdAmount?: number;
  status?: 'active' | 'disabled';
}): Promise<number> {
  const inserted = await ctx.sql<{ insertId: number }>(
    `INSERT INTO biz_coupon_template (name, threshold_amount, discount_amount, valid_days, status, sort)
     VALUES (?, ?, ?, 30, ?, 1)`,
    [
      input.name,
      input.thresholdAmount ?? 0,
      input.discountAmount,
      input.status ?? 'active',
    ],
  );
  return inserted.insertId;
}

beforeAll(async () => {
  ctx = await createTestContext();
}, 120_000);

beforeEach(async () => {
  await ctx.resetBusinessData();
}, 60_000);

afterAll(async () => {
  await ctx.close();
});

describe('后台发券（本目标新增）', () => {
  it('发券成功：券进顾客名下，面额/门槛按模板快照', async () => {
    const customerId = await seedCustomer('后台发券顾客');
    const templateId = await seedTemplate({
      name: '满 50 减 10',
      thresholdAmount: 5000,
      discountAmount: 1000,
    });

    const issued = await ctx.request(
      'POST',
      `/api/v1/biz/members/${customerId}/coupons`,
      { body: { templateId } },
    );
    expect(issued.status).toBe(201);
    const coupon = issued.body as {
      couponNo: string;
      discountAmount: number;
      thresholdAmount: number;
      status: string;
      source: string;
    };
    expect(coupon.discountAmount).toBe(1000);
    expect(coupon.thresholdAmount).toBe(5000);
    expect(coupon.status).toBe('usable');
    // 后台发的券标记来源，便于日后对账区分（claim = 顾客自助领）
    expect(coupon.source).toBe('admin');

    // 回查顾客的券列表
    const list = await ctx.request(
      'GET',
      `/api/v1/biz/members/${customerId}/coupons`,
    );
    expect(list.status).toBe(200);
    const items = (list.body as { items: { couponNo: string }[] }).items;
    expect(items).toHaveLength(1);
    expect(items[0].couponNo).toBe(coupon.couponNo);
  });

  it('**允许重复发放**（补偿/补发是正常诉求，与顾客自助领券不同）', async () => {
    const customerId = await seedCustomer('重复发券顾客');
    const templateId = await seedTemplate({ name: '补偿券', discountAmount: 2000 });

    const first = await ctx.request(
      'POST',
      `/api/v1/biz/members/${customerId}/coupons`,
      { body: { templateId } },
    );
    const second = await ctx.request(
      'POST',
      `/api/v1/biz/members/${customerId}/coupons`,
      { body: { templateId } },
    );
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);

    const rows = await ctx.sql<{ total: number }>(
      `SELECT COUNT(*) AS total FROM biz_customer_coupon WHERE customer_id = ?`,
      [customerId],
    );
    expect(Number(rows[0]?.total)).toBe(2);
  });

  it('停用的模板不能发放 → 409', async () => {
    const customerId = await seedCustomer('停用模板顾客');
    const templateId = await seedTemplate({
      name: '已停用券',
      discountAmount: 1000,
      status: 'disabled',
    });

    const res = await ctx.request(
      'POST',
      `/api/v1/biz/members/${customerId}/coupons`,
      { body: { templateId } },
    );
    expect(res.status).toBe(409);
  });

  it('模板不存在 → 404', async () => {
    const customerId = await seedCustomer('不存在模板');
    const res = await ctx.request(
      'POST',
      `/api/v1/biz/members/${customerId}/coupons`,
      { body: { templateId: 999999 } },
    );
    expect(res.status).toBe(404);
  });

  it('**并发发券：单号各不相同**（主键回填在并发下必须唯一）', async () => {
    const customerId = await seedCustomer('并发发券顾客');
    const templateId = await seedTemplate({ name: '并发券', discountAmount: 500 });

    const results = await Promise.all([
      ctx.request('POST', `/api/v1/biz/members/${customerId}/coupons`, {
        body: { templateId },
      }),
      ctx.request('POST', `/api/v1/biz/members/${customerId}/coupons`, {
        body: { templateId },
      }),
      ctx.request('POST', `/api/v1/biz/members/${customerId}/coupons`, {
        body: { templateId },
      }),
    ]);

    expect(results.every((r) => r.status === 201)).toBe(true);
    const numbers = results.map((r) => (r.body as { couponNo: string }).couponNo);
    // 单号唯一索引兜底；这里断言三张号互不相同
    expect(new Set(numbers).size).toBe(3);
    // 单号不是占位号（`TMP...`）—— 事务内回填成功
    expect(numbers.every((no) => no.startsWith('X'))).toBe(true);
  });
});
