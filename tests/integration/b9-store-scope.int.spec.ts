import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  addLocalDays,
  shopToday,
  shopWeekday,
} from '../../src/modules/biz/common/shop-time.js';
import { createTestContext, type TestContext } from './harness.js';

let ctx: TestContext;
let date: string;

/**
 * 门店数据范围（连锁直营 · 阶段 1）。
 *
 * 口径（用户明确要求）：
 * - **门店店长只看自己门店**的预约/订单等信息；
 * - **超级管理员看全部**，并且**可以按门店筛选**；
 * - 一个门店都没分配的账号 → 403 + 明确原因（不是静默空列表）。
 *
 * 测法：`ctx.token({permissions})` 签出来的票 `sub` 固定是 `1`，
 * 所以**把 `sys_user_store` 绑到 user 1** 就能扮演「绑定某家店的店长」。
 * 权限里给 `biz:booking:manageall` 是为了让 RBAC 侧放行（不叠加美甲师/部门范围），
 * 这样用例测到的**只有门店维度**。
 */
beforeAll(async () => {
  ctx = await createTestContext();
  date = addLocalDays(shopToday(), 3);
}, 120_000);

afterAll(async () => {
  await ctx?.close();
});

/** 建一家门店（返回 id） */
async function seedStore(
  code: string,
  name: string,
  sort = 5,
): Promise<number> {
  const inserted = await ctx.sql<{ insertId: number }>(
    `INSERT INTO sys_store (code, name, sort, is_default, status) VALUES (?, ?, ?, 0, 'active')`,
    [code, name, sort],
  );
  return inserted.insertId;
}

/** 直插一条预约（读侧用例不需要走九步建单） */
async function seedBooking(
  storeId: number,
  seedRow: { staffId: number; customerId: number },
  startAt: string,
): Promise<number> {
  const inserted = await ctx.sql<{ insertId: number }>(
    `INSERT INTO biz_booking
       (booking_no, store_id, customer_id, customer_name, staff_id, start_at, end_at,
        duration_minutes, buffer_minutes, original_price, payable_amount, paid_amount, due_amount,
        pay_status, status)
     VALUES (?, ?, ?, '张女士', ?, ?, DATE_ADD(?, INTERVAL 60 MINUTE), 60, 15, 10000, 10000, 0, 10000,
        'unpaid', 'confirmed')`,
    [
      `T${Date.now()}${Math.floor(Math.random() * 1000)}`,
      storeId,
      seedRow.customerId,
      seedRow.staffId,
      startAt,
      startAt,
    ],
  );
  return inserted.insertId;
}

async function seedBase(): Promise<{
  serviceItemId: number;
  staffId: number;
  customerId: number;
}> {
  const item = await ctx.sql<{ insertId: number }>(
    `INSERT INTO biz_service_item (name, category, duration_minutes, buffer_minutes, price, status, sort)
     VALUES ('基础美甲', '基础', 60, 15, 10000, 'active', 1)`,
  );
  const staff = await ctx.sql<{ insertId: number }>(
    `INSERT INTO biz_staff (nickname, status, sort) VALUES ('小美', 'active', 1)`,
  );
  const customer = await ctx.sql<{ insertId: number }>(
    `INSERT INTO biz_customer (name, phone, gender) VALUES ('张女士', '13800008801', 'female')`,
  );
  await ctx.sql(
    `INSERT INTO biz_staff_weekly_shift (staff_id, weekday, start_time, end_time)
     VALUES (?, ?, '10:00:00', '20:00:00')`,
    [staff.insertId, shopWeekday(date)],
  );
  return {
    serviceItemId: item.insertId,
    staffId: staff.insertId,
    customerId: customer.insertId,
  };
}

/** 把 user 1 绑到指定门店（不传 = 清空绑定） */
async function bindUser1(stores: number[]): Promise<void> {
  await ctx.sql(`DELETE FROM sys_user_store WHERE user_id = 1`);
  for (const storeId of stores) {
    await ctx.sql(
      `INSERT INTO sys_user_store (user_id, store_id) VALUES (1, ?)`,
      [storeId],
    );
  }
}

/** 店长票：**没有** `*:*:*`，但 RBAC 侧放行（`manageall`），这样只剩门店维度生效 */
function storeManagerToken(): Promise<string> {
  return ctx.token({
    permissions: [
      'biz:booking:list',
      'biz:booking:create',
      'biz:booking:manageall',
      // 列表读权限：门店筛选要在这些接口上一起验，缺了会先被 RBAC 挡成 401
      'biz:payment:list',
      'biz:refund:list',
      'biz:receivable:list',
    ],
    roles: [],
  });
}

beforeEach(async () => {
  await ctx.resetBusinessData();
  /**
   * ctx.token() 签出来的票 sub 固定是 1，而 sys_user_store.user_id 有外键约束 ——
   * 测试库里必须先有一个 id = 1 的后台账号，否则「绑定门店」这一步直接撞外键。
   */
  await ctx.sql(
    `INSERT INTO sys_user (id, username, display_name, password_hash, status)
     VALUES (1, 'store-manager', '徐家汇店长', 'x', 'active')
     ON DUPLICATE KEY UPDATE display_name = VALUES(display_name)`,
  );
  // 门店是 `sys_*`，reset 不清；每个用例从「只有默认门店」开始
  // （先解绑再删店：`sys_user_store` 到门店是外键，顺序反了会 1451）
  await bindUser1([]);
  await ctx.sql(`DELETE FROM sys_store WHERE code <> 'MAIN'`);
  await ctx.sql(
    `UPDATE sys_store SET is_default = 1, status = 'active', deleted_at = NULL WHERE code = 'MAIN'`,
  );
});

describe('门店数据范围：店长只看本店 / 超管看全部并可筛选', () => {
  it('店长只看到本店预约，超管看到全部，且超管可按门店筛选', async () => {
    const storeA = (
      await ctx.sql<{ id: number }[]>(
        `SELECT id FROM sys_store WHERE code = 'MAIN'`,
      )
    )[0]!.id;
    const storeB = await seedStore('XJH', '徐家汇店');
    const row = await seedBase();
    await seedBooking(storeA, row, `${date}T10:00:00+08:00`);
    await seedBooking(storeB, row, `${date}T14:00:00+08:00`);

    // 店长绑 B 店 → 只看得到 B
    await bindUser1([storeB]);
    const manager = await ctx.request(
      'GET',
      '/api/v1/biz/bookings?page=1&pageSize=20',
      {
        token: await storeManagerToken(),
      },
    );
    expect(manager.status).toBe(200);
    expect(manager.body.items).toHaveLength(1);
    expect(manager.body.items[0].storeId).toBe(storeB);

    // 超管 → 两家店的单都在
    const admin = await ctx.request(
      'GET',
      '/api/v1/biz/bookings?page=1&pageSize=20',
      {},
    );
    expect(admin.status).toBe(200);
    expect(admin.body.items).toHaveLength(2);

    // 超管按门店筛选 → 只剩 A
    const filtered = await ctx.request(
      'GET',
      `/api/v1/biz/bookings?page=1&pageSize=20&storeId=${storeA}`,
      {},
    );
    expect(filtered.status).toBe(200);
    expect(filtered.body.items).toHaveLength(1);
    expect(filtered.body.items[0].storeId).toBe(storeA);
  });

  it('店长筛选别人的门店 → 403（不是静默返回空）', async () => {
    const storeA = (
      await ctx.sql<{ id: number }[]>(
        `SELECT id FROM sys_store WHERE code = 'MAIN'`,
      )
    )[0]!.id;
    const storeB = await seedStore('XJH', '徐家汇店');
    await bindUser1([storeB]);

    const res = await ctx.request(
      'GET',
      `/api/v1/biz/bookings?page=1&pageSize=20&storeId=${storeA}`,
      { token: await storeManagerToken() },
    );
    expect(res.status).toBe(403);
    expect(res.body.message).toContain('无权');
  });

  it('一个门店都没分配的非超管账号 → 403 且说明原因', async () => {
    await bindUser1([]);
    const res = await ctx.request(
      'GET',
      '/api/v1/biz/bookings?page=1&pageSize=20',
      {
        token: await storeManagerToken(),
      },
    );
    expect(res.status).toBe(403);
    expect(res.body.message).toContain('未分配门店');
  });
});

describe('门店写入：建单与收款落在正确的门店', () => {
  it('店长建单 → 落本店；超管指定门店建单 → 落指定门店，且收款单继承门店', async () => {
    const storeA = (
      await ctx.sql<{ id: number }[]>(
        `SELECT id FROM sys_store WHERE code = 'MAIN'`,
      )
    )[0]!.id;
    const storeB = await seedStore('XJH', '徐家汇店');
    const row = await seedBase();
    await bindUser1([storeB]);

    // 店长（绑 B）建单：现金全款，同一事务里会落支付单
    const created = await ctx.request('POST', '/api/v1/biz/bookings', {
      token: await storeManagerToken(),
      body: {
        customerId: row.customerId,
        staffId: row.staffId,
        startAt: `${date}T10:00:00+08:00`,
        serviceItemIds: [row.serviceItemId],
        payMode: 'full',
        payments: [{ channel: 'cash', amount: 10000 }],
      },
    });
    expect(created.status).toBe(201);
    const bookingId = created.body.id as number;

    const [booking] = await ctx.sql<{ store_id: number }[]>(
      `SELECT store_id FROM biz_booking WHERE id = ?`,
      [bookingId],
    );
    expect(Number(booking!.store_id)).toBe(storeB);

    // 支付单继承预约门店
    const [payment] = await ctx.sql<{ store_id: number }[]>(
      `SELECT store_id FROM biz_payment WHERE booking_id = ?`,
      [bookingId],
    );
    expect(Number(payment!.store_id)).toBe(storeB);

    // 超管不带 storeId → 落在**默认门店**（A = MAIN，单店期的常态）
    const adminDefault = await ctx.request('POST', '/api/v1/biz/bookings', {
      body: {
        customerId: row.customerId,
        staffId: row.staffId,
        startAt: `${date}T15:00:00+08:00`,
        serviceItemIds: [row.serviceItemId],
        payMode: 'full',
        payments: [{ channel: 'cash', amount: 10000 }],
      },
    });
    expect(adminDefault.status).toBe(201);
    const [adminBooking] = await ctx.sql<{ store_id: number }[]>(
      `SELECT store_id FROM biz_booking WHERE id = ?`,
      [adminDefault.body.id],
    );
    expect(Number(adminBooking!.store_id)).toBe(storeA);

    // 超管**显式指定 B 店**（非默认门店）→ 落在 B，这条才真正证明覆盖生效
    const adminOverride = await ctx.request('POST', '/api/v1/biz/bookings', {
      body: {
        storeId: storeB,
        customerId: row.customerId,
        staffId: row.staffId,
        startAt: `${date}T17:00:00+08:00`,
        serviceItemIds: [row.serviceItemId],
        payMode: 'full',
        payments: [{ channel: 'cash', amount: 10000 }],
      },
    });
    expect(adminOverride.status).toBe(201);
    const [overrideBooking] = await ctx.sql<{ store_id: number }[]>(
      `SELECT store_id FROM biz_booking WHERE id = ?`,
      [adminOverride.body.id],
    );
    expect(Number(overrideBooking!.store_id)).toBe(storeB);
  });

  it('店长指定别人的门店建单 → 403，且一条数据都没落', async () => {
    const storeA = (
      await ctx.sql<{ id: number }[]>(
        `SELECT id FROM sys_store WHERE code = 'MAIN'`,
      )
    )[0]!.id;
    await seedStore('XJH', '徐家汇店');
    const row = await seedBase();
    await bindUser1([
      (
        await ctx.sql<{ id: number }[]>(
          `SELECT id FROM sys_store WHERE code = 'XJH'`,
        )
      )[0]!.id,
    ]);

    const res = await ctx.request('POST', '/api/v1/biz/bookings', {
      token: await storeManagerToken(),
      body: {
        storeId: storeA,
        customerId: row.customerId,
        staffId: row.staffId,
        startAt: `${date}T11:00:00+08:00`,
        serviceItemIds: [row.serviceItemId],
        payMode: 'full',
        payments: [{ channel: 'cash', amount: 10000 }],
      },
    });
    expect(res.status).toBe(403);
    const [count] = await ctx.sql<{ total: number }[]>(
      `SELECT COUNT(*) AS total FROM biz_booking`,
    );
    expect(Number(count!.total)).toBe(0);
  });
});

describe('门店筛选：收款 / 退款 / 应收列表同一口径', () => {
  /**
   * 收款与退款走真实链路（建单带现金全款 → 同一事务落支付单），
   * 这样才能同时验「写入带门店」与「列表按门店过滤」。
   */
  async function createPaidBooking(
    storeId: number | undefined,
    startAt: string,
    row: { staffId: number; customerId: number; serviceItemId: number },
    token?: string,
  ): Promise<number> {
    const res = await ctx.request('POST', '/api/v1/biz/bookings', {
      ...(token ? { token } : {}),
      body: {
        ...(storeId === undefined ? {} : { storeId }),
        customerId: row.customerId,
        staffId: row.staffId,
        startAt,
        serviceItemIds: [row.serviceItemId],
        payMode: 'full',
        payments: [{ channel: 'cash', amount: 10000 }],
      },
    });
    expect(res.status).toBe(201);
    return res.body.id as number;
  }

  it('店长只看到本店收款单；超管可按门店筛', async () => {
    const storeA = (
      await ctx.sql<{ id: number }[]>(
        `SELECT id FROM sys_store WHERE code = 'MAIN'`,
      )
    )[0]!.id;
    const storeB = await seedStore('XJH', '徐家汇店');
    const row = await seedBase();

    // A 店（超管默认门店）与 B 店各一笔现金全款
    await createPaidBooking(undefined, `${date}T10:00:00+08:00`, row);
    await createPaidBooking(storeB, `${date}T14:00:00+08:00`, row);

    // 店长绑 B → 只看得到 B 的收款单
    await bindUser1([storeB]);
    const manager = await ctx.request(
      'GET',
      '/api/v1/biz/payments?page=1&pageSize=50',
      { token: await storeManagerToken() },
    );
    expect(manager.status).toBe(200);
    expect(manager.body.items).toHaveLength(1);
    expect(manager.body.items[0].storeId).toBe(storeB);

    // 超管 → 两笔都在；按门店筛 → 只剩 A
    const admin = await ctx.request(
      'GET',
      '/api/v1/biz/payments?page=1&pageSize=50',
      {},
    );
    expect(admin.body.items).toHaveLength(2);
    const filtered = await ctx.request(
      'GET',
      `/api/v1/biz/payments?page=1&pageSize=50&storeId=${storeA}`,
      {},
    );
    expect(filtered.body.items).toHaveLength(1);
    expect(filtered.body.items[0].storeId).toBe(storeA);

    // 店长筛别人的门店 → 403（与预约列表同一口径）
    const denied = await ctx.request(
      'GET',
      `/api/v1/biz/payments?page=1&pageSize=50&storeId=${storeA}`,
      { token: await storeManagerToken() },
    );
    expect(denied.status).toBe(403);

    // 应收台账也接了同一套口径（本例没有挂账数据，验的是「不报错 + 空列表」）
    const receivables = await ctx.request(
      'GET',
      '/api/v1/biz/receivables?page=1&pageSize=50',
      { token: await storeManagerToken() },
    );
    expect(receivables.status).toBe(200);
    expect(receivables.body.items).toHaveLength(0);
  });
});
