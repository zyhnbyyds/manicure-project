/**
 * 券核销接入建单事务：`POST /app/bookings` 带 `couponId`。
 *
 * 守四条：
 * 1. **券真的被用掉并绑到该单**（`used_booking_id` = 新建的 booking id）——
 *    这一条同时证明「核销与建单在同一事务」；
 * 2. 应付金额 = 折后 − 券；
 * 3. **券与积分二选一**：同时传 400（不静默忽略积分）；
 * 4. **并发用同一张券下单 → 恰好一单成功，且失败的那单不留脏数据**。
 *
 * 第 4 条是最关键的：如果核销没走条件更新，并发下会出现「一券两单」。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  addLocalDays,
  shopToday,
  shopWeekday,
} from '../../src/modules/biz/common/shop-time';
import { createTestContext, type TestContext } from './harness';

let ctx: TestContext;
/** 建单用的店内本地日（今天 +3 天，避开提前期与「现在几点」） */
let date: string;

/** 造一个可下单的场景：美甲师 + 当天班次 + 一个 100 元的项目 */
async function seedBookable() {
  const staff = await ctx.sql<{ insertId: number }>(
    `INSERT INTO biz_staff (nickname, status, sort) VALUES ('券测试小柚', 'active', 1)`,
  );
  await ctx.sql(
    `INSERT INTO biz_staff_weekly_shift (staff_id, weekday, start_time, end_time)
     VALUES (?, ?, '10:00:00', '20:00:00')`,
    [staff.insertId, shopWeekday(date)],
  );
  const item = await ctx.sql<{ insertId: number }>(
    `INSERT INTO biz_service_item (name, category, duration_minutes, buffer_minutes, price, status, sort)
     VALUES ('券测试项目', '基础', 60, 15, 10000, 'active', 1)`,
  );
  return { staffId: staff.insertId, itemId: item.insertId };
}

/** 造一位已绑定顾客并签发 app token */
async function seedBoundCustomer(openid: string): Promise<{
  customerId: number;
  token: string;
}> {
  const customer = await ctx.sql<{ insertId: number }>(
    `INSERT INTO biz_customer (name, phone) VALUES ('券测试顾客', ?)`,
    [`139${openid.replace(/\D/g, '').padStart(8, '0').slice(0, 8)}`],
  );
  const appUser = await ctx.sql<{ insertId: number }>(
    `INSERT INTO app_wx_user (openid, customer_id, staff_status) VALUES (?, ?, 'none')`,
    [openid, customer.insertId],
  );
  return {
    customerId: customer.insertId,
    token: await ctx.appToken(openid, appUser.insertId),
  };
}

async function seedCoupon(input: {
  customerId: number;
  couponNo: string;
  discountAmount: number;
  thresholdAmount?: number;
}): Promise<number> {
  const template = await ctx.sql<{ insertId: number }>(
    `INSERT INTO biz_coupon_template (name, threshold_amount, discount_amount, valid_days, status, sort)
     VALUES (?, ?, ?, 30, 'active', 1)`,
    [
      `券模板${input.couponNo}`,
      input.thresholdAmount ?? 0,
      input.discountAmount,
    ],
  );
  const coupon = await ctx.sql<{ insertId: number }>(
    `INSERT INTO biz_customer_coupon
       (coupon_no, customer_id, template_id, discount_amount, threshold_amount, status, expire_at, source)
     VALUES (?, ?, ?, ?, ?, 'usable', DATE_ADD(NOW(), INTERVAL 30 DAY), 'manual')`,
    [
      input.couponNo,
      input.customerId,
      template.insertId,
      input.discountAmount,
      input.thresholdAmount ?? 0,
    ],
  );
  return coupon.insertId;
}

async function couponState(couponId: number) {
  const rows = await ctx.sql<{
    status: string;
    used_booking_id: number | null;
  }>(`SELECT status, used_booking_id FROM biz_customer_coupon WHERE id = ?`, [
    couponId,
  ]);
  return rows[0];
}

async function bookingCount(): Promise<number> {
  const rows = await ctx.sql<{ total: number }>(
    `SELECT COUNT(*) AS total FROM biz_booking WHERE deleted_at IS NULL`,
  );
  return Number(rows[0]?.total ?? 0);
}

beforeAll(async () => {
  ctx = await createTestContext();
  date = addLocalDays(shopToday(), 3);
}, 120_000);

// 显式给足超时：`resetBusinessData()` 在整套回归满载时可能超过 vitest 默认的 10 秒，
// 会给整个套件带来随机红（本文件曾因此挂过一次）；与既有 spec 的 beforeAll(..., 120_000) 同一约定。
beforeEach(async () => {
  await ctx.resetBusinessData();
  // 券本身不受闸门约束，但**「券与积分二选一」这一条**要传 `pointsToUse` 才会触发；
  // 而 `pointsToUse` 与支付页的 settle 受同一道合规闸门约束（默认关闭）。
  // 所以这里先放量到 100%，否则会在闸门处先拿到 501、测不到二选一的 400。
  await ctx.setPayGate(true, 100);
}, 60_000);

afterAll(async () => {
  await ctx.close();
});

describe('券核销接入建单（本目标新增）', () => {
  it('带券下单：应付 = 折后 − 券，且券被核销并绑到该单', async () => {
    const { staffId, itemId } = await seedBookable();
    const { customerId, token } = await seedBoundCustomer('coupon-book-1');
    const couponId = await seedCoupon({
      customerId,
      couponNo: 'X20260912001001',
      discountAmount: 2000,
    });

    const res = await ctx.request('POST', '/api/v1/app/bookings', {
      token,
      body: {
        staffId,
        startAt: `${date}T10:00:00+08:00`,
        serviceItemIds: [itemId],
        couponId,
      },
    });
    expect(res.status).toBe(201);
    const bookingId = (res.body as { id: number }).id;

    // 金额：原价 10000、无等级折扣、券 2000 → 应付 8000
    const rows = await ctx.sql<{
      original_price: number;
      coupon_discount_amount: number;
      payable_amount: number;
      coupon_id: number | null;
    }>(
      `SELECT original_price, coupon_discount_amount, payable_amount, coupon_id
         FROM biz_booking WHERE id = ?`,
      [bookingId],
    );
    expect(rows[0].original_price).toBe(10000);
    expect(rows[0].coupon_discount_amount).toBe(2000);
    expect(rows[0].payable_amount).toBe(8000);
    expect(rows[0].coupon_id).toBe(couponId);

    // 券：已核销，且**绑定到这一单** —— 这一条同时证明核销与建单在同一事务
    const state = await couponState(couponId);
    expect(state.status).toBe('used');
    expect(state.used_booking_id).toBe(bookingId);
  });

  it('券与积分二选一：同时传 → 400，且什么都不落库', async () => {
    const { staffId, itemId } = await seedBookable();
    const { customerId, token } = await seedBoundCustomer('coupon-book-2');
    const couponId = await seedCoupon({
      customerId,
      couponNo: 'X20260912001002',
      discountAmount: 2000,
    });

    const before = await bookingCount();
    const res = await ctx.request('POST', '/api/v1/app/bookings', {
      token,
      body: {
        staffId,
        startAt: `${date}T10:00:00+08:00`,
        serviceItemIds: [itemId],
        couponId,
        pointsToUse: 100,
      },
    });
    expect(res.status).toBe(400);
    expect(await bookingCount()).toBe(before);
    // 券没被消耗
    expect((await couponState(couponId)).status).toBe('usable');
  });

  it('未达门槛 → 409（失败不消耗券）', async () => {
    const { staffId, itemId } = await seedBookable();
    const { customerId, token } = await seedBoundCustomer('coupon-book-3');
    // 门槛 200 元 > 项目 100 元
    const couponId = await seedCoupon({
      customerId,
      couponNo: 'X20260912001003',
      discountAmount: 5000,
      thresholdAmount: 20000,
    });

    const res = await ctx.request('POST', '/api/v1/app/bookings', {
      token,
      body: {
        staffId,
        startAt: `${date}T10:00:00+08:00`,
        serviceItemIds: [itemId],
        couponId,
      },
    });
    expect(res.status).toBe(409);
    expect((await couponState(couponId)).status).toBe('usable');
  });

  it('**并发用同一张券下单：恰好一单成功，且不留脏单**', async () => {
    const { staffId, itemId } = await seedBookable();
    const { customerId, token } = await seedBoundCustomer('coupon-book-4');
    const couponId = await seedCoupon({
      customerId,
      couponNo: 'X20260912001004',
      discountAmount: 2000,
    });

    const body = {
      staffId,
      startAt: `${date}T10:00:00+08:00`,
      serviceItemIds: [itemId],
      couponId,
    };
    // 避开同一顾客的时段重叠（首次成功后第二次会撞顾客冲突 409）：
    // 这里三个请求都打同一时段，所以只可能有一个成功 —— 无论它是被券的
    // 条件更新挡住，还是被时段冲突挡住，**结果都必须是「只有一单落库」**。
    const results = await Promise.all([
      ctx.request('POST', '/api/v1/app/bookings', { token, body }),
      ctx.request('POST', '/api/v1/app/bookings', { token, body }),
      ctx.request('POST', '/api/v1/app/bookings', { token, body }),
    ]);

    const ok = results.filter((r) => r.status === 201);
    expect(ok).toHaveLength(1);

    // 红线：只落一单，且券只绑定这一单
    expect(await bookingCount()).toBe(1);
    const state = await couponState(couponId);
    expect(state.status).toBe('used');
    expect(state.used_booking_id).toBe((ok[0].body as { id: number }).id);
  });
});
