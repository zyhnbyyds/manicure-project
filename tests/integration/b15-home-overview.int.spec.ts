import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  addLocalDays,
  shopToday,
  shopWeekday,
} from '../../src/modules/biz/common/shop-time.js';
import { createTestContext, type TestContext } from './harness.js';

let ctx: TestContext;
let today: string;
/** 建单必须排在未来（服务端拒绝过去时间）；建完再 UPDATE 回今天，口径才落在「今日」区间里 */
let futureDate: string;
let futureStart: string;
let todayStart: string;
let todayEnd: string;
let todayPaidAt: string;

/**
 * 首页经营概览（按店）· 阶段 1.13。
 *
 * 这套断言锁住的是**首页最容易错、也最难被发现的三件事**：
 *
 * 1. **对账等式**：`Σ 门店对比.net === 汇总净营收` —— 分组漏一家店，页面看着照样正常，
 *    只有这条等式能抓出来；
 * 2. **两类门店口径不能混**：汇总/待办跟随顶栏切换器，**门店对比表恒为可见门店全量**
 *    （切到 B 店时这张表还要能回答「A 店今天怎么样」）；店长不传参也只看本店（数据权限）；
 * 3. **轻量版是真的不下发金额**：前台（只有 `biz:report:home`）拿到 `meta.money = false`，
 *    且响应里**不存在** `summary.money` / `stores[].net` —— 不是前端藏起来。
 */
beforeAll(async () => {
  ctx = await createTestContext();
  today = shopToday();
  futureDate = addLocalDays(today, 3);
  futureStart = `${futureDate}T10:00:00+08:00`;
  todayStart = `${today}T10:00:00+08:00`;
  todayEnd = `${today}T11:00:00+08:00`;
  todayPaidAt = `${today}T10:05:00+08:00`;
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
    [`${today}T12:00:00+08:00`],
  );
  // 班次按**建单那天**（未来）的星期插：冲突校验发生在建单那一刻
  await ctx.sql(
    `INSERT INTO biz_staff_weekly_shift (staff_id, weekday, start_time, end_time)
     VALUES (?, ?, '10:00:00', '20:00:00')`,
    [staff.insertId, shopWeekday(futureDate)],
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

/** 造一笔「已完成 + 现金全款」的预约，并把时间挪回今天（否则落在「今日」区间外） */
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
  await ctx.sql(
    `UPDATE biz_booking SET status = 'completed', start_at = ?, end_at = ?, created_at = ? WHERE id = ?`,
    [todayStart, todayEnd, todayStart, id],
  );
  await ctx.sql(
    `UPDATE biz_payment SET paid_at = ?, created_at = ? WHERE booking_id = ?`,
    [todayPaidAt, todayPaidAt, id],
  );
  return id;
}

/** 造一笔取消单（只影响单量与成单率，不进营收） */
async function seedCancelledBooking(
  storeId: number,
  row: { staffId: number; customerId: number; serviceItemId: number },
): Promise<void> {
  const res = await ctx.request('POST', '/api/v1/biz/bookings', {
    body: {
      storeId,
      customerId: row.customerId,
      staffId: row.staffId,
      startAt: futureStart,
      serviceItemIds: [row.serviceItemId],
      payMode: 'full',
      payments: [{ channel: 'cash', amount: 10000 }],
    },
  });
  expect(res.status).toBe(201);
  const id = res.body.id as number;
  await ctx.sql(
    `UPDATE biz_booking SET status = 'cancelled', start_at = ?, end_at = ?, created_at = ? WHERE id = ?`,
    [todayStart, todayEnd, todayStart, id],
  );
  // 取消单不该留下实收，否则净营收会被它带高（真实链路里取消会走退款）
  await ctx.sql(
    `UPDATE biz_payment SET status = 'closed' WHERE booking_id = ?`,
    [id],
  );
}

function homeUrl(query = ''): string {
  return `/api/v1/biz/reports/home${query ? `?${query}` : ''}`;
}

/** 店长票：能看报表（含金额） */
function managerToken(): Promise<string> {
  return ctx.token({ permissions: ['biz:report:view'], roles: [] });
}

/** 前台票：只有首页经营概览**轻量版**权限 */
function frontdeskToken(): Promise<string> {
  return ctx.token({ permissions: ['biz:report:home'], roles: [] });
}

beforeEach(async () => {
  await ctx.resetBusinessData();
  await ctx.sql(
    `INSERT INTO sys_user (id, username, display_name, password_hash, status)
     VALUES (1, 'home-manager', '首页店长', 'x', 'active')
     ON DUPLICATE KEY UPDATE display_name = VALUES(display_name)`,
  );
  await bindUser1([]);
  await ctx.sql(`DELETE FROM sys_store WHERE code <> 'MAIN'`);
  await ctx.sql(
    `UPDATE sys_store SET is_default = 1, status = 'active', deleted_at = NULL WHERE code = 'MAIN'`,
  );
});

describe('首页经营概览：口径与门店维度', () => {
  it('超管：汇总两店合并，且**各店之和 = 全店**（对账等式）', async () => {
    const storeA = await mainStoreId();
    const storeB = await seedStore('XJH', '徐家汇店');
    const row = await seedBase();
    await seedCompletedCashBooking(storeA, futureStart, row);
    await seedCompletedCashBooking(storeB, futureStart, row);

    const res = await ctx.request('GET', homeUrl('range=today'), {});
    expect(res.status).toBe(200);

    const summary = res.body.summary.money;
    expect(summary.net).toBe(20000);
    expect(summary.gross).toBe(20000);
    expect(summary.refund).toBe(0);
    expect(summary.avgTicket).toBe(10000);
    // 有实收、没退款 → 退款率就是 0%（「没有营收」才是 null，见下一个用例）
    expect(summary.refundRatePermille).toBe(0);
    expect(summary.refundCount).toBe(0);

    expect(res.body.summary.bookings.created).toBe(2);
    expect(res.body.summary.bookings.completed).toBe(2);
    expect(res.body.summary.bookings.completedRatePermille).toBe(1000);

    // 门店对比：可见门店全量（默认门店 + 新店），每店各 10000
    expect(res.body.stores).toHaveLength(2);
    for (const store of res.body.stores) expect(store.net).toBe(10000);

    // 对账等式：分组求和必须等于汇总（漏一家店只有这条能抓出来）
    const storeNetSum = res.body.stores.reduce(
      (total: number, store: { net: number }) => total + store.net,
      0,
    );
    expect(storeNetSum).toBe(summary.net);
  });

  it('超管切到 B 店：汇总收窄到 B，但门店对比仍是全量（切店后还要能看别家）', async () => {
    const storeA = await mainStoreId();
    const storeB = await seedStore('XJH', '徐家汇店');
    const row = await seedBase();
    await seedCompletedCashBooking(storeA, futureStart, row);
    await seedCompletedCashBooking(storeB, futureStart, row);

    const res = await ctx.request('GET', homeUrl('range=today'), {
      headers: { 'x-store-id': String(storeB) },
    });
    expect(res.status).toBe(200);
    expect(res.body.meta.activeStoreId).toBe(storeB);
    expect(res.body.meta.activeStoreName).toBe('徐家汇店');
    // 汇总 = 只有 B
    expect(res.body.summary.money.net).toBe(10000);
    expect(res.body.summary.bookings.completed).toBe(1);
    // 对比表 = 两家都在，且 A 店那 10000 也在
    expect(res.body.stores).toHaveLength(2);
    const storeA_ = res.body.stores.find(
      (store: { storeId: number }) => store.storeId === storeA,
    );
    expect(storeA_.net).toBe(10000);
  });

  it('店长：不传任何参数也只统计本店（数据权限），对比表里看不到别家', async () => {
    const storeA = await mainStoreId();
    const storeB = await seedStore('XJH', '徐家汇店');
    const row = await seedBase();
    await seedCompletedCashBooking(storeA, futureStart, row);
    await seedCompletedCashBooking(storeB, futureStart, row);
    await bindUser1([storeB]);

    const token = await managerToken();
    const res = await ctx.request('GET', homeUrl('range=today'), { token });
    expect(res.status).toBe(200);
    expect(res.body.summary.money.net).toBe(10000);
    expect(res.body.meta.storeScope).toBe('stores');
    expect(res.body.stores).toHaveLength(1);
    expect(res.body.stores[0].storeId).toBe(storeB);

    // 显式筛别家 → 403（与列表同一口径，不是静默返回空）
    const denied = await ctx.request(
      'GET',
      homeUrl(`range=today&storeId=${storeA}`),
      {
        token,
      },
    );
    expect(denied.status).toBe(403);
  });

  it('成单率 = 完成 ÷ (完成+取消+爽约)，取消单不进营收也不进分母之外', async () => {
    const storeA = await mainStoreId();
    const row = await seedBase();
    await seedCompletedCashBooking(storeA, futureStart, row);
    await seedCancelledBooking(storeA, row);

    const res = await ctx.request('GET', homeUrl('range=today'), {});
    expect(res.status).toBe(200);
    const bookings = res.body.summary.bookings;
    expect(bookings.completed).toBe(1);
    expect(bookings.cancelled).toBe(1);
    // 1 / (1 + 1 + 0) = 500‰
    expect(bookings.completedRatePermille).toBe(500);
    expect(bookings.cancelRatePermille).toBe(500);
    // 取消单（已关单）不产生实收
    expect(res.body.summary.money.net).toBe(10000);
  });

  it('待办：未付款 / 待确认都指向「还没处理的活单」，且不随区间变化', async () => {
    const storeA = await mainStoreId();
    const row = await seedBase();
    // 未来的一单、不收款 → 既算「未付款」又算「待确认」（后台代录默认 confirmed）
    const res = await ctx.request('POST', '/api/v1/biz/bookings', {
      body: {
        storeId: storeA,
        customerId: row.customerId,
        staffId: row.staffId,
        startAt: futureStart,
        serviceItemIds: [row.serviceItemId],
        payMode: 'deposit',
        depositAmount: 0,
      },
    });
    expect(res.status).toBe(201);

    const today7d = await ctx.request('GET', homeUrl('range=7d'), {});
    expect(today7d.status).toBe(200);
    expect(today7d.body.todo.pendingPayments).toBe(1);
    expect(today7d.body.todo.unpaidPayments).toBe(1);
    expect(today7d.body.todo.partialPayments).toBe(0);
    // 一分钱营收都没有 → 退款率与客单价是「无从谈起」（null），不是 0%
    expect(today7d.body.summary.money.gross).toBe(0);
    expect(today7d.body.summary.money.refundRatePermille).toBeNull();
    expect(today7d.body.summary.money.avgTicket).toBeNull();
    // 待办是「当前状态」：换成 30 天区间，数字不变
    expect(today7d.body.todo.pendingPayments).toBe(
      (await ctx.request('GET', homeUrl('range=30d'), {})).body.todo
        .pendingPayments,
    );
  });

  it('前台（轻量版）：能拿到单量与待办，但响应里**根本不存在**金额字段', async () => {
    const storeA = await mainStoreId();
    const row = await seedBase();
    await seedCompletedCashBooking(storeA, futureStart, row);
    await bindUser1([storeA]);

    const res = await ctx.request('GET', homeUrl('range=today'), {
      token: await frontdeskToken(),
    });
    expect(res.status).toBe(200);
    expect(res.body.meta.money).toBe(false);

    // 单量/转化率/待办照给
    expect(res.body.summary.bookings.completed).toBe(1);
    expect(res.body.summary.bookings.completedRatePermille).toBe(1000);
    expect(res.body.todo).toBeTruthy();

    // 金额：整块不存在（不是 0）—— 抓包也拿不到营收
    expect(res.body.summary.money).toBeUndefined();
    expect(res.body.summary.member).toBeUndefined();
    for (const store of res.body.stores) {
      expect(store.net).toBeUndefined();
      expect(store.gross).toBeUndefined();
      expect(store.refund).toBeUndefined();
    }
    for (const day of res.body.trend) {
      expect(day.net).toBeUndefined();
      // 趋势里的单量仍然给
      expect(typeof day.completed).toBe('number');
    }
  });

  it('权限与门店的门槛：无权限 401（权限不足）；前台没绑门店 403（而不是静默空白）', async () => {
    const noPerm = await ctx.request('GET', homeUrl('range=today'), {
      token: await ctx.token({
        permissions: ['biz:booking:list'],
        roles: [],
      }),
    });
    // 权限点缺失由 `AccessTokenGuard` 判 401（全项目口径）；403 只留给「门店不可见」
    expect(noPerm.status).toBe(401);
    expect(String(noPerm.body.message)).toContain('权限不足');

    await bindUser1([]);
    const noStore = await ctx.request('GET', homeUrl('range=today'), {
      token: await frontdeskToken(),
    });
    expect(noStore.status).toBe(403);
    expect(String(noStore.body.message)).toContain('未分配门店');
  });
});
