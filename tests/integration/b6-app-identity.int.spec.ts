/**
 * B6 小程序身份：登录幂等、手机号绑定、美甲师工作台**候选**（不自动开通）。
 *
 * 这一组用例是新需求「美甲师登录看自己的预约与业绩」的**安全底线**：
 * 开通只能由店长在后台确认，app 域任何入参都不允许把 `staff_status` 顶成 `active`。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './harness.js';

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
