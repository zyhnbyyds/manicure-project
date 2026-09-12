/**
 * app 域「我的预约详情」：`GET /api/v1/app/bookings/:id`。
 *
 * 三件事：
 * 1. **归属隔离**（安全属性）：只能取本人的单；他人的单与不存在的单**统一 404** ——
 *    刻意不区分 403，否则等于告诉调用方「这个 id 存在、只是不属于你」；
 * 2. **按 id 直取**：支付页不必再从「列表前 50 条」里 find（老单翻不到会误报
 *    「没找到这笔订单」，用户无法为合法待付订单付款）；
 * 3. 返回**支付后确认**所需的字段（`payStatus`/`dueAmount`/`paidAmount`），
 *    让「微信收银台走完」与「账已落库」这两件事能分开判断。
 *
 * 建单走 **app 自助下单**（`POST /app/bookings`）—— 它按设计就不收款，
 * 正好得到一张 `unpaid` 的单，与支付页要确认的场景一致。
 * （走后台 `POST /biz/bookings` 会因「全款模式必须收清」而 400。）
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  addLocalDays,
  shopToday,
  shopWeekday,
} from '../../src/modules/biz/common/shop-time.js';
import { createTestContext, type TestContext } from './harness.js';

let ctx: TestContext;
let date: string;

/** 造项目 + 美甲师（含班次与可做项目映射）+ 顾客 */
async function seedBase(name: string): Promise<{
  serviceItemId: number;
  staffId: number;
  customerId: number;
}> {
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
  // 不建映射会被判「该美甲师不能做所选项目」
  await ctx.sql(
    `INSERT INTO biz_staff_service_item (staff_id, service_item_id) VALUES (?, ?)`,
    [staff.insertId, items.insertId],
  );
  const customer = await ctx.sql<{ insertId: number }>(
    `INSERT INTO biz_customer (name) VALUES (?)`,
    [name],
  );
  return {
    serviceItemId: items.insertId,
    staffId: staff.insertId,
    customerId: customer.insertId,
  };
}

/** 绑一个 app 用户到指定顾客；`customerId` 传 null = 未绑定手机号 */
async function seedAppUser(openid: string, customerId: number | null) {
  const inserted = await ctx.sql<{ insertId: number }>(
    `INSERT INTO app_wx_user (openid, customer_id, staff_status) VALUES (?, ?, 'none')`,
    [openid, customerId],
  );
  return { token: await ctx.appToken(openid, inserted.insertId) };
}

/** app 自助下单（设计上不收款 → 落 unpaid） */
async function createSelfBooking(
  seed: { serviceItemId: number; staffId: number },
  token: string,
  hour: string,
): Promise<number> {
  const created = await ctx.request('POST', '/api/v1/app/bookings', {
    token,
    body: {
      staffId: seed.staffId,
      startAt: `${date}T${hour}:00+08:00`,
      serviceItemIds: [seed.serviceItemId],
    },
  });
  expect([200, 201]).toContain(created.status);
  return (created.body as { id: number }).id;
}

beforeAll(async () => {
  ctx = await createTestContext();
  date = addLocalDays(shopToday(), 3);
}, 120_000);

beforeEach(async () => {
  await ctx.resetBusinessData();
}, 60_000);

afterAll(async () => {
  await ctx.close();
});

describe('我的预约详情（本目标新增）', () => {
  it('本人可取：返回支付页确认所需的字段', async () => {
    const seed = await seedBase('张女士');
    const { token } = await seedAppUser('detail-owner', seed.customerId);
    const bookingId = await createSelfBooking(seed, token, '10:00');

    const res = await ctx.request('GET', `/api/v1/app/bookings/${bookingId}`, {
      token,
    });

    expect(res.status).toBe(200);
    const body = res.body as {
      id: number;
      bookingNo: string;
      payStatus: string;
      payableAmount: number;
      paidAmount: number;
      dueAmount: number;
    };
    expect(body.id).toBe(bookingId);
    expect(body.bookingNo).toBeTruthy();
    // 支付页靠这三个字段判断「钱到没到」，必须都在
    expect(body.payStatus).toBe('unpaid');
    expect(body.payableAmount).toBeGreaterThan(0);
    expect(body.paidAmount).toBe(0);
    expect(body.dueAmount).toBe(body.payableAmount);
  });

  it('**他人的单统一 404**（不区分 403，避免泄露 id 是否存在）', async () => {
    const owner = await seedBase('张女士');
    const other = await seedBase('李女士');
    const ownerToken = (await seedAppUser('detail-owner-2', owner.customerId))
      .token;
    const bookingId = await createSelfBooking(owner, ownerToken, '10:00');

    // 绑到「李女士」的 app 用户去取「张女士」的单
    const { token } = await seedAppUser('detail-other', other.customerId);
    const res = await ctx.request('GET', `/api/v1/app/bookings/${bookingId}`, {
      token,
    });

    expect(res.status).toBe(404);
  });

  it('不存在的 id → 404（与「他人的单」同一个应答，无法区分）', async () => {
    const seed = await seedBase('张女士');
    const { token } = await seedAppUser('detail-missing', seed.customerId);

    const res = await ctx.request('GET', '/api/v1/app/bookings/999999', {
      token,
    });
    expect(res.status).toBe(404);
  });

  it('未绑定手机号 → 401 + needBind', async () => {
    const { token } = await seedAppUser('detail-unbound', null);

    const res = await ctx.request('GET', '/api/v1/app/bookings/1', { token });
    expect(res.status).toBe(401);
    expect((res.body as { needBind?: boolean }).needBind).toBe(true);
  });
});
