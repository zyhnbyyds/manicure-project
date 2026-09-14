import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './harness.js';

let ctx: TestContext;

/**
 * 门店档案（连锁直营 · 阶段 0）。
 *
 * 这一批只把「门店」变成实体，**不改任何业务表语义**，所以用例盯三件事：
 * 1. 门店表在业务数据 reset 之后仍在（它是 `sys_*`，不是业务数据）；
 * 2. 后台 CRUD 的规则：编码唯一、第一条自动成为默认、默认唯一、默认门店不可删；
 * 3. 小程序 `GET /app/shop` 以门店为准，门店字段为空时回落 `biz.shop.*` 配置。
 *
 * ⚠️ `resetBusinessData()` 清 `biz_*` / `app_*`，**不动 `sys_*`** ——
 * 所以门店数据要自己在 `beforeEach` 里清（否则用例互相污染）。
 */
beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.close();
});

/** 每个用例从「只有迁移建的默认门店」这个干净状态开始 */
beforeEach(async () => {
  /**
   * 先解绑再删门店：`sys_user_store` 到门店是外键（级联），但**用例之间共享同一个库**，
   * `b9` 会把 user 1 绑到临时门店上 —— 不清干净就会撞 1451（删除被引用的父行）。
   */
  await ctx.sql(`DELETE FROM sys_user_store`);
  await ctx.sql(`DELETE FROM sys_store WHERE code <> 'MAIN'`);
  await ctx.sql(
    `UPDATE sys_store SET name = '美甲小铺', phone = '13800000000',
       address = '上海市静安区南京西路 1788 号 3 楼 355 室', hours = '10:00 - 20:00',
       latitude = 31.229, longitude = 121.455, notice = NULL, is_default = 1, status = 'active',
       deleted_at = NULL
     WHERE code = 'MAIN'`,
  );
});

/** 造一个 app 身份并签发 token（`/app/shop` 只要求 app token，不要求绑定手机号） */
async function seedAppToken(openid: string): Promise<string> {
  const inserted = await ctx.sql<{ insertId: number }>(
    `INSERT INTO app_wx_user (openid, customer_id, staff_status) VALUES (?, NULL, 'none')`,
    [openid],
  );
  return ctx.appToken(openid, inserted.insertId);
}

describe('门店档案 CRUD /stores', () => {
  it('新建门店：第二条不会抢走默认；编码重复 400', async () => {
    const created = await ctx.request('POST', '/api/v1/stores', {
      body: { code: 'XJH', name: '徐家汇店', phone: '021-60000000', sort: 2 },
    });
    expect(created.status).toBe(201);
    const id = created.body.id as number;

    // 默认门店仍是 MAIN（第一条自动默认那条规则只对「一条都没有」时生效）
    const [main] = await ctx.sql<{ is_default: number }[]>(
      `SELECT is_default FROM sys_store WHERE code = 'MAIN'`,
    );
    expect(Number(main!.is_default)).toBe(1);
    const [newStore] = await ctx.sql<{ is_default: number }[]>(
      `SELECT is_default FROM sys_store WHERE id = ?`,
      [id],
    );
    expect(Number(newStore!.is_default)).toBe(0);

    const dup = await ctx.request('POST', '/api/v1/stores', {
      body: { code: 'XJH', name: '重复编码店' },
    });
    expect(dup.status).toBe(400);
    expect(dup.body.message).toContain('已被占用');
  });

  it('设为默认：旧默认被清掉，同一时刻只有一个默认门店', async () => {
    const created = await ctx.request('POST', '/api/v1/stores', {
      body: { code: 'XJH', name: '徐家汇店' },
    });
    const id = created.body.id as number;

    const set = await ctx.request('POST', `/api/v1/stores/${id}/default`, {});
    expect(set.status).toBe(200);

    const defaults = await ctx.sql<{ id: number; code: string }[]>(
      `SELECT id, code FROM sys_store WHERE is_default = 1`,
    );
    expect(defaults).toHaveLength(1);
    expect(Number(defaults[0]!.id)).toBe(id);
  });

  it('默认门店不允许删除（删了就没有兜底门店）', async () => {
    const [main] = await ctx.sql<{ id: number }[]>(
      `SELECT id FROM sys_store WHERE code = 'MAIN'`,
    );
    const res = await ctx.request('DELETE', `/api/v1/stores/${main!.id}`, {});
    expect(res.status).toBe(409);
    expect(res.body.message).toContain('默认门店');
  });

  it('停用的门店不作为默认；启用的其它门店顶上', async () => {
    const token = await seedAppToken('openid-store-disabled');
    await ctx.sql(
      `INSERT INTO sys_store (code, name, status, sort, is_default) VALUES ('DIS', '停用店', 'disabled', 1, 0)`,
    );
    // 把 MAIN 停用且取消默认 → 没有可用默认门店
    await ctx.sql(
      `UPDATE sys_store SET status = 'disabled', is_default = 0 WHERE code = 'MAIN'`,
    );
    const app = await ctx.request('GET', '/api/v1/app/shop', { token });
    // 一条启用门店都没有 → 回落配置，但不是报错
    expect(app.status).toBe(200);
    expect(app.body.storeId).toBeNull();
    expect(app.body.name).toBeTruthy();
  });

  it('门店图集：顺序即展示顺序、最多 5 张、不传 = 不改、空数组 = 清空', async () => {
    const images = ['/files/3.png', '/files/1.png', '/files/2.png'];
    const created = await ctx.request('POST', '/api/v1/stores', {
      body: { code: 'IMG', name: '图集店', images },
    });
    expect(created.status).toBe(201);
    const id = created.body.id as number;

    // 没有 `GET /stores/:id`，走列表接口回读
    const readImages = async (): Promise<unknown> => {
      const list = await ctx.request(
        'GET',
        '/api/v1/stores?page=1&pageSize=50',
        {},
      );
      const found = list.body.items.find(
        (item: { id: number }) => item.id === id,
      );
      // 注意别写成 `found?.images ?? 'NOT_FOUND'` —— 清空后 images 就是 null，
      // 那样会把「已清空」误判成「没找到」。
      if (!found) return 'NOT_FOUND';
      return found.images;
    };

    // 顺序即展示顺序（**不去排序**：第一张就是封面）
    expect(await readImages()).toEqual(images);

    // 超过 5 张 → 400（zod 的 `.max(5)`；前端 `limit` 只是体验，闸门在后端）
    const tooMany = await ctx.request('PATCH', `/api/v1/stores/${id}`, {
      body: { images: Array.from({ length: 6 }, (_, i) => `/files/${i}.png`) },
    });
    expect(tooMany.status).toBe(400);

    // 不传 `images` = 本次不改图集（改个名字不该把图弄丢）
    const renamed = await ctx.request('PATCH', `/api/v1/stores/${id}`, {
      body: { name: '图集店（改名）' },
    });
    expect(renamed.status).toBe(200);
    expect(await readImages()).toEqual(images);

    // 空数组 = 清空 → 归一成 NULL（库里只允许 NULL / 非空数组两种形态）
    await ctx.request('PATCH', `/api/v1/stores/${id}`, {
      body: { images: [] },
    });
    expect(await readImages()).toBeNull();
    const [row] = await ctx.sql<{ images: unknown }[]>(
      `SELECT images FROM sys_store WHERE id = ?`,
      [id],
    );
    expect(row!.images).toBeNull();
  });
});

describe('小程序门店档案 GET /app/shop 以门店为准', () => {
  it('门店字段覆盖配置；门店为空的字段回落配置', async () => {
    const token = await seedAppToken('openid-store-1');
    await ctx.sql(
      `UPDATE sys_store SET name = '徐家汇旗舰店', address = '漕溪北路 100 号',
         phone = NULL, notice = '本周六休息' WHERE code = 'MAIN'`,
    );
    ctx.app
      .get(
        (await import('../../src/modules/biz/common/biz-config.service.js'))
          .BizConfigService,
      )
      .invalidate();

    const res = await ctx.request('GET', '/api/v1/app/shop', { token });
    expect(res.status).toBe(200);
    // 门店有值 → 用门店的
    expect(res.body.name).toBe('徐家汇旗舰店');
    expect(res.body.address).toBe('漕溪北路 100 号');
    expect(res.body.notice).toBe('本周六休息');
    expect(res.body.storeCode).toBe('MAIN');
    expect(res.body.storeId).toBeGreaterThan(0);
    // 门店为 null → 回落 `biz.shop.*`，小程序不会拿到空值
    expect(res.body.phone).toBeTruthy();
    expect(res.body.hours).toBeTruthy();
  });

  it('门店表为空（老库还没建门店）时整份回落配置，不报错', async () => {
    const token = await seedAppToken('openid-store-2');
    await ctx.sql(`UPDATE sys_store SET deleted_at = NOW()`);
    ctx.app
      .get(
        (await import('../../src/modules/biz/common/biz-config.service.js'))
          .BizConfigService,
      )
      .invalidate();

    const res = await ctx.request('GET', '/api/v1/app/shop', { token });
    expect(res.status).toBe(200);
    expect(res.body.storeId).toBeNull();
    expect(res.body.name).toBeTruthy();
    expect(res.body.address).toBeTruthy();

    await ctx.sql(`UPDATE sys_store SET deleted_at = NULL`);
  });
});

describe('用户可见门店授权 /system/users/:id/stores', () => {
  /** 造一个后台账号（授权对象）；用户名带随机串，避免与残留数据撞 `uq_user_username` */
  async function seedUser(username: string): Promise<number> {
    const unique = `${username}-${Date.now()}${Math.floor(Math.random() * 1000)}`;
    const inserted = await ctx.sql<{ insertId: number }>(
      `INSERT INTO sys_user (username, display_name, password_hash, status)
       VALUES (?, ?, 'x', 'active')`,
      [unique, username],
    );
    return inserted.insertId;
  }

  it('设置与回填：整体替换、列表带上门店、取消全部授权', async () => {
    const storeB = await ctx.request('POST', '/api/v1/stores', {
      body: { code: 'XJH', name: '徐家汇店' },
    });
    const storeId = storeB.body.id as number;
    const userId = await seedUser('store-manager');

    const set = await ctx.request(
      'PUT',
      `/api/v1/system/users/${userId}/stores`,
      {
        body: { storeIds: [storeId] },
      },
    );
    expect(set.status).toBe(200);

    const read = await ctx.request(
      'GET',
      `/api/v1/system/users/${userId}/stores`,
      {},
    );
    expect(read.status).toBe(200);
    expect(read.body.storeIds).toEqual([storeId]);

    // 列表里带上门店名（前端「可见门店」列不用逐行查）
    const list = await ctx.request(
      'GET',
      '/api/v1/system/users?page=1&pageSize=50',
      {},
    );
    const row = list.body.items.find(
      (item: { id: number }) => item.id === userId,
    );
    expect(row.stores).toEqual([{ id: storeId, name: '徐家汇店' }]);

    // 空数组 = 取消全部授权
    await ctx.request('PUT', `/api/v1/system/users/${userId}/stores`, {
      body: { storeIds: [] },
    });
    const cleared = await ctx.request(
      'GET',
      `/api/v1/system/users/${userId}/stores`,
      {},
    );
    expect(cleared.body.storeIds).toEqual([]);
  });

  it('门店不存在或已停用 → 404；用户不存在 → 404', async () => {
    const userId = await seedUser('store-manager-2');
    const missing = await ctx.request(
      'PUT',
      `/api/v1/system/users/${userId}/stores`,
      { body: { storeIds: [999999] } },
    );
    expect(missing.status).toBe(404);
    expect(missing.body.message).toContain('门店不存在或已停用');

    await ctx.sql(
      `UPDATE sys_store SET status = 'disabled' WHERE code = 'MAIN'`,
    );
    const [main] = await ctx.sql<{ id: number }[]>(
      `SELECT id FROM sys_store WHERE code = 'MAIN'`,
    );
    const disabled = await ctx.request(
      'PUT',
      `/api/v1/system/users/${userId}/stores`,
      { body: { storeIds: [main!.id] } },
    );
    expect(disabled.status).toBe(404);

    const ghost = await ctx.request(
      'PUT',
      `/api/v1/system/users/999999/stores`,
      { body: { storeIds: [] } },
    );
    expect(ghost.status).toBe(404);
  });
});
