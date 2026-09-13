/**
 * B1 预约主链路集成验收（真库 + 真 HTTP）。
 *
 * 覆盖 spec §12 B1 的可自动化部分：时区、缓冲只计一次、网格、并发「恰好 1 个成功」、
 * 单号唯一、非法流转、排班冲突保护、定时任务幂等。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  addLocalDays,
  formatShopDateTime,
  shopDayRange,
  shopToday,
  shopWeekday,
} from '../../src/modules/biz/common/shop-time.js';
import { createTestContext, type TestContext } from './harness.js';

let ctx: TestContext;
/** 用例使用的店内本地日（相对今天 +3 天，避开「现在几点」的影响） */
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
  const customers = await ctx.sql<{ insertId: number }[]>(
    `INSERT INTO biz_customer (name, phone, gender) VALUES ('张女士', '13800000001', 'female')`,
  );
  await ctx.sql(
    `INSERT INTO biz_staff_weekly_shift (staff_id, weekday, start_time, end_time)
     VALUES (?, ?, '10:00:00', '20:00:00')`,
    [staffs.insertId, weekday],
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

function slotTimes(body: any): string[] {
  return (body?.slots ?? []).map((slot: any) =>
    String(slot.startAt).slice(11, 16),
  );
}

function createBody(
  seedRow: Seed,
  startAt: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    customerId: seedRow.customerId,
    staffId: seedRow.staffId,
    startAt,
    serviceItemIds: [seedRow.serviceItemId],
    payMode: 'full',
    payments: [{ channel: 'cash', amount: 10000 }],
    ...overrides,
  };
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

describe('B1 可约时段（§5.2 / §5.3）', () => {
  it('时段落在店内本地日区间内，且是带 +08:00 偏移的 ISO8601', async () => {
    const row = await seed();
    const response = await ctx.request(
      'GET',
      `/api/v1/biz/bookings/available-slots?staffId=${row.staffId}&date=${date}&serviceItemIds=${row.serviceItemId}`,
    );
    expect(response.status).toBe(200);
    const times = slotTimes(response.body);
    expect(times.length).toBeGreaterThan(0);
    const { start, end } = shopDayRange(date);
    for (const slot of response.body.slots) {
      expect(String(slot.startAt)).toMatch(/\+08:00$/);
      const instant = new Date(slot.startAt);
      expect(instant.getTime()).toBeGreaterThanOrEqual(start.getTime());
      expect(instant.getTime()).toBeLessThan(end.getTime());
      // 结束时间不含缓冲，正好是开始 + 时长
      expect(new Date(slot.endAt).getTime() - instant.getTime()).toBe(
        60 * 60_000,
      );
    }
    // 网格以店内本地日 00:00 为基准、步长 15 分钟
    for (const time of times)
      expect(['00', '15', '30', '45']).toContain(time.slice(3));
  });

  it('当天无班次 → reason=no_shift；请假 → reason=off', async () => {
    const row = await seed();
    const otherDay = addLocalDays(date, 1);
    const noShift = await ctx.request(
      'GET',
      `/api/v1/biz/bookings/available-slots?staffId=${row.staffId}&date=${otherDay}&serviceItemIds=${row.serviceItemId}`,
    );
    // 只有配置的那一天有班次；相邻日期若恰好同 weekday 则跳过该断言
    if (shopWeekday(otherDay) !== shopWeekday(date)) {
      expect(noShift.body.slots).toHaveLength(0);
      expect(noShift.body.reason).toBe('no_shift');
    }

    const off = await ctx.request(
      'GET',
      `/api/v1/biz/bookings/available-slots?staffId=${row.staffId}&date=${date}&serviceItemIds=${row.serviceItemId}`,
    );
    expect(off.body.reason).toBeUndefined();
    await ctx.sql(
      `INSERT INTO biz_staff_schedule_override (staff_id, date, type, reason)
       VALUES (?, ?, 'off', '调休')`,
      [row.staffId, date],
    );
    const afterOff = await ctx.request(
      'GET',
      `/api/v1/biz/bookings/available-slots?staffId=${row.staffId}&date=${date}&serviceItemIds=${row.serviceItemId}`,
    );
    expect(afterOff.body.slots).toHaveLength(0);
    expect(afterOff.body.reason).toBe('off');
  });

  it('custom 例外替代周模板（仅返回自定义时段）', async () => {
    const row = await seed();
    await ctx.sql(
      `INSERT INTO biz_staff_schedule_override (staff_id, date, type, start_time, end_time, reason)
       VALUES (?, ?, 'custom', '14:00:00', '16:00:00', '临时加班')`,
      [row.staffId, date],
    );
    const response = await ctx.request(
      'GET',
      `/api/v1/biz/bookings/available-slots?staffId=${row.staffId}&date=${date}&serviceItemIds=${row.serviceItemId}`,
    );
    const times = slotTimes(response.body);
    expect(times.length).toBeGreaterThan(0);
    expect(times[0]).toBe('14:00');
    // 16:00 起已超出该段（60 分钟时长 + 不含缓冲），因此最晚 15:00 开始
    expect(times.at(-1)).toBe('15:00');
  });

  it('缓冲只计一次：60 分钟服务 + 15 分钟缓冲 → 下一单最早 11:15', async () => {
    const row = await seed();
    const created = await ctx.request('POST', '/api/v1/biz/bookings', {
      body: createBody(row, `${date}T10:00:00+08:00`),
    });
    expect(created.status).toBe(201);
    const response = await ctx.request(
      'GET',
      `/api/v1/biz/bookings/available-slots?staffId=${row.staffId}&date=${date}&serviceItemIds=${row.serviceItemId}`,
    );
    const times = slotTimes(response.body);
    expect(times).not.toContain('10:00');
    expect(times).not.toContain('11:00');
    expect(times).toContain('11:15');
    // 对称：11:15 之后按 15 分钟步长连续可用
    expect(times).toContain('11:30');
  });

  it('对称性：先录 A 再录 B 与先录 B 再录 A，可约结果一致', async () => {
    const row = await seed();
    const morning = `${date}T10:00:00+08:00`;
    const afternoon = `${date}T14:00:00+08:00`;
    await ctx.request('POST', '/api/v1/biz/bookings', {
      body: createBody(row, morning),
    });
    await ctx.request('POST', '/api/v1/biz/bookings', {
      body: createBody(row, afternoon),
    });
    const first = await ctx.request(
      'GET',
      `/api/v1/biz/bookings/available-slots?staffId=${row.staffId}&date=${date}&serviceItemIds=${row.serviceItemId}`,
    );

    await ctx.resetBusinessData();
    const row2 = await seed();
    await ctx.request('POST', '/api/v1/biz/bookings', {
      body: createBody(row2, afternoon),
    });
    await ctx.request('POST', '/api/v1/biz/bookings', {
      body: createBody(row2, morning),
    });
    const second = await ctx.request(
      'GET',
      `/api/v1/biz/bookings/available-slots?staffId=${row2.staffId}&date=${date}&serviceItemIds=${row2.serviceItemId}`,
    );
    expect(slotTimes(second.body)).toEqual(slotTimes(first.body));
  });

  it('同一时段已有预约 → 第二次创建 409（含冲突提示）', async () => {
    const row = await seed();
    const first = await ctx.request('POST', '/api/v1/biz/bookings', {
      body: createBody(row, `${date}T10:00:00+08:00`),
    });
    expect(first.status).toBe(201);
    const second = await ctx.request('POST', '/api/v1/biz/bookings', {
      body: createBody(row, `${date}T10:30:00+08:00`),
    });
    expect(second.status).toBe(409);
  });
});

describe('B1 并发与单号（§6.2）', () => {
  it('并发 10 个同一美甲师同时段创建 → 恰好 1 个成功', async () => {
    const row = await seed();
    const body = createBody(row, `${date}T10:00:00+08:00`);
    const responses = await Promise.all(
      Array.from({ length: 10 }, () =>
        ctx.request('POST', '/api/v1/biz/bookings', { body }),
      ),
    );
    const created = responses.filter((item) => item.status === 201);
    const conflicts = responses.filter((item) => item.status === 409);
    expect(created).toHaveLength(1);
    expect(conflicts).toHaveLength(9);

    const rows = await ctx.sql<{ count: number }[]>(
      'SELECT COUNT(*) AS count FROM biz_booking WHERE deleted_at IS NULL',
    );
    expect(Number(rows[0].count)).toBe(1);
  });

  it('并发创建的单号唯一且格式为 B{yyyyMMdd}{id}', async () => {
    const row = await seed();
    const responses = await Promise.all(
      [0, 1, 2, 3, 4].map((offset) =>
        ctx.request('POST', '/api/v1/biz/bookings', {
          body: createBody(
            row,
            formatShopDateTime(
              new Date(
                shopDayRange(date).start.getTime() +
                  (10 * 60 + offset * 75) * 60_000,
              ),
            ),
          ),
        }),
      ),
    );
    const ok = responses.filter((item) => item.status === 201);
    expect(ok.length).toBeGreaterThanOrEqual(1);
    const numbers = ok.map((item) => item.body.bookingNo);
    expect(new Set(numbers).size).toBe(numbers.length);
    for (const number of numbers) expect(number).toMatch(/^B\d{8}\d{6}$/);
  });

  it('顾客同时段重复录单默认 409，force=true 放行', async () => {
    const row = await seed();
    const second = await ctx.sql<{ insertId: number }[]>(
      `INSERT INTO biz_staff (nickname, status, sort) VALUES ('小丽', 'active', 2)`,
    );
    await ctx.sql(
      `INSERT INTO biz_staff_weekly_shift (staff_id, weekday, start_time, end_time)
       VALUES (?, ?, '10:00:00', '20:00:00')`,
      [second.insertId, shopWeekday(date)],
    );
    const startAt = `${date}T10:00:00+08:00`;
    await ctx.request('POST', '/api/v1/biz/bookings', {
      body: createBody(row, startAt),
    });
    const clash = await ctx.request('POST', '/api/v1/biz/bookings', {
      body: createBody(row, startAt, { staffId: second.insertId }),
    });
    expect(clash.status).toBe(409);
    const forced = await ctx.request('POST', '/api/v1/biz/bookings', {
      body: createBody(row, startAt, { staffId: second.insertId, force: true }),
    });
    expect(forced.status).toBe(201);
  });
});

describe('B1 时间校验与状态流转', () => {
  it('startAt 不在 15 分钟网格 → 400', async () => {
    const row = await seed();
    const response = await ctx.request('POST', '/api/v1/biz/bookings', {
      body: createBody(row, `${date}T10:07:00+08:00`),
    });
    expect(response.status).toBe(400);
  });

  it('startAt 无时区偏移 → 400（禁止 new Date("YYYY-MM-DD") 类误用）', async () => {
    const row = await seed();
    const response = await ctx.request('POST', '/api/v1/biz/bookings', {
      body: createBody(row, `${date}T10:00:00`),
    });
    expect(response.status).toBe(400);
  });

  it('超出班次（19:30 + 60 分钟 > 20:00）→ 400', async () => {
    const row = await seed();
    const response = await ctx.request('POST', '/api/v1/biz/bookings', {
      body: createBody(row, `${date}T19:30:00+08:00`),
    });
    expect(response.status).toBe(400);
  });

  it('非法流转被拒绝：completed → arrived', async () => {
    const row = await seed();
    const created = await ctx.request('POST', '/api/v1/biz/bookings', {
      body: createBody(row, `${date}T10:00:00+08:00`),
    });
    const id = created.body.id;
    expect(
      (await ctx.request('POST', `/api/v1/biz/bookings/${id}/arrive`)).status,
    ).toBe(201);
    expect(
      (await ctx.request('POST', `/api/v1/biz/bookings/${id}/complete`)).status,
    ).toBe(201);
    expect(
      (await ctx.request('POST', `/api/v1/biz/bookings/${id}/arrive`)).status,
    ).toBe(409);
    expect(
      (await ctx.request('POST', `/api/v1/biz/bookings/${id}/complete`)).status,
    ).toBe(409);
  });

  it('爽约需填原因，且只能从 confirmed 发起', async () => {
    const row = await seed();
    const created = await ctx.request('POST', '/api/v1/biz/bookings', {
      body: createBody(row, `${date}T10:00:00+08:00`),
    });
    const id = created.body.id;
    const noReason = await ctx.request(
      'POST',
      `/api/v1/biz/bookings/${id}/no-show`,
      {
        body: {},
      },
    );
    expect(noReason.status).toBe(400);
    expect(
      (
        await ctx.request('POST', `/api/v1/biz/bookings/${id}/no-show`, {
          body: { reason: '顾客未到店' },
        })
      ).status,
    ).toBe(201);
    expect(
      (await ctx.request('POST', `/api/v1/biz/bookings/${id}/arrive`)).status,
    ).toBe(409);
  });

  it('取消需填原因，有实收时提示走退款流程', async () => {
    const row = await seed();
    const created = await ctx.request('POST', '/api/v1/biz/bookings', {
      body: createBody(row, `${date}T10:00:00+08:00`),
    });
    const cancelled = await ctx.request(
      'POST',
      `/api/v1/biz/bookings/${created.body.id}/cancel`,
      { body: { reason: '顾客临时有事' } },
    );
    expect(cancelled.status).toBe(201);
    expect(String(cancelled.body.warning)).toContain('退款');
  });

  it('有实收的预约不允许直接软删', async () => {
    const row = await seed();
    const created = await ctx.request('POST', '/api/v1/biz/bookings', {
      body: createBody(row, `${date}T10:00:00+08:00`),
    });
    const removed = await ctx.request(
      'DELETE',
      `/api/v1/biz/bookings/${created.body.id}`,
    );
    expect(removed.status).toBe(409);
  });
});

describe('B1 主数据 / 排班变更的冲突保护（§6.4）', () => {
  it('该日已有预约时加 off → 409 + 受影响清单；force=true 才落库', async () => {
    const row = await seed();
    await ctx.request('POST', '/api/v1/biz/bookings', {
      body: createBody(row, `${date}T10:00:00+08:00`),
    });
    const blocked = await ctx.request(
      'POST',
      `/api/v1/biz/staffs/${row.staffId}/overrides`,
      { body: { date, type: 'off', reason: '临时请假' } },
    );
    expect(blocked.status).toBe(409);
    expect(Array.isArray(blocked.body.conflicts)).toBe(true);
    expect(blocked.body.conflicts).toHaveLength(1);
    expect(String(blocked.body.conflicts[0].bookingNo)).toMatch(
      /^B\d{8}\d{6}$/,
    );

    const forced = await ctx.request(
      'POST',
      `/api/v1/biz/staffs/${row.staffId}/overrides`,
      { body: { date, type: 'off', reason: '临时请假', force: true } },
    );
    expect([200, 201]).toContain(forced.status);
    const slots = await ctx.request(
      'GET',
      `/api/v1/biz/bookings/available-slots?staffId=${row.staffId}&date=${date}&serviceItemIds=${row.serviceItemId}`,
    );
    expect(slots.body.reason).toBe('off');
  });

  it('停用被未完成预约引用的服务项目 → 409', async () => {
    const row = await seed();
    await ctx.request('POST', '/api/v1/biz/bookings', {
      body: createBody(row, `${date}T10:00:00+08:00`),
    });
    const removed = await ctx.request(
      'DELETE',
      `/api/v1/biz/service-items/${row.serviceItemId}`,
    );
    expect(removed.status).toBe(409);
  });

  it('手机号重复创建顾客 → 409', async () => {
    await seed();
    const duplicate = await ctx.request('POST', '/api/v1/biz/customers', {
      body: { name: '李女士', phone: '13800000001' },
    });
    expect(duplicate.status).toBe(409);
    const fresh = await ctx.request('POST', '/api/v1/biz/customers', {
      body: { name: '李女士', phone: '13800000002' },
    });
    expect(fresh.status).toBe(201);
  });
});

describe('B1 定时任务幂等（§11）', () => {
  it('arrived 且已过 end_at → 自动 completed，重复执行无副作用', async () => {
    const row = await seed();
    const created = await ctx.request('POST', '/api/v1/biz/bookings', {
      body: createBody(row, `${date}T10:00:00+08:00`),
    });
    const id = created.body.id;
    await ctx.request('POST', `/api/v1/biz/bookings/${id}/arrive`);
    await ctx.sql(
      `UPDATE biz_booking SET end_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 HOUR) WHERE id = ?`,
      [id],
    );

    const { BookingOpsPort } =
      await import('../../src/modules/biz/common/ports.js');
    const ops = ctx.app.get(BookingOpsPort);
    const first = await ops.autoCompleteExpired();
    expect(first.completed).toBe(1);
    const second = await ops.autoCompleteExpired();
    expect(second.completed).toBe(0);

    const rows = await ctx.sql<{ status: string; visit_count: number }[]>(
      `SELECT b.status, c.visit_count FROM biz_booking b
         JOIN biz_customer c ON c.id = b.customer_id WHERE b.id = ?`,
      [id],
    );
    expect(rows[0].status).toBe('completed');
    // 到店统计只在真正发生流转那一次累加
    expect(Number(rows[0].visit_count)).toBe(1);
  });

  it('confirmed 超过容忍期 → no_show，重复执行无副作用', async () => {
    const row = await seed();
    const created = await ctx.request('POST', '/api/v1/biz/bookings', {
      body: createBody(row, `${date}T10:00:00+08:00`),
    });
    await ctx.sql(
      `UPDATE biz_booking SET start_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 2 HOUR) WHERE id = ?`,
      [created.body.id],
    );
    const { BookingOpsPort } =
      await import('../../src/modules/biz/common/ports.js');
    const ops = ctx.app.get(BookingOpsPort);
    expect((await ops.autoNoShowExpired()).noShow).toBe(1);
    expect((await ops.autoNoShowExpired()).noShow).toBe(0);
  });
});

describe('收银台队列：作废单不进队（§10.5 / §17.2）', () => {
  /** 收了定金的单：pay_status=partial、还挂着尾款 */
  function depositBody(
    row: Seed,
    startAt: string,
    overrides: Record<string, unknown> = {},
  ) {
    return createBody(row, startAt, {
      payMode: 'deposit',
      depositAmount: 3000,
      payments: [{ channel: 'cash', amount: 3000 }],
      ...overrides,
    });
  }

  async function queueNos(query: string): Promise<string[]> {
    const response = await ctx.request(
      'GET',
      `/api/v1/biz/bookings?page=1&pageSize=50&${query}`,
    );
    expect(response.status).toBe(200);
    return response.body.items.map(
      (item: { bookingNo: string }) => item.bookingNo,
    );
  }

  it('取消只改服务状态、不改资金状态：列表必须靠 collectable 排掉它', async () => {
    const row = await seed();
    const kept = await ctx.request('POST', '/api/v1/biz/bookings', {
      body: depositBody(row, `${date}T10:00:00+08:00`),
    });
    const killed = await ctx.request('POST', '/api/v1/biz/bookings', {
      body: depositBody(row, `${date}T12:00:00+08:00`),
    });
    const killedId = killed.body.id as number;

    const cancelled = await ctx.request(
      'POST',
      `/api/v1/biz/bookings/${killedId}/cancel`,
      { body: { reason: '顾客临时有事' } },
    );
    expect(cancelled.status).toBe(201);

    // 取消**不动** pay_status：这正是不带 collectable 就会把它列进队列的原因
    const rows = await ctx.sql<
      { status: string; pay_status: string; due_amount: number }[]
    >(`SELECT status, pay_status, due_amount FROM biz_booking WHERE id = ?`, [
      killedId,
    ]);
    expect(rows[0]!.status).toBe('cancelled');
    expect(rows[0]!.pay_status).toBe('partial');
    expect(Number(rows[0]!.due_amount)).toBe(7000);

    // 收银台队列（collectable=true）：只留还能收的那张
    const queue = await queueNos('payStatus=partial&collectable=true');
    expect(queue).toContain(kept.body.bookingNo);
    expect(queue).not.toContain(killed.body.bookingNo);

    // 预约列表不传 collectable：历史取消单必须还查得到（不能把列表也一起改了）
    const all = await queueNos('payStatus=partial');
    expect(all).toContain(killed.body.bookingNo);
  });

  it('爽约同样不进队，且列表顺序/关键字筛选下也排得掉', async () => {
    const row = await seed();
    const noShow = await ctx.request('POST', '/api/v1/biz/bookings', {
      body: depositBody(row, `${date}T14:00:00+08:00`),
    });
    await ctx.request('POST', `/api/v1/biz/bookings/${noShow.body.id}/confirm`);
    const result = await ctx.request(
      'POST',
      `/api/v1/biz/bookings/${noShow.body.id}/no-show`,
      { body: { reason: '顾客未到店' } },
    );
    expect(result.status).toBe(201);

    expect(await queueNos('payStatus=partial&collectable=true')).not.toContain(
      noShow.body.bookingNo,
    );
    // 关键字 + collectable 同时生效（队列搜索框就是这条组合）
    expect(
      await queueNos('payStatus=partial&collectable=true&keyword=张女士'),
    ).not.toContain(noShow.body.bookingNo);
  });

  it('列表排掉只是 UI 友好：直接结算作废单仍然 409（闸门在服务端）', async () => {
    const row = await seed();
    const created = await ctx.request('POST', '/api/v1/biz/bookings', {
      body: depositBody(row, `${date}T16:00:00+08:00`),
    });
    await ctx.request(
      'POST',
      `/api/v1/biz/bookings/${created.body.id}/cancel`,
      {
        body: { reason: '顾客临时有事' },
      },
    );
    const settled = await ctx.request(
      'POST',
      `/api/v1/biz/bookings/${created.body.id}/settle`,
      { body: { payments: [{ channel: 'cash', amount: 7000 }] } },
    );
    expect(settled.status).toBe(409);
    expect(String(settled.body.message)).toContain('不能结算');
  });
});
