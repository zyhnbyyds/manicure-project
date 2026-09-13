import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { RechargePlansService } from './recharge-plans.service.js';

type Row = Record<string, unknown>;

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
  options: {
    selectResults?: unknown[][];
    affectedRows?: number;
    maxBonusPermille?: number;
  } = {},
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
  const member = vi.fn().mockResolvedValue({
    maxBonusPermille: options.maxBonusPermille ?? 200,
  });

  const service = new RechargePlansService(
    { db: { select, insert, update } } as never,
    { member } as never,
  );
  return { service, select, insertValues, updateSet, member };
}

const plan = (overrides: Row = {}): Row => ({
  id: 1,
  name: '充 1000 送 200',
  payAmount: 100000,
  bonusAmount: 20000,
  status: 'active',
  sort: 0,
  ...overrides,
});

describe('RechargePlansService（§15.4 充值方案）', () => {
  it('list 返回 items/page/pageSize', async () => {
    const { service } = createHarness({ selectResults: [[plan()]] });
    await expect(service.list(1, 20)).resolves.toEqual({
      items: [plan()],
      page: 1,
      pageSize: 20,
    });
  });

  it('listActive 只取启用方案（充值下拉用）', async () => {
    const { service } = createHarness({ selectResults: [[plan()]] });
    await expect(service.listActive()).resolves.toEqual([plan()]);
  });

  it('findOne 不存在时抛 NotFoundException', async () => {
    const { service } = createHarness({ selectResults: [[]] });
    await expect(service.findOne(404)).rejects.toThrow(NotFoundException);
  });

  describe('赠送比例上限（默认 200‰ = 20%）', () => {
    it('恰好等于上限时通过（整数比较，不受取整误差影响）', async () => {
      const { service } = createHarness({ selectResults: [[]] });
      await expect(
        service.create(
          { name: '充 100 送 20', payAmount: 10000, bonusAmount: 2000 },
          1,
        ),
      ).resolves.toEqual({ id: 1 });
    });

    it('超出上限 1 分即拒绝', async () => {
      const { service } = createHarness({ selectResults: [[]] });
      await expect(
        service.create(
          { name: '超送', payAmount: 10000, bonusAmount: 2001 },
          1,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('上限随配置变化', async () => {
      const { service } = createHarness({
        selectResults: [[]],
        maxBonusPermille: 500,
      });
      await expect(
        service.create(
          { name: '半送', payAmount: 10000, bonusAmount: 5000 },
          1,
        ),
      ).resolves.toEqual({ id: 1 });
    });

    it('充值金额必须大于 0', async () => {
      const { service } = createHarness({ selectResults: [[]] });
      await expect(
        service.create({ name: '白送', payAmount: 0, bonusAmount: 0 }, 1),
      ).rejects.toThrow('充值金额必须是大于 0 的整数（分）');
    });

    it('赠送金额必须非负', async () => {
      const { service } = createHarness({ selectResults: [[]] });
      await expect(
        service.create({ name: '负送', payAmount: 10000, bonusAmount: -1 }, 1),
      ).rejects.toThrow('赠送金额必须是非负整数（分）');
    });
  });

  describe('create', () => {
    it('名称重复时抛 ConflictException', async () => {
      const { service } = createHarness({ selectResults: [[{ id: 9 }]] });
      await expect(
        service.create({ name: '充 1000 送 200', payAmount: 100000 }, 1),
      ).rejects.toThrow(ConflictException);
    });

    it('未传赠送金额时按 0 处理，并记录操作人', async () => {
      const { service, insertValues } = createHarness({ selectResults: [[]] });
      await service.create({ name: '纯充值', payAmount: 10000 }, 7);
      expect(insertValues).toHaveBeenCalledWith(
        expect.objectContaining({
          name: '纯充值',
          payAmount: 10000,
          bonusAmount: 0,
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

    it('只改 remark 时不校验赠送比例（省一次配置读取）', async () => {
      const { service, member } = createHarness({
        selectResults: [[plan()]],
      });
      await service.update(1, { remark: '备注' }, 1);
      expect(member).not.toHaveBeenCalled();
    });

    it('改赠送金额时按「当前充值金额」重新校验上限', async () => {
      const { service } = createHarness({
        selectResults: [[plan({ payAmount: 10000, bonusAmount: 0 })]],
      });
      await expect(service.update(1, { bonusAmount: 5000 }, 1)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('并发下 affectedRows=0 时抛 NotFoundException', async () => {
      const { service } = createHarness({
        selectResults: [[plan()]],
        affectedRows: 0,
      });
      await expect(service.update(1, { remark: 'x' }, 1)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('remove', () => {
    it('软删并记录操作人', async () => {
      const { service, updateSet } = createHarness();
      await service.remove(1, 3);
      expect(updateSet).toHaveBeenCalledWith(
        expect.objectContaining({ updatedBy: 3, deletedAt: expect.any(Date) }),
      );
    });

    it('并发下 affectedRows=0 时抛 NotFoundException', async () => {
      const { service } = createHarness({ affectedRows: 0 });
      await expect(service.remove(404, 1)).rejects.toThrow(NotFoundException);
    });
  });
});
