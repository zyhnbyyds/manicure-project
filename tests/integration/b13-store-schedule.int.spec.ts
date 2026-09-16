import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  addLocalDays,
  shopToday,
  shopWeekday,
} from '../../src/modules/biz/common/shop-time';
import { createTestContext, type TestContext } from './harness';

let ctx: TestContext;
/** 排班冲突检查的「未来 30 天」，取一个稳定在窗口内的日期 */
let date: string;

/**
 * 按门店排班（多店 · 阶段 1.11）。
 *
 * 核心口径：**门店专属班次优先、通用班次兜底**（`store_id` 可空即通用）。
 * 用一个小场景讲清楚它能表达什么：
 *
 * 小柚 - 通用模板：周一到周日 10:00-20:00（老行为）；
 * 小柚 - A 店专属：周三 12:00-16:00（A 店周三只上半天）。
 * → 顾客在 A 店查周三：只有 12:00-16:00 的时段（专属生效）；
 *   在 B 店查周三：还是 10:00-20:00（专属不干涉别的店，回落到通用）。
 */
beforeAll(async () => {
  ctx = await createTestContext();
  date = addLocalDays(shopToday(), 5);
}, 120_000);

afterAll(async () => {
  await ctx?.close();
});

async function storeIdOf(code: string): Promise<number> {
  const rows = await ctx.sql<{ id: number }[]>(
    `SELECT id FROM sys_store WHERE code = ?`,
    [code],
  );
  return rows[0]!.id;
}

async function seedStaff(nickname: string): Promise<number> {
  const res = await ctx.request('POST', '/api/v1/biz/staffs', {
    body: { nickname },
  });
  expect(res.status).toBe(201);
  return res.body.id as number;
}

/** 直插班次段（通用或某门店），不校验周模板冲突 —— 测试只需要「段存在」 */
async function seedShift(
  staffId: number,
  weekday: number,
  startTime: string,
  endTime: string,
  storeId?: number | null,
): Promise<void> {
  await ctx.sql(
    `INSERT INTO biz_staff_weekly_shift (staff_id, store_id, weekday, start_time, end_time)
     VALUES (?, ?, ?, ?, ?)`,
    [staffId, storeId ?? null, weekday, startTime, endTime],
  );
}

/** 直插一条「未完成」预约（冲突保护只查未完成的状态） */
async function seedBooking(
  storeId: number,
  row: { staffId: number; customerId: number; serviceItemId: number },
  startAt: string,
): Promise<number> {
  const inserted = await ctx.sql<{ insertId: number }>(
    `INSERT INTO biz_booking
       (booking_no, store_id, customer_id, customer_name, staff_id, start_at, end_at,
        duration_minutes, buffer_minutes, original_price, payable_amount, paid_amount, due_amount,
        pay_status, status)
     VALUES (?, ?, ?, '按店排班顾客', ?, ?, DATE_ADD(?, INTERVAL 60 MINUTE), 60, 15, 10000, 10000, 0, 10000,
        'unpaid', 'confirmed')`,
    [
      `S${Date.now()}${Math.floor(Math.random() * 1000)}`,
      storeId,
      row.customerId,
      row.staffId,
      startAt,
      startAt,
    ],
  );
  return inserted.insertId;
}

beforeEach(async () => {
  await ctx.resetBusinessData();
  // 门店（sys_*）reset 不清：回到只有 MAIN 的默认态
  await ctx.sql(`DELETE FROM sys_store WHERE code <> 'MAIN'`);
  await ctx.sql(
    `UPDATE sys_store SET is_default = 1, status = 'active', deleted_at = NULL WHERE code = 'MAIN'`,
  );
});

describe('按门店排班：专属优先、通用兜底', () => {
  it('追加班次段的求值：通用层所有门店都生效，专属层只有该店生效', async () => {
    const mainId = await storeIdOf('MAIN');
    const staffId = await seedStaff('小柚');
    await seedShift(staffId, 3, '12:00:00', '16:00:00', mainId);

    const resolved = await ctx.sql<{ store_id: number | null }[]>(
      `SELECT DISTINCT store_id FROM biz_staff_weekly_shift WHERE staff_id = ?`,
      [staffId],
    );
    expect(resolved).toEqual([{ store_id: mainId }]);
  });

  it('可约时段：A 店用专属班次、B 店回落通用（同一美甲师同一天两个答案）', async () => {
    const mainId = await storeIdOf('MAIN');
    // 造一家没有专属班次的店（B）
    await ctx.sql(
      `INSERT INTO sys_store (code, name, sort, is_default, status) VALUES ('XJH', '徐家汇店', 2, 0, 'active')`,
    );
    const xjhId = await storeIdOf('XJH');

    const staff = await ctx.sql<{ insertId: number }>(
      `INSERT INTO biz_staff (nickname, status, sort) VALUES ('小柚', 'active', 1)`,
    );
    await ctx.sql(
      `INSERT INTO biz_staff_weekly_shift (staff_id, store_id, weekday, start_time, end_time)
       VALUES (?, NULL, ?, '10:00:00', '20:00:00')`, // 通用：整天可用
      [staff.insertId, shopWeekday(date)],
    );
    // 小柚 A 店（默认门森）周三只上 12-16
    await seedShift(
      staff.insertId,
      shopWeekday(date),
      '12:00:00',
      '16:00:00',
      mainId,
    );

    const item = await ctx.sql<{ insertId: number }>(
      `INSERT INTO biz_service_item (name, category, duration_minutes, buffer_minutes, price, status, sort)
       VALUES ('按店排班项目', '基础', 120, 15, 10000, 'active', 1)`,
    );

    const token = await ctx.token({});
    const slotsQuery = (storeId: string | undefined) => {
      const q = new URLSearchParams({
        staffId: String(staff.insertId),
        date,
        serviceItemIds: String(item.insertId),
      });
      if (storeId) q.append('storeId', storeId);
      return q.toString();
    };

    // A 店（专属 12-16）：可约时段只能框在 12-16 里
    const atMain = await ctx.request(
      'GET',
      `/api/v1/biz/bookings/available-slots?${slotsQuery(String(mainId))}`,
      { token },
    );
    expect(atMain.status).toBe(200);
    const mainSlots = atMain.body.slots as { startAt: string }[];
    expect(mainSlots.length).toBeGreaterThan(0);
    for (const slot of mainSlots) {
      const h = Number(slot.startAt.slice(11, 13));
      expect(h).toBeGreaterThanOrEqual(12);
      expect(h).toBeLessThan(16);
    }

    // B 店（没有专属 → 回落通用 10-20）
    const atXjh = await ctx.request(
      'GET',
      `/api/v1/biz/bookings/available-slots?${slotsQuery(String(xjhId))}`,
      { token },
    );
    expect(atXjh.status).toBe(200);
    const xjhSlots = atXjh.body.slots as { startAt: string }[];
    expect(xjhSlots.length).toBeGreaterThan(atMain.body.slots.length);
    const xjhHours = xjhSlots.map((s) => Number(s.startAt.slice(11, 13)));
    expect(Math.min(...xjhHours)).toBeLessThan(11);
    expect(Math.max(...xjhHours)).toBeGreaterThanOrEqual(16);

    // 不传 storeId（老行为/通用）→ 同 B 店：通用 10-20
    const noStore = await ctx.request(
      'GET',
      `/api/v1/biz/bookings/available-slots?${slotsQuery(undefined)}`,
      { token },
    );
    expect(noStore.status).toBe(200);
    expect((noStore.body.slots as unknown[]).length).toBeGreaterThan(0);
  });

  it('周模板接口：门店专属优先、通用兜底；替换只改那一层', async () => {
    const mainId = await storeIdOf('MAIN');
    // 先造第二家店（本用例独立，不走 beforeEach 的默认态以外）
    await ctx.sql(
      `INSERT INTO sys_store (code, name, sort, is_default, status) VALUES ('XJH', '徐家汇店', 2, 0, 'active')`,
    );
    const xjhId = await storeIdOf('XJH');
    const staffId = await seedStaff('小柚');
    // 通用：周一 10-20；A 店专属：周一 12-16
    await seedShift(staffId, 1, '10:00:00', '20:00:00', null);
    await seedShift(staffId, 1, '12:00:00', '16:00:00', mainId);

    // 查 A 店 → 专属（source: store）；查 B 店 → 通用（source: shared）
    const atStore = await ctx.request(
      'GET',
      `/api/v1/biz/staffs/${staffId}/weekly-shifts?storeId=${mainId}`,
      {},
    );
    expect(atStore.status).toBe(200);
    expect(atStore.body.source).toBe('store');
    expect(atStore.body.shifts).toHaveLength(1);
    expect(atStore.body.shifts[0].startTime).toBe('12:00:00');

    const atOther = await ctx.request(
      'GET',
      `/api/v1/biz/staffs/${staffId}/weekly-shifts?storeId=${xjhId}`,
      {},
    );
    expect(atOther.status).toBe(200);
    expect(atOther.body.source).toBe('shared');
    expect(atOther.body.shifts[0].startTime).toBe('10:00:00');

    // 替换 B 店专属（现在是空的）→ 只新增 B 店那一层，不动通用、不动 A 店
    const replace = await ctx.request(
      'PUT',
      `/api/v1/biz/staffs/${staffId}/weekly-shifts?storeId=${xjhId}`,
      {
        body: {
          shifts: [{ weekday: 1, startTime: '08:00:00', endTime: '12:00:00' }],
        },
      },
    );
    expect(replace.status).toBe(200);
    const layers = await ctx.sql<{ store_id: number | null }[]>(
      `SELECT store_id FROM biz_staff_weekly_shift WHERE staff_id = ?`,
      [staffId],
    );
    // 通用、A 店、B 店三层各一条
    expect(layers.map((row) => row.store_id)).toEqual([null, mainId, xjhId]);
  });

  it('小程序当前门店同样能反映门店专属班次（x-store-id 头）', async () => {
    const mainId = await storeIdOf('MAIN');
    const staff = await ctx.sql<{ insertId: number }>(
      `INSERT INTO biz_staff (nickname, status, sort) VALUES ('小柚', 'active', 1)`,
    );
    await ctx.sql(
      `INSERT INTO biz_staff_weekly_shift (staff_id, store_id, weekday, start_time, end_time)
       VALUES (?, NULL, ?, '10:00:00', '20:00:00')`,
      [staff.insertId, shopWeekday(date)],
    );
    // 默认店专属：周三 14-18
    await seedShift(
      staff.insertId,
      shopWeekday(date),
      '14:00:00',
      '18:00:00',
      mainId,
    );
    const item = await ctx.sql<{ insertId: number }>(
      `INSERT INTO biz_service_item (name, category, duration_minutes, buffer_minutes, price, status, sort)
       VALUES ('按店排班项目', '基础', 90, 15, 10000, 'active', 1)`,
    );
    const query = new URLSearchParams({
      staffId: String(staff.insertId),
      date,
      serviceItemIds: String(item.insertId),
    });

    const token = await ctx.appToken('openid-store-schedule', 1);
    // 带当前门店头 → 用默认店专属班次
    const withHeader = await ctx.request(
      'GET',
      `/api/v1/app/available-slots?${query.toString()}`,
      { token, headers: { 'x-store-id': String(mainId) } },
    );
    expect(withHeader.status).toBe(200);
    const mainSlots = withHeader.body.slots as { startAt: string }[];
    for (const slot of mainSlots) {
      const h = Number(slot.startAt.slice(11, 13));
      expect(h).toBeGreaterThanOrEqual(14);
      expect(h).toBeLessThan(18);
    }
  });

  it('冲突保护按门店：缩短 A 店专属班次不误伤 B 店的预约', async () => {
    const mainId = await storeIdOf('MAIN');
    await ctx.sql(
      `INSERT INTO sys_store (code, name, sort, is_default, status) VALUES ('XJH', '徐家汇店', 2, 0, 'active')`,
    );
    const xjhId = await storeIdOf('XJH');
    const staff = await ctx.sql<{ insertId: number }>(
      `INSERT INTO biz_staff (nickname, status, sort) VALUES ('小柚', 'active', 1)`,
    );
    const customer = await ctx.sql<{ insertId: number }>(
      `INSERT INTO biz_customer (name, phone) VALUES ('按店排班顾客', '13600000001')`,
    );
    const item = await ctx.sql<{ insertId: number }>(
      `INSERT INTO biz_service_item (name, category, duration_minutes, buffer_minutes, price, status, sort)
       VALUES ('按店排班项目', '基础', 60, 15, 10000, 'active', 1)`,
    );
    const weekday = shopWeekday(date);
    // 通用：09-20；A 店专属：09-20（与通用一致的宽班次）
    await seedShift(staff.insertId, weekday, '09:00:00', '20:00:00', null);
    await seedShift(staff.insertId, weekday, '09:00:00', '20:00:00', mainId);

    // A 店与 B 店各一条未完成预约，都在 09-20 内
    await seedBooking(
      mainId,
      {
        staffId: staff.insertId,
        customerId: customer.insertId,
        serviceItemId: item.insertId,
      },
      `${date}T10:00:00+08:00`,
    );
    await seedBooking(
      xjhId,
      {
        staffId: staff.insertId,
        customerId: customer.insertId,
        serviceItemId: item.insertId,
      },
      `${date}T14:00:00+08:00`,
    );

    // 把 A 店专属缩到 12-16：A 店的 10 点预约越界 → 应 409 + 清单（只列 A 店那条）；
    // B 店的 14 点预约不该被误伤
    const res = await ctx.request(
      'PUT',
      `/api/v1/biz/staffs/${staff.insertId}/weekly-shifts?storeId=${mainId}`,
      {
        body: {
          shifts: [{ weekday, startTime: '12:00:00', endTime: '16:00:00' }],
        },
      },
    );
    expect(res.status).toBe(409);
    expect(Array.isArray(res.body.conflicts)).toBe(true);
    expect(res.body.conflicts.length).toBe(1);
  });
});
