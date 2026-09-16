import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './harness';

let ctx: TestContext;

/**
 * 美甲师的服务门店（连锁直营 · 阶段 1.9）。
 *
 * 口径（与「可做项目」同款）：**空集合 = 可服务全部门店**，勾选后才变成白名单。
 *
 * 三个必须成立的点：
 * 1. 没配门店的美甲师**在哪家店都能约**（否则新上的人会从所有店消失，直接打断营业）；
 * 2. 配了 A 店就**不在 B 店出现**（列表、选人、小程序三处口径一致）；
 * 3. 店长按**可见范围**收窄 —— 他看不到别家店专属的人，也不该能筛别家店（403）。
 *
 * 注意本批**不动排班**：一人一份周模板，「这家店今天谁在」仍由班次决定，
 * 门店归属只回答「这个人能不能在这家店接单」。
 */
beforeAll(async () => {
  ctx = await createTestContext();
}, 120_000);

afterAll(async () => {
  await ctx?.close();
});

async function seedStore(code: string, name: string): Promise<number> {
  const inserted = await ctx.sql<{ insertId: number }>(
    `INSERT INTO sys_store (code, name, sort, is_default, status) VALUES (?, ?, 5, 0, 'active')`,
    [code, name],
  );
  return inserted.insertId;
}

async function mainStoreId(): Promise<number> {
  const rows = await ctx.sql<{ id: number }[]>(
    `SELECT id FROM sys_store WHERE code = 'MAIN'`,
  );
  return rows[0]!.id;
}

/** 建一位美甲师（不配门店 = 全店可用） */
async function seedStaff(nickname: string): Promise<number> {
  const res = await ctx.request('POST', '/api/v1/biz/staffs', {
    body: { nickname },
  });
  expect(res.status).toBe(201);
  return res.body.id as number;
}

function listIds(body: { items: { id: number }[] }): number[] {
  return body.items.map((item) => item.id);
}

/** 店长票：能看美甲师、能维护服务门店（但没有门店档案权限） */
function staffManagerToken(): Promise<string> {
  return ctx.token({
    permissions: ['biz:staff:list', 'biz:staff:stores'],
    roles: [],
  });
}

async function bindUser1(stores: number[]): Promise<void> {
  await ctx.sql(`DELETE FROM sys_user_store WHERE user_id = 1`);
  for (const storeId of stores) {
    await ctx.sql(
      `INSERT INTO sys_user_store (user_id, store_id) VALUES (1, ?)`,
      [storeId],
    );
  }
}

beforeEach(async () => {
  await ctx.resetBusinessData();
  await ctx.sql(
    `INSERT INTO sys_user (id, username, display_name, password_hash, status)
     VALUES (1, 'store-manager', '徐家汇店长', 'x', 'active')
     ON DUPLICATE KEY UPDATE display_name = VALUES(display_name)`,
  );
  await bindUser1([]);
  await ctx.sql(`DELETE FROM sys_store WHERE code <> 'MAIN'`);
  await ctx.sql(
    `UPDATE sys_store SET is_default = 1, status = 'active', deleted_at = NULL WHERE code = 'MAIN'`,
  );
});

describe('美甲师的服务门店：空 = 全部门店，配了才收窄', () => {
  it('未配门店 → 每家店都能看到；配了 A 店 → B 店看不到了', async () => {
    const storeA = await mainStoreId();
    const storeB = await seedStore('XJH', '徐家汇店');
    const staffId = await seedStaff('小美');

    // 不筛门店：能看到，且 `stores` 是空数组（= 全部门店）
    const all = await ctx.request(
      'GET',
      '/api/v1/biz/staffs?page=1&pageSize=20',
      {},
    );
    expect(listIds(all.body)).toContain(staffId);
    expect(
      all.body.items.find((item: { id: number }) => item.id === staffId).stores,
    ).toEqual([]);

    // 空 = 全部门店：A、B 两家店都看得到
    for (const storeId of [storeA, storeB]) {
      const scoped = await ctx.request(
        'GET',
        `/api/v1/biz/staffs?page=1&pageSize=20&storeId=${storeId}`,
        {},
      );
      expect(listIds(scoped.body)).toContain(staffId);
    }

    // 配到 A 店（整体替换）→ 回填能拿到名称
    const set = await ctx.request(
      'PUT',
      `/api/v1/biz/staffs/${staffId}/stores`,
      { body: { storeIds: [storeA] } },
    );
    expect(set.status).toBe(200);
    const back = await ctx.request(
      'GET',
      `/api/v1/biz/staffs/${staffId}/stores`,
      {},
    );
    expect(back.status).toBe(200);
    expect(back.body.map((row: { id: number }) => row.id)).toEqual([storeA]);
    expect(typeof back.body[0].name).toBe('string');

    // A 店还在，**B 店没了**（这就是「按门店划分」的核心效果）
    const inA = await ctx.request(
      'GET',
      `/api/v1/biz/staffs?page=1&pageSize=20&storeId=${storeA}`,
      {},
    );
    expect(listIds(inA.body)).toContain(staffId);
    const inB = await ctx.request(
      'GET',
      `/api/v1/biz/staffs?page=1&pageSize=20&storeId=${storeB}`,
      {},
    );
    expect(listIds(inB.body)).not.toContain(staffId);

    // 列表里也带出了门店（前端「服务门店」列直接渲染）
    const withStore = inA.body.items.find(
      (item: { id: number }) => item.id === staffId,
    );
    expect(withStore.stores.map((row: { id: number }) => row.id)).toEqual([
      storeA,
    ]);
  });

  it('店长按可见范围收窄：看不到别店专属的人，筛别家店 403', async () => {
    const storeA = await mainStoreId();
    const storeB = await seedStore('XJH', '徐家汇店');
    const onlyA = await seedStaff('只服务A店');
    const anyone = await seedStaff('哪家店都行');

    await ctx.request('PUT', `/api/v1/biz/staffs/${onlyA}/stores`, {
      body: { storeIds: [storeA] },
    });
    await bindUser1([storeB]);

    // 店长不传参数 → 按可见范围（B 店）：别店专属的人看不到，「哪家店都行」看得到
    const manager = await ctx.request(
      'GET',
      '/api/v1/biz/staffs?page=1&pageSize=20',
      { token: await staffManagerToken() },
    );
    expect(manager.status).toBe(200);
    expect(listIds(manager.body)).not.toContain(onlyA);
    expect(listIds(manager.body)).toContain(anyone);

    // 显式筛别人的门店 → 403（与预约/收款列表同一口径）
    const denied = await ctx.request(
      'GET',
      `/api/v1/biz/staffs?page=1&pageSize=20&storeId=${storeA}`,
      { token: await staffManagerToken() },
    );
    expect(denied.status).toBe(403);

    // 跨店支援：把 alsoA 也勾到 B 店 → 两位店长都能看到他
    const shared = await seedStaff('两地支援');
    await ctx.request('PUT', `/api/v1/biz/staffs/${shared}/stores`, {
      body: { storeIds: [storeA, storeB] },
    });
    const managerAgain = await ctx.request(
      'GET',
      '/api/v1/biz/staffs?page=1&pageSize=20',
      { token: await staffManagerToken() },
    );
    expect(listIds(managerAgain.body)).toContain(shared);
  });

  it('小程序（还没选店）按默认门店收窄', async () => {
    await mainStoreId(); // MAIN 就是默认门店（beforeEach 里已重置）
    const storeB = await seedStore('XJH', '徐家汇店');
    const onlyB = await seedStaff('只服务B店');
    const anyone = await seedStaff('哪家店都行');
    await ctx.request('PUT', `/api/v1/biz/staffs/${onlyB}/stores`, {
      body: { storeIds: [storeB] },
    });

    const app = await ctx.request(
      'GET',
      '/api/v1/app/staffs?page=1&pageSize=50',
      {
        token: await ctx.appToken('openid-staff-store', 1),
      },
    );
    expect(app.status).toBe(200);
    const ids = listIds(app.body);
    expect(ids).not.toContain(onlyB); // A 店（默认门店）约不到只服务 B 店的人
    expect(ids).toContain(anyone);
  });

  it('配置校验：门店不存在 / 已停用 → 400；空数组恢复「全部门店」', async () => {
    const storeA = await mainStoreId();
    const storeB = await seedStore('XJH', '徐家汇店');
    const staffId = await seedStaff('小美');

    const missing = await ctx.request(
      'PUT',
      `/api/v1/biz/staffs/${staffId}/stores`,
      { body: { storeIds: [999_999] } },
    );
    expect(missing.status).toBe(400);
    expect(missing.body.message).toContain('不存在');

    await ctx.sql(`UPDATE sys_store SET status = 'disabled' WHERE id = ?`, [
      storeB,
    ]);
    const disabled = await ctx.request(
      'PUT',
      `/api/v1/biz/staffs/${staffId}/stores`,
      { body: { storeIds: [storeB] } },
    );
    expect(disabled.status).toBe(400);
    expect(disabled.body.message).toContain('停用');

    // 先配 A，再清空 → 回到「全部门店」：B 店又能看到了
    await ctx.request('PUT', `/api/v1/biz/staffs/${staffId}/stores`, {
      body: { storeIds: [storeA] },
    });
    await ctx.request('PUT', `/api/v1/biz/staffs/${staffId}/stores`, {
      body: { storeIds: [] },
    });
    const cleared = await ctx.request(
      'GET',
      `/api/v1/biz/staffs/${staffId}/stores`,
      {},
    );
    expect(cleared.body).toEqual([]);
    await ctx.sql(`UPDATE sys_store SET status = 'active' WHERE id = ?`, [
      storeB,
    ]);
    const inB = await ctx.request(
      'GET',
      `/api/v1/biz/staffs?page=1&pageSize=20&storeId=${storeB}`,
      {},
    );
    expect(listIds(inB.body)).toContain(staffId);
  });
});
