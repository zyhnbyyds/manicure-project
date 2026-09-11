import { ConflictException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import {
  ServiceItemsService,
  imagesPatch,
  normalizeImages,
} from './service-items.service.js';

type Row = Record<string, unknown>;

/** 造一条「怎么链都行、await 得到固定结果」的查询链（Promise 作节点挂链式方法） */
function chainFor(result: unknown) {
  const make = (): Record<string, unknown> => {
    const node = Promise.resolve(result) as unknown as Record<string, unknown>;
    node.from = make;
    node.where = make;
    node.orderBy = make;
    node.limit = make;
    node.offset = make;
    node.innerJoin = make;
    return node;
  };
  return make();
}

function createHarness(
  options: { selectResults?: unknown[][]; affectedRows?: number } = {},
) {
  const queue = [...(options.selectResults ?? [])];
  const select = vi.fn(() => chainFor(queue.shift() ?? []));
  const insertValues = vi.fn().mockResolvedValue([{ insertId: 1 }]);
  const insert = vi.fn(() => ({ values: insertValues }));
  const updateWhere = vi
    .fn()
    .mockResolvedValue([{ affectedRows: options.affectedRows ?? 1 }]);
  const updateSet = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set: updateSet }));

  const service = new ServiceItemsService({
    db: { select, insert, update },
  } as never);
  return { service, select, insertValues, updateSet };
}

const item = (overrides: Row = {}): Row => ({
  id: 11,
  name: '纯色美甲',
  category: '基础',
  durationMinutes: 60,
  bufferMinutes: 15,
  price: 12800,
  description: null,
  images: null,
  image: null,
  status: 'active',
  sort: 0,
  remark: null,
  ...overrides,
});

describe('normalizeImages（图集归一化）', () => {
  it('没传 / null / 空数组都归一成 null', () => {
    expect(normalizeImages(undefined)).toBeNull();
    expect(normalizeImages(null)).toBeNull();
    expect(normalizeImages([])).toBeNull();
  });

  it('全空白也归一成 null（不允许存一个「有数组但没图」的形态）', () => {
    expect(normalizeImages(['', '   '])).toBeNull();
  });

  it('去掉首尾空白', () => {
    expect(normalizeImages(['  /files/1.png  '])).toEqual(['/files/1.png']);
  });

  it('按首次出现去重且保持原顺序', () => {
    expect(normalizeImages(['b', 'a', 'b', 'c', 'a'])).toEqual(['b', 'a', 'c']);
  });

  it('顺序即展示顺序，不做排序', () => {
    expect(normalizeImages(['/3.png', '/1.png', '/2.png'])).toEqual([
      '/3.png',
      '/1.png',
      '/2.png',
    ]);
  });

  it('超过 9 张时截断，保留前 9 张', () => {
    const many = Array.from({ length: 12 }, (_, i) => `/files/${i}.png`);
    const normalized = normalizeImages(many);
    expect(normalized).toHaveLength(9);
    expect(normalized?.[0]).toBe('/files/0.png');
    expect(normalized?.[8]).toBe('/files/8.png');
  });

  it('不去重以外的清洗：不做 url 合法性判断（与 biz_review.images 口径一致）', () => {
    expect(normalizeImages(['not-a-url'])).toEqual(['not-a-url']);
  });
});

describe('imagesPatch（图集 → 写入补丁，封面派生）', () => {
  it('undefined 表示「本次不改图集」，返回空补丁', () => {
    expect(imagesPatch(undefined)).toEqual({});
  });

  it('null / 空数组 → 图集与封面一起清空', () => {
    expect(imagesPatch(null)).toEqual({ images: null, image: null });
    expect(imagesPatch([])).toEqual({ images: null, image: null });
  });

  it('封面恒等于归一化后的首图（而不是原始入参的第一项）', () => {
    expect(imagesPatch(['  ', '/b.png', '/a.png'])).toEqual({
      images: ['/b.png', '/a.png'],
      image: '/b.png',
    });
  });

  it('去重后首图变化时，封面跟着变', () => {
    expect(imagesPatch(['/a.png', '/a.png', '/b.png'])).toEqual({
      images: ['/a.png', '/b.png'],
      image: '/a.png',
    });
  });
});

describe('ServiceItemsService 图集写入（§9.1）', () => {
  describe('create', () => {
    it('传了图集：写入归一化结果并派生封面', async () => {
      const h = createHarness();
      await expect(
        h.service.create(
          {
            name: '法式美甲',
            durationMinutes: 90,
            images: ['/b.png', '  ', '/b.png', '/a.png'],
          },
          7,
        ),
      ).resolves.toEqual({ id: 1 });
      expect(h.insertValues).toHaveBeenCalledWith(
        expect.objectContaining({
          name: '法式美甲',
          durationMinutes: 90,
          images: ['/b.png', '/a.png'],
          image: '/b.png',
          createdBy: 7,
          updatedBy: 7,
        }),
      );
    });

    it('不传图集：images / image 都不落值（不写 image 键，交给列默认值 NULL）', async () => {
      const h = createHarness();
      await h.service.create({ name: '基础美甲', durationMinutes: 60 }, 7);
      const payload = h.insertValues.mock.calls[0]?.[0] as Row;
      expect('image' in payload).toBe(false);
      expect('images' in payload).toBe(false);
    });

    it('传空数组：与不传图集等价，封面为 null', async () => {
      const h = createHarness();
      await h.service.create(
        { name: '基础美甲', durationMinutes: 60, images: [] },
        7,
      );
      expect(h.insertValues).toHaveBeenCalledWith(
        expect.objectContaining({ images: null, image: null }),
      );
    });
  });

  describe('update', () => {
    it('目标不存在时抛 NotFoundException', async () => {
      const h = createHarness({ selectResults: [[]] });
      await expect(
        h.service.update(404, { images: ['/a.png'] }, 1),
      ).rejects.toThrow(NotFoundException);
    });

    it('不传 images 时 SET 里既没有 images 也没有 image（保持原图集不动）', async () => {
      const h = createHarness({ selectResults: [[item()]] });
      await h.service.update(11, { remark: '改个备注' }, 2);
      const patch = h.updateSet.mock.calls[0]?.[0] as Row;
      expect(patch).toEqual({ remark: '改个备注', updatedBy: 2 });
      expect('images' in patch).toBe(false);
      expect('image' in patch).toBe(false);
    });

    it('传了图集时 images 与 image 一起写（同进同退）', async () => {
      const h = createHarness({ selectResults: [[item()]] });
      await h.service.update(11, { images: ['/x.png', '/y.png'] }, 2);
      expect(h.updateSet).toHaveBeenCalledWith(
        expect.objectContaining({
          images: ['/x.png', '/y.png'],
          image: '/x.png',
          updatedBy: 2,
        }),
      );
    });

    it('传 null 清空图集时，封面一并清空', async () => {
      const h = createHarness({
        selectResults: [[item({ images: ['/x.png'], image: '/x.png' })]],
      });
      await h.service.update(11, { images: null }, 2);
      expect(h.updateSet).toHaveBeenCalledWith(
        expect.objectContaining({ images: null, image: null }),
      );
    });

    it('只改图集不会触发停用校验（省一次未完成预约查询）', async () => {
      const h = createHarness({ selectResults: [[item()]] });
      await h.service.update(11, { images: ['/x.png'] }, 2);
      // 只查了 findOne 那一次
      expect(h.select).toHaveBeenCalledTimes(1);
    });

    it('并发下 affectedRows=0 时抛 NotFoundException', async () => {
      const h = createHarness({
        selectResults: [[item()]],
        affectedRows: 0,
      });
      await expect(
        h.service.update(11, { images: ['/x.png'] }, 2),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('停用 / 删除保护不受图集改造影响（§6.4 回归）', () => {
    it('停用被未完成预约引用的项目时仍然 409', async () => {
      const h = createHarness({
        selectResults: [
          [item()],
          [{ value: 2 }],
          [{ bookingNo: 'B20260911001' }, { bookingNo: 'B20260911002' }],
        ],
      });
      await expect(
        h.service.update(11, { status: 'disabled', images: ['/x.png'] }, 1),
      ).rejects.toThrow(ConflictException);
    });

    it('已经是停用状态时不重复校验，可以继续改图集', async () => {
      const h = createHarness({
        selectResults: [[item({ status: 'disabled' })]],
      });
      await h.service.update(
        11,
        { status: 'disabled', images: ['/x.png'] },
        1,
      );
      expect(h.updateSet).toHaveBeenCalledWith(
        expect.objectContaining({ images: ['/x.png'], image: '/x.png' }),
      );
    });

    it('被未完成预约引用时不能删除', async () => {
      const h = createHarness({
        selectResults: [
          [item()],
          [{ value: 1 }],
          [{ bookingNo: 'B20260911001' }],
        ],
      });
      await expect(h.service.remove(11, 1)).rejects.toThrow(
        '被 1 条未完成预约引用',
      );
    });

    it('无引用时软删并记录操作人', async () => {
      const h = createHarness({
        selectResults: [[item()], [{ value: 0 }]],
      });
      await h.service.remove(11, 3);
      expect(h.updateSet).toHaveBeenCalledWith(
        expect.objectContaining({ updatedBy: 3, deletedAt: expect.any(Date) }),
      );
    });
  });
});
