/**
 * B6 小程序身份：登录幂等、手机号绑定、美甲师工作台**候选**（不自动开通）。
 *
 * 这一组用例是新需求「美甲师登录看自己的预约与业绩」的**安全底线**：
 * 开通只能由店长在后台确认，app 域任何入参都不允许把 `staff_status` 顶成 `active`。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  addLocalDays,
  shopToday,
  shopWeekday,
} from '../../src/modules/biz/common/shop-time.js';
import { createTestContext, itemsOf, type TestContext } from './harness.js';

let ctx: TestContext;
/** 建单用的店内本地日（今天 +3 天，避开「现在几点」的影响） */
let date: string;

/**
 * 造一条小程序身份并签发 app token，
 * 等价于「已 `wx.login` 拿到 token，但还没授权手机号」的状态。
 */
async function seedAppUser(openid: string, nickname: string | null = null) {
  const inserted = await ctx.sql<{ insertId: number }>(
    `INSERT INTO app_wx_user (openid, nickname, staff_status) VALUES (?, ?, 'none')`,
    [openid, nickname],
  );
  const appUserId = inserted.insertId;
  return { appUserId, token: await ctx.appToken(openid, appUserId) };
}

beforeAll(async () => {
  ctx = await createTestContext();
  date = addLocalDays(shopToday(), 3);
}, 120_000);

beforeEach(async () => {
  await ctx.resetBusinessData();
});

afterAll(async () => {
  await ctx.close();
});

describe('B6 小程序登录（§16.2）', () => {
  it('测试 code 换到 app token；同一 openid 重复登录只有一行身份', async () => {
    const first = await ctx.request('POST', '/api/v1/app/auth/login', {
      token: null,
      body: { code: 'u1' },
    });
    expect(first.status).toBe(201);
    expect(typeof first.body.accessToken).toBe('string');
    // 假实现下 openid = 'fake-openid-' + code
    expect(first.body.customerId).toBeNull();
    expect(first.body.staffStatus).toBe('none');

    const again = await ctx.request('POST', '/api/v1/app/auth/login', {
      token: null,
      body: { code: 'u1' },
    });
    expect(again.status).toBe(201);

    const counted = await ctx.sql<{ total: number }[]>(
      `SELECT COUNT(*) AS total FROM app_wx_user WHERE openid = 'fake-openid-u1'`,
    );
    expect(Number(counted[0].total)).toBe(1);
  });

  it('并发首登也只会有一行身份（openid 唯一 + upsert）', async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        ctx.request('POST', '/api/v1/app/auth/login', {
          token: null,
          body: { code: 'race' },
        }),
      ),
    );
    expect(results.every((item) => item.status === 201)).toBe(true);

    const counted = await ctx.sql<{ total: number }[]>(
      `SELECT COUNT(*) AS total FROM app_wx_user WHERE openid = 'fake-openid-race'`,
    );
    expect(Number(counted[0].total)).toBe(1);
  });

  it('换取的 app token 能读会员信息（未绑定手机号 → 401 + needBind）', async () => {
    const login = await ctx.request('POST', '/api/v1/app/auth/login', {
      token: null,
      body: { code: 'u2' },
    });
    const me = await ctx.request('GET', '/api/v1/app/member/me', {
      token: login.body.accessToken,
    });
    expect(me.status).toBe(401);
    expect(me.body.needBind).toBe(true);
  });
});

describe('B6 手机号绑定（§9.7 / §4.3）', () => {
  it('无匹配顾客 → 新建档案并绑定锚点；重复绑定幂等、不再新建', async () => {
    const { appUserId, token } = await seedAppUser('openid-bind', '小美');

    const first = await ctx.request('POST', '/api/v1/app/auth/phone', {
      token,
      body: { code: '13800000001' },
    });
    expect(first.status).toBe(201);
    expect(first.body.created).toBe(true);
    expect(first.body.customerId).toBeGreaterThan(0);

    const customers = await ctx.sql<
      { id: number; name: string; phone: string }[]
    >(`SELECT id, name, phone FROM biz_customer WHERE phone = '13800000001'`);
    expect(customers).toHaveLength(1);
    // 昵称来自 wx.login 时的快照
    expect(customers[0].name).toBe('小美');

    const identity = await ctx.sql<{ customer_id: number; phone: string }[]>(
      `SELECT customer_id, phone FROM app_wx_user WHERE id = ${appUserId}`,
    );
    expect(identity[0].customer_id).toBe(customers[0].id);
    expect(identity[0].phone).toBe('13800000001');

    const again = await ctx.request('POST', '/api/v1/app/auth/phone', {
      token,
      body: { code: '13800000001' },
    });
    expect(again.status).toBe(201);
    expect(again.body.created).toBe(false);
    expect(again.body.customerId).toBe(first.body.customerId);

    const counted = await ctx.sql<{ total: number }[]>(
      `SELECT COUNT(*) AS total FROM biz_customer WHERE phone = '13800000001'`,
    );
    expect(Number(counted[0].total)).toBe(1);
  });

  it('手机号命中已有顾客 → 直接复用，不新建', async () => {
    const existing = await ctx.sql<{ insertId: number }>(
      `INSERT INTO biz_customer (name, phone) VALUES ('老顾客', '13800000002')`,
    );
    const { token } = await seedAppUser('openid-reuse');

    const res = await ctx.request('POST', '/api/v1/app/auth/phone', {
      token,
      body: { code: '13800000002' },
    });
    expect(res.status).toBe(201);
    expect(res.body.created).toBe(false);
    expect(res.body.customerId).toBe(existing.insertId);
  });

  it('后台恢复软删顾客后，小程序可以重新绑定该手机号', async () => {
    const removed = await ctx.sql<{ insertId: number }>(
      `INSERT INTO biz_customer (name, phone, deleted_at) VALUES ('待恢复顾客', '13800000012', NOW())`,
    );

    const deletedList = await ctx.request(
      'GET',
      '/api/v1/biz/customers?status=deleted&keyword=13800000012',
    );
    expect(deletedList.status).toBe(200);
    expect(deletedList.body.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: removed.insertId,
          deletedAt: expect.any(String),
        }),
      ]),
    );

    const restored = await ctx.request(
      'POST',
      `/api/v1/biz/customers/${removed.insertId}/restore`,
    );
    expect(restored.status).toBe(201);

    const afterRestore = await ctx.sql<{ deleted_at: string | null }[]>(
      `SELECT deleted_at FROM biz_customer WHERE id = ${removed.insertId}`,
    );
    expect(afterRestore[0].deleted_at).toBeNull();

    const { token } = await seedAppUser('openid-restore-then-bind');
    const rebound = await ctx.request('POST', '/api/v1/app/auth/phone', {
      token,
      body: { code: '13800000012' },
    });
    expect(rebound.status).toBe(201);
    expect(rebound.body.customerId).toBe(removed.insertId);
    expect(rebound.body.created).toBe(false);
  });

  it('恢复接口幂等：重复恢复同一顾客仍成功', async () => {
    const removed = await ctx.sql<{ insertId: number }>(
      `INSERT INTO biz_customer (name, phone, deleted_at) VALUES ('幂等恢复顾客', '13800000013', NOW())`,
    );
    const first = await ctx.request(
      'POST',
      `/api/v1/biz/customers/${removed.insertId}/restore`,
    );
    const second = await ctx.request(
      'POST',
      `/api/v1/biz/customers/${removed.insertId}/restore`,
    );
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
  });

  it('恢复不存在的顾客 → 404', async () => {
    const res = await ctx.request(
      'POST',
      '/api/v1/biz/customers/999999/restore',
    );
    expect(res.status).toBe(404);
  });

  it('命中**已删除**顾客 → 409 + needRestoreConfirm，且既不恢复也不绑定', async () => {
    const removed = await ctx.sql<{ insertId: number }>(
      `INSERT INTO biz_customer (name, phone, deleted_at) VALUES ('旧顾客', '13800000003', NOW())`,
    );
    const { appUserId, token } = await seedAppUser('openid-softdeleted');

    const res = await ctx.request('POST', '/api/v1/app/auth/phone', {
      token,
      body: { code: '13800000003' },
    });
    expect(res.status).toBe(409);
    expect(res.body.needRestoreConfirm).toBe(true);
    expect(res.body.customerId).toBe(removed.insertId);

    // 恢复是数据完整性动作：C 端不允许自动做（会带回余额/积分/次卡历史）
    const customers = await ctx.sql<{ deleted_at: string | null }[]>(
      `SELECT deleted_at FROM biz_customer WHERE phone = '13800000003'`,
    );
    expect(customers[0].deleted_at).not.toBeNull();

    // 也没绑定：手机号快照落了，但 customer_id 必须仍为空
    const identity = await ctx.sql<
      { customer_id: number | null; phone: string }[]
    >(`SELECT customer_id, phone FROM app_wx_user WHERE id = ${appUserId}`);
    expect(identity[0].customer_id).toBeNull();
    expect(identity[0].phone).toBe('13800000003');
  });

  it('未登录（无 app token）→ 401', async () => {
    const res = await ctx.request('POST', '/api/v1/app/auth/phone', {
      token: null,
      body: { code: '13800000001' },
    });
    expect(res.status).toBe(401);
  });
});

describe('B6 美甲师工作台申请（§12.5 S1）', () => {
  it('未绑定手机号 → 400，不能凭空申请', async () => {
    const { token } = await seedAppUser('openid-apply-no-phone');
    const res = await ctx.request('POST', '/api/v1/app/staff/apply', {
      token,
      body: {},
    });
    expect(res.status).toBe(400);
  });

  it('手机号命中在职美甲师 → pending，并忽略请求体里的提权字段', async () => {
    const staff = await ctx.sql<{ insertId: number }>(
      `INSERT INTO biz_staff (nickname, phone, status, sort) VALUES ('申请小柚', '13800000014', 'active', 1)`,
    );
    const { appUserId, token } = await seedAppUser('openid-apply-pending');
    const bound = await ctx.request('POST', '/api/v1/app/auth/phone', {
      token,
      body: { code: '13800000014' },
    });
    expect(bound.status).toBe(201);

    const res = await ctx.request('POST', '/api/v1/app/staff/apply', {
      token,
      body: { staffId: 999999, staffStatus: 'active' },
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      staffId: staff.insertId,
      staffStatus: 'pending',
    });
    expect(typeof res.body.staffRequestedAt).toBe('string');

    const row = await ctx.sql<
      {
        staff_id: number;
        staff_status: string;
        staff_decided_at: string | null;
      }[]
    >(
      `SELECT staff_id, staff_status, staff_decided_at FROM app_wx_user WHERE id = ${appUserId}`,
    );
    expect(row[0].staff_id).toBe(staff.insertId);
    expect(row[0].staff_status).toBe('pending');
    expect(row[0].staff_decided_at).toBeNull();
  });

  it('重复申请幂等；rejected 可以重新申请回 pending', async () => {
    await ctx.sql(
      `INSERT INTO biz_staff (nickname, phone, status, sort) VALUES ('重申小柚', '13800000015', 'active', 1)`,
    );
    const { appUserId, token } = await seedAppUser('openid-apply-repeat');
    await ctx.request('POST', '/api/v1/app/auth/phone', {
      token,
      body: { code: '13800000015' },
    });
    const first = await ctx.request('POST', '/api/v1/app/staff/apply', {
      token,
      body: {},
    });
    const second = await ctx.request('POST', '/api/v1/app/staff/apply', {
      token,
      body: {},
    });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.staffStatus).toBe('pending');

    await ctx.sql(
      `UPDATE app_wx_user SET staff_status = 'rejected', staff_decided_at = NOW(), staff_decided_by = 1 WHERE id = ${appUserId}`,
    );
    const reapply = await ctx.request('POST', '/api/v1/app/staff/apply', {
      token,
      body: {},
    });
    expect(reapply.status).toBe(201);
    expect(reapply.body.staffStatus).toBe('pending');
  });

  it('手机号命中停用 / 软删美甲师 → 400', async () => {
    await ctx.sql(
      `INSERT INTO biz_staff (nickname, phone, status, sort) VALUES ('停用小柚', '13800000016', 'disabled', 1)`,
    );
    const { token } = await seedAppUser('openid-apply-disabled');
    await ctx.request('POST', '/api/v1/app/auth/phone', {
      token,
      body: { code: '13800000016' },
    });
    const disabled = await ctx.request('POST', '/api/v1/app/staff/apply', {
      token,
      body: {},
    });
    expect(disabled.status).toBe(400);
  });

  it('没有在职身份的 app token 不能通过工作台作用域（集成入口待 S3）', async () => {
    // apply 只要求 app token；它返回 pending 后仍不能调用后续 staff scope 接口。
    // 这里锁住申请接口不把 pending 误当 active，S3 接口接入 scope guard 后再补 403。
    const { token } = await seedAppUser('openid-apply-no-staff');
    const res = await ctx.request('POST', '/api/v1/app/staff/apply', {
      token,
      body: {},
    });
    expect(res.status).toBe(400);
  });
});

describe('B6 美甲师工作台开通：只给候选，不给权限', () => {
  it('手机号命中在职美甲师 → 返回候选，但身份仍是 none、库里未绑定', async () => {
    const staff = await ctx.sql<{ insertId: number }>(
      `INSERT INTO biz_staff (nickname, phone, status, sort) VALUES ('小柚', '13800000011', 'active', 1)`,
    );
    const { appUserId, token } = await seedAppUser('openid-staff');

    const res = await ctx.request('POST', '/api/v1/app/auth/phone', {
      token,
      body: { code: '13800000011' },
    });
    expect(res.status).toBe(201);
    expect(res.body.staffCandidate).toEqual({
      id: staff.insertId,
      nickname: '小柚',
    });
    expect(res.body.staffStatus).toBe('none');

    const identity = await ctx.sql<
      { staff_id: number | null; staff_status: string }[]
    >(`SELECT staff_id, staff_status FROM app_wx_user WHERE id = ${appUserId}`);
    expect(identity[0].staff_id).toBeNull();
    expect(identity[0].staff_status).toBe('none');
  });

  it('**防提权**：请求体里塞 staffStatus/staffId 一律被忽略（Zod 只取声明字段）', async () => {
    await ctx.sql(
      `INSERT INTO biz_staff (nickname, phone, status, sort) VALUES ('星野', '13800000012', 'active', 1)`,
    );
    const { appUserId, token } = await seedAppUser('openid-escalate');

    const res = await ctx.request('POST', '/api/v1/app/auth/phone', {
      token,
      body: { code: '13800000012', staffStatus: 'active', staffId: 1 },
    });
    expect(res.status).toBe(201);
    expect(res.body.staffStatus).toBe('none');

    const identity = await ctx.sql<
      { staff_id: number | null; staff_status: string }[]
    >(`SELECT staff_id, staff_status FROM app_wx_user WHERE id = ${appUserId}`);
    expect(identity[0].staff_id).toBeNull();
    expect(identity[0].staff_status).toBe('none');
  });

  it('已停用 / 已删除的美甲师不算候选', async () => {
    await ctx.sql(
      `INSERT INTO biz_staff (nickname, phone, status, sort) VALUES ('离职的', '13800000013', 'disabled', 1)`,
    );
    await ctx.sql(
      `INSERT INTO biz_staff (nickname, phone, status, sort, deleted_at) VALUES ('删掉的', '13800000014', 'active', 2, NOW())`,
    );

    for (const code of ['13800000013', '13800000014']) {
      const { token } = await seedAppUser(`openid-${code}`);
      const res = await ctx.request('POST', '/api/v1/app/auth/phone', {
        token,
        body: { code },
      });
      expect(res.status).toBe(201);
      expect(res.body.staffCandidate).toBeNull();
    }
  });
});

describe('B6 店长确认工作台开通（§12.5 S2）', () => {
  /** 造一条 pending 申请：美甲师档案 + 小程序身份 + 绑手机号 + apply */
  async function seedPending(openid: string, phone: string, nickname: string) {
    const staff = await ctx.sql<{ insertId: number }>(
      `INSERT INTO biz_staff (nickname, phone, status, sort) VALUES (?, ?, 'active', 1)`,
      [nickname, phone],
    );
    const { appUserId, token } = await seedAppUser(openid);
    await ctx.request('POST', '/api/v1/app/auth/phone', {
      token,
      body: { code: phone },
    });
    const applied = await ctx.request('POST', '/api/v1/app/staff/apply', {
      token,
      body: {},
    });
    expect(applied.status).toBe(201);
    return { staffId: staff.insertId, appUserId, token };
  }

  it('未申请过的顾客不出现在店长待办里；pending 申请能筛出来', async () => {
    await seedPending('openid-grant-pending', '13800000021', '待确认小柚');
    const { appUserId } = await seedAppUser('openid-grant-none');

    const list = await ctx.request(
      'GET',
      '/api/v1/biz/app-staff-grants?status=pending',
    );
    expect(list.status).toBe(200);
    const ids = itemsOf(list.body).map((row: any) => row.id);
    expect(ids).not.toContain(appUserId); // 从没申请过的顾客不该进店长待办
    expect(ids).toHaveLength(1);
    expect(itemsOf(list.body)[0]).toMatchObject({
      staffStatus: 'pending',
      staffName: '待确认小柚',
      staffArchivedStatus: 'active',
    });
  });

  it('通过 → active + 决策人落库；重复通过幂等', async () => {
    const { appUserId } = await seedPending(
      'openid-grant-approve',
      '13800000022',
      '通过小柚',
    );
    const first = await ctx.request(
      'POST',
      `/api/v1/biz/app-staff-grants/${appUserId}/approve`,
    );
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ staffStatus: 'active' });

    const row = await ctx.sql<
      { staff_status: string; staff_decided_by: number | null }[]
    >(
      `SELECT staff_status, staff_decided_by FROM app_wx_user WHERE id = ${appUserId}`,
    );
    expect(row[0].staff_status).toBe('active');
    expect(Number(row[0].staff_decided_by)).toBeGreaterThan(0);

    const again = await ctx.request(
      'POST',
      `/api/v1/biz/app-staff-grants/${appUserId}/approve`,
    );
    expect(again.status).toBe(201);
    expect(again.body.staffStatus).toBe('active');
  });

  it('档案停用后批准 → 409（批了也进不去工作台）', async () => {
    const { staffId, appUserId } = await seedPending(
      'openid-grant-disabled',
      '13800000023',
      '停用小柚',
    );
    await ctx.sql(`UPDATE biz_staff SET status = 'disabled' WHERE id = ?`, [
      staffId,
    ]);
    const res = await ctx.request(
      'POST',
      `/api/v1/biz/app-staff-grants/${appUserId}/approve`,
    );
    expect(res.status).toBe(409);
    const row = await ctx.sql<{ staff_status: string }[]>(
      `SELECT staff_status FROM app_wx_user WHERE id = ${appUserId}`,
    );
    expect(row[0].staff_status).toBe('pending');
  });

  it('驳回必须填原因；驳回后可重新申请回 pending', async () => {
    const { appUserId, token } = await seedPending(
      'openid-grant-reject',
      '13800000024',
      '驳回小柚',
    );
    const noReason = await ctx.request(
      'POST',
      `/api/v1/biz/app-staff-grants/${appUserId}/reject`,
      { body: { reason: '' } },
    );
    expect(noReason.status).toBe(400);

    const rejected = await ctx.request(
      'POST',
      `/api/v1/biz/app-staff-grants/${appUserId}/reject`,
      { body: { reason: '手机号与档案不符' } },
    );
    expect(rejected.status).toBe(201);
    const row = await ctx.sql<
      { staff_status: string; staff_reject_reason: string | null }[]
    >(
      `SELECT staff_status, staff_reject_reason FROM app_wx_user WHERE id = ${appUserId}`,
    );
    expect(row[0].staff_status).toBe('rejected');
    expect(row[0].staff_reject_reason).toBe('手机号与档案不符');

    // 已驳回不能再被批准（必须走申请端重申，避免店长绕过重申直接开通）
    const approve = await ctx.request(
      'POST',
      `/api/v1/biz/app-staff-grants/${appUserId}/approve`,
    );
    expect(approve.status).toBe(409);

    const reapply = await ctx.request('POST', '/api/v1/app/staff/apply', {
      token,
      body: {},
    });
    expect(reapply.status).toBe(201);
    expect(reapply.body.staffStatus).toBe('pending');
  });

  it('没有 biz:staff:grant 权限 → 拒绝访问', async () => {
    const { appUserId } = await seedPending(
      'openid-grant-noperm',
      '13800000025',
      '无权限小柚',
    );
    const weak = await ctx.token({ permissions: ['biz:staff:list'] });
    const list = await ctx.request('GET', '/api/v1/biz/app-staff-grants', {
      token: weak,
    });
    // 本仓库的口径：权限不足抛 UnauthorizedException（401），不是 403
    expect(list.status).toBe(401);
    const approve = await ctx.request(
      'POST',
      `/api/v1/biz/app-staff-grants/${appUserId}/approve`,
      { token: weak },
    );
    expect(approve.status).toBe(401);
  });
});

describe('B6 美甲师工作台只读面（§12.5 S3）', () => {
  /** 走完整链路开通：档案 → 绑手机号 → 申请 → 店长通过 */
  async function seedGrantedStaff(
    openid: string,
    phone: string,
    nickname: string,
  ) {
    const staff = await ctx.sql<{ insertId: number }>(
      `INSERT INTO biz_staff (nickname, phone, status, sort) VALUES (?, ?, 'active', 1)`,
      [nickname, phone],
    );
    const { appUserId, token } = await seedAppUser(openid);
    await ctx.request('POST', '/api/v1/app/auth/phone', {
      token,
      body: { code: phone },
    });
    const applied = await ctx.request('POST', '/api/v1/app/staff/apply', {
      token,
      body: {},
    });
    expect(applied.status).toBe(201);
    const approved = await ctx.request(
      'POST',
      `/api/v1/biz/app-staff-grants/${appUserId}/approve`,
    );
    expect(approved.status).toBe(201);
    return { staffId: staff.insertId, appUserId, token };
  }

  /** 建一单（建单接口出来就是 confirmed），顺便给该美甲师排上班（可重复调用） */
  async function seedBooking(
    staffId: number,
    customerPhone: string,
    startHour = 10,
  ) {
    const item = await ctx.sql<{ insertId: number }>(
      `INSERT INTO biz_service_item (name, category, duration_minutes, buffer_minutes, price, status, sort)
       VALUES ('法式美甲', '基础', 60, 0, 19900, 'active', 1)`,
    );
    const customer = await ctx.sql<{ insertId: number }>(
      `INSERT INTO biz_customer (name, phone, gender) VALUES ('李女士', ?, 'female')`,
      [customerPhone],
    );
    await ctx.sql(
      `INSERT INTO biz_staff_weekly_shift (staff_id, weekday, start_time, end_time)
       SELECT ?, ?, '09:00:00', '21:00:00' FROM DUAL
       WHERE NOT EXISTS (SELECT 1 FROM biz_staff_weekly_shift WHERE staff_id = ? AND weekday = ?)`,
      [staffId, shopWeekday(date), staffId, shopWeekday(date)],
    );
    const created = await ctx.request('POST', '/api/v1/biz/bookings', {
      body: {
        customerId: customer.insertId,
        staffId,
        startAt: `${date}T${String(startHour).padStart(2, '0')}:00:00+08:00`,
        serviceItemIds: [item.insertId],
        payMode: 'full',
        payments: [{ channel: 'cash', amount: 19900 }],
      },
    });
    expect(created.status).toBe(201);
    return {
      bookingId: Number(created.body.id),
      customerId: customer.insertId,
      serviceItemId: item.insertId,
    };
  }

  it('me：只出本人档案，手机号脱敏，字段集合固定', async () => {
    const me = await seedGrantedStaff('openid-wb-me', '13800000031', '小柚');
    const res = await ctx.request('GET', '/api/v1/app/staff/me', {
      token: me.token,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      staffId: me.staffId,
      nickname: '小柚',
      phone: '138****0031',
      staffStatus: 'active',
    });
    expect(Object.keys(res.body).sort()).toEqual([
      'allowedServiceItemIds',
      'avatar',
      'bio',
      'nickname',
      'phone',
      'staffId',
      'staffStatus',
    ]);
  });

  it('bookings：只出本人的单；别人（含同事）的单一条都看不到', async () => {
    const me = await seedGrantedStaff('openid-wb-list', '13800000032', '小柚');
    const colleague = await ctx.sql<{ insertId: number }>(
      `INSERT INTO biz_staff (nickname, status, sort) VALUES ('同事小美', 'active', 2)`,
    );
    const mine = await seedBooking(me.staffId, '13800000033');
    const others = await seedBooking(colleague.insertId, '13800000034');

    const res = await ctx.request('GET', '/api/v1/app/staff/bookings', {
      token: me.token,
    });
    expect(res.status).toBe(200);
    const ids = itemsOf(res.body).map((row: any) => Number(row.id));
    expect(ids).toContain(mine.bookingId);
    expect(ids).not.toContain(others.bookingId);

    const booking = itemsOf(res.body)[0] as Record<string, unknown>;
    // §12.6：成本 / 内部字段一个都不出去
    for (const key of [
      'customerId',
      'staffId',
      'originalPrice',
      'adjustAmount',
      'adjustReason',
      'depositAmount',
      'payChannelSummary',
      'createdBy',
      'updatedBy',
      'deletedAt',
    ])
      expect(booking[key]).toBeUndefined();
    expect(booking.customerPhoneMasked).toBe('138****0033');
  });

  it('schedule：返回当天生效班次与日期例外', async () => {
    const me = await seedGrantedStaff(
      'openid-wb-schedule',
      '13800000035',
      '小柚',
    );
    await ctx.sql(
      `INSERT INTO biz_staff_weekly_shift (staff_id, weekday, start_time, end_time)
       VALUES (?, ?, '10:00:00', '19:00:00')`,
      [me.staffId, shopWeekday(date)],
    );
    const res = await ctx.request(
      'GET',
      `/api/v1/app/staff/schedule?date=${date}`,
      { token: me.token },
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      date,
      off: false,
      segments: [{ startTime: '10:00:00', endTime: '19:00:00' }],
    });
    expect(res.body.overrides).toEqual([]);
  });

  it('schedule：date 缺失或格式不对 → 400', async () => {
    const me = await seedGrantedStaff(
      'openid-wb-sched-bad',
      '13800000036',
      '小柚',
    );
    const missing = await ctx.request('GET', '/api/v1/app/staff/schedule', {
      token: me.token,
    });
    expect(missing.status).toBe(400);
    const bad = await ctx.request(
      'GET',
      '/api/v1/app/staff/schedule?date=2026/09/11',
      { token: me.token },
    );
    expect(bad.status).toBe(400);
  });

  it('performance：默认当月；同事的单不计进我的业绩', async () => {
    const me = await seedGrantedStaff('openid-wb-perf', '13800000037', '小柚');
    const res = await ctx.request('GET', '/api/v1/app/staff/performance', {
      token: me.token,
    });
    expect(res.status).toBe(200);
    // 服务端按店内时区算当月，端上不传 period 也要有值
    expect(res.body.period).toMatch(/^\d{6}$/);
    expect(res.body.completedCount).toBe(0);
    expect(res.body.commission).toEqual({
      accrued: 0,
      settled: 0,
      reversed: 0,
    });
    expect(res.body.rating).toEqual({ count: 0, average: null });
    expect(res.body.items).toEqual([]);
  });

  it('performance：period 格式错误 → 400', async () => {
    const me = await seedGrantedStaff(
      'openid-wb-perf-bad',
      '13800000038',
      '小柚',
    );
    const res = await ctx.request(
      'GET',
      '/api/v1/app/staff/performance?period=2026-09',
      { token: me.token },
    );
    expect(res.status).toBe(400);
  });

  it('reviews：只出本人已公开评价，隐藏的不给本人看（§20.1）', async () => {
    const me = await seedGrantedStaff(
      'openid-wb-review',
      '13800000039',
      '小柚',
    );
    const colleague = await ctx.sql<{ insertId: number }>(
      `INSERT INTO biz_staff (nickname, status, sort) VALUES ('同事小美', 'active', 2)`,
    );
    const mine = await seedBooking(me.staffId, '13800000040', 10);
    const mineHidden = await seedBooking(me.staffId, '13800000060', 14);
    const others = await seedBooking(colleague.insertId, '13800000041', 10);

    await ctx.sql(
      `INSERT INTO biz_review (booking_id, customer_id, staff_id, score, content, reply, status)
       VALUES (?, ?, ?, 5, '很细心', '谢谢～', 'published'),
              (?, ?, ?, 3, '一般般', NULL, 'hidden'),
              (?, ?, ?, 1, '同事的单', NULL, 'published')`,
      [
        mine.bookingId,
        mine.customerId,
        me.staffId,
        mineHidden.bookingId,
        mineHidden.customerId,
        me.staffId,
        others.bookingId,
        others.customerId,
        colleague.insertId,
      ],
    );

    const res = await ctx.request('GET', '/api/v1/app/staff/reviews', {
      token: me.token,
    });
    expect(res.status).toBe(200);
    const rows = itemsOf(res.body);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      bookingId: mine.bookingId,
      score: 5,
      content: '很细心',
      reply: '谢谢～',
    });
  });

  it('未开通 / 待确认 / 已失效的 app token → 403，一个字段都读不到', async () => {
    // 申请了但店长还没批
    await ctx.sql(
      `INSERT INTO biz_staff (nickname, phone, status, sort) VALUES ('待批小柚', '13800000042', 'active', 1)`,
    );
    const { token: pendingToken } = await seedAppUser('openid-wb-pending');
    await ctx.request('POST', '/api/v1/app/auth/phone', {
      token: pendingToken,
      body: { code: '13800000042' },
    });
    await ctx.request('POST', '/api/v1/app/staff/apply', {
      token: pendingToken,
      body: {},
    });

    // 开通了但档案被停用 → 每请求复查，下次请求立刻失效
    const disabled = await seedGrantedStaff(
      'openid-wb-disabled',
      '13800000043',
      '停用小柚',
    );
    await ctx.sql(`UPDATE biz_staff SET status = 'disabled' WHERE id = ?`, [
      disabled.staffId,
    ]);

    for (const token of [pendingToken, disabled.token]) {
      for (const path of ['me', 'bookings', 'performance', 'reviews']) {
        const res = await ctx.request('GET', `/api/v1/app/staff/${path}`, {
          token,
        });
        expect(res.status, `${path}`).toBe(403);
      }
    }
  });
});

describe('B6 美甲师工作台写操作（§12.5 S4 / money-invariants）', () => {
  async function seedGrantedStaff(
    openid: string,
    phone: string,
    nickname: string,
  ) {
    const staff = await ctx.sql<{ insertId: number }>(
      `INSERT INTO biz_staff (nickname, phone, status, sort) VALUES (?, ?, 'active', 1)`,
      [nickname, phone],
    );
    const { appUserId, token } = await seedAppUser(openid);
    await ctx.request('POST', '/api/v1/app/auth/phone', {
      token,
      body: { code: phone },
    });
    await ctx.request('POST', '/api/v1/app/staff/apply', { token, body: {} });
    const approved = await ctx.request(
      'POST',
      `/api/v1/biz/app-staff-grants/${appUserId}/approve`,
    );
    expect(approved.status).toBe(201);
    return { staffId: staff.insertId, token };
  }

  async function seedBooking(staffId: number, customerPhone: string) {
    const item = await ctx.sql<{ insertId: number }>(
      `INSERT INTO biz_service_item (name, category, duration_minutes, buffer_minutes, price, status, sort)
       VALUES ('法式美甲', '基础', 60, 0, 19900, 'active', 1)`,
    );
    const customer = await ctx.sql<{ insertId: number }>(
      `INSERT INTO biz_customer (name, phone, gender) VALUES ('李女士', ?, 'female')`,
      [customerPhone],
    );
    await ctx.sql(
      `INSERT INTO biz_staff_weekly_shift (staff_id, weekday, start_time, end_time)
       SELECT ?, ?, '09:00:00', '21:00:00' FROM DUAL
       WHERE NOT EXISTS (SELECT 1 FROM biz_staff_weekly_shift WHERE staff_id = ? AND weekday = ?)`,
      [staffId, shopWeekday(date), staffId, shopWeekday(date)],
    );
    const created = await ctx.request('POST', '/api/v1/biz/bookings', {
      body: {
        customerId: customer.insertId,
        staffId,
        startAt: `${date}T10:00:00+08:00`,
        serviceItemIds: [item.insertId],
        payMode: 'full',
        payments: [{ channel: 'cash', amount: 19900 }],
      },
    });
    expect(created.status).toBe(201);
    return Number(created.body.id);
  }

  /**
   * 把单子的服务时间挪到过去（否则完成动作会被 §12.4-3 的时间护栏拦下）。
   *
   * 用 JS 的 Date 传参，不用 MySQL `NOW()`：写入与读取都由 mysql2 按连接时区
   * 做同一套换算，传 `NOW()` 会让两端时区不一致、回读出来的时刻落在未来。
   */
  async function backdate(bookingId: number) {
    const start = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const end = new Date(start.getTime() + 60 * 60 * 1000);
    await ctx.sql(
      `UPDATE biz_booking SET start_at = ?, end_at = ? WHERE id = ?`,
      [start, end, bookingId],
    );
  }

  async function commissionCount(bookingId: number): Promise<number> {
    const rows = await ctx.sql<{ total: number }[]>(
      `SELECT COUNT(*) AS total FROM biz_commission_record WHERE booking_id = ?`,
      [bookingId],
    );
    return Number(rows[0].total);
  }

  it('到店：本单可标记；重复点幂等（changed:false，不报错）', async () => {
    const me = await seedGrantedStaff(
      'openid-wb-arrive',
      '13800000051',
      '小柚',
    );
    const bookingId = await seedBooking(me.staffId, '13800000052');

    const first = await ctx.request(
      'POST',
      `/api/v1/app/staff/bookings/${bookingId}/arrived`,
      { token: me.token },
    );
    expect(first.status).toBe(201);
    expect(first.body.changed).toBe(true);

    const again = await ctx.request(
      'POST',
      `/api/v1/app/staff/bookings/${bookingId}/arrived`,
      { token: me.token },
    );
    expect(again.status).toBe(201);
    expect(again.body.changed).toBe(false);

    const row = await ctx.sql<{ status: string; arrived_at: string | null }[]>(
      `SELECT status, arrived_at FROM biz_booking WHERE id = ${bookingId}`,
    );
    expect(row[0].status).toBe('arrived');
    expect(row[0].arrived_at).not.toBeNull();
  });

  it('到店 / 完成：改别人的单 → 403，且状态一栏不变', async () => {
    const me = await seedGrantedStaff('openid-wb-403', '13800000053', '小柚');
    const colleague = await ctx.sql<{ insertId: number }>(
      `INSERT INTO biz_staff (nickname, status, sort) VALUES ('同事小美', 'active', 2)`,
    );
    const othersBooking = await seedBooking(colleague.insertId, '13800000054');

    for (const action of ['arrived', 'complete']) {
      const res = await ctx.request(
        'POST',
        `/api/v1/app/staff/bookings/${othersBooking}/${action}`,
        { token: me.token },
      );
      expect(res.status, action).toBe(403);
    }
    const row = await ctx.sql<{ status: string }[]>(
      `SELECT status FROM biz_booking WHERE id = ${othersBooking}`,
    );
    expect(row[0].status).toBe('confirmed');
  });

  it('不存在的单 → 404（不泄露「这单是不是别人的」）', async () => {
    const me = await seedGrantedStaff('openid-wb-404', '13800000055', '小柚');
    const res = await ctx.request(
      'POST',
      '/api/v1/app/staff/bookings/999999/arrived',
      { token: me.token },
    );
    expect(res.status).toBe(404);
  });

  it('完成：早于 start_at → 400（§12.4-3 防提前刷提成）', async () => {
    const me = await seedGrantedStaff('openid-wb-guard', '13800000056', '小柚');
    const bookingId = await seedBooking(me.staffId, '13800000057');
    await ctx.request(
      'POST',
      `/api/v1/app/staff/bookings/${bookingId}/arrived`,
      {
        token: me.token,
      },
    );

    const res = await ctx.request(
      'POST',
      `/api/v1/app/staff/bookings/${bookingId}/complete`,
      { token: me.token },
    );
    expect(res.status).toBe(400);

    const row = await ctx.sql<{ status: string }[]>(
      `SELECT status FROM biz_booking WHERE id = ${bookingId}`,
    );
    expect(row[0].status).toBe('arrived');
    expect(await commissionCount(bookingId)).toBe(0);
  });

  it('完成：重复点击只计提一次（money-invariants §4 只追加 + 幂等）', async () => {
    const me = await seedGrantedStaff(
      'openid-wb-complete',
      '13800000058',
      '小柚',
    );
    const bookingId = await seedBooking(me.staffId, '13800000059');
    await ctx.sql(
      `INSERT INTO biz_commission_rule (name, scope, staff_id, permille, base, effective_from, status, sort)
       VALUES ('小柚提成', 'staff', ?, 100, 'paid', '2026-01-01', 'active', 1)`,
      [me.staffId],
    );
    await backdate(bookingId);
    await ctx.request(
      'POST',
      `/api/v1/app/staff/bookings/${bookingId}/arrived`,
      {
        token: me.token,
      },
    );

    const first = await ctx.request(
      'POST',
      `/api/v1/app/staff/bookings/${bookingId}/complete`,
      { token: me.token },
    );
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body.changed).toBe(true);
    expect(await commissionCount(bookingId)).toBe(1);

    // 双击 / 自动重试：状态已经是 completed，直接返回 changed:false，提成不双计
    const again = await ctx.request(
      'POST',
      `/api/v1/app/staff/bookings/${bookingId}/complete`,
      { token: me.token },
    );
    expect(again.status).toBe(201);
    expect(again.body.changed).toBe(false);
    expect(await commissionCount(bookingId)).toBe(1);

    const row = await ctx.sql<{ status: string; finished_at: string | null }[]>(
      `SELECT status, finished_at FROM biz_booking WHERE id = ${bookingId}`,
    );
    expect(row[0].status).toBe('completed');
    expect(row[0].finished_at).not.toBeNull();

    // 业绩立刻能看到这一单
    const perf = await ctx.request('GET', '/api/v1/app/staff/performance', {
      token: me.token,
    });
    expect(perf.status).toBe(200);
    expect(perf.body.completedCount).toBe(1);
    expect(perf.body.items).toHaveLength(1);
    expect(perf.body.items[0]).toMatchObject({
      bookingId,
      amount: 1990, // 19900 × 100‰
      status: 'accrued',
    });
    expect(perf.body.commission.accrued).toBe(1990);
  });
});
