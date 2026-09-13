/**
 * 顾客自助领券：`GET /app/coupon-offers` + `POST /app/coupons/claim`。
 *
 * 守四条：
 * 1. **必须要身份**（领了就是个人权益）→ 未绑定 401 + needBind；
 * 2. 领到的券**真的进「我的优惠券」**（不只是接口返回 200）；
 * 3. **重复领 409** —— 同一张券反复领就是薅羊毛；
 * 4. **并发领同一张恰好成功一次**（服务端事务内锁模板行串行化）。
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

/** `customerId` 传 null = 未绑定手机号 */
async function seedAppUser(openid: string, customerId: number | null) {
  const inserted = await ctx.sql<{ insertId: number }>(
    `INSERT INTO app_wx_user (openid, customer_id, staff_status) VALUES (?, ?, 'none')`,
    [openid, customerId],
  );
  return { token: await ctx.appToken(openid, inserted.insertId) };
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

describe('顾客自助领券（本目标新增）', () => {
  it('未绑定手机号 → 401 + needBind', async () => {
    const { token } = await seedAppUser('claim-unbound', null);
    const res = await ctx.request('GET', '/api/v1/app/coupon-offers', {
      token,
    });
    expect(res.status).toBe(401);
    expect((res.body as { needBind?: boolean }).needBind).toBe(true);
  });

  it('可领取列表只给上架模板；领过之后不再出现', async () => {
    const customerId = await seedCustomer('领券顾客');
    const { token } = await seedAppUser('claim-offers', customerId);
    const active = await seedTemplate({ name: '可领券', discountAmount: 2000 });
    await seedTemplate({
      name: '已停发券',
      discountAmount: 1000,
      status: 'disabled',
    });

    const before = await ctx.request('GET', '/api/v1/app/coupon-offers', {
      token,
    });
    expect(before.status).toBe(200);
    const items = (before.body as { items: { id: number; name: string }[] })
      .items;
    expect(items.map((i) => i.name)).toEqual(['可领券']);

    // 领了之后：列表里不再出现它
    const claim = await ctx.request('POST', '/api/v1/app/coupons/claim', {
      token,
      body: { templateId: active },
    });
    expect(claim.status).toBe(200);

    const after = await ctx.request('GET', '/api/v1/app/coupon-offers', {
      token,
    });
    expect((after.body as { items: unknown[] }).items).toHaveLength(0);
  });

  it('领到的券真的进「我的优惠券」', async () => {
    const customerId = await seedCustomer('券到账顾客');
    const { token } = await seedAppUser('claim-mine', customerId);
    const templateId = await seedTemplate({
      name: '满 50 减 10',
      discountAmount: 1000,
      thresholdAmount: 5000,
    });

    const claim = await ctx.request('POST', '/api/v1/app/coupons/claim', {
      token,
      body: { templateId },
    });
    expect(claim.status).toBe(200);
    const claimed = claim.body as {
      couponNo: string;
      discountAmount: number;
      thresholdAmount: number;
      status: string;
    };
    expect(claimed.discountAmount).toBe(1000);
    expect(claimed.thresholdAmount).toBe(5000);
    expect(claimed.status).toBe('usable');

    // 关键：不是「接口返回 200」就算，回查我的券列表
    const mine = await ctx.request('GET', '/api/v1/app/coupons', { token });
    const items = (mine.body as { items: { couponNo: string }[] }).items;
    expect(items).toHaveLength(1);
    expect(items[0].couponNo).toBe(claimed.couponNo);
  });

  it('重复领 → 409（同一张券不能反复领）', async () => {
    const customerId = await seedCustomer('重复领顾客');
    const { token } = await seedAppUser('claim-repeat', customerId);
    const templateId = await seedTemplate({
      name: '只能领一张',
      discountAmount: 500,
    });

    const first = await ctx.request('POST', '/api/v1/app/coupons/claim', {
      token,
      body: { templateId },
    });
    expect(first.status).toBe(200);

    const second = await ctx.request('POST', '/api/v1/app/coupons/claim', {
      token,
      body: { templateId },
    });
    expect(second.status).toBe(409);

    // 且库里只有一张（失败的尝试不能多插一张）
    const rows = await ctx.sql<{ total: number }>(
      `SELECT COUNT(*) AS total FROM biz_customer_coupon WHERE customer_id = ? AND status = 'usable'`,
      [customerId],
    );
    expect(Number(rows[0]?.total)).toBe(1);
  });

  it('**并发领同一张券：恰好成功一次**', async () => {
    const customerId = await seedCustomer('并发领顾客');
    const { token } = await seedAppUser('claim-race', customerId);
    const templateId = await seedTemplate({
      name: '并发券',
      discountAmount: 800,
    });

    const results = await Promise.all([
      ctx.request('POST', '/api/v1/app/coupons/claim', {
        token,
        body: { templateId },
      }),
      ctx.request('POST', '/api/v1/app/coupons/claim', {
        token,
        body: { templateId },
      }),
      ctx.request('POST', '/api/v1/app/coupons/claim', {
        token,
        body: { templateId },
      }),
    ]);

    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(2);

    const rows = await ctx.sql<{ total: number }>(
      `SELECT COUNT(*) AS total FROM biz_customer_coupon WHERE customer_id = ?`,
      [customerId],
    );
    // 红线：并发下也只能有一张
    expect(Number(rows[0]?.total)).toBe(1);
  });
});
