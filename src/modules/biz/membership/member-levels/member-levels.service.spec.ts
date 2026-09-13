import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import {
  MemberLevelsService,
  pickLowestLevel,
  pickUpgradeLevel,
} from './member-levels.service.js';

/** 等级行的最小形状（`pickUpgradeLevel` / `pickLowestLevel` 的泛型约束） */
type LevelRow = {
  id: number;
  name: string;
  sort: number;
  status: string;
  upgradeAmount: number;
  discountPermille: number;
};

/** 造一条「怎么链都行、await 得到固定结果」的查询链（Promise 作节点挂链式方法） */
function chainFor(result: unknown) {
  const make = (): Record<string, unknown> => {
    const node = Promise.resolve(result) as unknown as Record<string, unknown>;
    node.from = make;
    node.where = make;
    node.orderBy = make;
    node.limit = make;
    node.offset = make;
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

  const service = new MemberLevelsService({
    db: { select, insert, update },
  } as never);
  return { service, select, insertValues, updateSet };
}

const level = (overrides: Partial<LevelRow> = {}): LevelRow => ({
  id: 1,
  name: '普通会员',
  sort: 0,
  status: 'active',
  upgradeAmount: 0,
  discountPermille: 1000,
  ...overrides,
});

describe('会员等级纯函数（§15.2 门槛随 sort 单调不减）', () => {
  describe('pickUpgradeLevel：取达标等级中 sort 最大的一个', () => {
    const levels = [
      level({ id: 1, sort: 0, upgradeAmount: 0 }),
      level({ id: 2, sort: 1, upgradeAmount: 100000 }),
      level({ id: 3, sort: 2, upgradeAmount: 500000 }),
    ];

    it('按累计消费落到对应等级', () => {
      expect(pickUpgradeLevel(levels, 0)?.id).toBe(1);
      expect(pickUpgradeLevel(levels, 99999)?.id).toBe(1);
      expect(pickUpgradeLevel(levels, 100000)?.id).toBe(2);
      expect(pickUpgradeLevel(levels, 999999)?.id).toBe(3);
    });

    it('跳过停用等级', () => {
      const withDisabled = [
        level({ id: 1, sort: 0, upgradeAmount: 0 }),
        level({ id: 2, sort: 1, upgradeAmount: 100000, status: 'disabled' }),
      ];
      expect(pickUpgradeLevel(withDisabled, 999999)?.id).toBe(1);
    });

    it('sort 相同时取 id 更大的，结果与遍历顺序无关', () => {
      const a = level({ id: 5, sort: 1, upgradeAmount: 0 });
      const b = level({ id: 9, sort: 1, upgradeAmount: 0 });
      expect(pickUpgradeLevel([a, b], 0)?.id).toBe(9);
      expect(pickUpgradeLevel([b, a], 0)?.id).toBe(9);
    });

    it('没有任何等级达标时返回 null', () => {
      expect(
        pickUpgradeLevel([level({ upgradeAmount: 100000 })], 0),
      ).toBeNull();
      expect(pickUpgradeLevel([], 0)).toBeNull();
    });
  });

  describe('pickLowestLevel：入会默认等级', () => {
    it('取 sort 最小、其次 id 最小的启用等级', () => {
      const levels = [
        level({ id: 3, sort: 2 }),
        level({ id: 2, sort: 0 }),
        level({ id: 1, sort: 0 }),
      ];
      expect(pickLowestLevel(levels)?.id).toBe(1);
    });

    it('忽略停用等级', () => {
      const levels = [
        level({ id: 1, sort: 0, status: 'disabled' }),
        level({ id: 2, sort: 5 }),
      ];
      expect(pickLowestLevel(levels)?.id).toBe(2);
    });

    it('全部停用时返回 null', () => {
      expect(pickLowestLevel([level({ status: 'disabled' })])).toBeNull();
    });
  });
});

describe('MemberLevelsService（§15.2）', () => {
  it('list 返回 items/page/pageSize（没有 total）', async () => {
    const { service } = createHarness({ selectResults: [[level()]] });
    await expect(service.list(2, 10)).resolves.toEqual({
      items: [level()],
      page: 2,
      pageSize: 10,
    });
  });

  it('findOne 不存在时抛 NotFoundException', async () => {
    const { service } = createHarness({ selectResults: [[]] });
    await expect(service.findOne(404)).rejects.toThrow(NotFoundException);
  });

  describe('discountPermilleOf：无等级一律按不打折', () => {
    it('levelId 为 null → 1000', async () => {
      const { service } = createHarness();
      expect(await service.discountPermilleOf(null)).toBe(1000);
    });

    it('等级查不到 → 回落 1000（不因脏数据让算价崩掉）', async () => {
      const { service } = createHarness({ selectResults: [[]] });
      expect(await service.discountPermilleOf(9)).toBe(1000);
    });

    it('命中等级时返回配置折扣率', async () => {
      const { service } = createHarness({
        selectResults: [[{ discountPermille: 950 }]],
      });
      expect(await service.discountPermilleOf(1)).toBe(950);
    });
  });

  describe('create', () => {
    it('名称重复时抛 ConflictException', async () => {
      const { service } = createHarness({ selectResults: [[{ id: 9 }]] });
      await expect(service.create({ name: 'VIP' }, 1)).rejects.toThrow(
        ConflictException,
      );
    });

    it('折扣率越界时抛 BadRequestException', async () => {
      const { service } = createHarness({ selectResults: [[]] });
      await expect(
        service.create({ name: 'VIP', discountPermille: 1001 }, 1),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.create({ name: 'VIP', discountPermille: -1 }, 1),
      ).rejects.toThrow(BadRequestException);
    });

    it('升级门槛为负时抛 BadRequestException', async () => {
      const { service } = createHarness({ selectResults: [[]] });
      await expect(
        service.create({ name: 'VIP', upgradeAmount: -1 }, 1),
      ).rejects.toThrow(BadRequestException);
    });

    it('门槛不随 sort 单调不减时拒绝（排序更小但门槛更高）', async () => {
      const { service } = createHarness({
        selectResults: [[], [level({ id: 7, sort: 5, upgradeAmount: 100000 })]],
      });
      await expect(
        service.create({ name: 'VIP', sort: 1, upgradeAmount: 200000 }, 1),
      ).rejects.toThrow(BadRequestException);
    });

    it('门槛不随 sort 单调不减时拒绝（排序更大但门槛更低）', async () => {
      const { service } = createHarness({
        selectResults: [[], [level({ id: 7, sort: 1, upgradeAmount: 100000 })]],
      });
      await expect(
        service.create({ name: 'VIP', sort: 5, upgradeAmount: 1000 }, 1),
      ).rejects.toThrow(BadRequestException);
    });

    it('成功时补齐折扣率默认值并记录操作人', async () => {
      const { service, insertValues } = createHarness({
        selectResults: [[], []],
      });
      await expect(
        service.create({ name: 'VIP', sort: 1, upgradeAmount: 100000 }, 7),
      ).resolves.toEqual({ id: 1 });
      expect(insertValues).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'VIP',
          sort: 1,
          upgradeAmount: 100000,
          discountPermille: 1000,
          createdBy: 7,
          updatedBy: 7,
        }),
      );
    });
  });

  describe('update', () => {
    it('目标不存在时抛 NotFoundException', async () => {
      const { service } = createHarness({ selectResults: [[]] });
      await expect(service.update(404, { name: 'X' }, 1)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('并发下 affectedRows=0 时抛 NotFoundException', async () => {
      const { service } = createHarness({
        selectResults: [[level()]],
        affectedRows: 0,
      });
      await expect(service.update(1, { remark: 'x' }, 1)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('改名时排除自身查重，并写入 updatedBy', async () => {
      const { service, updateSet } = createHarness({
        selectResults: [[level()], []],
      });
      await service.update(1, { name: '白金会员' }, 2);
      expect(updateSet).toHaveBeenCalledWith(
        expect.objectContaining({ name: '白金会员', updatedBy: 2 }),
      );
    });

    it('只改 remark 时不触发单调性校验（省一次全量查询）', async () => {
      const { service, select } = createHarness({
        selectResults: [[level()]],
      });
      await service.update(1, { remark: '备注' }, 1);
      expect(select).toHaveBeenCalledTimes(1);
    });
  });

  describe('remove', () => {
    it('有会员挂在该等级时拒绝删除', async () => {
      const { service } = createHarness({
        selectResults: [[level()], [{ id: 88 }]],
      });
      await expect(service.remove(1, 1)).rejects.toThrow(
        '有会员处于该等级，不能删除',
      );
    });

    it('无会员使用时软删并记录操作人', async () => {
      const { service, updateSet } = createHarness({
        selectResults: [[level()], []],
      });
      await service.remove(1, 3);
      expect(updateSet).toHaveBeenCalledWith(
        expect.objectContaining({ updatedBy: 3, deletedAt: expect.any(Date) }),
      );
    });
  });
});
