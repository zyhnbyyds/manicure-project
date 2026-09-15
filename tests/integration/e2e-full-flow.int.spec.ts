/**
 * 全流程 E2E（真库 + 真 HTTP）：**从登录开始，一路走到退款与报表**。
 *
 * 这个文件跟其它 `*.int.spec.ts` 的区别是：它不按模块切片，而是把「一家店的一天」
 * 按真人操作顺序串起来 —— 登录 → 建基础数据 → 顾客入会充值 → 下单收定金 → 到店 →
 * 核销 + 混合支付 → 完成计提成 → 评价 → 报表核对 → 退款冲减。
 *
 * ## 两个约定
 *
 * 1. **有状态、必须顺序跑**：①~⑪ 共享同一批种子数据，后面的步骤依赖前面的结果。
 *    别跳着跑单个用例（`bun test -t '⑥'` 会因为没前置数据而失败），要跑就整文件跑：
 *    ```
 *    bun test tests/integration/e2e-full-flow.int.spec.ts
 *    ```
 * 2. **不走测试后门**：唯一的用户是**真的 `POST /auth/login` 登进来的**（argon2 哈希
 *    落在 `sys_user` 上），后续每一步都带这个 token —— 顺带把 RBAC 也走通了；
 *    其它集成用例用 `ctx.token()` 直接签票，那条路绕过了登录与权限装配。
 *
 * 每一步都断言**能手工复核的数字**（金额、流水、次数、报表口径），而不是只断言 200。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../../src/common/password/password.service.js';
import {
  addLocalDays,
  shopToday,
  shopWeekday,
} from '../../src/modules/biz/common/shop-time.js';
import { createTestContext, type TestContext } from './harness.js';

let ctx: TestContext;
/** 预约落在「今天 +3 天」，避开「现在几点」对可约时段的影响 */
let date: string;
/** 登录拿到的**真** access token，后续所有请求都用它 */
let token: string;

// ---- 流程中逐步累积的状态（这就是「不要跳着跑」的原因）----
let serviceItemId = 0;
let staffId = 0;
let customerId = 0;
let cardId = 0;
let bookingOneId = 0;
let bookingTwoId = 0;
let bookingOneNo = '';
let levelId = 0;

const CUSTOMER = { name: '全流程顾客', phone: '13900000001' };
const ADMIN = { username: 'e2e-admin', password: 'E2e#Passw0rd' };

/** 带登录 token 的请求（登录那一句除外） */
function call(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any; headers: Record<string, any> }> {
  return ctx.request(method, path, {
    body,
    token: path.includes('/auth/login') ? null : token,
  });
}

beforeAll(async () => {
  ctx = await createTestContext();
  date = addLocalDays(shopToday(), 3);

  // 测试库只跑迁移、不跑 seed，所以「有没有管理员」得自己铺。
  // 密码走项目自己的 argon2 哈希（`hashPassword`），否则登录一定失败。
  //
  // 注意：`resetBusinessData()` 只清 `biz_*` / `app_*`，**不动 `sys_*`** ——
  // 所以这一段必须自带幂等（先删后插），否则同一台机器第二次跑就撞唯一键。
  await ctx.sql(`DELETE FROM sys_user WHERE username = ?`, [ADMIN.username]);
  await ctx.sql(`DELETE FROM sys_role WHERE role_key = ?`, ['e2e-admin-role']);
  const passwordHash = await hashPassword(ADMIN.password);
  const user = await ctx.sql<{ insertId: number }[]>(
    `INSERT INTO sys_user (username, display_name, password_hash, status)
     VALUES (?, '全流程管理员', ?, 'active')`,
    [ADMIN.username, passwordHash],
  );
  // `is_system = 1`（或 role_key = 'admin'）→ getClaims 直接给 `*:*:*`
  const role = await ctx.sql<{ insertId: number }[]>(
    `INSERT INTO sys_role (name, role_key, is_system, status, sort)
     VALUES ('全流程管理员角色', 'e2e-admin-role', 1, 'active', 1)`,
  );
  await ctx.sql(`INSERT INTO sys_user_role (user_id, role_id) VALUES (?, ?)`, [
    user.insertId,
    role.insertId,
  ]);

  // 小额充值与卡价会撞默认下限（`biz.member.minRechargeAmount` 默认 10000 分），置 0 便于构造
  await ctx.sql(
    `INSERT INTO sys_config (name, config_key, value, builtin)
     VALUES ('单次充值下限（E2E）', 'biz.member.minRechargeAmount', '0', 1)
     ON DUPLICATE KEY UPDATE value = '0'`,
  );
  const { BizConfigService } =
    await import('../../src/modules/biz/common/biz-config.service.js');
  ctx.app.get(BizConfigService).invalidate();
}, 180_000);

afterAll(async () => {
  await ctx?.close();
});

describe('E2E 全流程：登录 → 开店 → 预约 → 到店 → 核销 → 收款 → 完成 → 报表 → 退款', () => {
  it('① 登录：POST /auth/login 拿到带 *:*:* 的 token（走真实 RBAC，不用测试签票）', async () => {
    const wrong = await ctx.request('POST', '/api/v1/auth/login', {
      // 注意长度也要合法（登录 schema 的 password 是 `min(8)`），否则拿到的是 400 校验错而不是 401
      body: { username: ADMIN.username, password: 'WrongPassw0rd' },
      token: null,
    });
    expect(wrong.status).toBe(401);

    const login = await ctx.request('POST', '/api/v1/auth/login', {
      body: ADMIN,
      token: null,
    });
    expect([200, 201]).toContain(login.status);
    expect(login.body.tokenType).toBe('Bearer');
    token = login.body.accessToken;
    expect(typeof token).toBe('string');

    // token 里的权限是服务端按角色算出来的：is_system 角色 → 通配符
    const payload = JSON.parse(
      Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8'),
    );
    expect(payload.permissions).toEqual(['*:*:*']);

    // 未登录必须被拒（后面每一步都靠这个 token）
    const anonymous = await ctx.request('GET', '/api/v1/biz/bookings', {
      token: null,
    });
    expect(anonymous.status).toBe(401);

    // 登录会记 last_login
    const [user] = await ctx.sql<{ login_at: string | null }[]>(
      `SELECT login_at FROM sys_user WHERE username = ?`,
      [ADMIN.username],
    );
    expect(user!.login_at).not.toBeNull();
  });

  it('② 开店：建服务项目 / 美甲师 / 可做项目 / 周排班 / 会员等级', async () => {
    const item = await call('POST', '/api/v1/biz/service-items', {
      name: '基础美甲',
      category: '基础',
      durationMinutes: 60,
      bufferMinutes: 15,
      price: 10000,
      status: 'active',
      sort: 1,
    });
    expect(item.status).toBe(201);
    serviceItemId = item.body.id;
    // 建单响应只回 id 之类的壳，价格这类字段回读详情确认（顺便验读接口）
    const itemDetail = await call(
      'GET',
      `/api/v1/biz/service-items/${serviceItemId}`,
    );
    expect(itemDetail.status).toBe(200);
    expect(Number(itemDetail.body.price)).toBe(10000);

    const staff = await call('POST', '/api/v1/biz/staffs', {
      nickname: '小美',
      status: 'active',
      sort: 1,
    });
    expect(staff.status).toBe(201);
    staffId = staff.body.id;

    // 可做项目：空数组 = 可做全部；这里显式绑定，顺带验证「美甲师可做项目」闸门
    const items = await call(
      'PUT',
      `/api/v1/biz/staffs/${staffId}/service-items`,
      {
        serviceItemIds: [serviceItemId],
      },
    );
    expect([200, 201]).toContain(items.status);

    // 周模板：整体替换语义，给目标星期排 10:00~20:00
    const shifts = await call(
      'PUT',
      `/api/v1/biz/staffs/${staffId}/weekly-shifts`,
      {
        shifts: [
          {
            weekday: shopWeekday(date),
            startTime: '10:00:00',
            endTime: '20:00:00',
          },
        ],
      },
    );
    expect([200, 201]).toContain(shifts.status);
    expect(Number(shifts.body.count)).toBe(1);

    const silver = await call('POST', '/api/v1/biz/member-levels', {
      name: '银卡',
      discountPermille: 1000,
      upgradeAmount: 0,
      sort: 1,
      status: 'active',
    });
    const gold = await call('POST', '/api/v1/biz/member-levels', {
      name: '金卡',
      discountPermille: 950,
      upgradeAmount: 50000,
      sort: 2,
      status: 'active',
    });
    expect([200, 201]).toContain(silver.status);
    expect([200, 201]).toContain(gold.status);
    levelId = gold.body.id;

    // 排班生效 → 当天必须能约到时段（这条把「基础数据」与「可约时段」串起来）
    const slots = await call(
      'GET',
      `/api/v1/biz/bookings/available-slots?staffId=${staffId}&date=${date}&serviceItemIds=${serviceItemId}`,
    );
    expect(slots.status).toBe(200);
    expect(slots.body.slots.length).toBeGreaterThan(0);
    expect(String(slots.body.slots[0].startAt)).toContain(
      `${date}T10:00:00+08:00`,
    );
  });

  it('③ 顾客建档 + 入会 + 手工调级 + 充值 2000 元（储值）', async () => {
    const customer = await call('POST', '/api/v1/biz/customers', {
      name: CUSTOMER.name,
      phone: CUSTOMER.phone,
      gender: 'female',
    });
    expect(customer.status).toBe(201);
    customerId = customer.body.id;

    // 手机号唯一：重复建档必须 409（免得店员建出两条同一人的档案）
    const duplicate = await call('POST', '/api/v1/biz/customers', {
      name: CUSTOMER.name,
      phone: CUSTOMER.phone,
    });
    expect(duplicate.status).toBe(409);

    // 调级 + 送积分：都走会员账务接口（写流水），不直接改表
    const adjust = await call(
      'POST',
      `/api/v1/biz/members/${customerId}/adjust`,
      {
        levelId,
        pointsDelta: 5000,
        reason: 'E2E：开业活动送积分并升金卡',
      },
    );
    expect([200, 201]).toContain(adjust.status);

    // 充值方案「充 2000 送 200」，走方案而不是自定义金额
    const plan = await call('POST', '/api/v1/biz/recharge-plans', {
      name: '充 2000 送 200',
      payAmount: 200000,
      bonusAmount: 20000,
    });
    expect(plan.status).toBe(201);

    const recharge = await call(
      'POST',
      `/api/v1/biz/members/${customerId}/recharge`,
      { planId: plan.body.id, payChannel: 'cash', remark: 'E2E 充值' },
    );
    expect([200, 201]).toContain(recharge.status);
    expect(Number(recharge.body.payAmount)).toBe(200000);
    expect(Number(recharge.body.bonusAmount)).toBe(20000);
    // 首次充值自动入会 → 有会员号
    expect(String(recharge.body.memberNo)).toMatch(/^M?\d+/);

    const member = await call('GET', `/api/v1/biz/members/${customerId}`);
    expect(Number(member.body.balancePrincipal)).toBe(200000);
    expect(Number(member.body.balanceBonus)).toBe(20000);
    expect(Number(member.body.points)).toBe(5000);
    // 本金 + 赠送 = 可用余额，是后面「余额支付」的上限
    expect(
      Number(member.body.balancePrincipal) + Number(member.body.balanceBonus),
    ).toBe(220000);

    // 账务不变量：余额 = 流水累计（只追加表）
    const [ledger] = await ctx.sql<
      { principal: string; bonus: string; points: string }[]
    >(
      `SELECT COALESCE(SUM(balance_delta_principal), 0) AS principal,
              COALESCE(SUM(balance_delta_bonus), 0)     AS bonus,
              COALESCE(SUM(points_delta), 0)            AS points
         FROM biz_member_transaction WHERE customer_id = ?`,
      [customerId],
    );
    expect(Number(ledger!.principal)).toBe(200000);
    expect(Number(ledger!.bonus)).toBe(20000);
    expect(Number(ledger!.points)).toBe(5000);
  });

  it('④ 预约第一单：定金 100 元现金 → partial（等级折扣 + 尾款都对得上）', async () => {
    const created = await call('POST', '/api/v1/biz/bookings', {
      customerId,
      staffId,
      startAt: `${date}T10:00:00+08:00`,
      serviceItemIds: [serviceItemId],
      payMode: 'deposit',
      depositAmount: 1000,
      payments: [{ channel: 'cash', amount: 1000 }],
    });
    expect(created.status).toBe(201);
    bookingOneId = created.body.id;
    bookingOneNo = created.body.bookingNo;
    expect(bookingOneNo).toMatch(/^B\d{8}\d+$/);

    // 原价 10000 → 金卡 950‰ 优惠 500 → 应付 9500；收了 1000 定金 → 尾款 8500
    expect(Number(created.body.originalPrice)).toBe(10000);
    expect(Number(created.body.levelDiscountAmount)).toBe(500);
    expect(Number(created.body.payableAmount)).toBe(9500);
    expect(Number(created.body.paidAmount)).toBe(1000);
    expect(Number(created.body.dueAmount)).toBe(8500);
    expect(created.body.payStatus).toBe('partial');
    // 建单后即可到店（服务状态直接是 confirmed）
    expect(created.body.status).toBe('confirmed');

    // 现收现金已经落了支付单（purpose=deposit）
    const [deposit] = await ctx.sql<{ purpose: string; amount: number }[]>(
      `SELECT purpose, amount FROM biz_payment
        WHERE booking_id = ? AND status = 'success'`,
      [bookingOneId],
    );
    expect(deposit!.purpose).toBe('deposit');
    expect(Number(deposit!.amount)).toBe(1000);

    // 同顾客同一时段再录一单 → 409（顾客时间冲突闸门）
    // 注意：请求体本身要**合法**（全款必须收清），否则先撞 400 业务校验，测不到冲突闸门
    const clash = await call('POST', '/api/v1/biz/bookings', {
      customerId,
      staffId,
      startAt: `${date}T10:00:00+08:00`,
      serviceItemIds: [serviceItemId],
      payMode: 'full',
      payments: [{ channel: 'cash', amount: 9500 }],
    });
    expect(clash.status, JSON.stringify(clash.body)).toBe(409);
  });

  it('⑤ 到店：arrive 只接受 confirmed → arrived；重复调用 409 且不会重复计次', async () => {
    const arrived = await call(
      'POST',
      `/api/v1/biz/bookings/${bookingOneId}/arrive`,
    );
    expect([200, 201]).toContain(arrived.status);

    // 「幂等」在这个状态机里的含义是**条件更新不会二次生效**，不是「重复调用也回 200」：
    // `transition()` 的 WHERE 带 `status IN (allowed)`，第二次命中 0 行 → 409
    const again = await call(
      'POST',
      `/api/v1/biz/bookings/${bookingOneId}/arrive`,
    );
    expect(again.status, JSON.stringify(again.body)).toBe(409);

    const [booking] = await ctx.sql<
      { status: string; arrived_at: string | null }[]
    >(`SELECT status, arrived_at FROM biz_booking WHERE id = ?`, [
      bookingOneId,
    ]);
    expect(booking!.status).toBe('arrived');
    expect(booking!.arrived_at).not.toBeNull();
  });

  it('⑥ 收款：积分抵扣 1000 + 余额 50 元 + 现金 25 元 → 结清（混合支付两张单）', async () => {
    // 积分试算：服务端复算上限（100 分抵 1 元、单笔上限 30%）
    const preview = await call('POST', '/api/v1/biz/points/preview', {
      customerId,
      serviceItemIds: [serviceItemId],
    });
    expect([200, 201]).toContain(preview.status);
    expect(Number(preview.body.maxPoints)).toBeGreaterThanOrEqual(1000);

    const settled = await call(
      'POST',
      `/api/v1/biz/bookings/${bookingOneId}/settle`,
      {
        pointsUsed: 1000,
        payments: [
          { channel: 'balance', amount: 5000 },
          { channel: 'cash', amount: 2500 },
        ],
        remark: 'E2E：积分 + 余额 + 现金混合结清',
      },
    );
    expect([200, 201]).toContain(settled.status);

    // 9500 − 1000 积分抵扣 = 8500；已收 1000 定金 + 5000 余额 + 2500 现金
    expect(Number(settled.body.payableAmount)).toBe(8500);
    expect(Number(settled.body.paidAmount)).toBe(8500);
    expect(Number(settled.body.dueAmount)).toBe(0);
    expect(settled.body.payStatus).toBe('paid');
    expect(String(settled.body.channelSummary)).toContain('balance');
    expect(String(settled.body.channelSummary)).toContain('cash');

    // 支付单：定金 + 余额 + 现金 = 3 张，且金额与渠道逐笔对得上
    const payments = await ctx.sql<{ channel: string; amount: number }[]>(
      `SELECT channel, amount FROM biz_payment
        WHERE booking_id = ? AND status = 'success' ORDER BY id`,
      [bookingOneId],
    );
    expect(payments.map((row) => [row.channel, Number(row.amount)])).toEqual([
      ['cash', 1000],
      ['balance', 5000],
      ['cash', 2500],
    ]);

    // 会员侧：总余额 −5000；积分 −1000 抵扣（同时按实收返积分），余额绝不为负
    const member = await call('GET', `/api/v1/biz/members/${customerId}`);
    const balanceTotal =
      Number(member.body.balancePrincipal) + Number(member.body.balanceBonus);
    expect(balanceTotal).toBe(215000); // 220000 − 5000
    // 扣减顺序：默认先扣**赠送**（`biz.member.bonusDeductMode`），所以本金不动
    expect(Number(member.body.balancePrincipal)).toBe(200000);
    expect(Number(member.body.balanceBonus)).toBe(15000);

    // 积分：抵扣那 1000 分是真的扣了（不写死余额，消费还会返积分，靠不变量兜）
    const txn = await ctx.sql<
      {
        type: string;
        points_delta: number;
        balance_delta_principal: number;
        balance_delta_bonus: number;
      }[]
    >(
      `SELECT type, points_delta, balance_delta_principal, balance_delta_bonus
         FROM biz_member_transaction WHERE customer_id = ? ORDER BY id`,
      [customerId],
    );
    const spend = txn.filter((row) => row.type === 'points_spend');
    expect(spend).toHaveLength(1);
    expect(Number(spend[0]!.points_delta)).toBe(-1000);
    expect(txn.reduce((sum, row) => sum + Number(row.points_delta), 0)).toBe(
      Number(member.body.points),
    );
    expect(Number(member.body.points)).toBeGreaterThan(4000); // 5000 − 1000 抵扣 + 本单返积分

    // 再收一笔就会超收 → 拒（应收已经结清）
    const over = await call(
      'POST',
      `/api/v1/biz/bookings/${bookingOneId}/settle`,
      {
        payments: [{ channel: 'cash', amount: 100 }],
      },
    );
    expect(over.status).toBeGreaterThanOrEqual(400);
  });

  it('⑦ 第二单：次卡核销（应付重算为 0），并验证卡次数 −1 与流水', async () => {
    // 买卡：10 次基础美甲卡
    const cardType = await call('POST', '/api/v1/biz/card-types', {
      name: '10 次基础美甲卡',
      price: 80000,
      totalTimes: 10,
      validDays: 0,
      serviceItemIds: [serviceItemId],
    });
    expect(cardType.status).toBe(201);

    const card = await call('POST', '/api/v1/biz/member-cards', {
      customerId,
      cardTypeId: cardType.body.id,
      payChannel: 'cash',
      remark: 'E2E 发卡',
    });
    expect(card.status).toBe(201);
    cardId = card.body.id;
    expect(String(card.body.cardNo)).toMatch(/^C\d+$/);
    const issued = await call('GET', `/api/v1/biz/member-cards/${cardId}`);
    expect(Number(issued.body.usedTimes)).toBe(0);
    expect(Number(issued.body.totalTimes)).toBe(10);

    // 用次卡下单：`memberCardId` 必须随支付行提交，服务端靠它把 payable 重算为 0
    const created = await call('POST', '/api/v1/biz/bookings', {
      customerId,
      staffId,
      startAt: `${date}T14:00:00+08:00`,
      serviceItemIds: [serviceItemId],
      payMode: 'full',
      payments: [{ channel: 'card', amount: 0, memberCardId: cardId }],
      memberCardId: cardId,
      pointsUsed: 1000,
    });
    expect(created.status).toBe(201);
    bookingTwoId = created.body.id;
    expect(Number(created.body.payableAmount)).toBe(0);
    expect(Number(created.body.dueAmount)).toBe(0);
    expect(created.body.payStatus).toBe('paid');
    // 次卡核销不叠加积分抵扣（服务端把抵扣归零）
    expect(Number(created.body.pointsDiscountAmount)).toBe(0);

    const after = await call('GET', `/api/v1/biz/member-cards/${cardId}`);
    expect(Number(after.body.usedTimes)).toBe(1);
    expect(Number(after.body.totalTimes)).toBe(10);
    // 核销流水（只追加）
    const [cardTxn] = await ctx.sql<{ type: string; card_id: number }[]>(
      `SELECT type, card_id FROM biz_member_transaction
        WHERE customer_id = ? AND type IN ('card_use', 'card_buy') ORDER BY id`,
      [customerId],
    );
    expect(cardTxn!.type).toBe('card_buy');

    // 到店 → 完成，两张单都走完整链路
    expect(
      (await call('POST', `/api/v1/biz/bookings/${bookingTwoId}/arrive`))
        .status,
    ).toBeLessThan(300);
    const done = await call(
      'POST',
      `/api/v1/biz/bookings/${bookingTwoId}/complete`,
    );
    expect([200, 201]).toContain(done.status);
  });

  it('⑧ 完成第一单 → 计提成 + 到店统计；重复完成不重复计提', async () => {
    const rule = await call('POST', '/api/v1/biz/commission-rules', {
      name: '基础提成 10% + 5 元',
      scope: 'staff',
      staffId,
      permille: 100,
      fixedAmount: 500,
      base: 'paid',
      effectiveFrom: '2026-01-01',
      status: 'active',
      sort: 1,
    });
    expect(rule.status).toBe(201);

    const done = await call(
      'POST',
      `/api/v1/biz/bookings/${bookingOneId}/complete`,
    );
    expect([200, 201]).toContain(done.status);

    // 非法流转/重复完成：已经 completed → 409，不会重复计提
    const again = await call(
      'POST',
      `/api/v1/biz/bookings/${bookingOneId}/complete`,
    );
    expect(again.status).toBe(409);

    const records = await call(
      'GET',
      `/api/v1/biz/commission-records?staffId=${staffId}`,
    );
    expect(records.status).toBe(200);
    expect(records.body.items).toHaveLength(1);
    // 实收 8500 → 10% = 850 + 固定 500 = 1350
    expect(Number(records.body.items[0].baseAmount)).toBe(8500);
    expect(Number(records.body.items[0].amount)).toBe(1350);

    // 到店统计：⑦ 已经把第二单也 complete 了，所以两单都算到店
    const [customer] = await ctx.sql<{ visit_count: number }[]>(
      `SELECT visit_count FROM biz_customer WHERE id = ?`,
      [customerId],
    );
    expect(Number(customer!.visit_count)).toBe(2);
  });

  it('⑨ 评价：一单一评 + 店家回复 + 隐藏', async () => {
    const review = await call('POST', '/api/v1/biz/reviews', {
      bookingId: bookingOneId,
      score: 5,
      content: '很满意，下次还来',
      isPublic: true,
    });
    expect(review.status).toBe(201);
    const reviewId = review.body.id;

    // 一单一评
    const duplicate = await call('POST', '/api/v1/biz/reviews', {
      bookingId: bookingOneId,
      score: 3,
      content: '再来一次',
    });
    expect(duplicate.status).toBe(409);

    const reply = await call('POST', `/api/v1/biz/reviews/${reviewId}/reply`, {
      reply: '谢谢惠顾，欢迎再来～',
    });
    expect([200, 201]).toContain(reply.status);

    const hidden = await call('PATCH', `/api/v1/biz/reviews/${reviewId}`, {
      isPublic: false,
    });
    expect([200, 201]).toContain(hidden.status);

    const list = await call('GET', '/api/v1/biz/reviews?isPublic=false');
    expect(
      list.body.items.some((row: { id: number }) => row.id === reviewId),
    ).toBe(true);
  });

  it('⑩ 报表：净营收 = 成功支付 − 成功退款，能与支付流水手工复核', async () => {
    const range = `dateFrom=${shopToday()}&dateTo=${date}`;

    const overview = await call('GET', `/api/v1/biz/reports/overview?${range}`);
    expect(overview.status).toBe(200);
    // 现收：定金 1000 + 余额 5000 + 现金 2500 = 8500（次卡核销单金额 0，不进营收）
    expect(Number(overview.body.revenue.gross)).toBe(8500);
    expect(Number(overview.body.revenue.refund)).toBe(0);
    expect(Number(overview.body.revenue.net)).toBe(8500);

    // 用支付表反查一遍：报表口径必须等于「成功支付合计 − 成功退款合计」
    const [sum] = await ctx.sql<{ paid: string; refunded: string }[]>(
      `SELECT COALESCE(SUM(amount), 0) AS paid
         FROM biz_payment WHERE status IN ('success', 'partial_refunded', 'refunded')`,
    );
    expect(Number(overview.body.revenue.gross)).toBe(Number(sum!.paid));

    const revenue = await call(
      'GET',
      `/api/v1/biz/reports/revenue?${range}&granularity=day`,
    );
    expect(revenue.status).toBe(200);

    const services = await call('GET', `/api/v1/biz/reports/services?${range}`);
    expect(services.status).toBe(200);
    // 这个报表接口返回**裸数组**（不是 `{ items }` 分页壳），两单都用了同一个项目：
    // 一单现金结清、一单次卡核销
    expect(Array.isArray(services.body)).toBe(true);
    const row = services.body.find(
      (item: { serviceItemId?: number; name?: string }) =>
        item.serviceItemId === serviceItemId || item.name === '基础美甲',
    );
    expect(row).toBeTruthy();
    // 次数 / 金额 / 次卡核销占比（字段名是 times，不是 count）
    expect(Number(row.times)).toBe(2);
    expect(Number(row.amount)).toBe(8500);
    // 两单里一单是次卡核销 → 占比 50%
    expect(Number(row.cardTimes)).toBe(1);
    expect(Number(row.cardRatio)).toBe(500);
  });

  it('⑪ 退款：服务开始前无理由全额退 → 直接执行 → 报表冲减 + 提成冲销 + 只能执行一次', async () => {
    const preview = await call('POST', '/api/v1/biz/refunds/preview', {
      bookingId: bookingOneId,
    });
    expect([200, 201]).toContain(preview.status);
    // 预约落在「今天 +3 天」→ 服务开始前：无理由全额退，金额由服务端锁定
    expect(preview.body.stage).toBe('before_start');
    expect(preview.body.lockedAmount).toBe(true);

    // 混合支付：退款单必须挂到**具体支付单**上，先取最近一笔仍可退的
    const [target] = await ctx.sql<{ id: number; refundable: number }[]>(
      `SELECT id, amount - refunded_amount AS refundable FROM biz_payment
        WHERE booking_id = ? AND status IN ('success','partial_refunded')
        ORDER BY id DESC LIMIT 1`,
      [bookingOneId],
    );
    const refundable = Number(target!.refundable);
    expect(refundable).toBeGreaterThan(0);

    const applied = await call('POST', '/api/v1/biz/refunds', {
      paymentId: target!.id,
      mode: 'cash',
      reason: 'E2E：服务开始前取消，无理由全额退',
    });
    expect(applied.status).toBe(201);
    // 关键变化：不再落 pending，建单即执行
    expect(applied.body.status).toBe('success');
    expect(applied.body.executed).toBe(true);
    expect(applied.body.refundStage).toBe('before_start');
    expect(Number(applied.body.actualAmount)).toBe(refundable);

    // 「只能执行一次」：重复审批不报错，而是回 `handled: true`，且**不会二次退款**
    const second = await call(
      'POST',
      `/api/v1/biz/refunds/${applied.body.id}/approve`,
    );
    expect([200, 201]).toContain(second.status);
    expect(second.body.handled).toBe(true);
    expect(String(second.body.message)).toContain('已处理');
    const refundRows = await ctx.sql<{ count: number }[]>(
      `SELECT COUNT(*) AS count FROM biz_refund WHERE booking_id = ?`,
      [bookingOneId],
    );
    expect(Number(refundRows[0]!.count)).toBe(1);

    const [booking] = await ctx.sql<{ refund_amount: number }[]>(
      `SELECT refund_amount FROM biz_booking WHERE id = ?`,
      [bookingOneId],
    );
    expect(Number(booking!.refund_amount)).toBe(refundable);

    // 报表：净营收 = 毛实收 − 退款
    const overview = await call(
      'GET',
      `/api/v1/biz/reports/overview?dateFrom=${shopToday()}&dateTo=${date}`,
    );
    expect(Number(overview.body.revenue.gross)).toBe(8500);
    expect(Number(overview.body.revenue.refund)).toBe(refundable);
    expect(Number(overview.body.revenue.net)).toBe(8500 - refundable);

    // 提成冲销：退款后对应计提置 reversed
    const records = await call(
      'GET',
      `/api/v1/biz/commission-records?staffId=${staffId}`,
    );
    const reversed = records.body.items.filter(
      (row: { status: string }) => row.status === 'reversed',
    );
    expect(reversed.length).toBeGreaterThanOrEqual(1);

    // 会员账务仍然自洽：余额/积分 = 流水累计（退款走现金，不动储值）
    const [ledger] = await ctx.sql<{ principal: string; points: string }[]>(
      `SELECT COALESCE(SUM(balance_delta_principal), 0) AS principal,
              COALESCE(SUM(points_delta), 0)            AS points
         FROM biz_member_transaction WHERE customer_id = ?`,
      [customerId],
    );
    const member = await call('GET', `/api/v1/biz/members/${customerId}`);
    expect(Number(member.body.balancePrincipal)).toBe(
      Number(ledger!.principal),
    );
    expect(Number(member.body.points)).toBe(Number(ledger!.points));

    // 对账修复入口是幂等的：重算前后数字不变
    const recount = await call(
      'POST',
      `/api/v1/biz/members/${customerId}/recount`,
      { reason: 'E2E 收尾对账' },
    );
    expect([200, 201]).toContain(recount.status);
    const after = await call('GET', `/api/v1/biz/members/${customerId}`);
    expect(Number(after.body.balancePrincipal)).toBe(
      Number(member.body.balancePrincipal),
    );
    expect(Number(after.body.points)).toBe(Number(member.body.points));
  });
});
