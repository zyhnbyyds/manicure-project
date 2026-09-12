/**
 * B6 app 域契约收口：501 骨架（G4）、`/app/member/me` 字段与越权（G8）、
 * 未配置微信凭据 → 503（G2）。
 *
 * 这三件事的共同点是**出了事没人拦**：
 * - 骨架端点 P2 才会填实现，期间任何一次手滑改路由/改 schema 都不会让现有用例变红；
 * - `/app/member/me` 是 C 端唯一一处直接吐会员账务数据的接口，字段漏出去就是数据泄露；
 * - 「未配置凭据」这条分支在集成环境永远走不到（harness 固定注入假实现），只能靠注入真实现来验。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  addLocalDays,
  shopToday,
  shopWeekday,
} from '../../src/modules/biz/common/shop-time.js';
import { createTestContext, type TestContext } from './harness.js';

let ctx: TestContext;
/** 未配置凭据的 context（G2 专用，见文件末尾的 describe） */
let noCredentialCtx: TestContext;
let date: string;

/**
 * 骨架端点清单：**必须与 spec §16.1 的 501 清单逐条对应**（G5 的口径落点）。
 *
 * `GET /app/member/cards` 已由 A9、`POST /app/reviews` 已由 A11、`POST /app/subscribe` 已由 A12、
 * `POST /app/payments/wxpay/notify` 已由 A13、`GET/POST /app/bookings` + `POST /app/bookings/:id/cancel`
 * 已由 A10 换成真实现，从清单里移出（8 → 1）。每实现一个 P2 端点，这里就少一条——条数即进度。
 *
 * 剩 1 个：**JSAPI 支付**（`POST /app/payments/wxpay/jsapi`）。它不是「没做完」，是契约位：
 * 后台在线支付本期只有 Native 扫码（§17.1），JSAPI 预支付留到 P2（需要商户号 + openid）。
 */
const SKELETON_ROUTES: {
  name: string;
  method: string;
  path: string;
  body?: unknown;
  /** 是否需要 app token（支付回调是渠道回调，天生不带 token） */
  guarded: boolean;
}[] = [
  {
    name: 'JSAPI 支付',
    method: 'POST',
    path: '/api/v1/app/payments/wxpay/jsapi',
    body: { bookingId: 1, purpose: 'deposit' },
    guarded: true,
  },
];

async function countOf(table: string): Promise<number> {
  const rows = await ctx.sql<{ total: number }[]>(
    `SELECT COUNT(*) AS total FROM \`${table}\``,
  );
  return Number(rows[0].total);
}

/** 造一条已绑定顾客的小程序身份 */
async function seedBoundAppUser(
  openid: string,
  customerId: number | null,
): Promise<{ appUserId: number; token: string }> {
  const inserted = await ctx.sql<{ insertId: number }>(
    `INSERT INTO app_wx_user (openid, customer_id, staff_status) VALUES (?, ?, 'none')`,
    [openid, customerId],
  );
  const appUserId = inserted.insertId;
  return { appUserId, token: await ctx.appToken(openid, appUserId) };
}

/** 造一个只有基本档案的顾客（次卡 / 等级另配） */
async function seedCustomer(name: string, phone: string): Promise<number> {
  const inserted = await ctx.sql<{ insertId: number }>(
    `INSERT INTO biz_customer (name, phone) VALUES (?, ?)`,
    [name, phone],
  );
  return inserted.insertId;
}

/**
 * 造一个「有等级 / 有积分 / 有余额 / 有次卡」的顾客。
 * 用真实账务列而不是走业务接口：这一组用例验的是 **读** 出来的字段集合，
 * 数据怎么来的不重要，重要的是别多吐、也别少吐。
 */
async function seedRichCustomer(
  name: string,
  phone: string,
  levelName = '金卡',
  discountPermille = 880,
): Promise<number> {
  const levels = await ctx.sql<{ insertId: number }>(
    `INSERT INTO biz_member_level (name, discount_permille, upgrade_amount, sort)
     VALUES (?, ?, 0, 1)`,
    [levelName, discountPermille],
  );
  const levelId = levels.insertId;
  const customers = await ctx.sql<{ insertId: number }>(
    `INSERT INTO biz_customer (name, phone, level_id, points, balance_principal, balance_bonus)
     VALUES (?, ?, ?, 320, 15000, 2000)`,
    [name, phone, levelId],
  );
  const customerId = customers.insertId;

  const cardTypes = await ctx.sql<{ insertId: number }>(
    `INSERT INTO biz_member_card_type (name, price, total_times, valid_days)
     VALUES (?, 100000, 10, 365)`,
    [`十次卡-${phone}`],
  );
  await ctx.sql(
    `INSERT INTO biz_member_card
       (card_no, customer_id, card_type_id, card_name, total_times, used_times,
        price, pay_channel, purchased_at, expire_at, status)
     VALUES (?, ?, ?, ?, 10, 3, 100000, 'wechat', NOW(), DATE_ADD(NOW(), INTERVAL 365 DAY), 'active')`,
    [`CARD-${phone}`, customerId, cardTypes.insertId, `十次卡-${phone}`],
  );
  return customerId;
}

/** 造一单；`status` 决定是否可评价 / 可作为授权的关联上下文 */
async function seedBooking(
  customerId: number,
  name: string,
  status: 'pending' | 'completed',
): Promise<number> {
  const staffs = await ctx.sql<{ insertId: number }>(
    `INSERT INTO biz_staff (nickname, status, sort) VALUES (?, 'active', 1)`,
    [`美甲师-${name}`],
  );
  const inserted = await ctx.sql<{ insertId: number }>(
    `INSERT INTO biz_booking
       (booking_no, customer_id, staff_id, start_at, end_at, duration_minutes,
        original_price, payable_amount, paid_amount, due_amount, status, pay_status,
        customer_name, customer_phone)
     VALUES (?, ?, ?, ?, ?, 60, 10000, 10000, 10000, 0, ?, 'paid', ?, '13800000000')`,
    [
      `B-${name}`,
      customerId,
      staffs.insertId,
      `${date} 10:00:00`,
      `${date} 11:00:00`,
      status,
      name,
    ],
  );
  return inserted.insertId;
}

beforeAll(async () => {
  ctx = await createTestContext();
  date = addLocalDays(shopToday(), 3);

  const { WxMiniappProvider, HttpWxMiniappProvider } =
    await import('../../src/modules/app/auth/wx-miniapp.provider.js');
  // 只喂一个「凭据为空」的配置桩：真实现只用到 config.wxMiniapp，
  // 这样就能在不联网的前提下让整条链路（controller → service → provider）跑出 503。
  const emptyCredentialConfig = {
    wxMiniapp: {
      appId: undefined,
      secret: undefined,
      configured: false,
      fake: false,
    },
  };
  noCredentialCtx = await createTestContext({
    providers: [
      {
        provide: WxMiniappProvider,
        useValue: new HttpWxMiniappProvider(emptyCredentialConfig as never),
      },
    ],
  });
}, 180_000);

beforeEach(async () => {
  await ctx.resetBusinessData();
});

afterAll(async () => {
  await ctx.close();
  await noCredentialCtx.close();
});

/* ------------------------------------------------------------------ */

describe('B6 契约骨架：501 端点清单（G4 / G5）', () => {
  it('清单条数与 spec §16.1 一致（1 个），且全部返回 501', async () => {
    // 口径锚点：spec §12 原写 5 个、§16.1 列 8 个、代码 9 个（含已转真实现的 auth/phone）。
    // 统一到 8 之后，`POST /app/auth/phone`（A8）、`GET /app/member/cards`（A9）、
    // `POST /app/reviews`（A11）、`POST /app/subscribe`（A12）、
    // `POST /app/payments/wxpay/notify`（A13）、`GET/POST /app/bookings` +
    // `POST /app/bookings/:id/cancel`（A10）又各自转成真实现 → 1。
    expect(SKELETON_ROUTES).toHaveLength(1);

    const { token } = await seedBoundAppUser('openid-skeleton', null);
    for (const route of SKELETON_ROUTES) {
      const response = await ctx.request(route.method, route.path, {
        token: route.guarded ? token : null,
        body: route.body,
      });
      expect(response.status, `${route.name} ${route.path}`).toBe(501);
    }
  });

  it('骨架只冻结契约，一个字都不落库', async () => {
    const { token } = await seedBoundAppUser('openid-nowrite', null);
    // 先放一批真实数据进去，避免「空库当然没变化」这种假绿
    const staffs = await ctx.sql<{ insertId: number }>(
      `INSERT INTO biz_staff (nickname, status, sort) VALUES ('小美', 'active', 1)`,
    );
    await ctx.sql(
      `INSERT INTO biz_staff_weekly_shift (staff_id, weekday, start_time, end_time)
       VALUES (?, ?, '10:00:00', '20:00:00')`,
      [staffs.insertId, shopWeekday(date)],
    );
    const items = await ctx.sql<{ insertId: number }>(
      `INSERT INTO biz_service_item (name, category, duration_minutes, buffer_minutes, price, status, sort)
       VALUES ('基础美甲', '基础', 60, 15, 10000, 'active', 1)`,
    );
    const customers = await ctx.sql<{ insertId: number }>(
      `INSERT INTO biz_customer (name, phone) VALUES ('张女士', '13800000001')`,
    );
    await ctx.sql(
      `INSERT INTO biz_booking
         (booking_no, customer_id, staff_id, start_at, end_at, duration_minutes,
          original_price, payable_amount, paid_amount, due_amount, status, pay_status,
          customer_name, customer_phone)
       VALUES ('B-SKEL-1', ?, ?, ?, ?, 60, 10000, 10000, 0, 10000, 'pending', 'unpaid', '张女士', '13800000001')`,
      [
        customers.insertId,
        staffs.insertId,
        `${date} 10:00:00`,
        `${date} 11:00:00`,
      ],
    );

    const tables = [
      'app_wx_user',
      'biz_booking',
      'biz_payment',
      'biz_review',
      'biz_member_card',
      'biz_customer',
    ];
    const before = Object.fromEntries(
      await Promise.all(tables.map(async (t) => [t, await countOf(t)])),
    );

    for (const route of SKELETON_ROUTES) {
      await ctx.request(route.method, route.path, {
        token: route.guarded ? token : null,
        body: route.body,
      });
    }
    // 服务项目只是造数据的副产物，单独记一下确保 seed 真的写进去了
    expect(items.insertId).toBeGreaterThan(0);

    for (const table of tables) {
      expect(await countOf(table), `${table} 行数被骨架改动了`).toBe(
        before[table],
      );
    }
  });

  it('骨架的入参校验是活的：非法入参 400，不是「一律 501」', async () => {
    const { token } = await seedBoundAppUser('openid-invalid', null);

    const badReview = await ctx.request('POST', '/api/v1/app/reviews', {
      token,
      body: { bookingId: 1, rating: 9 },
    });
    expect(badReview.status).toBe(400);

    const badBooking = await ctx.request('POST', '/api/v1/app/bookings', {
      token,
      body: { staffId: 1, serviceItemIds: [] },
    });
    expect(badBooking.status).toBe(400);

    const badSubscribe = await ctx.request('POST', '/api/v1/app/subscribe', {
      token,
      body: { templateIds: [] },
    });
    expect(badSubscribe.status).toBe(400);
  });

  it('剩下的骨架全部都要 app token（回调已转真实现，见 b6-app-wxpay-notify）', async () => {
    // 之前唯一一个 `guarded:false` 的是支付回调（渠道方向，本就不带 token），
    // A13 之后它已经是真接口了，清单里剩下的都是 C 端点，一律要 token。
    expect(SKELETON_ROUTES.every((route) => route.guarded)).toBe(true);
    for (const route of SKELETON_ROUTES) {
      const response = await ctx.request(route.method, route.path, {
        token: null,
        body: route.body,
      });
      expect(response.status, `${route.name} ${route.path}`).toBe(401);
    }
  });
});

/* ------------------------------------------------------------------ */

describe('B6 /app/member/me：字段集合与越权（G8）', () => {
  it('已绑定：字段集合固定，一个内部字段都漏不出来', async () => {
    const customerId = await seedRichCustomer('李女士', '13800000021');
    const { token } = await seedBoundAppUser('openid-me', customerId);

    const me = await ctx.request('GET', '/api/v1/app/member/me', { token });
    expect(me.status).toBe(200);
    expect(Object.keys(me.body).sort()).toEqual(
      [
        'balanceBonus',
        'balancePrincipal',
        'cards',
        'customerId',
        'discountPermille',
        'levelName',
        // 积分抵扣上限（‰）：**刻意对 C 端公开** —— 小程序要用它算预估，
        // 前端不该硬编码服务端配置（曾经硬编码 500 而后端 300，预估必然对不上）
        'maxPointsPermille',
        'name',
        'phone',
        'points',
      ].sort(),
    );

    expect(me.body.customerId).toBe(customerId);
    expect(me.body.name).toBe('李女士');
    expect(me.body.levelName).toBe('金卡');
    expect(me.body.discountPermille).toBe(880);
    expect(me.body.points).toBe(320);
    expect(me.body.balancePrincipal).toBe(15000);
    expect(me.body.balanceBonus).toBe(2000);

    // 次卡字段：没有成本、没有进价、没有 remark
    expect(me.body.cards).toHaveLength(1);
    expect(Object.keys(me.body.cards[0]).sort()).toEqual(
      [
        'cardName',
        'cardNo',
        'expireAt',
        'id',
        'status',
        'totalTimes',
        'usedTimes',
      ].sort(),
    );
  });

  it('越权：换 openid 只看到自己的档案；传 customerId 入参也不好使', async () => {
    // 等级与折扣率也不同：这样「看到别人的等级」也能被抓出来，而不只是看 customerId
    const mineId = await seedRichCustomer('李女士', '13800000022', '金卡', 880);
    const otherId = await seedRichCustomer(
      '王女士',
      '13800000023',
      '银卡',
      950,
    );
    const mine = await seedBoundAppUser('openid-mine', mineId);
    const other = await seedBoundAppUser('openid-other', otherId);

    const mineMe = await ctx.request('GET', '/api/v1/app/member/me', {
      token: mine.token,
    });
    const otherMe = await ctx.request('GET', '/api/v1/app/member/me', {
      token: other.token,
    });
    expect(mineMe.status).toBe(200);
    expect(otherMe.status).toBe(200);
    expect(mineMe.body.customerId).toBe(mineId);
    expect(otherMe.body.customerId).toBe(otherId);
    expect(mineMe.body.name).toBe('李女士');
    expect(otherMe.body.name).toBe('王女士');
    expect(mineMe.body.levelName).toBe('金卡');
    expect(otherMe.body.levelName).toBe('银卡');
    // 我的次卡不会串到别人那边
    expect(mineMe.body.cards[0].cardNo).not.toBe(otherMe.body.cards[0].cardNo);

    // app 域不接任何客户端传入的顾客 ID：`?customerId=` 必须被忽略
    const withQuery = await ctx.request(
      'GET',
      `/api/v1/app/member/me?customerId=${otherId}`,
      { token: mine.token },
    );
    expect(withQuery.status).toBe(200);
    expect(withQuery.body.customerId).toBe(mineId);
  });

  it('顾客档案被软删 → 401 + needBind（而不是 500 或空壳对象）', async () => {
    const customerId = await seedRichCustomer('赵女士', '13800000024');
    const { token } = await seedBoundAppUser('openid-deleted', customerId);
    await ctx.sql(`UPDATE biz_customer SET deleted_at = NOW() WHERE id = ?`, [
      customerId,
    ]);

    const me = await ctx.request('GET', '/api/v1/app/member/me', { token });
    expect(me.status).toBe(401);
    expect(me.body.needBind).toBe(true);
  });
});

/* ------------------------------------------------------------------ */

describe('B6 我的次卡 /app/member/cards（A9）', () => {
  /** 造一张卡；`expireAt` 传 null 表示长期有效 */
  async function seedCard(
    customerId: number,
    options: {
      cardNo: string;
      cardName: string;
      totalTimes?: number;
      usedTimes?: number;
      expireAt?: Date | null;
      status?: 'active' | 'used_up' | 'expired' | 'refunded';
    },
  ): Promise<void> {
    const types = await ctx.sql<{ insertId: number }>(
      `INSERT INTO biz_member_card_type (name, price, total_times, valid_days)
       VALUES (?, 100000, 10, 365)`,
      [`卡种-${options.cardNo}`],
    );
    await ctx.sql(
      `INSERT INTO biz_member_card
         (card_no, customer_id, card_type_id, card_name, total_times, used_times,
          price, pay_channel, purchased_at, expire_at, status)
       VALUES (?, ?, ?, ?, ?, ?, 100000, 'wechat', NOW(), ?, ?)`,
      [
        options.cardNo,
        customerId,
        types.insertId,
        options.cardName,
        options.totalTimes ?? 10,
        options.usedTimes ?? 0,
        options.expireAt ?? null,
        options.status ?? 'active',
      ],
    );
  }

  it('只出本人的卡；字段集合固定，无成本 / 无备注 / 无顾客 ID', async () => {
    const mineId = await seedCustomer('李女士', '13800000031');
    const otherId = await seedCustomer('王女士', '13800000032');
    await seedCard(mineId, { cardNo: 'C-MINE', cardName: '十次卡' });
    await seedCard(otherId, { cardNo: 'C-OTHER', cardName: '五次卡' });

    const mine = await seedBoundAppUser('openid-cards-mine', mineId);
    const response = await ctx.request('GET', '/api/v1/app/member/cards', {
      token: mine.token,
    });
    expect(response.status).toBe(200);
    expect(response.body.items).toHaveLength(1);
    expect(response.body.items[0].cardNo).toBe('C-MINE');
    expect(Object.keys(response.body.items[0]).sort()).toEqual(
      [
        'cardName',
        'cardNo',
        'expireAt',
        'id',
        'status',
        'totalTimes',
        'usedTimes',
      ].sort(),
    );
    // 分页壳在，`total` 依然不给（app 域列表统一无 total）
    expect(response.body.page).toBe(1);
    expect(response.body).not.toHaveProperty('total');
  });

  it('状态按「到店是否真能用」现算：过期与用完不依赖定时任务', async () => {
    const customerId = await seedCustomer('赵女士', '13800000033');
    await seedCard(customerId, {
      cardNo: 'C-OK',
      cardName: '可用卡',
      usedTimes: 2,
      expireAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
    });
    // 过期：status 仍是 active，但 expire_at 已经过了
    await seedCard(customerId, {
      cardNo: 'C-EXPIRED',
      cardName: '过期卡',
      expireAt: new Date(Date.now() - 24 * 3600 * 1000),
    });
    // 用完：次数满了但状态没翻
    await seedCard(customerId, {
      cardNo: 'C-USEDUP',
      cardName: '用完卡',
      totalTimes: 5,
      usedTimes: 5,
    });

    const { token } = await seedBoundAppUser('openid-cards-status', customerId);
    const response = await ctx.request('GET', '/api/v1/app/member/cards', {
      token,
    });
    expect(response.status).toBe(200);
    const byNo = Object.fromEntries(
      response.body.items.map((item: any) => [item.cardNo, item.status]),
    );
    expect(byNo).toEqual({
      'C-USEDUP': 'used_up',
      'C-EXPIRED': 'expired',
      'C-OK': 'active',
    });

    // 过滤也按展示态走：只给「真能用」的
    const activeOnly = await ctx.request(
      'GET',
      '/api/v1/app/member/cards?status=active',
      { token },
    );
    expect(activeOnly.body.items.map((item: any) => item.cardNo)).toEqual([
      'C-OK',
    ]);
  });

  it('分页生效；未绑定手机号 → 401 + needBind', async () => {
    const customerId = await seedCustomer('孙女士', '13800000034');
    for (const i of [1, 2, 3])
      await seedCard(customerId, {
        cardNo: `C-PAGE-${i}`,
        cardName: `次卡${i}`,
      });

    const { token } = await seedBoundAppUser('openid-cards-page', customerId);
    const firstPage = await ctx.request(
      'GET',
      '/api/v1/app/member/cards?page=1&pageSize=2',
      { token },
    );
    expect(firstPage.status).toBe(200);
    expect(firstPage.body.items).toHaveLength(2);
    expect(firstPage.body.pageSize).toBe(2);

    const secondPage = await ctx.request(
      'GET',
      '/api/v1/app/member/cards?page=2&pageSize=2',
      { token },
    );
    expect(secondPage.body.items).toHaveLength(1);

    const unbound = await seedBoundAppUser('openid-cards-unbound', null);
    const denied = await ctx.request('GET', '/api/v1/app/member/cards', {
      token: unbound.token,
    });
    expect(denied.status).toBe(401);
    expect(denied.body.needBind).toBe(true);
  });
});

describe('B6 提交评价 /app/reviews（A11）', () => {
  it('本人已完成的单可以评价；customer_id / staff_id 由预约事实带出', async () => {
    const customerId = await seedCustomer('周女士', '13800000041');
    const bookingId = await seedBooking(customerId, '周女士', 'completed');
    const { token } = await seedBoundAppUser('openid-review-ok', customerId);

    const response = await ctx.request('POST', '/api/v1/app/reviews', {
      token,
      body: { bookingId, rating: 5, content: '非常满意' },
    });
    expect(response.status).toBe(201);
    expect(response.body.bookingId).toBe(bookingId);
    expect(response.body.rating).toBe(5);

    const rows = await ctx.sql<
      {
        customer_id: number;
        staff_id: number;
        score: number;
        content: string;
      }[]
    >(
      `SELECT customer_id, staff_id, score, content FROM biz_review WHERE booking_id = ?`,
      [bookingId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].customer_id).toBe(customerId);
    expect(rows[0].score).toBe(5);
    expect(rows[0].content).toBe('非常满意');
  });

  it('别人的单 → 403，且一条评价都不落', async () => {
    const mineId = await seedCustomer('吴女士', '13800000042');
    const otherId = await seedCustomer('郑女士', '13800000043');
    const otherBooking = await seedBooking(otherId, '郑女士', 'completed');
    const { token } = await seedBoundAppUser('openid-review-403', mineId);

    const response = await ctx.request('POST', '/api/v1/app/reviews', {
      token,
      body: { bookingId: otherBooking, rating: 1, content: '差评' },
    });
    expect(response.status).toBe(403);

    const rows = await ctx.sql<{ total: number }[]>(
      `SELECT COUNT(*) AS total FROM biz_review`,
    );
    expect(Number(rows[0].total)).toBe(0);
  });

  it('未完成的单 → 400；一单一评，二次提交 → 409', async () => {
    const customerId = await seedCustomer('冯女士', '13800000044');
    const pending = await seedBooking(customerId, '冯女士', 'pending');
    const done = await seedBooking(customerId, '冯女士2', 'completed');
    const { token } = await seedBoundAppUser('openid-review-400', customerId);

    const notCompleted = await ctx.request('POST', '/api/v1/app/reviews', {
      token,
      body: { bookingId: pending, rating: 5 },
    });
    expect(notCompleted.status).toBe(400);

    const first = await ctx.request('POST', '/api/v1/app/reviews', {
      token,
      body: { bookingId: done, rating: 4 },
    });
    expect(first.status).toBe(201);

    const second = await ctx.request('POST', '/api/v1/app/reviews', {
      token,
      body: { bookingId: done, rating: 2 },
    });
    expect(second.status).toBe(409);

    const rows = await ctx.sql<{ total: number }[]>(
      `SELECT COUNT(*) AS total FROM biz_review WHERE booking_id = ?`,
      [done],
    );
    expect(Number(rows[0].total)).toBe(1);
  });
});

/* ------------------------------------------------------------------ */

describe('B6 订阅消息授权 /app/subscribe（A12）', () => {
  it('上报已授权的模板 → 落库累加额度；同一模板再授权是累加不是覆盖', async () => {
    const customerId = await seedCustomer('孙女士', '13800000051');
    const bookingId = await seedBooking(customerId, '孙女士', 'pending');
    const { token } = await seedBoundAppUser('openid-sub-ok', customerId);

    const first = await ctx.request('POST', '/api/v1/app/subscribe', {
      token,
      body: { templateIds: ['TID-A', 'TID-B'], bookingId },
    });
    expect(first.status).toBe(201);
    expect(first.body.accepted).toBe(true);
    expect(first.body.templateIds).toEqual(['TID-A', 'TID-B']);

    // 同一模板再授权一次：微信一次性订阅可累积，所以 granted_count 要 +1，
    // 而不是覆盖成 1，也不是插出第二行
    const second = await ctx.request('POST', '/api/v1/app/subscribe', {
      token,
      body: { templateIds: ['TID-A'] },
    });
    expect(second.status).toBe(201);

    const rows = await ctx.sql<
      {
        template_id: string;
        granted_count: number;
        customer_id: number;
        last_booking_id: number | null;
      }[]
    >(
      `SELECT template_id, granted_count, customer_id, last_booking_id
         FROM app_wx_subscribe_grant WHERE customer_id = ? ORDER BY template_id`,
      [customerId],
    );
    expect(rows.map((row) => [row.template_id, row.granted_count])).toEqual([
      ['TID-A', 2],
      ['TID-B', 1],
    ]);
    // bookingId 只是上下文：第二次没带，不能把第一次带的抹掉
    expect(
      rows.find((row) => row.template_id === 'TID-A')?.last_booking_id,
    ).toBe(bookingId);
  });

  it('bookingId 是别人的单 → 403，不存在的单 → 404，且一条额度都不落', async () => {
    const mineId = await seedCustomer('钱女士', '13800000052');
    const otherId = await seedCustomer('孔女士', '13800000053');
    const otherBooking = await seedBooking(otherId, '孔女士', 'pending');
    const { token } = await seedBoundAppUser('openid-sub-403', mineId);

    const forbidden = await ctx.request('POST', '/api/v1/app/subscribe', {
      token,
      body: { templateIds: ['TID-A'], bookingId: otherBooking },
    });
    expect(forbidden.status).toBe(403);

    const missing = await ctx.request('POST', '/api/v1/app/subscribe', {
      token,
      body: { templateIds: ['TID-A'], bookingId: 9_999_999 },
    });
    expect(missing.status).toBe(404);

    const rows = await ctx.sql<{ total: number }[]>(
      `SELECT COUNT(*) AS total FROM app_wx_subscribe_grant`,
    );
    expect(Number(rows[0].total)).toBe(0);
  });

  it('未绑定手机号 → 401 + needBind；额度归属只认 token，不认客户端传什么', async () => {
    const { token } = await seedBoundAppUser('openid-sub-nobind', null);

    const response = await ctx.request('POST', '/api/v1/app/subscribe', {
      token,
      body: { templateIds: ['TID-A'] },
    });
    expect(response.status).toBe(401);
    expect(response.body.needBind).toBe(true);

    const rows = await ctx.sql<{ total: number }[]>(
      `SELECT COUNT(*) AS total FROM app_wx_subscribe_grant`,
    );
    expect(Number(rows[0].total)).toBe(0);
  });
});

/* ------------------------------------------------------------------ */

describe('B6 未配置微信凭据 → 503（G2）', () => {
  it('登录：凭据没配就 503「小程序端未启用」，不是 500 也不是放行', async () => {
    const response = await noCredentialCtx.request(
      'POST',
      '/api/v1/app/auth/login',
      { token: null, body: { code: 'any-code' } },
    );
    expect(response.status).toBe(503);
    expect(String(response.body.message)).toContain('小程序端未启用');
  });

  it('绑定手机号同样 503（守卫放行、provider 拦下）', async () => {
    const inserted = await noCredentialCtx.sql<{ insertId: number }>(
      `INSERT INTO app_wx_user (openid, staff_status) VALUES ('openid-nocred', 'none')`,
    );
    const token = await noCredentialCtx.appToken(
      'openid-nocred',
      inserted.insertId,
    );
    const response = await noCredentialCtx.request(
      'POST',
      '/api/v1/app/auth/phone',
      { token, body: { code: '13800000025' } },
    );
    expect(response.status).toBe(503);
    expect(String(response.body.message)).toContain('小程序端未启用');
  });

  it('凭据没配也不落身份：login 失败后 app_wx_user 一行都没有', async () => {
    await noCredentialCtx.request('POST', '/api/v1/app/auth/login', {
      token: null,
      body: { code: 'openid-nocred-2' },
    });
    const rows = await noCredentialCtx.sql<{ total: number }[]>(
      `SELECT COUNT(*) AS total FROM app_wx_user WHERE openid = 'fake-openid-openid-nocred-2'`,
    );
    expect(Number(rows[0].total)).toBe(0);
  });
});

/* ------------------------------------------------------------------ */

/**
 * A10 自助下单 / 我的预约列表 / 自助取消。
 *
 * 共同点：**归属从 token 来，业务全在 `BookingPort.createForCustomer`**。
 * 这里只验证「app 域收口」这一层：401/403/409 语义、落库口径（pending + miniapp）、
 * VO 字段集合。并发恰好 1 成功这类资金正确性已在 `b1-booking.int.spec.ts` 用
 * 后台入口验过，app 域复用同一 service，不需重跑。
 */
describe('B6 自助下单 / 我的预约 / 自助取消（A10）', () => {
  /** 造一条已绑定顾客的小程序身份，返回 token */
  async function seedBound(
    openid: string,
    customerId: number,
  ): Promise<string> {
    const { token } = await seedBoundAppUser(openid, customerId);
    return token;
  }

  /** 造美甲师 + 周模板班次（10:00-20:00）+ 2 个服务项目（60min / 90min，不同价） */
  async function seedShopFixture(): Promise<{
    staffId: number;
    itemIds: number[];
  }> {
    const staffs = await ctx.sql<{ insertId: number }>(
      `INSERT INTO biz_staff (nickname, status, sort) VALUES ('A10美甲师', 'active', 1)`,
    );
    await ctx.sql(
      `INSERT INTO biz_staff_weekly_shift (staff_id, weekday, start_time, end_time)
       VALUES (?, ?, '10:00:00', '20:00:00')`,
      [staffs.insertId, shopWeekday(date)],
    );
    const a = await ctx.sql<{ insertId: number }>(
      `INSERT INTO biz_service_item (name, category, duration_minutes, buffer_minutes, price, status, sort)
       VALUES ('A10基础美甲', '基础', 60, 0, 10000, 'active', 1)`,
    );
    const b = await ctx.sql<{ insertId: number }>(
      `INSERT INTO biz_service_item (name, category, duration_minutes, buffer_minutes, price, status, sort)
       VALUES ('A10精致美甲', '精致', 90, 0, 15000, 'active', 1)`,
    );
    return { staffId: staffs.insertId, itemIds: [a.insertId, b.insertId] };
  }

  it('未绑定手机号不能下单：401 + needBind，且不落库', async () => {
    const { token } = await seedBoundAppUser('openid-a10-nobind', null);
    const response = await ctx.request('POST', '/api/v1/app/bookings', {
      token,
      body: {
        staffId: 1,
        startAt: `${date}T10:00:00+08:00`,
        serviceItemIds: [1],
      },
    });
    expect(response.status).toBe(401);
    expect(response.body.needBind).toBe(true);
    const rows = await ctx.sql<{ total: number }[]>(
      `SELECT COUNT(*) AS total FROM biz_booking`,
    );
    expect(Number(rows[0].total)).toBe(0);
  });

  it('下单成功：落 pending + channel=miniapp，金额服务端重算', async () => {
    const customerId = await seedCustomer('A10张女士', '13800000101');
    const token = await seedBound('openid-a10-create', customerId);
    const { staffId, itemIds } = await seedShopFixture();

    const startAt = `${date}T10:00:00+08:00`;
    const response = await ctx.request('POST', '/api/v1/app/bookings', {
      token,
      body: { staffId, startAt, serviceItemIds: [itemIds[0]] },
    });
    expect(response.status).toBe(201);
    expect(response.body.status).toBe('pending');
    expect(response.body.payableAmount).toBe(10000); // 服务端算：原价
    expect(response.body.paidAmount).toBe(0);
    expect(response.body.dueAmount).toBe(10000);
    expect(response.body.payStatus).toBe('unpaid');
    expect(response.body.items).toHaveLength(1);
    expect(response.body.items[0].name).toBe('A10基础美甲');

    // 落库口径：pending + miniapp + 金额正确
    const [row] = await ctx.sql<
      { status: string; channel: string; payableAmount: number }[]
    >(
      `SELECT status, channel, payable_amount AS payableAmount
         FROM biz_booking WHERE id = ?`,
      [response.body.id],
    );
    expect(row.status).toBe('pending');
    expect(row.channel).toBe('miniapp');
    expect(row.payableAmount).toBe(10000);
  });

  it('我的预约列表：只出本人、status 过滤可工作', async () => {
    const mineId = await seedCustomer('A10李女士', '13800000102');
    const otherId = await seedCustomer('A10王女士', '13800000103');
    const mineToken = await seedBound('openid-a10-list1', mineId);
    const otherToken = await seedBound('openid-a10-list2', otherId);
    const { staffId, itemIds } = await seedShopFixture();

    // 本人 1 张 pending；他人 1 张
    const minePending = await ctx.request('POST', '/api/v1/app/bookings', {
      token: mineToken,
      body: {
        staffId,
        startAt: `${date}T10:00:00+08:00`,
        serviceItemIds: itemIds,
      },
    });
    expect(minePending.status).toBe(201);
    await ctx.sql(
      `INSERT INTO biz_booking
         (booking_no, customer_id, staff_id, start_at, end_at, duration_minutes,
          original_price, payable_amount, paid_amount, due_amount, status, pay_status,
          customer_name, customer_phone, channel)
       VALUES ('B-A10-OTHER', ?, ?, ?, ?, 60, 10000, 10000, 10000, 0, 'pending', 'unpaid',
               'A10王女士', '13800000103', 'miniapp')`,
      [otherId, staffId, `${date}T09:00:00+08:00`, `${date}T10:00:00+08:00`],
    );

    const mine = await ctx.request('GET', '/api/v1/app/bookings', {
      token: mineToken,
    });
    expect(mine.status).toBe(200);
    // 本人只看到 1 张，不包含他人单
    expect(mine.body.items).toHaveLength(1);
    expect(mine.body.items[0].bookingNo).toBe(minePending.body.bookingNo);
    expect(mine.body.page).toBe(1);

    // 他人 token 列表不含同店数据
    const other = await ctx.request('GET', '/api/v1/app/bookings', {
      token: otherToken,
    });
    expect(other.status).toBe(200);
    expect(other.body.items).toHaveLength(1);
    expect(other.body.items[0].customerName).toBeUndefined(); // 无他人信息字段

    // status 过滤
    const pending = await ctx.request(
      'GET',
      `/api/v1/app/bookings?status=pending`,
      { token: mineToken },
    );
    expect(pending.body.items).toHaveLength(1);
    expect(pending.body.items[0].status).toBe('pending');
    const cancelled = await ctx.request(
      'GET',
      `/api/v1/app/bookings?status=cancelled`,
      { token: mineToken },
    );
    expect(cancelled.body.items).toHaveLength(0);
  });

  it('VO 字段集：列表项只有卡面字段，无成本 / 无 createdBy / 无内部字段', async () => {
    const customerId = await seedCustomer('A10孙女士', '13800000104');
    const token = await seedBound('openid-a10-vo', customerId);
    const { staffId, itemIds } = await seedShopFixture();
    await ctx.request('POST', '/api/v1/app/bookings', {
      token,
      body: {
        staffId,
        startAt: `${date}T10:00:00+08:00`,
        serviceItemIds: itemIds,
      },
    });

    const list = await ctx.request('GET', '/api/v1/app/bookings', { token });
    const item = list.body.items[0];
    expect(Object.keys(item).sort()).toEqual(
      [
        'bookingNo',
        'dueAmount',
        'endAt',
        'id',
        'items',
        'paidAmount',
        'payStatus',
        'payableAmount',
        'staffId',
        'staffName',
        'startAt',
        'status',
      ].sort(),
    );
    expect(Object.keys(item.items[0]).sort()).toEqual(
      ['durationMinutes', 'name', 'price', 'serviceItemId'].sort(),
    );
  });

  it('自助取消：本人成功（pending → cancelled）；他人 403；不存在 404', async () => {
    const meId = await seedCustomer('A10赵女士', '13800000105');
    const otherId = await seedCustomer('A10钱女士', '13800000106');
    const meToken = await seedBound('openid-a10-cancel1', meId);
    const otherToken = await seedBound('openid-a10-cancel2', otherId);
    const { staffId, itemIds } = await seedShopFixture();

    const created = await ctx.request('POST', '/api/v1/app/bookings', {
      token: meToken,
      body: {
        staffId,
        startAt: `${date}T14:00:00+08:00`,
        serviceItemIds: itemIds,
      },
    });
    expect(created.status).toBe(201);
    const bookingId = created.body.id;

    // 他人取消 → 403
    const forbidden = await ctx.request(
      'POST',
      `/api/v1/app/bookings/${bookingId}/cancel`,
      { token: otherToken, body: { reason: '不是我单' } },
    );
    expect(forbidden.status).toBe(403);

    // 本人缺 reason → 400
    const noReason = await ctx.request(
      'POST',
      `/api/v1/app/bookings/${bookingId}/cancel`,
      { token: meToken, body: {} },
    );
    expect(noReason.status).toBe(400);

    // 本人取消 → 200 changed:true，且落库 cancelled
    const cancelled = await ctx.request(
      'POST',
      `/api/v1/app/bookings/${bookingId}/cancel`,
      { token: meToken, body: { reason: '临时有事' } },
    );
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.changed).toBe(true);

    const [row] = await ctx.sql<{ status: string }[]>(
      `SELECT status FROM biz_booking WHERE id = ?`,
      [bookingId],
    );
    expect(row.status).toBe('cancelled');

    // 重复取消：状态机拦截 → 409（与后台取消一致）
    const again = await ctx.request(
      'POST',
      `/api/v1/app/bookings/${bookingId}/cancel`,
      { token: meToken, body: { reason: '再取消一次' } },
    );
    expect(again.status).toBe(409);
  });

  it('与本人已有预约重叠 → 409，不占用时段', async () => {
    const customerId = await seedCustomer('A10郑女士', '13800000107');
    const token = await seedBound('openid-a10-conflict', customerId);
    const { staffId, itemIds } = await seedShopFixture();

    const first = await ctx.request('POST', '/api/v1/app/bookings', {
      token,
      body: {
        staffId,
        startAt: `${date}T10:00:00+08:00`,
        serviceItemIds: itemIds,
      },
    });
    expect(first.status).toBe(201);

    // 同顾客同时段再来一单 → 409（不用 force）
    const second = await ctx.request('POST', '/api/v1/app/bookings', {
      token,
      body: {
        staffId,
        startAt: `${date}T10:00:00+08:00`,
        serviceItemIds: itemIds,
      },
    });
    expect(second.status).toBe(409);

    const rows = await ctx.sql<{ total: number }[]>(
      `SELECT COUNT(*) AS total FROM biz_booking WHERE customer_id = ?`,
      [customerId],
    );
    expect(Number(rows[0].total)).toBe(1);
  });
});

/* ------------------------------------------------------------------ */

describe('B6 充值档位 /app/recharge-plans（C 端只读）', () => {
  it('只返回上架档位；**字段集合固定**（内部字段一个都不能漏）', async () => {
    // 档位是**门店配置**：小程序必须从服务端取 ——
    // 曾经硬编码在充值页（充 2000 送 800…），门店改了后台配置就会「宣传与实际到账不一致」
    await ctx.sql(
      `INSERT INTO biz_recharge_plan (name, pay_amount, bonus_amount, status, sort)
       VALUES ('充 100 送 20', 10000, 2000, 'active', 1),
              ('已停用档位', 50000, 15000, 'disabled', 2)`,
    );
    // 只需要 app token，**不要求绑定手机号**（与积分商品目录同一口径）
    const { token } = await seedBoundAppUser('recharge-plans', null);

    const res = await ctx.request('GET', '/api/v1/app/recharge-plans', {
      token,
    });
    expect(res.status).toBe(200);

    const items = (res.body as { items: Record<string, unknown>[] }).items;
    // 停用的档位不能出现：否则小程序会宣传一个门店已经下掉的档位
    expect(items).toHaveLength(1);
    // 只给展示所需字段（状态 / 排序 / 审计字段都不该出现）
    expect(Object.keys(items[0]).sort()).toEqual([
      'bonusAmount',
      'id',
      'name',
      'payAmount',
    ]);
    expect(items[0]).toMatchObject({
      name: '充 100 送 20',
      payAmount: 10000,
      bonusAmount: 2000,
    });
  });

  it('未登录 → 401', async () => {
    const res = await ctx.request('GET', '/api/v1/app/recharge-plans', {
      token: null,
    });
    expect(res.status).toBe(401);
  });
});