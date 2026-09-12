/**
 * B4~B6 集成验收：挂账/应收、报表、提成、评价、周期预约、美甲师项目、通知、小程序预留。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  addLocalDays,
  DEFAULT_SHOP_TIMEZONE,
  shopLocalToUtc,
  shopToday,
  shopWeekday,
} from '../../src/modules/biz/common/shop-time.js';
import { createTestContext, type TestContext } from './harness.js';

let ctx: TestContext;
let date: string;

/**
 * 绝对时刻 → 店内墙钟 `HH:mm:ss`。
 *
 * 刻意用 `Intl` 而不是 MySQL 的 `TIME(NOW() - INTERVAL 30 MINUTE)`：
 * 后者取的是**数据库会话时区**，与应用的 `Asia/Shanghai` 不是同一套，跨机器跑会错。
 */
function shopLocalClock(instant: number): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: DEFAULT_SHOP_TIMEZONE,
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(instant));
}

type Seed = {
  serviceItemId: number;
  staffId: number;
  customerId: number;
  cardTypeId: number;
};

async function seed(options: { withCardType?: boolean } = {}): Promise<Seed> {
  const weekday = shopWeekday(date);
  const items = await ctx.sql<{ insertId: number }[]>(
    `INSERT INTO biz_service_item (name, category, duration_minutes, buffer_minutes, price, status, sort)
     VALUES ('基础美甲', '基础', 60, 15, 10000, 'active', 1),
            ('彩绘', '彩绘', 45, 15, 6000, 'active', 2)`,
  );
  const serviceItemId = items.insertId;
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
  let cardTypeId = 0;
  if (options.withCardType) {
    const cardTypes = await ctx.sql<{ insertId: number }[]>(
      `INSERT INTO biz_member_card_type (name, price, total_times, valid_days, status, sort)
       VALUES ('10 次基础美甲卡', 80000, 10, 0, 'active', 1)`,
    );
    cardTypeId = cardTypes.insertId;
    await ctx.sql(
      `INSERT INTO biz_member_card_type_item (card_type_id, service_item_id, sort) VALUES (?, ?, 1)`,
      [cardTypeId, serviceItemId],
    );
  }
  return {
    serviceItemId,
    staffId: staffs.insertId,
    customerId: customers.insertId,
    cardTypeId,
  };
}

async function createBooking(
  row: Seed,
  options: {
    startAt?: string;
    serviceItemId?: number;
    customerId?: number;
    staffId?: number;
    payments?: unknown[];
    payMode?: 'full' | 'deposit';
    depositAmount?: number;
    creditAccountId?: number;
    pointsUsed?: number;
    itemIds?: number[];
  } = {},
) {
  return ctx.request('POST', '/api/v1/biz/bookings', {
    body: {
      customerId: options.customerId ?? row.customerId,
      staffId: options.staffId ?? row.staffId,
      startAt: options.startAt ?? `${date}T10:00:00+08:00`,
      serviceItemIds: options.itemIds ?? [
        options.serviceItemId ?? row.serviceItemId,
      ],
      payMode: options.payMode ?? 'full',
      depositAmount: options.depositAmount,
      payments: options.payments ?? [{ channel: 'cash', amount: 10000 }],
      creditAccountId: options.creditAccountId,
      pointsUsed: options.pointsUsed,
    },
  });
}

beforeAll(async () => {
  ctx = await createTestContext();
  date = addLocalDays(shopToday(), 3);
}, 120_000);

afterAll(async () => {
  await ctx?.close();
});

beforeEach(async () => {
  await ctx.resetBusinessData();
});

describe('B4 挂账与应收（§18）', () => {
  it('额度校验：超出额度被拒；额度内挂账成功且 used_amount 正确', async () => {
    const row = await seed();
    const account = await ctx.request('POST', '/api/v1/biz/credit-accounts', {
      body: {
        name: '某某公司',
        type: 'company',
        creditLimit: 500000,
        settleDay: 5,
      },
    });
    expect(account.status).toBe(201);
    const accountId = account.body.id;

    // 正常项目 10000 分挂在 5000 元额度内 → 成功
    const within = await createBooking(row, {
      payments: [{ channel: 'credit', amount: 10000 }],
      creditAccountId: accountId,
    });
    expect(within.status).toBe(201);
    expect(within.body.payStatus).toBe('credit');

    // 大额项目 600000 分（6000 元）超出 5000 元额度 → 409
    const big = await ctx.sql<{ insertId: number }[]>(
      `INSERT INTO biz_service_item (name, category, duration_minutes, buffer_minutes, price, status, sort)
       VALUES ('大额套餐', '套餐', 60, 0, 600000, 'active', 9)`,
    );
    const over = await createBooking(row, {
      startAt: `${date}T13:00:00+08:00`,
      itemIds: [big.insertId],
      payments: [{ channel: 'credit', amount: 600000 }],
      creditAccountId: accountId,
    });
    expect(over.status).toBe(409);

    const [accountRow] = await ctx.sql<{ used_amount: number }[]>(
      'SELECT used_amount FROM biz_credit_account WHERE id = ?',
      [accountId],
    );
    expect(Number(accountRow.used_amount)).toBe(10000);
    const receivables = await ctx.request(
      'GET',
      `/api/v1/biz/receivables?creditAccountId=${accountId}`,
    );
    expect(receivables.body.items).toHaveLength(1);
    expect(String(receivables.body.items[0].receivableNo)).toMatch(
      /^A\d{8}\d{6}$/,
    );
  });

  it('挂账下单不写支付单，pay_status=credit；销账后逐步变 paid', async () => {
    const row = await seed();
    const account = await ctx.request('POST', '/api/v1/biz/credit-accounts', {
      body: { name: '员工小李', type: 'staff', creditLimit: 0, settleDay: 0 },
    });
    const accountId = account.body.id;
    const created = await createBooking(row, {
      payments: [{ channel: 'credit', amount: 10000 }],
      creditAccountId: accountId,
    });
    expect(created.status).toBe(201);
    expect(created.body.payStatus).toBe('credit');

    const payments = await ctx.sql<{ count: number }[]>(
      'SELECT COUNT(*) AS count FROM biz_payment WHERE booking_id = ?',
      [created.body.id],
    );
    expect(Number(payments[0].count)).toBe(0);

    const list = await ctx.request(
      'GET',
      `/api/v1/biz/receivables?creditAccountId=${accountId}`,
    );
    const receivableId = list.body.items[0].id;
    const [receivable] = await ctx.sql<{ due_date: string | null }[]>(
      'SELECT due_date FROM biz_receivable WHERE id = ?',
      [receivableId],
    );
    // settle_day=0 → 不定期
    expect(receivable.due_date).toBeNull();

    // 部分销账 4000
    const partial = await ctx.request(
      'POST',
      `/api/v1/biz/receivables/${receivableId}/settle`,
      { body: { payments: [{ channel: 'cash', amount: 4000 }] } },
    );
    expect([200, 201]).toContain(partial.status);
    expect(partial.body.status).toBe('partial');
    const [afterPartial] = await ctx.sql<{ used_amount: number }[]>(
      'SELECT used_amount FROM biz_credit_account WHERE id = ?',
      [accountId],
    );
    expect(Number(afterPartial.used_amount)).toBe(6000);

    // 超额销账被拒
    const overflow = await ctx.request(
      'POST',
      `/api/v1/biz/receivables/${receivableId}/settle`,
      { body: { payments: [{ channel: 'cash', amount: 99999 }] } },
    );
    expect(overflow.status).toBe(409);

    // 结清
    const rest = await ctx.request(
      'POST',
      `/api/v1/biz/receivables/${receivableId}/settle`,
      { body: { payments: [{ channel: 'cash', amount: 6000 }] } },
    );
    expect([200, 201]).toContain(rest.status);
    expect(rest.body.status).toBe('settled');

    // 重复销账被条件更新拦下
    const again = await ctx.request(
      'POST',
      `/api/v1/biz/receivables/${receivableId}/settle`,
      { body: { payments: [{ channel: 'cash', amount: 1000 }] } },
    );
    expect(again.status).toBe(409);

    const detail = await ctx.request(
      'GET',
      `/api/v1/biz/bookings/${created.body.id}`,
    );
    expect(detail.body.paidAmount).toBe(10000);
    expect(detail.body.payStatus).toBe('paid');

    const summary = await ctx.request('GET', '/api/v1/biz/receivables/summary');
    expect(summary.status).toBe(200);
    expect(Array.isArray(summary.body)).toBe(true);
  });
});

describe('B4 提成（§20.3）', () => {
  it('完成后按规则计提（比例 + 固定额），结算后置 settled', async () => {
    const row = await seed();
    const rule = await ctx.request('POST', '/api/v1/biz/commission-rules', {
      body: {
        name: '基础提成',
        scope: 'staff',
        staffId: row.staffId,
        permille: 100,
        fixedAmount: 500,
        base: 'paid',
        effectiveFrom: '2026-01-01',
        status: 'active',
        sort: 1,
      },
    });
    expect(rule.status).toBe(201);

    const created = await createBooking(row);
    await ctx.request('POST', `/api/v1/biz/bookings/${created.body.id}/arrive`);
    await ctx.request(
      'POST',
      `/api/v1/biz/bookings/${created.body.id}/complete`,
    );

    const records = await ctx.request(
      'GET',
      `/api/v1/biz/commission-records?staffId=${row.staffId}`,
    );
    expect(records.status).toBe(200);
    expect(records.body.items).toHaveLength(1);
    // 实收 10000 → 10% = 1000 + 固定 500
    expect(Number(records.body.items[0].amount)).toBe(1500);
    expect(Number(records.body.items[0].baseAmount)).toBe(10000);

    // 重复完成不会重复计提（非法流转被拒）
    const again = await ctx.request(
      'POST',
      `/api/v1/biz/bookings/${created.body.id}/complete`,
    );
    expect(again.status).toBe(409);

    const period = String(records.body.items[0].period);
    const settled = await ctx.request('POST', '/api/v1/biz/commission-settle', {
      body: { period },
    });
    expect([200, 201]).toContain(settled.status);
    expect(Number(settled.body.count)).toBe(1);
    expect(Number(settled.body.amount)).toBe(1500);

    const after = await ctx.request(
      'GET',
      `/api/v1/biz/commission-records?staffId=${row.staffId}&status=settled`,
    );
    expect(after.body.items.length).toBe(1);
  });
});

describe('B4 报表（§20.2）', () => {
  it('净营收 = 成功支付 − 成功退款，可手工复核', async () => {
    const row = await seed();
    await createBooking(row, {
      payments: [{ channel: 'cash', amount: 10000 }],
    });
    const online = await createBooking(row, {
      startAt: `${date}T13:00:00+08:00`,
      payments: [{ channel: 'wechat_offline', amount: 10000 }],
    });
    expect(online.status).toBe(201);

    const overview = await ctx.request(
      'GET',
      `/api/v1/biz/reports/overview?dateFrom=${shopToday()}&dateTo=${date}`,
    );
    expect(overview.status).toBe(200);
    expect(Number(overview.body.revenue.gross)).toBe(20000);
    expect(Number(overview.body.revenue.refund)).toBe(0);
    expect(Number(overview.body.revenue.net)).toBe(20000);

    const revenue = await ctx.request(
      'GET',
      `/api/v1/biz/reports/revenue?dateFrom=${shopToday()}&dateTo=${date}&granularity=day`,
    );
    expect(revenue.status).toBe(200);
    const rows = Array.isArray(revenue.body)
      ? revenue.body
      : revenue.body.items;
    expect(Array.isArray(rows)).toBe(true);
    const total = rows.reduce(
      (sum: number, item: any) => sum + Number(item.net),
      0,
    );
    expect(total).toBe(20000);

    for (const type of ['services', 'staffs', 'members', 'receivables']) {
      const response = await ctx.request(
        'GET',
        `/api/v1/biz/reports/${type}?dateFrom=${shopToday()}&dateTo=${date}`,
      );
      expect(response.status).toBe(200);
    }

    const exported = await ctx.request(
      'GET',
      `/api/v1/biz/reports/export?type=overview&dateFrom=${shopToday()}&dateTo=${date}&format=csv`,
    );
    expect(exported.status).toBe(200);
  });
});

describe('B5 评价 / 周期预约 / 美甲师项目 / 通知', () => {
  it('一单一评：同一预约二次评价被拒；隐藏后公开列表不再返回', async () => {
    const row = await seed();
    const created = await createBooking(row);
    await ctx.request('POST', `/api/v1/biz/bookings/${created.body.id}/arrive`);
    await ctx.request(
      'POST',
      `/api/v1/biz/bookings/${created.body.id}/complete`,
    );

    const review = await ctx.request('POST', '/api/v1/biz/reviews', {
      body: {
        bookingId: created.body.id,
        score: 5,
        content: '很满意',
        isPublic: true,
      },
    });
    expect(review.status).toBe(201);
    const duplicate = await ctx.request('POST', '/api/v1/biz/reviews', {
      body: { bookingId: created.body.id, score: 3, content: '再来一次' },
    });
    expect(duplicate.status).toBe(409);

    const id = review.body.id;
    const hidden = await ctx.request('PATCH', `/api/v1/biz/reviews/${id}`, {
      body: { status: 'hidden' },
    });
    expect([200, 204]).toContain(hidden.status);
    const published = await ctx.request(
      'GET',
      '/api/v1/biz/reviews?status=published',
    );
    expect(published.body.items).toHaveLength(0);
    const hiddenList = await ctx.request(
      'GET',
      '/api/v1/biz/reviews?status=hidden',
    );
    expect(hiddenList.body.items).toHaveLength(1);
  });

  it('周期预约恰好生成 4 单，重跑不重复，暂停不影响已生成', async () => {
    const row = await seed();
    const weekday = shopWeekday(shopToday());
    const endDate = addLocalDays(shopToday(), 27);
    const created = await ctx.request('POST', '/api/v1/biz/recurrences', {
      body: {
        name: '每周固定',
        customerId: row.customerId,
        staffId: row.staffId,
        serviceItemIds: [row.serviceItemId],
        weekday,
        startTime: '15:00:00',
        startDate: shopToday(),
        endDate,
        generateDays: 30,
        conflictPolicy: 'skip',
      },
    });
    expect(created.status).toBe(201);
    expect(Number(created.body.generated)).toBe(4);

    const { RecurrencePort } =
      await import('../../src/modules/biz/common/ports.js');
    const recurrences = ctx.app.get(RecurrencePort);
    const rerun = await recurrences.generate(created.body.id);
    expect(rerun.generated).toBe(0);

    const generated = await ctx.sql<{ count: number }[]>(
      'SELECT COUNT(*) AS count FROM biz_booking WHERE recurrence_id = ?',
      [created.body.id],
    );
    expect(Number(generated[0].count)).toBe(4);

    const pause = await ctx.request(
      'POST',
      `/api/v1/biz/recurrences/${created.body.id}/pause`,
    );
    expect([200, 201]).toContain(pause.status);
    const afterPause = await ctx.sql<{ count: number }[]>(
      'SELECT COUNT(*) AS count FROM biz_booking WHERE recurrence_id = ?',
      [created.body.id],
    );
    expect(Number(afterPause[0].count)).toBe(4);
  });

  it('美甲师可做项目：限制后时段为空且下单 400，清空后恢复', async () => {
    const row = await seed();
    const second = await ctx.sql<{ insertId: number }[]>(
      `INSERT INTO biz_service_item (name, category, duration_minutes, buffer_minutes, price, status, sort)
       VALUES ('延长甲', '延长', 90, 0, 20000, 'active', 5)`,
    );
    const secondItemId = second.insertId;

    const put = await ctx.request(
      'PUT',
      `/api/v1/biz/staffs/${row.staffId}/service-items`,
      { body: { serviceItemIds: [secondItemId] } },
    );
    expect([200, 204]).toContain(put.status);

    const slots = await ctx.request(
      'GET',
      `/api/v1/biz/bookings/available-slots?staffId=${row.staffId}&date=${date}&serviceItemIds=${row.serviceItemId}`,
    );
    expect(slots.body.slots).toHaveLength(0);
    expect(slots.body.reason).toBe('staff_cannot_do');

    const blocked = await createBooking(row, { itemIds: [row.serviceItemId] });
    expect(blocked.status).toBe(400);

    await ctx.request(
      'PUT',
      `/api/v1/biz/staffs/${row.staffId}/service-items`,
      {
        body: { serviceItemIds: [] },
      },
    );
    const restored = await ctx.request(
      'GET',
      `/api/v1/biz/bookings/available-slots?staffId=${row.staffId}&date=${date}&serviceItemIds=${row.serviceItemId}`,
    );
    expect(restored.body.slots.length).toBeGreaterThan(0);
    expect(restored.body.reason).toBeUndefined();
  });

  it('通知：未声明变量被拒；短信未配置不阻塞业务', async () => {
    const bad = await ctx.request('POST', '/api/v1/biz/notice-templates', {
      body: {
        code: 'bad_template',
        name: '测试',
        channel: 'sms',
        content: '尊敬的 {customerName}，您的 {notDeclared} 已就绪',
        variables: [{ name: 'customerName', label: '顾客姓名' }],
      },
    });
    expect(bad.status).toBe(400);

    // 通知模板由 seed 写入，测试库是空的，这里补一条（下单后会异步发送）
    await ctx.sql(
      `INSERT INTO sys_notice_template (code, name, channel, title, content, variables, status)
       VALUES ('booking_created', '预约成功', 'both', '预约成功通知',
               '尊敬的 {customerName}，您已预约成功', JSON_ARRAY(JSON_OBJECT('name','customerName','label','顾客姓名')), 'active')`,
    );

    const row = await seed();
    const created = await createBooking(row);
    // 下单成功即说明通知不阻塞业务（发送是事务提交后的 fire-and-forget）
    expect(created.status).toBe(201);

    let codes: string[] = [];
    for (let attempt = 0; attempt < 10 && !codes.length; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 120));
      const logs = await ctx.request('GET', '/api/v1/biz/notice-logs');
      expect(logs.status).toBe(200);
      codes = logs.body.items.map((item: any) => item.templateCode);
    }
    expect(codes).toContain('booking_created');
    // 短信未配置 → 不阻塞业务，状态落 failed/skipped 而不是抛错
    const [statuses] = await ctx.sql<{ status: string }[]>(
      `SELECT status FROM sys_notice_log WHERE template_code = 'booking_created'`,
    );
    expect(['success', 'failed', 'skipped']).toContain(statuses.status);
  });
});

describe('B6 小程序预留（§16）', () => {
  it('双向拒绝：app token 打后台被拒，后台 token 打 app 域被拒', async () => {
    await seed();
    const wx = await ctx.sql<{ insertId: number }[]>(
      `INSERT INTO app_wx_user (openid, customer_id) VALUES ('openid-reject', NULL)`,
    );
    const appToken = await ctx.appToken('openid-reject', wx.insertId);
    const backend = await ctx.request('GET', '/api/v1/biz/service-items', {
      token: appToken,
    });
    expect(backend.status).toBe(401);

    const appWithBackendToken = await ctx.request(
      'GET',
      '/api/v1/app/service-items',
    );
    expect(appWithBackendToken.status).toBe(401);
    // 这一条**不能**因为「浏览类接口放开了访客访问」而放宽：
    // `ctx.request` 不传 token 时默认带后台 token，所以这里断言的是
    // 「后台 token 打 app 域被拒」，不是「没有凭证被拒」。
    // 没有凭证的情形见下一个用例（那条现在是 200）。
  });

  it('浏览类接口访客即可访问：不带任何凭证也 200（美甲列表 / 美甲师 / 可约时段）', async () => {
    const row = await seed();
    const guest = { token: null };

    const items = await ctx.request('GET', '/api/v1/app/service-items', guest);
    expect(items.status).toBe(200);
    expect(Array.isArray(items.body.items)).toBe(true);

    const staffs = await ctx.request('GET', '/api/v1/app/staffs', guest);
    expect(staffs.status).toBe(200);
    expect(Array.isArray(staffs.body.items)).toBe(true);

    const slots = await ctx.request(
      'GET',
      `/api/v1/app/available-slots?staffId=${row.staffId}&date=${date}&serviceItemIds=${row.serviceItemId}`,
      guest,
    );
    expect(slots.status).toBe(200);
  });

  it('只读接口只返回公开字段，且可约时段与后台一致', async () => {
    const row = await seed();
    const wx = await ctx.sql<{ insertId: number }[]>(
      `INSERT INTO app_wx_user (openid, customer_id) VALUES ('openid-1', NULL)`,
    );
    const appToken = await ctx.appToken('openid-1', wx.insertId);

    const items = await ctx.request('GET', '/api/v1/app/service-items', {
      token: appToken,
    });
    expect(items.status).toBe(200);
    expect(Object.keys(items.body.items[0]).sort()).toEqual(
      [
        'category',
        'description',
        'durationMinutes',
        'id',
        'image',
        'name',
        'price',
      ].sort(),
    );

    const staffs = await ctx.request('GET', '/api/v1/app/staffs', {
      token: appToken,
    });
    expect(staffs.status).toBe(200);
    expect(Object.keys(staffs.body.items[0]).sort()).toEqual(
      ['avatar', 'bio', 'id', 'nickname'].sort(),
    );

    const appSlots = await ctx.request(
      'GET',
      `/api/v1/app/available-slots?staffId=${row.staffId}&date=${date}&serviceItemIds=${row.serviceItemId}`,
      { token: appToken },
    );
    const backendSlots = await ctx.request(
      'GET',
      `/api/v1/biz/bookings/available-slots?staffId=${row.staffId}&date=${date}&serviceItemIds=${row.serviceItemId}`,
    );
    expect(appSlots.status).toBe(200);
    expect(backendSlots.status).toBe(200);
    // G6：去掉「两边都非空才比对」——空集也必须比，否则「小程序端返回空」这类
    // 回归（排班没读到 / 时区算错）会静默通过。
    // 未来某天（60 分钟提前期够不到）两边应当**完全相等**：渠道不同，算法是同一个。
    const appTimes: string[] = appSlots.body.slots.map(
      (slot: any) => slot.startAt,
    );
    const backendTimes: string[] = backendSlots.body.slots.map(
      (slot: any) => slot.startAt,
    );
    expect(appTimes.length).toBeGreaterThan(0);
    expect(appTimes).toEqual(backendTimes);

    const me = await ctx.request('GET', '/api/v1/app/member/me', {
      token: appToken,
    });
    expect(me.status).toBe(401);
    expect(me.body.needBind).toBe(true);

    // A10 后自助下单已真实现：未绑定手机号 → 401 + needBind（不再 501）
    const skeleton = await ctx.request('POST', '/api/v1/app/bookings', {
      token: appToken,
      body: {
        staffId: row.staffId,
        startAt: `${date}T10:00:00+08:00`,
        serviceItemIds: [row.serviceItemId],
      },
    });
    expect(skeleton.status).toBe(401);
    expect(skeleton.body.needBind).toBe(true);
  });

  // 这个用例必须「当天还剩足够时间、且已经过了零点一会儿」才有意义：它比的是
  // 「未来 1 小时内能不能约」，深夜跑时当天已经没有可约时段，硬跑只会得到空集（假绿）。
  // 两个方向都要留量：
  // - 剩余不足 2.5h：排不出「now+1h 之后」的时段，比不出差异；
  // - 已过不足 1h：班次起点 now-30min 会跨到前一天，区间变成空。
  const todayForLead = shopToday();
  const startOfTomorrowMs = shopLocalToUtc(
    addLocalDays(todayForLead, 1),
    '00:00:00',
  ).getTime();
  const remainingMs = startOfTomorrowMs - Date.now();
  const elapsedMs =
    Date.now() - shopLocalToUtc(todayForLead, '00:00:00').getTime();
  it.skipIf(remainingMs < 150 * 60 * 1000 || elapsedMs < 60 * 60 * 1000)(
    'G7：小程序端 60 分钟提前期 ≠ 后台 0 分钟（同一时刻两种口径）',
    async () => {
      const row = await seed();
      const now = Date.now();
      // 班次**相对当前时间**铺开（不写死 10:00-20:00）：
      // 写死的话「未来 1 小时内」可能根本不在班次里，断言就变成空转。
      // 终点必须**截断在当天 24:00 之前**：`end_time` 是 TIME 列，跨夜的班次
      // （如 19:52 → 00:22）在 slots.service 里会被算成「结束早于开始」，排出 0 个时段。
      // 正常写入不会造出这种数据（`scheduling.service` 的 `validateWeeklyShifts` 里
      // `startTime >= endTime` 直接 400），是这里用裸 SQL 绕过了那道校验才踩到。
      const shiftEndMs = Math.min(
        now + 4 * 60 * 60 * 1000,
        startOfTomorrowMs - 60 * 1000,
      );
      await ctx.sql(
        `UPDATE biz_staff_weekly_shift SET weekday = ?, start_time = ?, end_time = ? WHERE staff_id = ?`,
        [
          shopWeekday(todayForLead),
          shopLocalClock(now - 30 * 60 * 1000),
          shopLocalClock(shiftEndMs),
          row.staffId,
        ],
      );
      const wx = await ctx.sql<{ insertId: number }>(
        `INSERT INTO app_wx_user (openid, customer_id) VALUES ('openid-lead', NULL)`,
      );
      const appToken = await ctx.appToken('openid-lead', wx.insertId);
      const query = `staffId=${row.staffId}&date=${todayForLead}&serviceItemIds=${row.serviceItemId}`;

      const appSlots = await ctx.request(
        'GET',
        `/api/v1/app/available-slots?${query}`,
        { token: appToken },
      );
      const backendSlots = await ctx.request(
        'GET',
        `/api/v1/biz/bookings/available-slots?${query}`,
      );
      expect(appSlots.status).toBe(200);
      expect(backendSlots.status).toBe(200);

      const appTimes: string[] = appSlots.body.slots.map(
        (slot: any) => slot.startAt,
      );
      const backendTimes: string[] = backendSlots.body.slots.map(
        (slot: any) => slot.startAt,
      );

      // 后台 0 分钟：能排出「现在之后立刻就能做」的时段
      expect(backendTimes.length).toBeGreaterThan(0);
      expect(new Date(backendTimes[0]).getTime()).toBeLessThan(
        now + 60 * 60 * 1000,
      );

      // 小程序 60 分钟：一个「1 小时内」的时段都不给
      expect(appTimes.length).toBeGreaterThan(0);
      for (const startAt of appTimes)
        expect(new Date(startAt).getTime()).toBeGreaterThanOrEqual(
          now + 60 * 60 * 1000 - 1000,
        );

      // 两边差的不只是「少几个」：小程序的最早时段必须严格晚于后台
      expect(appTimes).not.toContain(backendTimes[0]);
      expect(new Date(appTimes[0]).getTime()).toBeGreaterThan(
        new Date(backendTimes[0]).getTime(),
      );
    },
  );
});
