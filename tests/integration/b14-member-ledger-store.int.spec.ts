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
 * 会员流水归店（连锁直营 · 阶段 1.12「资产通兑、流水归店」）。
 *
 * 前提（用户 2026-09-13 决策）：**会员资产全店通兑** —— 余额 / 积分 / 次卡 / 券全店通用，
 * 所以**不拆资产池**（`biz_customer.balance_*` 仍是全店一个池子）。这一批只补一件事：
 * **每笔流水记下它发生在哪家店**，让「这笔充值 / 这次消费发生在哪家店」可追溯、可报按店。
 *
 * 落店口径：
 * - **独立收付款**（充值 / 冲正 / 调整 / 购卡 / 退卡）→ 入口解析的**当前门店**；
 * - **挂在预约上的**（消费 / 余额支付 / 积分抵扣 / 退款冲减）→ 顺 `booking_id` 带出；
 * - 两样都没有（定时任务、历史数据）→ **留空**，按店统计时宁少不多、不硬塞给任何门店。
 *
 * 报表边界：储值充退 / 积分**发生额**跟随门店；期末结存是资产存量 → **恒全店口径**。
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
    `INSERT INTO biz_customer (name, phone, gender) VALUES ('张女士', '13800009901', 'female')`,
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

/** 会员收付权限齐全的店长票（不含 `*:*:*`，门店范围只剩 `sys_user_store` 那一层） */
function storeManagerToken(): Promise<string> {
  return ctx.token({
    permissions: [
      'biz:member:list',
      'biz:member:recharge',
      'biz:member:refund',
      'biz:member:adjust',
      'biz:card:issue',
      'biz:card:refund',
      'biz:booking:create',
      'biz:booking:manageall',
      'biz:report:view',
    ],
    roles: [],
  });
}

/** 充值（返回状态码，便于断言 403/200） */
async function recharge(
  customerId: number,
  payAmount: number,
  token?: string,
): Promise<{ status: number; body: any }> {
  return ctx.request('POST', `/api/v1/biz/members/${customerId}/recharge`, {
    ...(token === undefined ? {} : { token }),
    body: { payAmount, payChannel: 'cash' },
  });
}

/** 流水的 `(type, store_id, store_name)`，按 id 倒序 */
async function ledgerRows(
  customerId: number,
  token?: string,
): Promise<
  { type: string; storeId: number | null; storeName: string | null }[]
> {
  const res = await ctx.request(
    'GET',
    `/api/v1/biz/members/${customerId}/transactions?page=1&pageSize=50`,
    token === undefined ? {} : { token },
  );
  expect(res.status).toBe(200);
  return res.body.items.map((row: any) => ({
    type: row.type,
    storeId: row.storeId,
    storeName: row.storeName,
  }));
}

function overviewUrl(storeId?: number): string {
  const today = shopToday();
  const base = `/api/v1/biz/reports/overview?dateFrom=${today}&dateTo=${today}`;
  return storeId === undefined ? base : `${base}&storeId=${storeId}`;
}

beforeEach(async () => {
  await ctx.resetBusinessData();
  // ctx.token() 签出来的票 sub 固定是 1，`sys_user_store.user_id` 有外键 → 先备好这个账号
  await ctx.sql(
    `INSERT INTO sys_user (id, username, display_name, password_hash, status)
     VALUES (1, 'store-manager', '徐家汇店长', 'x', 'active')
     ON DUPLICATE KEY UPDATE display_name = VALUES(display_name)`,
  );
  // 门店表属 `sys_*`，reset 不清 → 每个用例从「只有默认门店」开始
  await bindUser1([]);
  await ctx.sql(`DELETE FROM sys_store WHERE code <> 'MAIN'`);
  await ctx.sql(
    `UPDATE sys_store SET is_default = 1, status = 'active', deleted_at = NULL WHERE code = 'MAIN'`,
  );
});

describe('会员流水归店：独立收付款落在入口解析的门店', () => {
  it('店长（绑 B）充值 → 流水记 B 店，接口带出门店名', async () => {
    const storeB = await seedStore('XJH', '徐家汇店');
    const row = await seedBase();
    await bindUser1([storeB]);

    const res = await recharge(
      row.customerId,
      20000,
      await storeManagerToken(),
    );
    expect([200, 201]).toContain(res.status);

    const [txn] = await ledgerRows(row.customerId, await storeManagerToken());
    expect(txn).toMatchObject({
      type: 'recharge',
      storeId: storeB,
      storeName: '徐家汇店',
    });
  });

  it('超管不传门店 → 落默认门店（不是留空）', async () => {
    const main = await mainStoreId();
    const row = await seedBase();

    await recharge(row.customerId, 20000);

    const [txn] = await ledgerRows(row.customerId);
    expect(txn).toMatchObject({ type: 'recharge', storeId: main });
  });

  it('冲正（现金）也带上门店', async () => {
    const storeB = await seedStore('XJH', '徐家汇店');
    const row = await seedBase();
    await bindUser1([storeB]);
    const token = await storeManagerToken();
    await recharge(row.customerId, 20000, token);

    const res = await ctx.request(
      'POST',
      `/api/v1/biz/members/${row.customerId}/refund`,
      {
        token,
        body: { mode: 'cash', amount: 5000, reason: '多收了' },
      },
    );
    expect([200, 201]).toContain(res.status);

    const rows = await ledgerRows(row.customerId, token);
    expect(rows[0]).toMatchObject({ type: 'adjust', storeId: storeB });
  });
});

describe('会员流水归店：挂在预约上的流水顺预约带出', () => {
  it('B 店建单收款 → 消费流水记 B 店（不用调用方逐个传门店）', async () => {
    const storeB = await seedStore('XJH', '徐家汇店');
    const row = await seedBase();

    const created = await ctx.request('POST', '/api/v1/biz/bookings', {
      body: {
        storeId: storeB,
        customerId: row.customerId,
        staffId: row.staffId,
        startAt: `${date}T10:00:00+08:00`,
        serviceItemIds: [row.serviceItemId],
        payMode: 'full',
        payments: [{ channel: 'cash', amount: 10000 }],
      },
    });
    expect(created.status).toBe(201);

    const [txn] = await ledgerRows(row.customerId);
    expect(txn).toMatchObject({
      type: 'consume',
      storeId: storeB,
      storeName: '徐家汇店',
    });
  });

  it('无预约的历史流水留空，不被硬塞给任何门店', async () => {
    const row = await seedBase();
    await ctx.sql(
      `INSERT INTO biz_member_transaction
         (customer_id, type, amount, balance_delta_principal, balance_principal_after, created_by)
       VALUES (?, 'recharge', 5000, 5000, 5000, 0)`,
      [row.customerId],
    );

    const [txn] = await ledgerRows(row.customerId);
    expect(txn).toMatchObject({ type: 'recharge', storeId: null });
  });
});

describe('报表：流水发生额按店，资产存量仍是全店口径', () => {
  it('储值充值 / 积分按发生门店统计；期末结存不随门店筛选变化', async () => {
    const main = await mainStoreId();
    const storeB = await seedStore('XJH', '徐家汇店');
    const row = await seedBase();

    // MAIN 店充 200 元、B 店充 300 元（同一张会员卡，资产通兑）
    await recharge(row.customerId, 20000);
    await bindUser1([storeB]);
    const manager = await storeManagerToken();
    await recharge(row.customerId, 30000, manager);

    const all = await ctx.request('GET', overviewUrl());
    expect(all.status).toBe(200);
    expect(Number(all.body.member.rechargePrincipal)).toBe(50000);

    const onlyMain = await ctx.request('GET', overviewUrl(main));
    expect(onlyMain.status).toBe(200);
    expect(Number(onlyMain.body.member.rechargePrincipal)).toBe(20000);

    const onlyB = await ctx.request('GET', overviewUrl(storeB));
    expect(onlyB.status).toBe(200);
    expect(Number(onlyB.body.member.rechargePrincipal)).toBe(30000);

    // 期末结存 = 资产存量（全店通兑的一个池子）→ 两个门店视角下必须是同一个数
    expect(Number(onlyMain.body.member.balancePrincipalEnd)).toBe(50000);
    expect(Number(onlyB.body.member.balancePrincipalEnd)).toBe(50000);
  });

  it('会员报表的期间行同样按店：储值本金只算本店', async () => {
    const main = await mainStoreId();
    const storeB = await seedStore('XJH', '徐家汇店');
    const row = await seedBase();

    await recharge(row.customerId, 20000);
    await bindUser1([storeB]);
    await recharge(row.customerId, 30000, await storeManagerToken());

    const today = shopToday();
    const onlyMain = await ctx.request(
      'GET',
      `/api/v1/biz/reports/members?dateFrom=${today}&dateTo=${today}&storeId=${main}`,
    );
    expect(onlyMain.status).toBe(200);
    // 会员报表直接返回期间行数组（单日粒度 = 一行）
    expect(onlyMain.body).toHaveLength(1);
    expect(Number(onlyMain.body[0].recharge)).toBe(20000);

    const onlyB = await ctx.request(
      'GET',
      `/api/v1/biz/reports/members?dateFrom=${today}&dateTo=${today}&storeId=${storeB}`,
    );
    expect(Number(onlyB.body[0].recharge)).toBe(30000);
    // 期末结存是资产存量 → 两个门店视角下同一个数
    expect(Number(onlyB.body[0].balanceEnd)).toBe(50000);
    expect(Number(onlyMain.body[0].balanceEnd)).toBe(50000);
  });
});
