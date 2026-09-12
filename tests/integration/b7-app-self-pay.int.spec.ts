/**
 * app 域自助结算（`POST /app/bookings/:id/settle`）+ **合规闸门**。
 *
 * ## 这一组用例守的是什么
 *
 * 1. **闸门必须在服务端**：`APP_SELF_PAY_ENABLED` 默认关闭时接口返回 501，
 *    且**一笔都不落库**。客户端把按钮藏起来不算数 —— 手写请求同样要挡住。
 * 2. **钱走的是同一份资金核心**：余额扣减是条件更新（余额不足 → 409 且
 *    **不部分扣**），不是「读出来减一减再写回去」。
 * 3. **到店用次卡核销会重算 `payable`**：不是简单记一笔 0 元支付单 ——
 *    否则就是「扣了顾客一次卡、价格却没减」（这正是后台收银台原来的缺口）。
 * 4. **归属只认 token**：不是本人的预约一律 403。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BizConfigService } from '../../src/modules/biz/common/biz-config.service.js';
import {
  addLocalDays,
  shopToday,
  shopWeekday,
} from '../../src/modules/biz/common/shop-time.js';
import { createTestContext, type TestContext } from './harness.js';

let ctx: TestContext;
let date: string;

type Seed = {
  serviceItemId: number;
  staffId: number;
  customerId: number;
};

async function seed(): Promise<Seed> {
  const weekday = shopWeekday(date);
  const items = await ctx.sql<{ insertId: number }[]>(
    `INSERT INTO biz_service_item (name, category, duration_minutes, buffer_minutes, price, status, sort)
     VALUES ('基础美甲', '基础', 60, 15, 10000, 'active', 1)`,
  );
  const staffs = await ctx.sql<{ insertId: number }[]>(
    `INSERT INTO biz_staff (nickname, status, sort) VALUES ('小美', 'active', 1)`,
  );
  await ctx.sql(
    `INSERT INTO biz_staff_weekly_shift (staff_id, weekday, start_time, end_time)
     VALUES (?, ?, '10:00:00', '20:00:00')`,
    [staffs.insertId, weekday],
  );
  const customers = await ctx.sql<{ insertId: number }[]>(
    `INSERT INTO biz_customer (name, phone) VALUES ('张女士', '13800000001')`,
  );
  return {
    serviceItemId: items.insertId,
    staffId: staffs.insertId,
    customerId: customers.insertId,
  };
}

/** 绑定一个小程序身份（`customerId` 非空 = 已绑定手机号） */
async function seedAppUser(openid: string, customerId: number) {
  const inserted = await ctx.sql<{ insertId: number }>(
    `INSERT INTO app_wx_user (openid, customer_id, staff_status) VALUES (?, ?, 'none')`,
    [openid, customerId],
  );
  return ctx.appToken(openid, inserted.insertId);
}

/** 走会员账务接口加钱/加积分，保证有流水（不直接 UPDATE 字段） */
async function grant(
  customerId: number,
  payload: Record<string, unknown>,
): Promise<void> {
  const response = await ctx.request(
    'POST',
    `/api/v1/biz/members/${customerId}/adjust`,
    { body: { reason: '测试预置', ...payload } },
  );
  expect([200, 201]).toContain(response.status);
}

/**
 * 造一张「顾客自助下单、**尚未付款**」的单据 —— 就是支付页要处理的那种。
 *
 * 必须走 app 域下单（`POST /app/bookings`）：小程序下单**不收款**，
 * 落 `pending` + `unpaid`、`dueAmount` = 全价。后台 `/biz/bookings` 建不出来，
 * 那边「全款模式必须收清」。
 */
async function createUnpaidBooking(row: Seed, token: string): Promise<number> {
  const response = await ctx.request('POST', '/api/v1/app/bookings', {
    token,
    body: {
      staffId: row.staffId,
      startAt: `${date}T10:00:00+08:00`,
      serviceItemIds: [row.serviceItemId],
    },
  });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return Number(response.body.id);
}

async function bookingOf(id: number) {
  const rows = await ctx.sql<{
    payable_amount: number;
    paid_amount: number;
    due_amount: number;
    pay_status: string;
    member_card_id: number | null;
  }>(
    `SELECT payable_amount, paid_amount, due_amount, pay_status, member_card_id
     FROM biz_booking WHERE id = ?`,
    [id],
  );
  return rows[0]!;
}

async function balanceOf(customerId: number): Promise<number> {
  const rows = await ctx.sql<{ total: number }>(
    `SELECT (balance_principal + balance_bonus) AS total FROM biz_customer WHERE id = ?`,
    [customerId],
  );
  return Number(rows[0]?.total ?? -1);
}

/**
 * 直接写 `sys_config` —— 这正是管理端「参数配置」页保存时改的那张表，
 * 所以这里测的是**运营真实会走的那条路**，而不是测试专用后门。
 *
 * 写完必须 `invalidate()`：配置有 10 秒缓存，不失效会读到上一轮的值，
 * 用例之间互相污染。
 */
async function writePayConfig(enabled: string, percent: string): Promise<void> {
  await ctx.sql(
    `INSERT INTO sys_config (name, config_key, value, builtin)
     VALUES ('自助支付-合规闸门（测试）', 'app.pay.selfPayEnabled', ?, 1),
            ('自助支付-放量比例（测试）', 'app.pay.rolloutPercent', ?, 1)
     ON DUPLICATE KEY UPDATE value = VALUES(value)`,
    [enabled, percent],
  );
  ctx.app.get(BizConfigService).invalidate();
}

/** 设置两道闸门：`0` = 小程序只做预约，`100` = 全量 */
function setGate(enabled: boolean, percent: number): Promise<void> {
  return writePayConfig(enabled ? 'true' : 'false', String(percent));
}

beforeAll(async () => {
  ctx = await createTestContext();
  date = addLocalDays(shopToday(), 3);
}, 120_000);

beforeEach(async () => {
  await ctx.resetBusinessData();
  // 每个用例都从**安全侧**开始（合规关、占比 0），否则上一轮写进 sys_config 的
  // 值会被下一个用例继承 —— 顺序一变就红，是最难查的一类不稳定。
  await setGate(false, 0);
}, 60_000);

afterAll(async () => {
  await ctx.close();
});

describe('app 域自助结算（A14）+ 合规闸门', () => {
  it('闸门关闭（默认）→ 501，且一笔都不落库、余额一分不动', async () => {
    const row = await seed();
    await grant(row.customerId, { balancePrincipalDelta: 100000 });
    const token = await seedAppUser('selfpay-gate-off', row.customerId);
    const bookingId = await createUnpaidBooking(row, token);

    const before = await balanceOf(row.customerId);
    const response = await ctx.request(
      'POST',
      `/api/v1/app/bookings/${bookingId}/settle`,
      {
        token,
        body: { payments: [{ channel: 'balance', amount: 10000 }] },
      },
    );

    expect(response.status).toBe(501);
    expect(String(response.body.message)).toContain('暂未开放');
    // 关键：不只是回个错 —— 账上也不能有任何变化
    expect(await balanceOf(row.customerId)).toBe(before);
    const booking = await bookingOf(bookingId);
    expect(booking.pay_status).toBe('unpaid');
    expect(booking.paid_amount).toBe(0);
    const payments = await ctx.sql<{ total: number }>(
      `SELECT COUNT(*) AS total FROM biz_payment WHERE booking_id = ?`,
      [bookingId],
    );
    expect(Number(payments[0]?.total)).toBe(0);
  });

  it('/app/member/me 如实回报闸门状态（前端据此置灰，而不是「显示可用、点了报错」）', async () => {
    const row = await seed();
    const token = await seedAppUser('selfpay-me', row.customerId);

    const off = await ctx.request('GET', '/api/v1/app/member/me', { token });
    expect(off.status).toBe(200);
    expect(off.body.selfPayEnabled).toBe(false);

    await setGate(true, 100);
    const on = await ctx.request('GET', '/api/v1/app/member/me', { token });
    expect(on.body.selfPayEnabled).toBe(true);
  });

  it('闸门打开：余额付清 → paid，且余额恰好少了应收金额', async () => {
    const row = await seed();
    await grant(row.customerId, { balancePrincipalDelta: 100000 });
    const token = await seedAppUser('selfpay-balance', row.customerId);
    const bookingId = await createUnpaidBooking(row, token);

    await setGate(true, 100);
    const before = await balanceOf(row.customerId);
    const response = await ctx.request(
      'POST',
      `/api/v1/app/bookings/${bookingId}/settle`,
      {
        token,
        body: { payments: [{ channel: 'balance', amount: 10000 }] },
      },
    );

    expect(response.status).toBe(200);
    expect(response.body.payStatus).toBe('paid');
    expect(response.body.dueAmount).toBe(0);
    expect(await balanceOf(row.customerId)).toBe(before - 10000);

    const booking = await bookingOf(bookingId);
    expect(booking.pay_status).toBe('paid');
    expect(booking.paid_amount).toBe(10000);
    const payments = await ctx.sql<{ channel: string; amount: number }[]>(
      `SELECT channel, amount FROM biz_payment WHERE booking_id = ?`,
      [bookingId],
    );
    expect(payments).toHaveLength(1);
    expect(payments[0]!.channel).toBe('balance');
  });

  it('余额不足 → 409，**不部分扣减**（钱与单都不动）', async () => {
    const row = await seed();
    // 只给 50 元，单据应收 100 元
    await grant(row.customerId, { balancePrincipalDelta: 5000 });
    const token = await seedAppUser('selfpay-short', row.customerId);
    const bookingId = await createUnpaidBooking(row, token);

    await setGate(true, 100);
    const before = await balanceOf(row.customerId);
    const response = await ctx.request(
      'POST',
      `/api/v1/app/bookings/${bookingId}/settle`,
      { token, body: { payments: [{ channel: 'balance', amount: 10000 }] } },
    );

    expect(response.status).toBe(409);
    expect(await balanceOf(row.customerId)).toBe(before);
    const booking = await bookingOf(bookingId);
    expect(booking.pay_status).toBe('unpaid');
    expect(booking.paid_amount).toBe(0);
  });

  it('**到店用次卡核销：会重算 payable（不是记一笔 0 元支付单）**', async () => {
    const row = await seed();
    const token = await seedAppUser('selfpay-card', row.customerId);
    const bookingId = await createUnpaidBooking(row, token);
    // 单据现在是全价 10000，未付
    expect((await bookingOf(bookingId)).payable_amount).toBe(10000);

    const cardType = await ctx.request('POST', '/api/v1/biz/card-types', {
      body: {
        name: '单次卡',
        price: 0,
        totalTimes: 1,
        validDays: 0,
        // 卡种适用项目必须包含单据里的项目，否则核销会被拒
        serviceItemIds: [row.serviceItemId],
      },
    });
    expect([200, 201]).toContain(cardType.status);
    const card = await ctx.request('POST', '/api/v1/biz/member-cards', {
      body: {
        customerId: row.customerId,
        cardTypeId: cardType.body.id,
        payChannel: 'cash',
      },
    });
    expect([200, 201]).toContain(card.status);

    await setGate(true, 100);
    const response = await ctx.request(
      'POST',
      `/api/v1/app/bookings/${bookingId}/settle`,
      { token, body: { memberCardId: card.body.id } },
    );

    expect(response.status).toBe(200);
    // 核心断言：payable 被重算成 0，而不是「payable 还是 10000、只是多了一笔 0 元支付」
    expect(response.body.payableAmount).toBe(0);
    expect(response.body.payStatus).toBe('paid');
    const booking = await bookingOf(bookingId);
    expect(booking.payable_amount).toBe(0);
    expect(booking.member_card_id).toBe(card.body.id);
    // 卡的次数真的扣了
    const used = await ctx.sql<{ used_times: number }>(
      `SELECT used_times FROM biz_member_card WHERE id = ?`,
      [card.body.id],
    );
    expect(Number(used[0]?.used_times)).toBe(1);
  });

  it('不是本人的预约 → 403（归属只认 token）', async () => {
    const row = await seed();
    // 单据属于 row.customerId（用**本人** token 下的单）
    const ownerToken = await seedAppUser('selfpay-owner', row.customerId);
    const bookingId = await createUnpaidBooking(row, ownerToken);

    // 另一个顾客（同样已绑定、同样有钱）来结这笔单
    const other = await ctx.sql<{ insertId: number }[]>(
      `INSERT INTO biz_customer (name, phone) VALUES ('李女士', '13800000002')`,
    );
    await grant(other.insertId, { balancePrincipalDelta: 100000 });
    const strangerToken = await seedAppUser('selfpay-stranger', other.insertId);

    await setGate(true, 100);
    const response = await ctx.request(
      'POST',
      `/api/v1/app/bookings/${bookingId}/settle`,
      {
        token: strangerToken,
        body: { payments: [{ channel: 'balance', amount: 10000 }] },
      },
    );
    expect(response.status).toBe(403);
    // 而且一分钱都没从"别人"账上扣走
    const booking = await bookingOf(bookingId);
    expect(booking.pay_status).toBe('unpaid');
    expect(booking.paid_amount).toBe(0);
  });

  it('付清后再付 → 400（金额超过待收尾款），不会重复扣钱', async () => {
    const row = await seed();
    await grant(row.customerId, { balancePrincipalDelta: 100000 });
    const token = await seedAppUser('selfpay-twice', row.customerId);
    const bookingId = await createUnpaidBooking(row, token);

    await setGate(true, 100);
    const first = await ctx.request(
      'POST',
      `/api/v1/app/bookings/${bookingId}/settle`,
      { token, body: { payments: [{ channel: 'balance', amount: 10000 }] } },
    );
    expect(first.status).toBe(200);
    const afterFirst = await balanceOf(row.customerId);

    const second = await ctx.request(
      'POST',
      `/api/v1/app/bookings/${bookingId}/settle`,
      { token, body: { payments: [{ channel: 'balance', amount: 10000 }] } },
    );
    expect(second.status).toBe(400);
    expect(await balanceOf(row.customerId)).toBe(afterFirst);
  });
});

describe('灰度放量旋钮（sys_config: app.pay.*）', () => {
  it('**放量比例不能绕过合规**：合规关着时，占比 100 也照样 501', async () => {
    const row = await seed();
    await grant(row.customerId, { balancePrincipalDelta: 100000 });
    const token = await seedAppUser('rollout-bypass', row.customerId);
    const bookingId = await createUnpaidBooking(row, token);

    // 合规 = false，占比 = 100
    await setGate(false, 100);
    const before = await balanceOf(row.customerId);
    const response = await ctx.request(
      'POST',
      `/api/v1/app/bookings/${bookingId}/settle`,
      { token, body: { payments: [{ channel: 'balance', amount: 10000 }] } },
    );
    expect(response.status).toBe(501);
    expect(await balanceOf(row.customerId)).toBe(before);
    expect((await bookingOf(bookingId)).pay_status).toBe('unpaid');
  });

  it('合规开着但占比 0 → 仍然 501（0 = 小程序只做预约）', async () => {
    const row = await seed();
    await grant(row.customerId, { balancePrincipalDelta: 100000 });
    const token = await seedAppUser('rollout-zero', row.customerId);
    const bookingId = await createUnpaidBooking(row, token);

    await setGate(true, 0);
    const me = await ctx.request('GET', '/api/v1/app/member/me', { token });
    expect(me.body.selfPayEnabled).toBe(false);

    const response = await ctx.request(
      'POST',
      `/api/v1/app/bookings/${bookingId}/settle`,
      { token, body: { payments: [{ channel: 'balance', amount: 10000 }] } },
    );
    expect(response.status).toBe(501);
  });

  it('**两端结论必须一致**：占比 50 时，me 显示可用 ⇔ settle 真的放行', async () => {
    const row = await seed();
    await grant(row.customerId, { balancePrincipalDelta: 100000 });
    const token = await seedAppUser('rollout-half', row.customerId);
    const bookingId = await createUnpaidBooking(row, token);

    await setGate(true, 50);
    const me = await ctx.request('GET', '/api/v1/app/member/me', { token });
    const settle = await ctx.request(
      'POST',
      `/api/v1/app/bookings/${bookingId}/settle`,
      { token, body: { payments: [{ channel: 'balance', amount: 10000 }] } },
    );

    // 这个身份落在哪一侧由分桶决定，但两侧**必须同一结论** ——
    // 「入口可见、一点就被拒」正是分成两套判断才会出现的 bug
    if (me.body.selfPayEnabled) {
      expect(settle.status).toBe(200);
    } else {
      expect(settle.status).toBe(501);
    }
  });

  it('放量是单调的：同一身份在 30% 放量内，调到 100% 必然也在（不会"时好时坏"）', async () => {
    const row = await seed();
    await grant(row.customerId, { balancePrincipalDelta: 100000 });
    const token = await seedAppUser('rollout-monotonic', row.customerId);

    await setGate(true, 30);
    const at30 = await ctx.request('GET', '/api/v1/app/member/me', { token });
    await setGate(true, 100);
    const at100 = await ctx.request('GET', '/api/v1/app/member/me', { token });

    expect(at100.body.selfPayEnabled).toBe(true);
    if (at30.body.selfPayEnabled) expect(at100.body.selfPayEnabled).toBe(true);
  });

  it('配置项**不存在**时也是关闭的（安全默认，不依赖 seed 跑过）', async () => {
    const row = await seed();
    await grant(row.customerId, { balancePrincipalDelta: 100000 });
    const token = await seedAppUser('rollout-missing', row.customerId);
    const bookingId = await createUnpaidBooking(row, token);

    await ctx.sql(
      `DELETE FROM sys_config WHERE config_key IN ('app.pay.selfPayEnabled', 'app.pay.rolloutPercent')`,
    );
    ctx.app.get(BizConfigService).invalidate();

    const me = await ctx.request('GET', '/api/v1/app/member/me', { token });
    expect(me.body.selfPayEnabled).toBe(false);
    const settle = await ctx.request(
      'POST',
      `/api/v1/app/bookings/${bookingId}/settle`,
      { token, body: { payments: [{ channel: 'balance', amount: 10000 }] } },
    );
    expect(settle.status).toBe(501);
  });

  it('放量比例填了越界值 → 回落 0（宁可"没放量"，也不要意外"全量"）', async () => {
    const row = await seed();
    const token = await seedAppUser('rollout-out-of-range', row.customerId);

    // 合规开着，但比例是非法值 999：getInt 的 bounds 必须把它打回默认 0
    await writePayConfig('true', '999');
    const me = await ctx.request('GET', '/api/v1/app/member/me', { token });
    expect(me.body.selfPayEnabled).toBe(false);

    // 非数字同理（配置页是自由文本输入，填错很正常）
    await writePayConfig('true', 'abc');
    ctx.app.get(BizConfigService).invalidate();
    const again = await ctx.request('GET', '/api/v1/app/member/me', { token });
    expect(again.body.selfPayEnabled).toBe(false);
  });
});
