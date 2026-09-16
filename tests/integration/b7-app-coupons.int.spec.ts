/**
 * app 域我的优惠券：`GET /app/coupons`。
 *
 * 守三件事：
 * 1. **鉴权**：券是个人权益 → 未绑定手机号必须 401 + `needBind`；
 * 2. **状态现算**：`status='usable'` 但 `expire_at` 已过期的券，
 *    在接口上必须是 `expired` —— 不能依赖定时任务是否已把行翻过去；
 * 3. **字段白名单**：响应**不含** `templateId` / `remark` / 审计字段，
 *    用「键集合全等」断言（而不是「某字段存在」）。
 *
 * 注：`CouponsService.issue()`（发券）本轮没有对外的 HTTP 入口
 * （发券走后台或活动），因此这里用 SQL 直接造持有券。
 * `issue()` 会在下一轮「下单核销 / 发券入口」一起补测。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './harness';

let ctx: TestContext;

async function seedCustomer(name: string): Promise<number> {
  const inserted = await ctx.sql<{ insertId: number }>(
    `INSERT INTO biz_customer (name) VALUES (?)`,
    [name],
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

async function seedTemplate(input: {
  name: string;
  discountAmount: number;
  thresholdAmount?: number;
}): Promise<number> {
  const inserted = await ctx.sql<{ insertId: number }>(
    `INSERT INTO biz_coupon_template (name, threshold_amount, discount_amount, valid_days, status, sort)
     VALUES (?, ?, ?, 0, 'active', 1)`,
    [input.name, input.thresholdAmount ?? 0, input.discountAmount],
  );
  return inserted.insertId;
}

/**
 * 直接造持有券。`expireAt` 传 ISO 字符串或 null；
 * `daysFromNow` 为负 = 已过期。
 */
async function seedCoupon(input: {
  customerId: number;
  templateId: number;
  couponNo: string;
  discountAmount: number;
  thresholdAmount?: number;
  status?: 'usable' | 'used' | 'expired' | 'void';
  /** 相对此刻的天数；负数 = 已过期 */
  expireDays?: number | null;
}): Promise<number> {
  const expireAt =
    input.expireDays === null || input.expireDays === undefined
      ? null
      : new Date(Date.now() + input.expireDays * 86_400_000);
  const inserted = await ctx.sql<{ insertId: number }>(
    `INSERT INTO biz_customer_coupon
       (coupon_no, customer_id, template_id, discount_amount, threshold_amount, status, expire_at, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'manual')`,
    [
      input.couponNo,
      input.customerId,
      input.templateId,
      input.discountAmount,
      input.thresholdAmount ?? 0,
      input.status ?? 'usable',
      expireAt,
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

describe('app 域我的优惠券（本目标新增）', () => {
  it('未绑定手机号 → 401 + needBind', async () => {
    const { token } = await seedAppUser('coupon-unbound', null);
    const res = await ctx.request('GET', '/api/v1/app/coupons', { token });
    expect(res.status).toBe(401);
    expect((res.body as { needBind?: boolean }).needBind).toBe(true);
  });

  it('字段白名单：键集合全等，不含 templateId / 审计字段', async () => {
    const customerId = await seedCustomer('有券顾客');
    const { token } = await seedAppUser('coupon-fields', customerId);
    const templateId = await seedTemplate({
      name: '满 100 减 20',
      discountAmount: 2000,
      thresholdAmount: 10000,
    });
    await seedCoupon({
      customerId,
      templateId,
      couponNo: 'X20260912000001',
      discountAmount: 2000,
      thresholdAmount: 10000,
      expireDays: 30,
    });

    const res = await ctx.request('GET', '/api/v1/app/coupons', { token });
    expect(res.status).toBe(200);
    const items = (res.body as { items: Record<string, unknown>[] }).items;
    expect(items).toHaveLength(1);
    expect(Object.keys(items[0]).sort()).toEqual([
      'couponNo',
      'discountAmount',
      'expireAt',
      'id',
      'status',
      'templateName',
      'thresholdAmount',
      'usedAt',
    ]);
    // 券名要给顾客看（他在页面上得知道这是张什么券）
    expect(items[0].templateName).toBe('满 100 减 20');
    // 模板 id 与审计字段绝不出现在响应里
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain('templateId');
    expect(raw).not.toContain('createdBy');
    expect(items[0].discountAmount).toBe(2000);
  });

  it('过期现算：usable 但已过期的券显示为 expired，且筛选口径一致', async () => {
    const customerId = await seedCustomer('券过期顾客');
    const { token } = await seedAppUser('coupon-expired', customerId);
    const templateId = await seedTemplate({
      name: '会过期的券',
      discountAmount: 1000,
    });
    // 行状态仍是 usable，但 expire_at 已过 —— 接口必须现算成 expired
    await seedCoupon({
      customerId,
      templateId,
      couponNo: 'X20260912000002',
      discountAmount: 1000,
      status: 'usable',
      expireDays: -1,
    });

    const all = await ctx.request('GET', '/api/v1/app/coupons', { token });
    const allItems = (all.body as { items: { status: string }[] }).items;
    expect(allItems[0].status).toBe('expired');

    const expired = await ctx.request(
      'GET',
      '/api/v1/app/coupons?status=expired',
      { token },
    );
    expect((expired.body as { items: unknown[] }).items).toHaveLength(1);

    const usable = await ctx.request(
      'GET',
      '/api/v1/app/coupons?status=usable',
      { token },
    );
    expect((usable.body as { items: unknown[] }).items).toHaveLength(0);
  });

  it('只看得到自己的券（本人数据隔离）', async () => {
    const mine = await seedCustomer('我');
    const other = await seedCustomer('别人');
    const templateId = await seedTemplate({
      name: '通用券',
      discountAmount: 500,
    });
    await seedCoupon({
      customerId: mine,
      templateId,
      couponNo: 'X20260912000003',
      discountAmount: 500,
      expireDays: 10,
    });
    await seedCoupon({
      customerId: other,
      templateId,
      couponNo: 'X20260912000004',
      discountAmount: 999,
      expireDays: 10,
    });

    const { token } = await seedAppUser('coupon-mine', mine);
    const res = await ctx.request('GET', '/api/v1/app/coupons', { token });
    expect(res.status).toBe(200);
    const items = (res.body as { items: { couponNo: string }[] }).items;
    expect(items).toHaveLength(1);
    expect(items[0].couponNo).toBe('X20260912000003');
  });
});
