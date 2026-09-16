/**
 * 在线渠道（`wxpay_native`）**结算**路径的覆盖。
 *
 * ## 为什么单独建这个文件
 *
 * `.env.test` 里没有任何渠道凭据，provider 的 `configured` 恒为 false，
 * 所以「结算时向渠道下单、把 `code_url` 带回收银台」这条路径
 * **一直没有任何测试**（现有测试要么直接 INSERT 支付单，要么只走线下渠道）。
 *
 * 而它是「收款与建单同事务」这条红线所在的地方 —— 要动 `createInTx`
 * （把渠道下单移出事务）之前，**必须先有这张安全网**。
 *
 * 渠道用 stub：`createNativeOrder` 直接返回假 `code_url`，不打网络。
 */
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  addLocalDays,
  shopToday,
  shopWeekday,
} from '../../src/modules/biz/common/shop-time';
import { WxpayNativeProvider } from '../../src/modules/biz/payment/channels/wxpay-native.provider';
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
  const items = await ctx.sql<{ insertId: number }>(
    `INSERT INTO biz_service_item (name, category, duration_minutes, buffer_minutes, price, status, sort)
     VALUES ('基础美甲', '基础', 60, 15, 10000, 'active', 1)`,
  );
  const staff = await ctx.sql<{ insertId: number }>(
    `INSERT INTO biz_staff (nickname, status, sort) VALUES ('小美', 'active', 1)`,
  );
  await ctx.sql(
    `INSERT INTO biz_staff_weekly_shift (staff_id, weekday, start_time, end_time)
     VALUES (?, ?, '10:00:00', '20:00:00')`,
    [staff.insertId, weekday],
  );
  const customer = await ctx.sql<{ insertId: number }>(
    `INSERT INTO biz_customer (name) VALUES ('在线结算顾客')`,
  );
  return {
    serviceItemId: items.insertId,
    staffId: staff.insertId,
    customerId: customer.insertId,
  };
}

/** 先收 3000 定金（现金），尾款 7000 待收 */
async function seedPartialBooking(row: Seed): Promise<number> {
  const created = await ctx.request('POST', '/api/v1/biz/bookings', {
    body: {
      customerId: row.customerId,
      staffId: row.staffId,
      startAt: `${date}T10:00:00+08:00`,
      serviceItemIds: [row.serviceItemId],
      payMode: 'deposit',
      depositAmount: 3000,
      payments: [{ channel: 'cash', amount: 3000 }],
    },
  });
  expect([200, 201]).toContain(created.status);
  return (created.body as { id: number }).id;
}

/** 被打过 `configured` 补丁的 provider 实例（afterEach 里清掉 own property 复原） */
const patched: WxpayNativeProvider[] = [];

/**
 * 把渠道 provider 变成「已配置」并让下单返回假 `code_url`。
 *
 * 注意：bun 的 vitest 兼容层**不支持 `vi.spyOn(obj, prop, 'get')`**（访问器属性），
 * 所以这里用 `Object.defineProperty` 在**实例上**盖一个 own property，
 * 测试结束删掉它即可恢复原型上的 getter。
 */
function stubChannel(codeUrl = 'weixin://wxpay/bizpayurl?pr=TESTQR') {
  const provider = ctx.app.get(WxpayNativeProvider);
  Object.defineProperty(provider, 'configured', {
    get: () => true,
    configurable: true,
  });
  patched.push(provider);
  return vi.spyOn(provider, 'createNativeOrder').mockResolvedValue({
    codeUrl,
    expireAt: new Date(Date.now() + 5 * 60_000),
    raw: { code_url: codeUrl },
  });
}

async function paymentRowsOf(bookingId: number) {
  return ctx.sql<
    { id: number; channel: string; status: string; code_url: string | null }[]
  >(
    `SELECT id, channel, status, code_url FROM biz_payment WHERE booking_id = ? ORDER BY id`,
    [bookingId],
  );
}

beforeAll(async () => {
  ctx = await createTestContext();
  date = addLocalDays(shopToday(), 3);
}, 120_000);

beforeEach(async () => {
  await ctx.resetBusinessData();
}, 60_000);

afterEach(() => {
  vi.restoreAllMocks();
  for (const provider of patched) {
    delete (provider as unknown as Record<string, unknown>)['configured'];
  }
  patched.length = 0;
});

describe('B3 在线渠道结算（wxpay_native）', () => {
  it('尾款走在线渠道 → 落 pending 单 + 渠道下单 + `code_url` 返回给收银台', async () => {
    const row = await seed();
    const bookingId = await seedPartialBooking(row);
    const order = stubChannel();

    const settled = await ctx.request(
      'POST',
      `/api/v1/biz/bookings/${bookingId}/settle`,
      { body: { payments: [{ channel: 'wxpay_native', amount: 7000 }] } },
    );

    expect([200, 201]).toContain(settled.status);
    // 渠道确实被调了一次，金额就是尾款
    expect(order).toHaveBeenCalledTimes(1);
    expect(order.mock.calls[0]?.[0]).toMatchObject({ amount: 7000 });

    // 支付单落 pending，并带上了渠道返回的 code_url
    const rows = await paymentRowsOf(bookingId);
    const online = rows.find((r) => r.channel === 'wxpay_native');
    expect(online?.status).toBe('pending');
    expect(online?.code_url).toBe('weixin://wxpay/bizpayurl?pr=TESTQR');

    // 收银台靠响应里的 codeUrl 弹二维码
    const outcomes = (
      settled.body as { payments?: { codeUrl?: string | null }[] }
    ).payments;
    expect(outcomes?.some((p) => p.codeUrl)).toBe(true);
  });

  it('**渠道未配置 → 结算失败且不留 pending 单**（重构时必须保留的行为）', async () => {
    const row = await seed();
    const bookingId = await seedPartialBooking(row);
    const before = await paymentRowsOf(bookingId);

    // 不打桩：provider 的 configured 为 false
    const settled = await ctx.request(
      'POST',
      `/api/v1/biz/bookings/${bookingId}/settle`,
      { body: { payments: [{ channel: 'wxpay_native', amount: 7000 }] } },
    );

    expect(settled.status).toBe(409);
    // 整个事务回滚：没有留下任何 pending 的在线单
    const after = await paymentRowsOf(bookingId);
    expect(after.length).toBe(before.length);
    expect(after.some((r) => r.channel === 'wxpay_native')).toBe(false);
  });
});
