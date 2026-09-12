/**
 * app 域积分兑换品目录：`GET /app/points-goods`。
 *
 * 这一组用例守两件事：
 * 1. **鉴权边界**：只要 app token，**不要求绑定手机号** —— 这是非个人的目录信息，
 *    未绑定用户也能先看到「能换什么」，到兑换那一步才需要身份；
 * 2. **字段白名单（§8.3）**：响应只能有兑换所需的六个字段，
 *    **不得出现后台 `remark`、成本与审计字段**。这条用「键集合全等」断言，
 *    而不是「某字段存在」—— 后者挡不住以后有人顺手把整行 spread 出去。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './harness.js';

let ctx: TestContext;

/** 造一条小程序身份（等价于已 `wx.login` 拿到 token、但没授权手机号） */
async function seedAppUser(openid: string) {
  const inserted = await ctx.sql<{ insertId: number }>(
    `INSERT INTO app_wx_user (openid, nickname, staff_status) VALUES (?, NULL, 'none')`,
    [openid],
  );
  return {
    appUserId: inserted.insertId,
    token: await ctx.appToken(openid, inserted.insertId),
  };
}

/** 积分兑换品直接指向卡种（兑换 = 发一张次卡），所以先要有一个卡种 */
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
  status: 'active' | 'disabled';
  perLimit?: number;
  /** 后台备注：**不应该**出现在 app 侧响应里 */
  remark?: string;
}): Promise<number> {
  const inserted = await ctx.sql<{ insertId: number }>(
    `INSERT INTO biz_points_goods (name, card_type_id, points, stock, per_limit, status, sort, remark)
     VALUES (?, ?, ?, -1, ?, ?, 1, ?)`,
    [
      input.name,
      input.cardTypeId,
      input.points,
      input.perLimit ?? 0,
      input.status,
      input.remark ?? null,
    ],
  );
  return inserted.insertId;
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

describe('app 域积分兑换品目录（§15.3 / §8.3）', () => {
  it('未带 app token → 401', async () => {
    const res = await ctx.request('GET', '/api/v1/app/points-goods', {
      token: null,
    });
    expect(res.status).toBe(401);
  });

  it('未绑定手机号也能读目录（非个人数据，不触发 needBind）', async () => {
    const { token } = await seedAppUser('points-guest');
    const cardTypeId = await seedCardType('测试单次卡');
    await seedGoods({
      name: '可兑换项目',
      cardTypeId,
      points: 1500,
      status: 'active',
    });

    const res = await ctx.request('GET', '/api/v1/app/points-goods', { token });
    expect(res.status).toBe(200);
    // 关键：这里是 200 而不是 401 + needBind —— 目录不要求绑定
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({
      name: '可兑换项目',
      points: 1500,
      stock: -1,
      perLimit: 0,
      cardTypeName: '测试单次卡',
    });
  });

  it('只返回上架商品（disabled 不出现）', async () => {
    const { token } = await seedAppUser('points-only-active');
    const cardTypeId = await seedCardType('测试单次卡');
    await seedGoods({
      name: '上架的',
      cardTypeId,
      points: 1000,
      status: 'active',
    });
    await seedGoods({
      name: '下架的',
      cardTypeId,
      points: 2000,
      status: 'disabled',
    });

    const res = await ctx.request('GET', '/api/v1/app/points-goods', { token });
    expect(res.status).toBe(200);
    const names = (res.body.items as { name: string }[]).map((g) => g.name);
    expect(names).toContain('上架的');
    expect(names).not.toContain('下架的');
  });

  it('字段白名单：响应键集合全等，不含 remark 与审计字段', async () => {
    const { token } = await seedAppUser('points-fields');
    const cardTypeId = await seedCardType('测试单次卡');
    await seedGoods({
      name: '带备注的商品',
      cardTypeId,
      points: 1200,
      status: 'active',
      perLimit: 2,
      remark: '后台备注：这个不该外泄',
    });

    const res = await ctx.request('GET', '/api/v1/app/points-goods', { token });
    expect(res.status).toBe(200);
    const first = (res.body.items as Record<string, unknown>[])[0];
    // 用键集合全等断言：多一个字段就失败（这是 §8.3 的硬要求）
    expect(Object.keys(first).sort()).toEqual([
      'cardTypeName',
      'id',
      'name',
      'perLimit',
      'points',
      'stock',
    ]);
    expect(JSON.stringify(res.body)).not.toContain('后台备注');
    expect(res.body.items[0].perLimit).toBe(2);
  });
});
