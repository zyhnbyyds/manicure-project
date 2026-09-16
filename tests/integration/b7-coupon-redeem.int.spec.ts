/**
 * 券核销的**并发红线**：`CouponsService.redeemForBooking`。
 *
 * 这一组用例不经过 HTTP（还没有建单接线），而是**从 Nest 容器里直接取
 * `CouponsService` 与 `DatabaseService`**，在真实事务里调用 ——
 * 因为要守的不变量是「同一张券不可能被两单同时用掉」，
 * 只有并发场景能证明，纯单线程的 200 断言证明不了。
 *
 * 为什么可以直接取 provider：`TestContext.app` 是完整的
 * `NestFastifyApplication`，`app.get(SomeService)` 拿到的就是运行时同一个单例。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseService } from '../../src/database/database.service';
import { CouponsService } from '../../src/modules/biz/membership/coupons/coupons.service';
import { createTestContext, type TestContext } from './harness';

let ctx: TestContext;
let coupons: CouponsService;
let database: DatabaseService;

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
}): Promise<number> {
  const inserted = await ctx.sql<{ insertId: number }>(
    `INSERT INTO biz_coupon_template (name, threshold_amount, discount_amount, valid_days, status, sort)
     VALUES (?, ?, ?, 0, 'active', 1)`,
    [input.name, input.thresholdAmount ?? 0, input.discountAmount],
  );
  return inserted.insertId;
}

async function seedCoupon(input: {
  customerId: number;
  templateId: number;
  couponNo: string;
  discountAmount: number;
  thresholdAmount?: number;
  /** 负数 = 已过期；null = 长期有效 */
  expireDays?: number | null;
}): Promise<number> {
  const expireAt =
    input.expireDays === null || input.expireDays === undefined
      ? null
      : new Date(Date.now() + input.expireDays * 86_400_000);
  const inserted = await ctx.sql<{ insertId: number }>(
    `INSERT INTO biz_customer_coupon
       (coupon_no, customer_id, template_id, discount_amount, threshold_amount, status, expire_at, source)
     VALUES (?, ?, ?, ?, ?, 'usable', ?, 'manual')`,
    [
      input.couponNo,
      input.customerId,
      input.templateId,
      input.discountAmount,
      input.thresholdAmount ?? 0,
      expireAt,
    ],
  );
  return inserted.insertId;
}

/** 在真实事务里核销一次；返回结果或抛出的错误 */
async function redeemOnce(input: {
  couponId: number;
  customerId: number;
  baseAmount: number;
}): Promise<
  { ok: true; discountAmount: number } | { ok: false; status: number }
> {
  try {
    const result = await database.db.transaction(async (tx) =>
      coupons.redeemForBooking(tx, {
        couponId: input.couponId,
        customerId: input.customerId,
        bookingId: null,
        baseAmount: input.baseAmount,
      }),
    );
    return { ok: true, discountAmount: result.discountAmount };
  } catch (error) {
    const status = (error as { status?: number }).status ?? 0;
    return { ok: false, status };
  }
}

async function statusOf(couponId: number): Promise<string> {
  const rows = await ctx.sql<{ status: string }>(
    `SELECT status FROM biz_customer_coupon WHERE id = ?`,
    [couponId],
  );
  return rows[0]?.status ?? '';
}

beforeAll(async () => {
  ctx = await createTestContext();
  coupons = ctx.app.get(CouponsService);
  database = ctx.app.get(DatabaseService);
}, 120_000);

// 显式给足超时：`resetBusinessData()` 在整套回归满载时可能超过 vitest 默认的 10 秒，
// 会给整个套件带来随机红（本文件曾因此挂过一次）；与既有 spec 的 beforeAll(..., 120_000) 同一约定。
beforeEach(async () => {
  await ctx.resetBusinessData();
}, 60_000);

afterAll(async () => {
  await ctx.close();
});

describe('券核销（§15 / money-invariants）', () => {
  it('正常核销：状态翻成 used、返回夹取后的抵扣额', async () => {
    const customerId = await seedCustomer('正常核销');
    const templateId = await seedTemplate({
      name: '满 100 减 20',
      discountAmount: 2000,
      thresholdAmount: 10000,
    });
    const couponId = await seedCoupon({
      customerId,
      templateId,
      couponNo: 'X20260912000011',
      discountAmount: 2000,
      thresholdAmount: 10000,
      expireDays: 30,
    });

    const result = await redeemOnce({
      couponId,
      customerId,
      baseAmount: 15000,
    });
    expect(result).toEqual({ ok: true, discountAmount: 2000 });
    expect(await statusOf(couponId)).toBe('used');
  });

  it('抵扣额不超过券后基准（券不能把单抵成负数）', async () => {
    const customerId = await seedCustomer('小额单');
    const templateId = await seedTemplate({
      name: '大额券',
      discountAmount: 5000,
    });
    const couponId = await seedCoupon({
      customerId,
      templateId,
      couponNo: 'X20260912000012',
      discountAmount: 5000,
      expireDays: 30,
    });

    const result = await redeemOnce({
      couponId,
      customerId,
      baseAmount: 3000,
    });
    expect(result).toEqual({ ok: true, discountAmount: 3000 });
  });

  it('未达门槛 → 409，且券仍是 usable（失败不得消耗券）', async () => {
    const customerId = await seedCustomer('不到门槛');
    const templateId = await seedTemplate({
      name: '满 200 减 50',
      discountAmount: 5000,
      thresholdAmount: 20000,
    });
    const couponId = await seedCoupon({
      customerId,
      templateId,
      couponNo: 'X20260912000013',
      discountAmount: 5000,
      thresholdAmount: 20000,
      expireDays: 30,
    });

    const result = await redeemOnce({
      couponId,
      customerId,
      baseAmount: 10000,
    });
    expect(result).toEqual({ ok: false, status: 409 });
    // 关键：失败的尝试不能把券吃掉
    expect(await statusOf(couponId)).toBe('usable');
  });

  it('已过期的券 → 409（即使行状态还是 usable）', async () => {
    const customerId = await seedCustomer('过期券');
    const templateId = await seedTemplate({
      name: '过期券模板',
      discountAmount: 1000,
    });
    const couponId = await seedCoupon({
      customerId,
      templateId,
      couponNo: 'X20260912000014',
      discountAmount: 1000,
      expireDays: -1,
    });

    const result = await redeemOnce({
      couponId,
      customerId,
      baseAmount: 10000,
    });
    expect(result).toEqual({ ok: false, status: 409 });
  });

  it('别人的券 → 409（不泄露归属）', async () => {
    const owner = await seedCustomer('券主');
    const other = await seedCustomer('别人');
    const templateId = await seedTemplate({
      name: '通用券',
      discountAmount: 1000,
    });
    const couponId = await seedCoupon({
      customerId: owner,
      templateId,
      couponNo: 'X20260912000015',
      discountAmount: 1000,
      expireDays: 30,
    });

    const result = await redeemOnce({
      couponId,
      customerId: other,
      baseAmount: 10000,
    });
    expect(result).toEqual({ ok: false, status: 409 });
    expect(await statusOf(couponId)).toBe('usable');
  });

  it('**并发核销同一张券：恰好一次成功**（一券多用的红线）', async () => {
    const customerId = await seedCustomer('并发用券');
    const templateId = await seedTemplate({
      name: '并发券',
      discountAmount: 3000,
    });
    const couponId = await seedCoupon({
      customerId,
      templateId,
      couponNo: 'X20260912000016',
      discountAmount: 3000,
      expireDays: 30,
    });

    const results = await Promise.all([
      redeemOnce({ couponId, customerId, baseAmount: 10000 }),
      redeemOnce({ couponId, customerId, baseAmount: 10000 }),
      redeemOnce({ couponId, customerId, baseAmount: 10000 }),
    ]);

    const ok = results.filter((r) => r.ok);
    const conflict = results.filter((r) => !r.ok);
    expect(ok).toHaveLength(1);
    expect(conflict).toHaveLength(2);
    expect(conflict.every((r) => !r.ok && r.status === 409)).toBe(true);
    expect(await statusOf(couponId)).toBe('used');
  });
});
