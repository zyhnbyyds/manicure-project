import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  addLocalDays,
  shopToday,
  shopWeekday,
} from '../../src/modules/biz/common/shop-time';
import { createTestContext, type TestContext } from './harness';

let ctx: TestContext;
let date: string;

/**
 * 报表按店（连锁直营 · 阶段 1.8）。
 *
 * 口径（用户要求「各种信息」都能按门店看）：
 * - **店长不传任何参数，也只看得到自己门店的报表** —— 这是数据权限，不是筛选；
 * - 超管不传 = 全部门店**合并**，`?storeId=N` = 只看那一家；
 * - 与业务列表**同一套门店上下文**：显式 `?storeId=` 优先，否则用顶栏的 `x-store-id` 头。
 *
 * 另一个必须锁住的边界：**会员资产存量（期末结存 / 新增会员 / 次卡发售）恒为全店口径** ——
 * 余额是全店通兑的一个池子、顾客入会也没有门店概念，给它们加门店过滤只会把数字算小。
 * 这条用「按店筛选后 memberNew 不变」钉住，免得以后有人顺手补一刀。
 * （阶段 1.12 起**流水发生额**已能按发生门店统计：储值充退 / 积分跟随门店，见
 * `b14-member-ledger-store`。）
 */
beforeAll(async () => {
  ctx = await createTestContext();
  date = addLocalDays(shopToday(), 3);
}, 120_000);

afterAll(async () => {
  await ctx?.close();
});

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

async function mainStoreId(): Promise<number> {
  const rows = await ctx.sql<{ id: number }[]>(
    `SELECT id FROM sys_store WHERE code = 'MAIN'`,
  );
  return rows[0]!.id;
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
    `INSERT INTO biz_customer (name, phone, gender, member_since)
     VALUES ('张女士', '13800008801', 'female', ?)`,
    [`${date}T12:00:00+08:00`],
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

async function bindUser1(stores: number[]): Promise<void> {
  await ctx.sql(`DELETE FROM sys_user_store WHERE user_id = 1`);
  for (const storeId of stores) {
    await ctx.sql(
      `INSERT INTO sys_user_store (user_id, store_id) VALUES (1, ?)`,
      [storeId],
    );
  }
}

/** 只看得到自己门店的店长票（报表读 + 导出） */
function reportManagerToken(): Promise<string> {
  return ctx.token({
    permissions: ['biz:report:view', 'biz:report:export'],
    roles: [],
  });
}

/**
 * 造一笔「已完成 + 现金全款」的预约。
 *
 * 报表口径：营收来自**成功支付单**（锚点是 `paid_at`）、单量来自 `status='completed'` 的预约
 * （锚点是 `start_at`）。测试里这两件事都要做，而且**时间要对齐到同一天** ——
 * 建单时支付单打的是「现在」，而预约刻意排在未来（+3 天，避开过去时间不允许建单的限制），
 * 不挪齐就会「单量算得出来、营收是 0」。
 */
async function seedCompletedCashBooking(
  storeId: number | undefined,
  startAt: string,
  row: { staffId: number; customerId: number; serviceItemId: number },
): Promise<number> {
  const res = await ctx.request('POST', '/api/v1/biz/bookings', {
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
  const id = res.body.id as number;
  await ctx.sql(`UPDATE biz_booking SET status = 'completed' WHERE id = ?`, [
    id,
  ]);
  const paidAt = `${date}T10:05:00+08:00`;
  await ctx.sql(
    `UPDATE biz_payment SET paid_at = ?, created_at = ? WHERE booking_id = ?`,
    [paidAt, paidAt, id],
  );
  return id;
}

function overviewUrl(storeId?: number): string {
  const base = `/api/v1/biz/reports/overview?dateFrom=${date}&dateTo=${date}`;
  return storeId === undefined ? base : `${base}&storeId=${storeId}`;
}

beforeEach(async () => {
  await ctx.resetBusinessData();
  await ctx.sql(
    `INSERT INTO sys_user (id, username, display_name, password_hash, status)
     VALUES (1, 'store-manager', '徐家汇店长', 'x', 'active')
     ON DUPLICATE KEY UPDATE display_name = VALUES(display_name)`,
  );
  await bindUser1([]);
  await ctx.sql(`DELETE FROM sys_store WHERE code <> 'MAIN'`);
  await ctx.sql(
    `UPDATE sys_store SET is_default = 1, status = 'active', deleted_at = NULL WHERE code = 'MAIN'`,
  );
});

describe('报表按店：超管可筛、店长自动限本店', () => {
  it('超管不传 = 两店合并；传 storeId = 只看该店', async () => {
    const storeA = await mainStoreId();
    const storeB = await seedStore('XJH', '徐家汇店');
    const row = await seedBase();
    await seedCompletedCashBooking(storeA, `${date}T10:00:00+08:00`, row);
    await seedCompletedCashBooking(storeB, `${date}T14:00:00+08:00`, row);

    const merged = await ctx.request('GET', overviewUrl(), {});
    expect(merged.status).toBe(200);
    expect(merged.body.revenue.net).toBe(20000);
    expect(merged.body.revenue.count).toBe(2);
    expect(merged.body.revenue.avgTicket).toBe(10000);
    expect(merged.body.bookings.completed).toBe(2);

    const onlyB = await ctx.request('GET', overviewUrl(storeB), {});
    expect(onlyB.status).toBe(200);
    expect(onlyB.body.revenue.net).toBe(10000);
    expect(onlyB.body.revenue.count).toBe(1);
    expect(onlyB.body.bookings.completed).toBe(1);
    expect(onlyB.body.revenue.avgTicket).toBe(10000);
  });

  it('店长不传参数也只看本店；筛别家 403；x-store-id 头同样生效', async () => {
    const storeA = await mainStoreId();
    const storeB = await seedStore('XJH', '徐家汇店');
    const row = await seedBase();
    await seedCompletedCashBooking(storeA, `${date}T10:00:00+08:00`, row);
    await seedCompletedCashBooking(storeB, `${date}T14:00:00+08:00`, row);
    await bindUser1([storeB]);

    // 店长**一个参数都不传** → 仍然只看得到 B 店（数据权限）
    const manager = await ctx.request('GET', overviewUrl(), {
      token: await reportManagerToken(),
    });
    expect(manager.status).toBe(200);
    expect(manager.body.revenue.net).toBe(10000);
    expect(manager.body.bookings.completed).toBe(1);

    // 显式筛别人的门店 → 403（与列表同一口径，不是静默返回空）
    const denied = await ctx.request('GET', overviewUrl(storeA), {
      token: await reportManagerToken(),
    });
    expect(denied.status).toBe(403);
    expect(denied.body.message).toContain('无权');

    // 超管用顶栏切换器的 x-store-id 头 → 只算 B
    const byHeader = await ctx.request('GET', overviewUrl(), {
      headers: { 'x-store-id': String(storeB) },
    });
    expect(byHeader.status).toBe(200);
    expect(byHeader.body.revenue.net).toBe(10000);
    expect(byHeader.body.bookings.completed).toBe(1);
  });

  it('项目排行 / 美甲师业绩 / 导出 都跟随门店口径', async () => {
    const storeA = await mainStoreId();
    const storeB = await seedStore('XJH', '徐家汇店');
    const row = await seedBase();
    await seedCompletedCashBooking(storeA, `${date}T10:00:00+08:00`, row);
    await seedCompletedCashBooking(storeB, `${date}T14:00:00+08:00`, row);

    const range = `dateFrom=${date}&dateTo=${date}`;

    // 项目排行：合并 = 同一项目 2 次；按店 = 1 次
    const mergedServices = await ctx.request(
      'GET',
      `/api/v1/biz/reports/services?${range}`,
      {},
    );
    expect(mergedServices.body).toHaveLength(1);
    expect(mergedServices.body[0].times).toBe(2);
    expect(mergedServices.body[0].amount).toBe(20000);

    const bServices = await ctx.request(
      'GET',
      `/api/v1/biz/reports/services?${range}&storeId=${storeB}`,
      {},
    );
    expect(bServices.body).toHaveLength(1);
    expect(bServices.body[0].times).toBe(1);
    expect(bServices.body[0].amount).toBe(10000);

    // 美甲师业绩：按店只算本店那单
    const bStaffs = await ctx.request(
      'GET',
      `/api/v1/biz/reports/staffs?${range}&storeId=${storeB}`,
      {},
    );
    expect(bStaffs.body).toHaveLength(1);
    expect(bStaffs.body[0].bookings).toBe(1);
    expect(bStaffs.body[0].amount).toBe(10000);

    const mergedStaffs = await ctx.request(
      'GET',
      `/api/v1/biz/reports/staffs?${range}`,
      {},
    );
    expect(mergedStaffs.body[0].bookings).toBe(2);
    expect(mergedStaffs.body[0].amount).toBe(20000);

    // 导出跟着当前门店口径（B 店净营收 10000，不含 A 店的 20000 合计）
    const csv = await ctx.request(
      'GET',
      `/api/v1/biz/reports/export?type=overview&${range}&storeId=${storeB}`,
      {},
    );
    expect(csv.status).toBe(200);
    expect(String(csv.body)).toContain('净营收');
    expect(String(csv.body)).toContain('10000');
    expect(String(csv.body)).not.toContain('20000');
  });

  it('口径边界：会员资产类指标（新增会员）不随门店筛选变化', async () => {
    const storeA = await mainStoreId();
    const storeB = await seedStore('XJH', '徐家汇店');
    const row = await seedBase();
    await seedCompletedCashBooking(storeA, `${date}T10:00:00+08:00`, row);

    const merged = await ctx.request('GET', overviewUrl(), {});
    const onlyB = await ctx.request('GET', overviewUrl(storeB), {});

    // 营收按店（B 店是 0），但「新增会员」是全店口径 —— 会员属于整个品牌，不属于某家店
    expect(merged.body.revenue.net).toBe(10000);
    expect(onlyB.body.revenue.net).toBe(0);
    expect(merged.body.customers.memberNew).toBe(1);
    expect(onlyB.body.customers.memberNew).toBe(1);
  });
});
