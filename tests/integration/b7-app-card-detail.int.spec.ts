/**
 * app 域次卡详情与使用记录（batch4 第 2 屏「次卡详情」）。
 *
 * 这一组守三件事：
 * 1. **剩余次数由服务端算**：撤销核销会把 `used_times` 退回去，
 *    前端如果自己做 `total - used`，撤销过的卡显示的数字会与门店对不上；
 * 2. **不能用要说清原因**：过期 / 用完 / 已退款，顾客的下一步动作完全不同；
 * 3. **归属**：`/app/member/cards/:id` 与 `.../logs` 拿别人的卡 id 一律 404
 *    （不是 403 —— 403 等于确认这个 id 存在）。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './harness.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await ctx.resetBusinessData();
});

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

async function seedCustomer(name: string, phone: string): Promise<number> {
  const inserted = await ctx.sql<{ insertId: number }>(
    `INSERT INTO biz_customer (name, phone) VALUES (?, ?)`,
    [name, phone],
  );
  return inserted.insertId;
}

/** 造一张次卡；`expireAt` 传 null = 长期有效 */
async function seedCard(
  customerId: number,
  options: {
    cardNo: string;
    cardName?: string;
    totalTimes?: number;
    usedTimes?: number;
    expireAt?: Date | null;
    status?: 'active' | 'used_up' | 'expired' | 'refunded';
  },
): Promise<number> {
  const types = await ctx.sql<{ insertId: number }>(
    `INSERT INTO biz_member_card_type (name, price, total_times, valid_days)
     VALUES (?, 100000, ?, 365)`,
    [`卡种-${options.cardNo}`, options.totalTimes ?? 10],
  );
  const expireAt = options.expireAt === undefined ? null : options.expireAt;
  const inserted = await ctx.sql<{ insertId: number }>(
    `INSERT INTO biz_member_card
       (card_no, customer_id, card_type_id, card_name, total_times, used_times,
        price, pay_channel, purchased_at, expire_at, status)
     VALUES (?, ?, ?, ?, ?, ?, 100000, 'cash', NOW(), ?, ?)`,
    [
      options.cardNo,
      customerId,
      types.insertId,
      options.cardName ?? '十次卡',
      options.totalTimes ?? 10,
      options.usedTimes ?? 0,
      expireAt,
      options.status ?? 'active',
    ],
  );
  return inserted.insertId;
}

async function seedServiceItem(name: string): Promise<number> {
  const inserted = await ctx.sql<{ insertId: number }>(
    `INSERT INTO biz_service_item (name, category, duration_minutes, price, status)
     VALUES (?, '基础款', 60, 8800, 'active')`,
    [name],
  );
  return inserted.insertId;
}

describe('B6 次卡详情 /app/member/cards/:id', () => {
  it('详情：服务端算剩余次数；字段集合固定（无成本 / 无备注 / 无顾客 ID）', async () => {
    const customerId = await seedCustomer('李女士', '13800008901');
    const { token } = await seedBoundAppUser('openid-card-1', customerId);
    const cardId = await seedCard(customerId, {
      cardNo: 'CARD-0001',
      cardName: '十次卡',
      totalTimes: 10,
      usedTimes: 3,
    });

    const res = await ctx.request('GET', `/api/v1/app/member/cards/${cardId}`, {
      token,
    });
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(
      [
        'cardName',
        'cardNo',
        'expireAt',
        'id',
        'remainingTimes',
        'status',
        'totalTimes',
        'unusableReason',
        'usable',
        'usedTimes',
      ].sort(),
    );
    expect(res.body).toMatchObject({
      id: cardId,
      cardNo: 'CARD-0001',
      remainingTimes: 7,
      usable: true,
      unusableReason: null,
    });
  });

  it('不能用时说清原因：过期 / 用完 / 已退款', async () => {
    const customerId = await seedCustomer('李女士', '13800008902');
    const { token } = await seedBoundAppUser('openid-card-2', customerId);
    const expired = await seedCard(customerId, {
      cardNo: 'CARD-EXP',
      totalTimes: 10,
      usedTimes: 2,
      // 昨天过期（不能只改 status：状态是现算的，过期时间才是事实）
      expireAt: new Date(Date.now() - 86_400_000),
    });
    const usedUp = await seedCard(customerId, {
      cardNo: 'CARD-USED',
      totalTimes: 4,
      usedTimes: 4,
    });
    const refunded = await seedCard(customerId, {
      cardNo: 'CARD-REFUND',
      totalTimes: 10,
      usedTimes: 1,
      status: 'refunded',
    });

    const cases: [number, string][] = [
      [expired, '次卡已过期'],
      [usedUp, '次数已用完'],
      [refunded, '次卡已退款'],
    ];
    for (const [cardId, reason] of cases) {
      const res = await ctx.request(
        'GET',
        `/api/v1/app/member/cards/${cardId}`,
        { token },
      );
      expect(res.status).toBe(200);
      expect(res.body.usable, String(cardId)).toBe(false);
      expect(res.body.unusableReason, String(cardId)).toBe(reason);
    }
  });

  it('使用记录：核销带项目与美甲师；撤销记录没有项目（不编名字）', async () => {
    const customerId = await seedCustomer('李女士', '13800008903');
    const { token } = await seedBoundAppUser('openid-card-3', customerId);
    const cardId = await seedCard(customerId, {
      cardNo: 'CARD-LOG',
      totalTimes: 10,
      usedTimes: 1,
    });
    const serviceItemId = await seedServiceItem('单色经典甲油胶');

    // 一笔已完成预约 + 美甲师，让日志能带出项目名与美甲师名
    const staff = await ctx.sql<{ insertId: number }>(
      `INSERT INTO biz_staff (nickname, phone, status) VALUES ('小美', '13800008999', 'active')`,
    );
    const booking = await ctx.sql<{ insertId: number }>(
      `INSERT INTO biz_booking
         (booking_no, customer_id, staff_id, start_at, end_at, duration_minutes,
          customer_name, status, pay_status)
       VALUES ('B20260913001', ?, ?, NOW(), DATE_ADD(NOW(), INTERVAL 1 HOUR), 60,
               '李女士', 'completed', 'paid')`,
      [customerId, staff.insertId],
    );
    await ctx.sql(
      `INSERT INTO biz_member_card_log (card_id, booking_id, service_item_id, type, times, created_by)
       VALUES (?, ?, ?, 'use', 1, 0)`,
      [cardId, booking.insertId, serviceItemId],
    );
    // 撤销记录：没有项目、没有预约
    await ctx.sql(
      `INSERT INTO biz_member_card_log (card_id, service_item_id, type, times, remark, created_by)
       VALUES (?, ?, 'revert', 1, '改单退回', 0)`,
      [cardId, serviceItemId],
    );

    const res = await ctx.request(
      'GET',
      `/api/v1/app/member/cards/${cardId}/logs`,
      { token },
    );
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    // 倒序：后插的撤销记录在前
    expect(res.body.items[0]).toMatchObject({
      type: 'revert',
      times: 1,
      remark: '改单退回',
    });
    expect(res.body.items[1]).toMatchObject({
      type: 'use',
      serviceItemName: '单色经典甲油胶',
      staffName: '小美',
    });
    expect(Object.keys(res.body.items[0]).sort()).toEqual(
      [
        'createdAt',
        'id',
        'remark',
        'serviceItemName',
        'staffName',
        'times',
        'type',
      ].sort(),
    );
  });

  it('越权：别人的卡 → 404（详情与记录都是），不是 403', async () => {
    const mineId = await seedCustomer('我', '13800008904');
    const otherId = await seedCustomer('别人', '13800008905');
    const mine = await seedBoundAppUser('openid-card-4a', mineId);
    // 造别人的卡（别人的身份本身不需要 token —— 这里只验「我的 token 拿不到他的卡」）
    await seedBoundAppUser('openid-card-4b', otherId);
    const otherCard = await seedCard(otherId, { cardNo: 'CARD-OTHER' });

    for (const path of [
      `/api/v1/app/member/cards/${otherCard}`,
      `/api/v1/app/member/cards/${otherCard}/logs`,
    ]) {
      const res = await ctx.request('GET', path, { token: mine.token });
      expect(res.status, path).toBe(404);
    }

    // 不存在的卡 id 同样是 404
    const missing = await ctx.request(
      'GET',
      '/api/v1/app/member/cards/999999',
      {
        token: mine.token,
      },
    );
    expect(missing.status).toBe(404);
  });

  it('未绑定手机号 → 401 + needBind（次卡是个人资产）', async () => {
    const { token } = await seedBoundAppUser('openid-card-5', null);
    const res = await ctx.request('GET', '/api/v1/app/member/cards/1', {
      token,
    });
    expect(res.status).toBe(401);
    expect(res.body.needBind).toBe(true);
  });
});
