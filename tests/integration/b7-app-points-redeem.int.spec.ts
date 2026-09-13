/**
 * app 域积分兑换：`POST /app/points/redeem`。
 *
 * 这一组用例守的是 `money-invariants` 的红线，不是「能不能跑通」：
 * 1. **身份**：兑换必须要绑定（401 + needBind），且顾客身份只从 token 来；
 * 2. **扣减是条件更新**：积分不足 → 409，**并发兑换不会把积分扣成负数**；
 * 3. **不重算**：积分与发卡由后台 `PointsGoodsService.redeem()` 的同事务实现完成，
 *    app 域只做转发 —— 所以这里断言「积分真的少了、次卡真的多了一张」，
 *    而不是只断言 HTTP 200。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './harness.js';

let ctx: TestContext;

/** 造一位已绑定顾客（`biz_customer` 只有 `name` 是必填） */
async function seedCustomer(name: string, points: number): Promise<number> {
  const inserted = await ctx.sql<{ insertId: number }>(
    `INSERT INTO biz_customer (name, points) VALUES (?, ?)`,
    [name, points],
  );
  return inserted.insertId;
}

/** 造小程序身份；`customerId` 传 null = 未绑定手机号 */
async function seedAppUser(openid: string, customerId: number | null) {
  const inserted = await ctx.sql<{ insertId: number }>(
    `INSERT INTO app_wx_user (openid, customer_id, staff_status) VALUES (?, ?, 'none')`,
    [openid, customerId],
  );
  return {
    appUserId: inserted.insertId,
    token: await ctx.appToken(openid, inserted.insertId),
  };
}

async function seedCardType(name: string): Promise<number> {
  const inserted = await ctx.sql<{ insertId: number }>(
    `INSERT INTO biz_member_card_type (name, price, total_times) VALUES (?, 0, 1)`,
    [name],
  );
  return inserted.insertId;
}

async function seedGoods(input: {
  name: string;
  cardTypeId: number;
  points: number;
  perLimit?: number;
  stock?: number;
}): Promise<number> {
  const inserted = await ctx.sql<{ insertId: number }>(
    `INSERT INTO biz_points_goods (name, card_type_id, points, stock, per_limit, status, sort)
     VALUES (?, ?, ?, ?, ?, 'active', 1)`,
    [
      input.name,
      input.cardTypeId,
      input.points,
      input.stock ?? -1,
      input.perLimit ?? 0,
    ],
  );
  return inserted.insertId;
}

async function pointsOf(customerId: number): Promise<number> {
  const rows = await ctx.sql<{ points: number }>(
    `SELECT points FROM biz_customer WHERE id = ?`,
    [customerId],
  );
  return Number(rows[0]?.points ?? -1);
}

async function cardCountOf(customerId: number): Promise<number> {
  const rows = await ctx.sql<{ total: number }>(
    `SELECT COUNT(*) AS total FROM biz_member_card WHERE customer_id = ? AND deleted_at IS NULL`,
    [customerId],
  );
  return Number(rows[0]?.total ?? 0);
}

beforeAll(async () => {
  ctx = await createTestContext();
}, 120_000);

// 显式给足超时：`resetBusinessData()` 在整套回归满载时可能超过 vitest 默认的 10 秒，
// 会给整个套件带来随机红（本文件曾因此挂过一次）；与既有 spec 的 beforeAll(..., 120_000) 同一约定。
beforeEach(async () => {
  await ctx.resetBusinessData();
}, 60_000);

afterAll(async () => {
  await ctx.close();
});

describe('app 域积分兑换（§15.3 / money-invariants）', () => {
  it('未绑定手机号 → 401 + needBind（兑换必须要身份）', async () => {
    const { token } = await seedAppUser('redeem-unbound', null);
    const cardTypeId = await seedCardType('测试单次卡');
    const goodsId = await seedGoods({
      name: '可兑换项目',
      cardTypeId,
      points: 100,
    });

    const res = await ctx.request('POST', '/api/v1/app/points/redeem', {
      token,
      body: { goodsId },
    });
    expect(res.status).toBe(401);
    expect((res.body as { needBind?: boolean }).needBind).toBe(true);
  });

  it('积分不足 → 409，且积分与次卡都不变', async () => {
    const customerId = await seedCustomer('缺分顾客', 50);
    const { token } = await seedAppUser('redeem-poor', customerId);
    const cardTypeId = await seedCardType('测试单次卡');
    const goodsId = await seedGoods({
      name: '贵的项目',
      cardTypeId,
      points: 1000,
    });

    const res = await ctx.request('POST', '/api/v1/app/points/redeem', {
      token,
      body: { goodsId },
    });
    expect(res.status).toBe(409);
    expect(await pointsOf(customerId)).toBe(50);
    expect(await cardCountOf(customerId)).toBe(0);
  });

  it('兑换成功：积分真的扣了、次卡真的发了一张', async () => {
    const customerId = await seedCustomer('有分顾客', 5000);
    const { token } = await seedAppUser('redeem-ok', customerId);
    const cardTypeId = await seedCardType('纯色美甲单次卡');
    const goodsId = await seedGoods({
      name: '可兑换项目',
      cardTypeId,
      points: 1500,
    });

    const res = await ctx.request('POST', '/api/v1/app/points/redeem', {
      token,
      body: { goodsId },
    });
    expect(res.status).toBe(200);
    const body = res.body as {
      redeemNo: string;
      points: number;
      cardNo: string;
    };
    expect(body.points).toBe(1500);
    expect(body.cardNo).toMatch(/^C\d{8}\d+$/);

    // 断言账实相符，而不是只看 200
    expect(await pointsOf(customerId)).toBe(3500);
    expect(await cardCountOf(customerId)).toBe(1);

    // 兑换记录与积分流水都要落
    const redeems = await ctx.sql<{ total: number }>(
      `SELECT COUNT(*) AS total FROM biz_points_redeem WHERE customer_id = ? AND status = 'success'`,
      [customerId],
    );
    expect(Number(redeems[0]?.total)).toBe(1);
  });

  it('并发兑换：积分只够一次时，恰好一次成功且积分不为负', async () => {
    // 积分刚好等于单价 → 两次并发里只能有一次成功
    const customerId = await seedCustomer('并发顾客', 1500);
    const { token } = await seedAppUser('redeem-race', customerId);
    const cardTypeId = await seedCardType('测试单次卡');
    const goodsId = await seedGoods({
      name: '并发兑换品',
      cardTypeId,
      points: 1500,
      stock: -1,
      perLimit: 0,
    });

    const results = await Promise.all([
      ctx.request('POST', '/api/v1/app/points/redeem', {
        token,
        body: { goodsId },
      }),
      ctx.request('POST', '/api/v1/app/points/redeem', {
        token,
        body: { goodsId },
      }),
      ctx.request('POST', '/api/v1/app/points/redeem', {
        token,
        body: { goodsId },
      }),
    ]);

    const ok = results.filter((r) => r.status === 200);
    const conflict = results.filter((r) => r.status === 409);
    expect(ok).toHaveLength(1);
    expect(conflict).toHaveLength(2);

    // 红线：积分永不为负，且恰好扣一次
    const left = await pointsOf(customerId);
    expect(left).toBe(0);
    expect(left).toBeGreaterThanOrEqual(0);
    expect(await cardCountOf(customerId)).toBe(1);
  });

  it('每人限兑：达到上限后再兑 → 409', async () => {
    const customerId = await seedCustomer('限兑顾客', 10000);
    const { token } = await seedAppUser('redeem-limit', customerId);
    const cardTypeId = await seedCardType('测试单次卡');
    const goodsId = await seedGoods({
      name: '限兑一次的商品',
      cardTypeId,
      points: 1000,
      perLimit: 1,
    });

    const first = await ctx.request('POST', '/api/v1/app/points/redeem', {
      token,
      body: { goodsId },
    });
    expect(first.status).toBe(200);

    const second = await ctx.request('POST', '/api/v1/app/points/redeem', {
      token,
      body: { goodsId },
    });
    expect(second.status).toBe(409);
    // 第二次被拒，积分不再减少
    expect(await pointsOf(customerId)).toBe(9000);
  });
});
