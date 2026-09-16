import { describe, expect, it, vi } from 'vitest';
import { ServiceItemsController } from './service-items.controller';

type Row = Record<string, unknown>;

function createHarness() {
  const service = {
    list: vi.fn().mockResolvedValue({ items: [], page: 1, pageSize: 20 }),
    findOne: vi.fn().mockResolvedValue({ id: 11 }),
    create: vi.fn().mockResolvedValue({ id: 11 }),
    update: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
  };
  const controller = new ServiceItemsController(service as never);
  return { controller, service };
}

const actor = { user: { id: 7 } };

/** create 校验通过后透传给 service 的入参 */
function createdPayload(service: { create: unknown }): Row {
  const calls = (service.create as { mock: { calls: unknown[][] } }).mock.calls;
  return calls[0]?.[0] as Row;
}

describe('ServiceItemsController（§9.1 服务项目）', () => {
  describe('create：图集入参', () => {
    it('透传图集数组给服务', async () => {
      const h = createHarness();
      await h.controller.create(
        {
          name: '法式美甲',
          durationMinutes: 90,
          images: ['/files/1.png', '/files/2.png'],
        },
        actor,
      );
      expect(createdPayload(h.service)).toMatchObject({
        name: '法式美甲',
        durationMinutes: 90,
        images: ['/files/1.png', '/files/2.png'],
      });
    });

    it('旧的单图字段 image 会被丢掉，不会流进服务（封面只能由图集派生）', async () => {
      const h = createHarness();
      await h.controller.create(
        {
          name: '法式美甲',
          durationMinutes: 90,
          images: ['/files/1.png'],
          image: '/files/evil.png',
        },
        actor,
      );
      const payload = createdPayload(h.service);
      expect('image' in payload).toBe(false);
      expect(payload.images).toEqual(['/files/1.png']);
    });

    it('不传图集时入参里没有 images 键（与「清空」区分开）', async () => {
      const h = createHarness();
      await h.controller.create(
        { name: '基础美甲', durationMinutes: 60 },
        actor,
      );
      expect('images' in createdPayload(h.service)).toBe(false);
    });

    it('images 传 null 时保留 null（表示清空图集）', async () => {
      const h = createHarness();
      await h.controller.create(
        { name: '基础美甲', durationMinutes: 60, images: null },
        actor,
      );
      expect(createdPayload(h.service).images).toBeNull();
    });

    it('超过 9 张 → 校验失败', async () => {
      const h = createHarness();
      const images = Array.from({ length: 10 }, (_, i) => `/files/${i}.png`);
      expect(() =>
        h.controller.create(
          { name: '基础美甲', durationMinutes: 60, images },
          actor,
        ),
      ).toThrow();
      expect(h.service.create).not.toHaveBeenCalled();
    });

    it('单张地址超过 500 字符 → 校验失败', async () => {
      const h = createHarness();
      expect(() =>
        h.controller.create(
          {
            name: '基础美甲',
            durationMinutes: 60,
            images: [`/${'a'.repeat(500)}`],
          },
          actor,
        ),
      ).toThrow();
    });

    it('图集元素类型不对 → 校验失败', async () => {
      const h = createHarness();
      expect(() =>
        h.controller.create(
          { name: '基础美甲', durationMinutes: 60, images: [1, 2] },
          actor,
        ),
      ).toThrow();
    });

    it('缺 name / durationMinutes → 校验失败', async () => {
      const h = createHarness();
      expect(() => h.controller.create({ name: '基础美甲' }, actor)).toThrow();
      expect(() =>
        h.controller.create({ durationMinutes: 60 }, actor),
      ).toThrow();
    });

    it('创建人取自登录态', async () => {
      const h = createHarness();
      await h.controller.create(
        { name: '基础美甲', durationMinutes: 60 },
        { user: { id: 42 } },
      );
      expect(
        (h.service.create as { mock: { calls: unknown[][] } }).mock
          .calls[0]?.[1],
      ).toBe(42);
    });
  });

  describe('update：图集入参', () => {
    it('只传图集时服务收到 { images }', async () => {
      const h = createHarness();
      await h.controller.update(11, { images: ['/files/9.png'] }, actor);
      expect(h.service.update).toHaveBeenCalledWith(
        11,
        { images: ['/files/9.png'] },
        7,
      );
    });

    it('image 同样会被丢掉', async () => {
      const h = createHarness();
      await h.controller.update(
        11,
        { images: ['/files/9.png'], image: '/files/evil.png' },
        actor,
      );
      const patch = (h.service.update as { mock: { calls: unknown[][] } }).mock
        .calls[0]?.[1] as Row;
      expect('image' in patch).toBe(false);
    });

    it('空 body 合法（局部更新），服务收到空对象', async () => {
      const h = createHarness();
      await h.controller.update(11, {}, actor);
      expect(h.service.update).toHaveBeenCalledWith(11, {}, 7);
    });

    it('超过 9 张 → 校验失败', async () => {
      const h = createHarness();
      const images = Array.from({ length: 11 }, (_, i) => `/files/${i}.png`);
      expect(() => h.controller.update(11, { images }, actor)).toThrow();
      expect(h.service.update).not.toHaveBeenCalled();
    });
  });

  describe('list / remove（回归）', () => {
    it('list 透传分页与过滤条件', async () => {
      const h = createHarness();
      await h.controller.list('2', '50', '美甲', 'active');
      expect(h.service.list).toHaveBeenCalledWith(2, 50, {
        keyword: '美甲',
        status: 'active',
      });
    });

    it('list 的 status 白名单：非法值当未传', async () => {
      const h = createHarness();
      await h.controller.list(undefined, undefined, undefined, 'deleted');
      expect(h.service.list).toHaveBeenCalledWith(1, 20, {});
    });

    it('remove 透传 id 与操作人', async () => {
      const h = createHarness();
      await h.controller.remove(11, actor);
      expect(h.service.remove).toHaveBeenCalledWith(11, 7);
    });
  });
});
