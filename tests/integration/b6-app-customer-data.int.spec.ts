/**
 * app 域「顾客自助数据」：收货地址（batch4 设计稿）。
 *
 * 这组用例盯的是**归属与默认地址**两件事 —— 它们出错时不会报错，只会静默地给出错的答案：
 * - 归属：写接口只认 token，别人的地址 id 必须 404（不是 403，403 等于确认「这个 id 存在」）；
 * - 默认地址：同顾客最多一个。删掉默认后必须有新的顶上 ——
 *   「有地址但没有默认」是下游没人能处理的状态（下单时选谁？）。
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

async function seedCustomer(name: string, phone: string): Promise<number> {
  const inserted = await ctx.sql<{ insertId: number }>(
    `INSERT INTO biz_customer (name, phone) VALUES (?, ?)`,
    [name, phone],
  );
  return inserted.insertId;
}

const BODY = {
  contactName: '王女士',
  contactPhone: '13800008888',
  province: '上海市',
  city: '上海市',
  district: '静安区',
  detail: '南京西路1788号3楼355室',
};

/** 造一个款式（可指定上/下架、软删，用来验「收藏夹只出在架的」） */
async function seedServiceItem(
  name: string,
  options: { status?: 'active' | 'disabled'; deleted?: boolean } = {},
): Promise<number> {
  const inserted = await ctx.sql<{ insertId: number }>(
    `INSERT INTO biz_service_item (name, category, duration_minutes, price, description, status, deleted_at)
     VALUES (?, '款式设计', 90, 16800, '测试款式', ?, ?)`,
    [name, options.status ?? 'active', options.deleted ? new Date() : null],
  );
  return inserted.insertId;
}

describe('B6 收货地址 /app/member/addresses', () => {
  it('新增：第一个地址自动成为默认；列表按「默认优先 + 新的在前」排序', async () => {
    const customerId = await seedCustomer('王女士', '13800008801');
    const { token } = await seedBoundAppUser('openid-addr-1', customerId);

    const empty = await ctx.request('GET', '/api/v1/app/member/addresses', {
      token,
    });
    expect(empty.status).toBe(200);
    expect(empty.body.items).toEqual([]);

    const first = await ctx.request('POST', '/api/v1/app/member/addresses', {
      token,
      body: BODY,
    });
    expect(first.status).toBe(200);
    // 第一个地址必须自动成为默认：否则「没有默认地址」要靠前端兜底，很容易漏
    expect(first.body.isDefault).toBe(true);
    expect(first.body.contactName).toBe('王女士');
    expect(first.body.detail).toBe('南京西路1788号3楼355室');
    // 字段集合固定：不许把 customer_id / created_by 这类内部字段吐给 C 端
    expect(Object.keys(first.body).sort()).toEqual(
      [
        'city',
        'contactName',
        'contactPhone',
        'detail',
        'district',
        'id',
        'isDefault',
        'province',
      ].sort(),
    );

    const second = await ctx.request('POST', '/api/v1/app/member/addresses', {
      token,
      body: { ...BODY, contactName: '李先生', detail: '淮海路880号' },
    });
    expect(second.status).toBe(200);
    expect(second.body.isDefault).toBe(false);

    const list = await ctx.request('GET', '/api/v1/app/member/addresses', {
      token,
    });
    expect(
      list.body.items.map((item: { contactName: string }) => item.contactName),
    ).toEqual(['王女士', '李先生']);
    // 列表项也是同一套字段（不能列表少字段、详情多字段）
    expect(Object.keys(list.body.items[0]).sort()).toEqual(
      Object.keys(first.body).sort(),
    );
  });

  it('默认地址唯一：设默认会清掉旧的；删掉默认后剩下最新的顶上', async () => {
    const customerId = await seedCustomer('王女士', '13800008802');
    const { token } = await seedBoundAppUser('openid-addr-2', customerId);

    const a = await ctx.request('POST', '/api/v1/app/member/addresses', {
      token,
      body: { ...BODY, contactName: 'A' },
    });
    const b = await ctx.request('POST', '/api/v1/app/member/addresses', {
      token,
      body: { ...BODY, contactName: 'B' },
    });
    expect(a.body.isDefault).toBe(true);
    expect(b.body.isDefault).toBe(false);

    // 把 B 设为默认 → A 必须不再是默认（同一事务里清的）
    const setB = await ctx.request(
      'POST',
      `/api/v1/app/member/addresses/${b.body.id}/default`,
      { token },
    );
    expect(setB.status).toBe(200);
    expect(setB.body.isDefault).toBe(true);

    const afterSet = await ctx.request('GET', '/api/v1/app/member/addresses', {
      token,
    });
    const defaults = afterSet.body.items.filter(
      (item: { isDefault: boolean }) => item.isDefault,
    );
    expect(defaults).toHaveLength(1);
    expect(defaults[0].contactName).toBe('B');

    // 删掉默认地址 B → A 顶上（绝不会出现「有地址但没默认」）
    const removed = await ctx.request(
      'POST',
      `/api/v1/app/member/addresses/${b.body.id}/delete`,
      { token },
    );
    expect(removed.status).toBe(200);

    const afterRemove = await ctx.request(
      'GET',
      '/api/v1/app/member/addresses',
      { token },
    );
    expect(afterRemove.body.items).toHaveLength(1);
    expect(afterRemove.body.items[0].contactName).toBe('A');
    expect(afterRemove.body.items[0].isDefault).toBe(true);
  });

  it('编辑：全量覆盖；不传 isDefault 时保持原默认状态', async () => {
    const customerId = await seedCustomer('王女士', '13800008803');
    const { token } = await seedBoundAppUser('openid-addr-3', customerId);

    const created = await ctx.request('POST', '/api/v1/app/member/addresses', {
      token,
      body: BODY,
    });
    const id = created.body.id;

    const updated = await ctx.request(
      'POST',
      `/api/v1/app/member/addresses/${id}/update`,
      {
        token,
        body: { ...BODY, contactName: '张女士', detail: '陆家嘴环路1000号' },
      },
    );
    expect(updated.status).toBe(200);
    expect(updated.body.contactName).toBe('张女士');
    expect(updated.body.detail).toBe('陆家嘴环路1000号');
    // 编辑时没提默认 → 它还是默认（不该被悄悄降级）
    expect(updated.body.isDefault).toBe(true);
  });

  it('越权：别人的地址一律 404；不能把别人的地址设成自己的默认', async () => {
    const mineId = await seedCustomer('我', '13800008804');
    const otherId = await seedCustomer('别人', '13800008805');
    const mine = await seedBoundAppUser('openid-addr-4a', mineId);
    const other = await seedBoundAppUser('openid-addr-4b', otherId);

    const mineAddress = await ctx.request(
      'POST',
      '/api/v1/app/member/addresses',
      { token: mine.token, body: { ...BODY, contactName: '我的' } },
    );
    const otherAddress = await ctx.request(
      'POST',
      '/api/v1/app/member/addresses',
      { token: other.token, body: { ...BODY, contactName: '别人的' } },
    );

    for (const path of [
      `/api/v1/app/member/addresses/${otherAddress.body.id}/update`,
      `/api/v1/app/member/addresses/${otherAddress.body.id}/default`,
      `/api/v1/app/member/addresses/${otherAddress.body.id}/delete`,
    ]) {
      const response = await ctx.request('POST', path, {
        token: mine.token,
        body: { ...BODY, contactName: '想改别人的' },
      });
      // 404 而不是 403：403 等于告诉对方「这个 id 存在」
      expect(response.status, path).toBe(404);
    }

    // 别人的地址一个字都没变，我的默认也没被抢走
    const otherList = await ctx.request('GET', '/api/v1/app/member/addresses', {
      token: other.token,
    });
    expect(otherList.body.items).toHaveLength(1);
    expect(otherList.body.items[0].contactName).toBe('别人的');
    expect(otherList.body.items[0].isDefault).toBe(true);

    const mineList = await ctx.request('GET', '/api/v1/app/member/addresses', {
      token: mine.token,
    });
    expect(mineList.body.items[0].contactName).toBe('我的');
    expect(mineList.body.items[0].id).toBe(mineAddress.body.id);
  });

  it('入参：白名单外字段 400；电话宽松校验（座机可以，乱码不行）；上限 10 条', async () => {
    const customerId = await seedCustomer('王女士', '13800008806');
    const { token } = await seedBoundAppUser('openid-addr-5', customerId);

    // 归属由 token 决定，传 customerId 只会被拒（.strict()）
    for (const body of [
      { ...BODY, customerId: 999 },
      { ...BODY, id: 1 },
      { ...BODY, isDefaultText: '是' },
      { ...BODY, contactPhone: '打不通' },
      { ...BODY, contactName: '' },
      { ...BODY, detail: '短' },
    ]) {
      const response = await ctx.request(
        'POST',
        '/api/v1/app/member/addresses',
        {
          token,
          body,
        },
      );
      expect(response.status, JSON.stringify(body)).toBe(400);
    }

    // 座机 / 带分隔符的电话要能存（收货人可能是家人或前台）
    const landline = await ctx.request('POST', '/api/v1/app/member/addresses', {
      token,
      body: { ...BODY, contactPhone: '021-6288-8888' },
    });
    expect(landline.status).toBe(200);
    expect(landline.body.contactPhone).toBe('021-6288-8888');

    // 上限：再补到 10 条，第 11 条被拒
    for (let i = 0; i < 9; i += 1) {
      const response = await ctx.request(
        'POST',
        '/api/v1/app/member/addresses',
        { token, body: { ...BODY, detail: `某某路${i + 1}号` } },
      );
      expect(response.status).toBe(200);
    }
    const overflow = await ctx.request('POST', '/api/v1/app/member/addresses', {
      token,
      body: { ...BODY, detail: '第 11 条' },
    });
    expect(overflow.status).toBe(400);
    expect(overflow.body.message).toContain('10');
  });

  it('未绑定手机号 → 400 + needBind（地址是个人数据，不是公开目录）', async () => {
    const { token } = await seedBoundAppUser('openid-addr-6', null);

    const list = await ctx.request('GET', '/api/v1/app/member/addresses', {
      token,
    });
    expect(list.status).toBe(400);
    expect(list.body.needBind).toBe(true);

    const create = await ctx.request('POST', '/api/v1/app/member/addresses', {
      token,
      body: BODY,
    });
    expect(create.status).toBe(400);
    expect(create.body.needBind).toBe(true);
    // 一条都不许落库
    const rows = await ctx.sql<{ total: number }[]>(
      `SELECT COUNT(*) AS total FROM biz_customer_address`,
    );
    expect(Number(rows[0].total)).toBe(0);
  });
});

describe('B6 款式收藏 /app/member/favorites', () => {
  it('收藏 → 出现在列表（卡面字段齐全）；取消 → 消失；重复收藏/重复取消都不报错', async () => {
    const customerId = await seedCustomer('李女士', '13800008811');
    const { token } = await seedBoundAppUser('openid-fav-1', customerId);
    const itemId = await seedServiceItem('单色经典甲油胶');

    const empty = await ctx.request('GET', '/api/v1/app/member/favorites', {
      token,
    });
    expect(empty.status).toBe(200);
    expect(empty.body.items).toEqual([]);

    const added = await ctx.request(
      'POST',
      `/api/v1/app/member/favorites/${itemId}`,
      { token },
    );
    expect(added.status).toBe(200);
    // 返回「目标状态」而不是「成功」两个字：前端据此改心形图标
    expect(added.body).toEqual({ serviceItemId: itemId, favorited: true });

    // 重复收藏：幂等，不报错也不插第二行
    const again = await ctx.request(
      'POST',
      `/api/v1/app/member/favorites/${itemId}`,
      { token },
    );
    expect(again.status).toBe(200);
    const rows = await ctx.sql<{ total: number }[]>(
      `SELECT COUNT(*) AS total FROM biz_customer_favorite WHERE deleted_at IS NULL`,
    );
    expect(Number(rows[0].total)).toBe(1);

    const list = await ctx.request('GET', '/api/v1/app/member/favorites', {
      token,
    });
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0].id).toBe(itemId);
    expect(list.body.items[0].name).toBe('单色经典甲油胶');
    expect(list.body.items[0].price).toBe(16800);
    expect(list.body.items[0].durationMinutes).toBe(90);
    // 字段集合固定：不许把成本 / created_by 这类内部字段吐出来
    expect(Object.keys(list.body.items[0]).sort()).toEqual(
      [
        'category',
        'description',
        'durationMinutes',
        'favoritedAt',
        'id',
        'image',
        'name',
        'price',
      ].sort(),
    );

    const removed = await ctx.request(
      'POST',
      `/api/v1/app/member/favorites/${itemId}/delete`,
      { token },
    );
    expect(removed.status).toBe(200);
    expect(removed.body).toEqual({ serviceItemId: itemId, favorited: false });

    const afterRemove = await ctx.request(
      'GET',
      '/api/v1/app/member/favorites',
      { token },
    );
    expect(afterRemove.body.items).toEqual([]);

    // 没收藏过再取消也算成功（幂等）
    const removeAgain = await ctx.request(
      'POST',
      `/api/v1/app/member/favorites/${itemId}/delete`,
      { token },
    );
    expect(removeAgain.status).toBe(200);
  });

  it('取消后再收藏走「恢复」而不是插新行（唯一索引 + 软删的坑）', async () => {
    const customerId = await seedCustomer('李女士', '13800008812');
    const { token } = await seedBoundAppUser('openid-fav-2', customerId);
    const itemId = await seedServiceItem('法式浪漫');

    await ctx.request('POST', `/api/v1/app/member/favorites/${itemId}`, {
      token,
    });
    await ctx.request('POST', `/api/v1/app/member/favorites/${itemId}/delete`, {
      token,
    });
    const back = await ctx.request(
      'POST',
      `/api/v1/app/member/favorites/${itemId}`,
      { token },
    );
    expect(back.status).toBe(200);

    // 关键：整张表里始终只有一行（软删行被复用），不会撞 uq_customer_favorite
    const rows = await ctx.sql<{ total: number; alive: number }[]>(
      `SELECT COUNT(*) AS total,
              SUM(deleted_at IS NULL) AS alive
         FROM biz_customer_favorite`,
    );
    expect(Number(rows[0].total)).toBe(1);
    expect(Number(rows[0].alive)).toBe(1);

    const list = await ctx.request('GET', '/api/v1/app/member/favorites', {
      token,
    });
    expect(list.body.items).toHaveLength(1);
  });

  it('收藏夹只出在架款式：下架 / 软删的款式不出现，重新上架后自动回来', async () => {
    const customerId = await seedCustomer('李女士', '13800008813');
    const { token } = await seedBoundAppUser('openid-fav-3', customerId);
    const onSale = await seedServiceItem('在架款');
    const disabled = await seedServiceItem('下架款');
    const deleted = await seedServiceItem('已删款');

    for (const id of [onSale, disabled, deleted]) {
      await ctx.request('POST', `/api/v1/app/member/favorites/${id}`, {
        token,
      });
    }
    // 下架与软删发生在这之后（先收藏再下架，是真实顺序）
    await ctx.sql(
      `UPDATE biz_service_item SET status = 'disabled' WHERE id = ?`,
      [disabled],
    );
    await ctx.sql(
      `UPDATE biz_service_item SET deleted_at = NOW() WHERE id = ?`,
      [deleted],
    );

    const list = await ctx.request('GET', '/api/v1/app/member/favorites', {
      token,
    });
    expect(list.body.items.map((item: { name: string }) => item.name)).toEqual([
      '在架款',
    ]);

    // 重新上架 → 收藏行还在，收藏自然回来
    await ctx.sql(
      `UPDATE biz_service_item SET status = 'active' WHERE id = ?`,
      [disabled],
    );
    const again = await ctx.request('GET', '/api/v1/app/member/favorites', {
      token,
    });
    expect(
      again.body.items.map((item: { name: string }) => item.name).sort(),
    ).toEqual(['在架款', '下架款'].sort());
  });

  it('越权：只看到自己的收藏；收藏不存在/已下架的款式 → 404，且一行都不落', async () => {
    const mineId = await seedCustomer('我', '13800008814');
    const otherId = await seedCustomer('别人', '13800008815');
    const mine = await seedBoundAppUser('openid-fav-4a', mineId);
    const other = await seedBoundAppUser('openid-fav-4b', otherId);
    const itemId = await seedServiceItem('共享款式');
    const disabledId = await seedServiceItem('下架款', { status: 'disabled' });

    await ctx.request('POST', `/api/v1/app/member/favorites/${itemId}`, {
      token: mine.token,
    });

    const mineList = await ctx.request('GET', '/api/v1/app/member/favorites', {
      token: mine.token,
    });
    expect(mineList.body.items).toHaveLength(1);

    // 别人的收藏夹看不到我的
    const otherList = await ctx.request('GET', '/api/v1/app/member/favorites', {
      token: other.token,
    });
    expect(otherList.body.items).toEqual([]);

    // 不存在的款式 / 已下架的款式：404（不是 500，也不是静默成功）
    for (const id of [999999, disabledId]) {
      const response = await ctx.request(
        'POST',
        `/api/v1/app/member/favorites/${id}`,
        { token: mine.token },
      );
      expect(response.status, String(id)).toBe(404);
    }
    const rows = await ctx.sql<{ total: number }[]>(
      `SELECT COUNT(*) AS total FROM biz_customer_favorite`,
    );
    expect(Number(rows[0].total)).toBe(1);
  });

  it('未绑定手机号 → 400 + needBind（收藏是个人数据）', async () => {
    const { token } = await seedBoundAppUser('openid-fav-5', null);
    const itemId = await seedServiceItem('款式');

    const list = await ctx.request('GET', '/api/v1/app/member/favorites', {
      token,
    });
    expect(list.status).toBe(400);
    expect(list.body.needBind).toBe(true);

    const add = await ctx.request(
      'POST',
      `/api/v1/app/member/favorites/${itemId}`,
      { token },
    );
    expect(add.status).toBe(400);
    expect(add.body.needBind).toBe(true);
    const rows = await ctx.sql<{ total: number }[]>(
      `SELECT COUNT(*) AS total FROM biz_customer_favorite`,
    );
    expect(Number(rows[0].total)).toBe(0);
  });
});
