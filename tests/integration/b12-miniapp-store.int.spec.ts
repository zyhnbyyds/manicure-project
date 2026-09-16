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

/**
 * 小程序多门店：选店（`/app/shops`）、当前门店（`x-store-id` 头）、下单落店。
 *
 * 守三件事：
 * 1. **当前门店只有一个来源** —— 请求头 `x-store-id`；传了不存在 / 已停用 / 乱值
 *    一律**回落默认门店**。宁可退化成单店期的行为，也不能因为小程序本地缓存过期
 *    就让顾客下不了单、更不能直落库去撞外键（500）；
 * 2. **门店维度真的生效**：美甲师目录按当前门店收窄、下单落在选中的那家店；
 * 3. **不带头的旧版本照旧**（落默认门店）—— 多店上线不能把老版本小程序打死。
 */
beforeAll(async () => {
  ctx = await createTestContext();
  date = addLocalDays(shopToday(), 3);
}, 120_000);

afterAll(async () => {
  await ctx?.close();
});

async function mainStoreId(): Promise<number> {
  const rows = await ctx.sql<{ id: number }[]>(
    `SELECT id FROM sys_store WHERE code = 'MAIN'`,
  );
  return rows[0]!.id;
}

async function seedStore(
  code: string,
  name: string,
  options: {
    latitude?: number | null;
    longitude?: number | null;
    status?: 'active' | 'disabled';
  } = {},
): Promise<number> {
  const inserted = await ctx.sql<{ insertId: number }>(
    `INSERT INTO sys_store (code, name, latitude, longitude, status, sort, is_default)
     VALUES (?, ?, ?, ?, ?, 5, 0)`,
    [
      code,
      name,
      options.latitude ?? null,
      options.longitude ?? null,
      options.status ?? 'active',
    ],
  );
  return inserted.insertId;
}

/** 造一位美甲师（默认不配服务门店 = 哪家店都能约） */
async function seedStaff(nickname: string): Promise<number> {
  const res = await ctx.request('POST', '/api/v1/biz/staffs', {
    body: { nickname },
  });
  expect(res.status).toBe(201);
  return res.body.id as number;
}

/** 造一位已绑定顾客并签发 app token */
async function seedBoundCustomer(openid: string): Promise<{
  customerId: number;
  token: string;
}> {
  const customer = await ctx.sql<{ insertId: number }>(
    `INSERT INTO biz_customer (name, phone) VALUES ('多店测试顾客', ?)`,
    [`137${openid.replace(/\D/g, '').padStart(8, '0').slice(0, 8)}`],
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

/** 造一个可下单的场景：美甲师 + 当天班次 + 一个 100 元的项目 */
async function seedBookable(): Promise<{ staffId: number; itemId: number }> {
  const staff = await ctx.sql<{ insertId: number }>(
    `INSERT INTO biz_staff (nickname, status, sort) VALUES ('多店测试小柚', 'active', 1)`,
  );
  await ctx.sql(
    `INSERT INTO biz_staff_weekly_shift (staff_id, weekday, start_time, end_time)
     VALUES (?, ?, '10:00:00', '20:00:00')`,
    [staff.insertId, shopWeekday(date)],
  );
  const item = await ctx.sql<{ insertId: number }>(
    `INSERT INTO biz_service_item (name, category, duration_minutes, buffer_minutes, price, status, sort)
     VALUES ('多店测试项目', '基础', 60, 15, 10000, 'active', 1)`,
  );
  return { staffId: staff.insertId, itemId: item.insertId };
}

async function bookingStoreId(bookingId: number): Promise<number | null> {
  const rows = await ctx.sql<{ store_id: number | null }[]>(
    `SELECT store_id FROM biz_booking WHERE id = ?`,
    [bookingId],
  );
  return rows[0]?.store_id ?? null;
}

beforeEach(async () => {
  await ctx.resetBusinessData();
  await ctx.sql(`DELETE FROM sys_store WHERE code <> 'MAIN'`);
  await ctx.sql(
    `UPDATE sys_store SET is_default = 1, status = 'active', deleted_at = NULL WHERE code = 'MAIN'`,
  );
  await ctx.sql(`DELETE FROM biz_staff_store`);
});

describe('小程序多门店：选店 / 当前门店 / 下单落店', () => {
  it('GET /app/shops：回启用门店（带坐标与图集），停用门店不出现', async () => {
    const token = await ctx.appToken('openid-shops-list', 1);
    const storeA = await mainStoreId();
    const storeB = await seedStore('XJH', '徐家汇店', {
      latitude: 31.19,
      longitude: 121.44,
    });
    const disabled = await seedStore('DIS', '停用店', { status: 'disabled' });
    const noCoordId = await seedStore('NC', '没配坐标店');
    await ctx.sql(
      `UPDATE sys_store SET images = JSON_ARRAY('/files/1.png') WHERE id = ?`,
      [storeA],
    );

    const res = await ctx.request('GET', '/api/v1/app/shops', { token });
    expect(res.status).toBe(200);
    const ids = res.body.items.map((item: { id: number }) => item.id);
    expect(ids).toContain(storeA);
    expect(ids).toContain(storeB);
    expect(ids).not.toContain(disabled);

    const a = res.body.items.find((item: { id: number }) => item.id === storeA);
    const b = res.body.items.find((item: { id: number }) => item.id === storeB);
    expect(a.isDefault).toBe(true);
    expect(a.images).toEqual(['/files/1.png']);
    expect(b.isDefault).toBe(false);
    expect(b.latitude).toBeCloseTo(31.19);
    expect(b.longitude).toBeCloseTo(121.44);
    // 没配坐标的门店**照样返回**，只是坐标为 null —— C 端据此把「算不出距离」的排最后，
    // 而不是把它从列表里抹掉（顾客可能就在那家店附近）
    const noCoord = res.body.items.find(
      (item: { id: number }) => item.id === noCoordId,
    );
    expect(noCoord.latitude).toBeNull();
    expect(noCoord.longitude).toBeNull();
  });

  it('GET /app/shop：头里的门店优先；不存在 / 乱值 / 停用一律回落默认门店', async () => {
    const token = await ctx.appToken('openid-shop-detail', 1);
    const storeA = await mainStoreId();
    const storeB = await seedStore('XJH', '徐家汇店');

    const noHeader = await ctx.request('GET', '/api/v1/app/shop', { token });
    expect(noHeader.body.storeId).toBe(storeA);

    const byHeader = await ctx.request('GET', '/api/v1/app/shop', {
      token,
      headers: { 'x-store-id': String(storeB) },
    });
    expect(byHeader.body.storeId).toBe(storeB);
    expect(byHeader.body.name).toBe('徐家汇店');

    // 乱值不报错、不 500 —— 老缓存 / 手抖传错都只是「回到默认门店」
    for (const bad of ['999999', 'abc', '-3', '0', '1.5']) {
      const res = await ctx.request('GET', '/api/v1/app/shop', {
        token,
        headers: { 'x-store-id': bad },
      });
      expect(res.status).toBe(200);
      expect(res.body.storeId).toBe(storeA);
    }

    // 门店被停用后再带着它的 id 来 → 同样回落默认门店
    await ctx.sql(`UPDATE sys_store SET status = 'disabled' WHERE id = ?`, [
      storeB,
    ]);
    const disabled = await ctx.request('GET', '/api/v1/app/shop', {
      token,
      headers: { 'x-store-id': String(storeB) },
    });
    expect(disabled.body.storeId).toBe(storeA);
  });

  it('GET /app/staffs：按当前门店收窄（只服务别家店的人不出现）', async () => {
    const token = await ctx.appToken('openid-staff-scope', 1);
    const storeA = await mainStoreId();
    const storeB = await seedStore('XJH', '徐家汇店');
    const onlyA = await seedStaff('只服务默认店');
    const anyone = await seedStaff('哪家店都行');
    await ctx.request('PUT', `/api/v1/biz/staffs/${onlyA}/stores`, {
      body: { storeIds: [storeA] },
    });

    const inB = await ctx.request(
      'GET',
      '/api/v1/app/staffs?page=1&pageSize=50',
      { token, headers: { 'x-store-id': String(storeB) } },
    );
    const ids = inB.body.items.map((item: { id: number }) => item.id);
    expect(ids).not.toContain(onlyA);
    expect(ids).toContain(anyone);

    // 不带头（旧版本）→ 按默认门店：只服务默认门店的那位仍看得到
    const noHeader = await ctx.request(
      'GET',
      '/api/v1/app/staffs?page=1&pageSize=50',
      { token },
    );
    expect(
      noHeader.body.items.map((item: { id: number }) => item.id),
    ).toContain(onlyA);
  });

  it('POST /app/bookings：落「当前门店」；不带头落默认门店；门店不存在也不 500', async () => {
    const storeA = await mainStoreId();
    const storeB = await seedStore('XJH', '徐家汇店');
    const { staffId, itemId } = await seedBookable();
    const { token } = await seedBoundCustomer('openid-multi-store');
    const body = {
      staffId,
      startAt: `${date}T10:00:00+08:00`,
      serviceItemIds: [itemId],
    };

    // 选了 B 店 → 单据落 B
    const toB = await ctx.request('POST', '/api/v1/app/bookings', {
      token,
      headers: { 'x-store-id': String(storeB) },
      body,
    });
    expect(toB.status).toBe(201);
    expect(await bookingStoreId(toB.body.id as number)).toBe(storeB);

    // 不带头的旧版本 → 落默认门店（多店上线不能打死老版本）
    const noHeader = await ctx.request('POST', '/api/v1/app/bookings', {
      token,
      body: { ...body, startAt: `${date}T13:00:00+08:00` },
    });
    expect(noHeader.status).toBe(201);
    expect(await bookingStoreId(noHeader.body.id as number)).toBe(storeA);

    // 头里是个不存在的门店 → 回落默认门店（而不是直落库撞外键 500）
    const badStore = await ctx.request('POST', '/api/v1/app/bookings', {
      token,
      headers: { 'x-store-id': '999999' },
      body: { ...body, startAt: `${date}T15:00:00+08:00` },
    });
    expect(badStore.status).toBe(201);
    expect(await bookingStoreId(badStore.body.id as number)).toBe(storeA);
  });
});
