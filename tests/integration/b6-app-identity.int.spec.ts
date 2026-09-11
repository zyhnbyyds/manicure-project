/**
 * B6 小程序身份：登录幂等、手机号绑定、美甲师工作台**候选**（不自动开通）。
 *
 * 这一组用例是新需求「美甲师登录看自己的预约与业绩」的**安全底线**：
 * 开通只能由店长在后台确认，app 域任何入参都不允许把 `staff_status` 顶成 `active`。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, itemsOf, type TestContext } from './harness.js';

let ctx: TestContext;

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
});

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
