/**
 * B2 会员 + B3 收银 集成验收（真库 + 真 HTTP）。
 *
 * 重点：算价数值、账务不变量、余额永不为负（并发）、次卡核销闸门、定金/尾款、
 * 混合支付渠道汇总、退款判责与「只能执行一次」。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  addLocalDays,
  shopToday,
  shopWeekday,
} from '../../src/modules/biz/common/shop-time';
import { createTestContext, type TestContext } from './harness';

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
  await ctx.sql(
    `INSERT INTO biz_member_level (name, discount_permille, upgrade_amount, sort, status)
     VALUES ('银卡', 1000, 0, 1, 'active'), ('金卡', 950, 50000, 2, 'active')`,
  );
  return {
    serviceItemId: items.insertId,
    staffId: staffs.insertId,
    customerId: customers.insertId,
  };
}

/** 给顾客一个等级或积分（走会员账务的 adjust 接口，保证有流水） */
async function grant(
  customerId: number,
  payload: Record<string, unknown>,
): Promise<void> {
  const response = await ctx.request(
    'POST',
    `/api/v1/biz/members/${customerId}/adjust`,
    {
      body: { reason: '测试预置', ...payload },
    },
  );
  expect([200, 201]).toContain(response.status);
}

async function createBooking(
  row: Seed,
  options: {
    startAt?: string;
    payments?: unknown[];
    payMode?: 'full' | 'deposit';
    depositAmount?: number;
    pointsUsed?: number;
  } = {},
) {
  return ctx.request('POST', '/api/v1/biz/bookings', {
    body: {
      customerId: row.customerId,
      staffId: row.staffId,
      startAt: options.startAt ?? `${date}T10:00:00+08:00`,
      serviceItemIds: [row.serviceItemId],
      payMode: options.payMode ?? 'full',
      depositAmount: options.depositAmount,
      payments: options.payments ?? [],
      pointsUsed: options.pointsUsed,
    },
  });
}

beforeAll(async () => {
  ctx = await createTestContext();
  date = addLocalDays(shopToday(), 3);
  // 测试要构造小额储值场景，把「单次充值下限」临时置 0（默认 10000 分 = 100 元）
  await ctx.sql(
    `INSERT INTO sys_config (name, config_key, value, builtin)
     VALUES ('单次充值下限（测试）', 'biz.member.minRechargeAmount', '0', 1)
     ON DUPLICATE KEY UPDATE value = '0'`,
  );
  const { BizConfigService } =
    await import('../../src/modules/biz/common/biz-config.service');
  ctx.app.get(BizConfigService).invalidate();
}, 120_000);

afterAll(async () => {
  await ctx?.close();
});

beforeEach(async () => {
  await ctx.resetBusinessData();
});

describe('B2 算价与等级折扣（§5.7 / §15.2）', () => {
  it('9.5 折：原价 10000 → 优惠 500、应付 9500', async () => {
    const row = await seed();
    const [level] = await ctx.sql<{ id: number }[]>(
      `SELECT id FROM biz_member_level WHERE name = '金卡'`,
    );
    await grant(row.customerId, { levelId: level.id });
    const created = await createBooking(row, {
      payments: [{ channel: 'cash', amount: 9500 }],
    });
    expect(created.status).toBe(201);
    expect(created.body.originalPrice).toBe(10000);
    expect(created.body.levelDiscountAmount).toBe(500);
    expect(created.body.payableAmount).toBe(9500);
    // 金额快照落库
    const [booking] = await ctx.sql<{ level_discount_permille: number }[]>(
      'SELECT level_discount_permille FROM biz_booking WHERE id = ?',
      [created.body.id],
    );
    expect(Number(booking.level_discount_permille)).toBe(950);
  });

  it('积分抵扣：1000 积分抵 1000 分，且不超过折后 30%', async () => {
    const row = await seed();
    const [level] = await ctx.sql<{ id: number }[]>(
      `SELECT id FROM biz_member_level WHERE name = '金卡'`,
    );
    await grant(row.customerId, { levelId: level.id, pointsDelta: 5000 });
    const created = await createBooking(row, {
      pointsUsed: 1000,
      payments: [{ channel: 'cash', amount: 8500 }],
    });
    expect(created.status).toBe(201);
    expect(created.body.pointsDiscountAmount).toBe(1000);
    expect(created.body.pointsUsed).toBe(1000);
    expect(created.body.payableAmount).toBe(8500);

    const [customer] = await ctx.sql<{ points: number }[]>(
      'SELECT points FROM biz_customer WHERE id = ?',
      [row.customerId],
    );
    // 5000（预置）− 1000（抵扣）+ 85（实收 8500 分累计的积分）
    expect(Number(customer.points)).toBe(4085);
  });

  it('账务不变量：SUM(流水) = 会员余额 / 积分', async () => {
    const row = await seed();
    await grant(row.customerId, { pointsDelta: 3000 });
    await ctx.request(
      'POST',
      `/api/v1/biz/members/${row.customerId}/recharge`,
      {
        body: { payAmount: 100000, payChannel: 'cash' },
      },
    );
    await createBooking(row, {
      payments: [{ channel: 'cash', amount: 10000 }],
    });

    const [customer] = await ctx.sql<
      { balance_principal: number; balance_bonus: number; points: number }[]
    >(
      'SELECT balance_principal, balance_bonus, points FROM biz_customer WHERE id = ?',
      [row.customerId],
    );
    const [sums] = await ctx.sql<
      {
        principal: number;
        bonus: number;
        points: number;
      }[]
    >(
      `SELECT COALESCE(SUM(balance_delta_principal),0) AS principal,
              COALESCE(SUM(balance_delta_bonus),0) AS bonus,
              COALESCE(SUM(points_delta),0) AS points
         FROM biz_member_transaction WHERE customer_id = ?`,
      [row.customerId],
    );
    expect(Number(sums.principal)).toBe(Number(customer.balance_principal));
    expect(Number(sums.bonus)).toBe(Number(customer.balance_bonus));
    expect(Number(sums.points)).toBe(Number(customer.points));
  });

  it('充值：实付本金与赠送分列，赠送超上限被拒', async () => {
    const row = await seed();
    const plan = await ctx.request('POST', '/api/v1/biz/recharge-plans', {
      body: { name: '充 1000 送 100', payAmount: 100000, bonusAmount: 10000 },
    });
    expect(plan.status).toBe(201);
    const recharge = await ctx.request(
      'POST',
      `/api/v1/biz/members/${row.customerId}/recharge`,
      { body: { planId: plan.body.id, payChannel: 'cash' } },
    );
    expect([200, 201]).toContain(recharge.status);
    const [customer] = await ctx.sql<
      { balance_principal: number; balance_bonus: number }[]
    >(
      'SELECT balance_principal, balance_bonus FROM biz_customer WHERE id = ?',
      [row.customerId],
    );
    expect(Number(customer.balance_principal)).toBe(100000);
    expect(Number(customer.balance_bonus)).toBe(10000);

    const tooMuch = await ctx.request('POST', '/api/v1/biz/recharge-plans', {
      body: { name: '送太多', payAmount: 10000, bonusAmount: 9000 },
    });
    expect(tooMuch.status).toBe(400);
  });

  it('储值支付：余额不足 409 且不部分扣减', async () => {
    const row = await seed();
    await ctx.request(
      'POST',
      `/api/v1/biz/members/${row.customerId}/recharge`,
      {
        body: { payAmount: 8000, payChannel: 'cash' },
      },
    );
    const failed = await createBooking(row, {
      payments: [{ channel: 'balance', amount: 10000 }],
    });
    expect(failed.status).toBe(409);
    const [customer] = await ctx.sql<{ balance_principal: number }[]>(
      'SELECT balance_principal FROM biz_customer WHERE id = ?',
      [row.customerId],
    );
    expect(Number(customer.balance_principal)).toBe(8000);
    const [count] = await ctx.sql<{ count: number }[]>(
      'SELECT COUNT(*) AS count FROM biz_booking WHERE deleted_at IS NULL',
    );
    expect(Number(count.count)).toBe(0);
  });

  it('并发余额支付：余额用尽前只成功一次，余额永不为负', async () => {
    const row = await seed();
    await ctx.request(
      'POST',
      `/api/v1/biz/members/${row.customerId}/recharge`,
      {
        body: { payAmount: 10000, payChannel: 'cash' },
      },
    );
    // 5 个互不冲突的时段（60 分钟服务 + 15 分钟缓冲 → 间隔 75 分钟）
    const starts = ['10:00', '11:15', '12:30', '13:45', '15:00'];
    const responses = await Promise.all(
      starts.map((time) =>
        createBooking(row, {
          startAt: `${date}T${time}:00+08:00`,
          payments: [{ channel: 'balance', amount: 10000 }],
        }),
      ),
    );
    const ok = responses.filter((item) => item.status === 201);
    const conflicts = responses.filter((item) => item.status === 409);
    expect(ok).toHaveLength(1);
    expect(conflicts).toHaveLength(4);

    const [customer] = await ctx.sql<{ balance_principal: number }[]>(
      'SELECT balance_principal FROM biz_customer WHERE id = ?',
      [row.customerId],
    );
    expect(Number(customer.balance_principal)).toBe(0);
    expect(Number(customer.balance_principal)).toBeGreaterThanOrEqual(0);
  });
});

describe('B2 次卡与积分兑换（§15.3 / §15.5）', () => {
  it('次卡：10 次用完 → used_up，第 11 次被拒，撤销后回补', async () => {
    const row = await seed();
    const cardType = await ctx.request('POST', '/api/v1/biz/card-types', {
      body: {
        name: '10 次基础美甲卡',
        price: 80000,
        totalTimes: 10,
        validDays: 0,
        serviceItemIds: [row.serviceItemId],
      },
    });
    expect(cardType.status).toBe(201);
    const card = await ctx.request('POST', '/api/v1/biz/member-cards', {
      body: {
        customerId: row.customerId,
        cardTypeId: cardType.body.id,
        payChannel: 'cash',
      },
    });
    expect(card.status).toBe(201);
    expect(String(card.body.cardNo)).toMatch(/^C\d{8}\d{6}$/);
    const cardId = card.body.id;

    for (let index = 0; index < 10; index += 1) {
      const used = await ctx.request(
        'POST',
        `/api/v1/biz/member-cards/${cardId}/use`,
        {
          body: { serviceItemId: row.serviceItemId },
        },
      );
      expect([200, 201]).toContain(used.status);
    }
    const [usedUp] = await ctx.sql<{ status: string; used_times: number }[]>(
      'SELECT status, used_times FROM biz_member_card WHERE id = ?',
      [cardId],
    );
    expect(usedUp.status).toBe('used_up');
    expect(Number(usedUp.used_times)).toBe(10);

    const eleventh = await ctx.request(
      'POST',
      `/api/v1/biz/member-cards/${cardId}/use`,
      {
        body: { serviceItemId: row.serviceItemId },
      },
    );
    expect(eleventh.status).toBe(409);

    const reverted = await ctx.request(
      'POST',
      `/api/v1/biz/member-cards/${cardId}/revert`,
      {
        body: { reason: '核销错误' },
      },
    );
    expect([200, 201]).toContain(reverted.status);
    const [afterRevert] = await ctx.sql<
      { status: string; used_times: number }[]
    >('SELECT status, used_times FROM biz_member_card WHERE id = ?', [cardId]);
    expect(Number(afterRevert.used_times)).toBe(9);
    expect(afterRevert.status).toBe('active');

    // 撤销记录是只追加的
    const logs = await ctx.sql<{ type: string }[]>(
      'SELECT type FROM biz_member_card_log WHERE card_id = ? ORDER BY id',
      [cardId],
    );
    expect(logs.filter((log) => log.type === 'use')).toHaveLength(10);
    expect(logs.filter((log) => log.type === 'revert')).toHaveLength(1);
  });

  it('次卡核销下单：payable = 0，不叠加等级折扣与积分', async () => {
    const row = await seed();
    const [level] = await ctx.sql<{ id: number }[]>(
      `SELECT id FROM biz_member_level WHERE name = '金卡'`,
    );
    await grant(row.customerId, { levelId: level.id, pointsDelta: 1000 });
    const cardType = await ctx.request('POST', '/api/v1/biz/card-types', {
      body: {
        name: '单次卡',
        price: 9000,
        totalTimes: 1,
        validDays: 0,
        serviceItemIds: [row.serviceItemId],
      },
    });
    const card = await ctx.request('POST', '/api/v1/biz/member-cards', {
      body: {
        customerId: row.customerId,
        cardTypeId: cardType.body.id,
        payChannel: 'cash',
      },
    });
    const created = await createBooking(row, {
      payments: [{ channel: 'card', amount: 0, memberCardId: card.body.id }],
      pointsUsed: 1000,
    });
    expect(created.status).toBe(201);
    expect(created.body.payableAmount).toBe(0);
    expect(created.body.pointsDiscountAmount).toBe(0);
    expect(created.body.payStatus).toBe('paid');
    const [customer] = await ctx.sql<{ points: number }[]>(
      'SELECT points FROM biz_customer WHERE id = ?',
      [row.customerId],
    );
    // 次卡不扣积分（发卡本身会按实付金额累计 90 积分，故只断言「没有减少」）
    expect(Number(customer.points)).toBeGreaterThanOrEqual(1000);
  });

  it('积分兑换：同一事务扣积分 + 发卡；撤销回补并废卡', async () => {
    const row = await seed();
    await grant(row.customerId, { pointsDelta: 5000 });
    const cardType = await ctx.request('POST', '/api/v1/biz/card-types', {
      body: {
        name: '兑换卡',
        price: 0,
        totalTimes: 1,
        validDays: 0,
        serviceItemIds: [row.serviceItemId],
      },
    });
    const goods = await ctx.request('POST', '/api/v1/biz/points-goods', {
      body: {
        name: '500 分换 1 次基础美甲',
        cardTypeId: cardType.body.id,
        points: 5000,
      },
    });
    expect(goods.status).toBe(201);

    const redeem = await ctx.request(
      'POST',
      `/api/v1/biz/members/${row.customerId}/redeem`,
      { body: { goodsId: goods.body.id } },
    );
    expect([200, 201]).toContain(redeem.status);
    const [afterRedeem] = await ctx.sql<{ points: number }[]>(
      'SELECT points FROM biz_customer WHERE id = ?',
      [row.customerId],
    );
    expect(Number(afterRedeem.points)).toBe(0);
    const redeems = await ctx.request('GET', '/api/v1/biz/points-redeems');
    expect(redeems.body.items).toHaveLength(1);
    const redeemId = redeems.body.items[0].id;
    const cardId = redeems.body.items[0].memberCardId;

    const revert = await ctx.request(
      'POST',
      `/api/v1/biz/points-redeems/${redeemId}/revert`,
      { body: { reason: '顾客改主意' } },
    );
    expect([200, 201]).toContain(revert.status);
    const [afterRevert] = await ctx.sql<{ points: number }[]>(
      'SELECT points FROM biz_customer WHERE id = ?',
      [row.customerId],
    );
    expect(Number(afterRevert.points)).toBe(5000);
    const [card] = await ctx.sql<{ status: string }[]>(
      'SELECT status FROM biz_member_card WHERE id = ?',
      [cardId],
    );
    expect(card.status).toBe('refunded');
  });
});

describe('B3 定金 / 尾款 / 混合支付（§5.8 / §17.2）', () => {
  it('定金 → partial + due_amount；settle 收清 → paid + settled_at', async () => {
    const row = await seed();
    const created = await createBooking(row, {
      payMode: 'deposit',
      depositAmount: 3000,
      payments: [{ channel: 'cash', amount: 3000 }],
    });
    expect(created.status).toBe(201);
    expect(created.body.payStatus).toBe('partial');
    expect(created.body.paidAmount).toBe(3000);
    expect(created.body.dueAmount).toBe(7000);

    const settled = await ctx.request(
      'POST',
      `/api/v1/biz/bookings/${created.body.id}/settle`,
      { body: { payments: [{ channel: 'cash', amount: 7000 }] } },
    );
    expect([200, 201]).toContain(settled.status);
    expect(settled.body.payStatus).toBe('paid');
    expect(settled.body.dueAmount).toBe(0);
    expect(settled.body.settledAt).toBeTruthy();
  });

  it('混合支付：余额 4000 + 现金 6000 → 2 张支付单，汇总 balance,cash', async () => {
    const row = await seed();
    await ctx.request(
      'POST',
      `/api/v1/biz/members/${row.customerId}/recharge`,
      {
        body: { payAmount: 4000, payChannel: 'cash' },
      },
    );
    const created = await createBooking(row, {
      payments: [
        { channel: 'balance', amount: 4000 },
        { channel: 'cash', amount: 6000 },
      ],
    });
    expect(created.status).toBe(201);
    expect(created.body.payStatus).toBe('paid');
    expect(created.body.payChannelSummary).toBe('balance,cash');
    const [count] = await ctx.sql<{ count: number }[]>(
      'SELECT COUNT(*) AS count FROM biz_payment WHERE booking_id = ? AND status = ?',
      [created.body.id, 'success'],
    );
    expect(Number(count.count)).toBe(2);
    const [customer] = await ctx.sql<{ balance_principal: number }[]>(
      'SELECT balance_principal FROM biz_customer WHERE id = ?',
      [row.customerId],
    );
    expect(Number(customer.balance_principal)).toBe(0);
  });

  it('收款超额被拒；挂账可与混合支付叠加', async () => {
    const row = await seed();
    const over = await createBooking(row, {
      payments: [{ channel: 'cash', amount: 20000 }],
    });
    expect(over.status).toBe(400);

    const account = await ctx.request('POST', '/api/v1/biz/credit-accounts', {
      body: {
        name: '混合挂账公司',
        type: 'company',
        creditLimit: 0,
        settleDay: 0,
      },
    });
    await ctx.request(
      'POST',
      `/api/v1/biz/members/${row.customerId}/recharge`,
      {
        body: { payAmount: 2000, payChannel: 'cash' },
      },
    );
    const mixed = await ctx.request('POST', '/api/v1/biz/bookings', {
      body: {
        customerId: row.customerId,
        staffId: row.staffId,
        startAt: `${date}T10:00:00+08:00`,
        serviceItemIds: [row.serviceItemId],
        payMode: 'full',
        creditAccountId: account.body.id,
        payments: [
          { channel: 'balance', amount: 2000 },
          { channel: 'credit', amount: 8000 },
        ],
      },
    });
    expect(mixed.status).toBe(201);
    expect(mixed.body.payStatus).toBe('credit');
    expect(Number(mixed.body.paidAmount)).toBe(2000);
  });
});

describe('B3 退款：按服务阶段分流（服务开始前全额直退 / 服务中店长手动退）', () => {
  beforeEach(async () => {
    // 规则表降级为**参考**：这里故意插一套「2 小时内不退」的老规则，
    // 用来验证它不再影响实际退款金额（只能出现在 policySuggestAmount 里）
    await ctx.sql(
      `INSERT INTO biz_refund_policy (name, hours_before, refund_permille, min_amount, status, sort)
       VALUES ('24 小时以上全退', 24, 1000, 0, 'active', 1),
              ('2-24 小时退一半', 2, 500, 0, 'active', 2),
              ('2 小时内不退', 0, 0, 0, 'active', 3)`,
    );
  });

  it('服务开始前：无理由全额退，建单即执行（不再有 pending 中间态）', async () => {
    const row = await seed();
    const created = await createBooking(row, {
      payments: [{ channel: 'cash', amount: 10000 }],
    });
    const bookingId = created.body.id;

    const preview = await ctx.request('POST', '/api/v1/biz/refunds/preview', {
      body: { bookingId },
    });
    expect(preview.status).toBe(201);
    expect(preview.body.stage).toBe('before_start');
    expect(preview.body.lockedAmount).toBe(true);
    expect(Number(preview.body.suggestAmount)).toBe(10000);
    // 老规则仍会算出一个参考值（具体多少随时点变），但它不再决定实际退款金额
    expect(preview.body.policySuggestAmount).toBeGreaterThanOrEqual(0);

    const applied = await ctx.request('POST', '/api/v1/biz/refunds', {
      body: { bookingId, mode: 'cash', reason: '顾客取消' },
    });
    expect(applied.status).toBe(201);
    expect(applied.body.status).toBe('success');
    expect(applied.body.executed).toBe(true);
    expect(applied.body.refundStage).toBe('before_start');
    expect(Number(applied.body.actualAmount)).toBe(10000);

    // 「只能执行一次」：重复审批既可以是 200（幂等返回）也可以是 409（状态机拒绝）
    const again = await ctx.request(
      'POST',
      `/api/v1/biz/refunds/${applied.body.id}/approve`,
    );
    expect([200, 201, 409]).toContain(again.status);
    const [sum] = await ctx.sql<{ total: number }[]>(
      `SELECT COALESCE(SUM(actual_amount),0) AS total FROM biz_refund
        WHERE booking_id = ? AND status = 'success'`,
      [bookingId],
    );
    expect(Number(sum.total)).toBe(10000);

    const detail = await ctx.request(
      'GET',
      `/api/v1/biz/bookings/${bookingId}`,
    );
    expect(Number(detail.body.refundAmount)).toBe(10000);
    expect(detail.body.payStatus).toBe('refunded');
  });

  it('服务开始前：前端传小额也全额退（金额由服务端锁定）', async () => {
    const row = await seed();
    const created = await createBooking(row, {
      payments: [{ channel: 'cash', amount: 10000 }],
    });
    const applied = await ctx.request('POST', '/api/v1/biz/refunds', {
      body: {
        bookingId: created.body.id,
        amount: 100,
        mode: 'cash',
        reason: '顾客取消',
        liable: 'customer',
      },
    });
    expect(applied.status).toBe(201);
    expect(Number(applied.body.actualAmount)).toBe(10000);
    // 无理由退款：责任固定记在店家侧，不接受前端传 customer
    expect(applied.body.liable).toBe('store');
  });

  it('服务开始后：店员 403 / 缺金额 400 / 超上限 400；店长手动填额可退', async () => {
    const row = await seed();
    const created = await createBooking(row, {
      payments: [{ channel: 'cash', amount: 10000 }],
    });
    const bookingId = created.body.id;
    // 把开始时间推到过去 = 服务中（判定基准是「退款时点 vs start_at」）。
    // 用 UTC_TIMESTAMP() 而不是 NOW()：DATETIME 列按 UTC 读写，NOW() 会带上服务器会话时区，
    // 写进去会被当成「未来」而判成 before_start。
    await ctx.sql(
      `UPDATE biz_booking SET start_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 HOUR),
              end_at = DATE_ADD(UTC_TIMESTAMP(), INTERVAL 1 HOUR) WHERE id = ?`,
      [bookingId],
    );

    const preview = await ctx.request('POST', '/api/v1/biz/refunds/preview', {
      body: { bookingId },
    });
    expect(preview.status).toBe(201);
    expect(preview.body.stage).toBe('in_service');
    expect(preview.body.lockedAmount).toBe(false);
    // 服务中不自动带出任何金额
    expect(Number(preview.body.suggestAmount)).toBe(0);

    // 只有 biz:refund:apply（前台店员）→ 服务中的退款要被拦
    const clerkToken = await ctx.token({ permissions: ['biz:refund:apply'] });
    const denied = await ctx.request('POST', '/api/v1/biz/refunds', {
      token: clerkToken,
      body: { bookingId, amount: 3000, mode: 'cash', reason: '顾客不满意' },
    });
    expect(denied.status).toBe(403);

    const missing = await ctx.request('POST', '/api/v1/biz/refunds', {
      body: { bookingId, mode: 'cash', reason: '顾客不满意' },
    });
    expect(missing.status).toBe(400);

    const tooMuch = await ctx.request('POST', '/api/v1/biz/refunds', {
      body: { bookingId, amount: 20000, mode: 'cash', reason: '顾客不满意' },
    });
    expect(tooMuch.status).toBe(400);

    // 店长（默认 token 带 *:*:*）手动退 3000
    const ok = await ctx.request('POST', '/api/v1/biz/refunds', {
      body: {
        bookingId,
        amount: 3000,
        mode: 'cash',
        reason: '服务中止，退部分',
      },
    });
    expect(ok.status).toBe(201);
    expect(ok.body.status).toBe('success');
    expect(ok.body.refundStage).toBe('in_service');
    expect(Number(ok.body.actualAmount)).toBe(3000);
  });

  it('驳回必须填原因（历史遗留的待审批单仍可处理）', async () => {
    const row = await seed();
    const created = await createBooking(row, {
      payments: [{ channel: 'cash', amount: 10000 }],
    });
    // 新流程不再产生 pending，手工造一张历史遗留单验证驳回接口仍可用
    const [payment] = await ctx.sql<{ id: number; store_id: number }[]>(
      `SELECT id, store_id FROM biz_payment WHERE booking_id = ? LIMIT 1`,
      [created.body.id],
    );
    const inserted = await ctx.sql<{ insertId: number }[]>(
      `INSERT INTO biz_refund
         (refund_no, store_id, payment_id, booking_id, customer_id, amount, actual_amount,
          deduct_amount, mode, liable, reason, status, apply_by, apply_at, refund_stage)
       VALUES ('R-LEGACY-1', ?, ?, ?, ?, 10000, 5000, 5000, 'cash', 'customer', '历史单',
               'pending', 1, NOW(), 'before_start')`,
      [payment!.store_id, payment!.id, created.body.id, row.customerId],
    );
    const rejected = await ctx.request(
      'POST',
      `/api/v1/biz/refunds/${inserted.insertId}/reject`,
      { body: {} },
    );
    expect(rejected.status).toBe(400);
    const ok = await ctx.request(
      'POST',
      `/api/v1/biz/refunds/${inserted.insertId}/reject`,
      { body: { reason: '已消费完不予退款' } },
    );
    expect([200, 201]).toContain(ok.status);
  });
});

describe('B3 对账差异（§17.5）', () => {
  it('标记处理必须填备注，且重跑对账不产生重复差异', async () => {
    await seed();
    const reconcile = await ctx.request(
      'POST',
      '/api/v1/biz/payment-diffs/reconcile',
      { body: { billDate: addLocalDays(shopToday(), -1) } },
    );
    expect([200, 201]).toContain(reconcile.status);
    const first = await ctx.request('GET', '/api/v1/biz/payment-diffs');
    const before = first.body.items.length;

    await ctx.request('POST', '/api/v1/biz/payment-diffs/reconcile', {
      body: { billDate: addLocalDays(shopToday(), -1) },
    });
    const second = await ctx.request('GET', '/api/v1/biz/payment-diffs');
    expect(second.body.items.length).toBe(before);

    if (before > 0) {
      const id = second.body.items[0].id;
      const noRemark = await ctx.request(
        'PATCH',
        `/api/v1/biz/payment-diffs/${id}`,
        {
          body: { status: 'resolved' },
        },
      );
      expect(noRemark.status).toBe(400);
      const handled = await ctx.request(
        'PATCH',
        `/api/v1/biz/payment-diffs/${id}`,
        {
          body: { status: 'resolved', remark: '已手工补单' },
        },
      );
      expect([200, 204]).toContain(handled.status);
    }
  });
});
