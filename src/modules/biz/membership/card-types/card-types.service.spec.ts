import { ConflictException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { CardTypesService } from './card-types.service.js';

type Row = Record<string, unknown>;

function chainFor(result: unknown) {
  const make = (): Record<string, unknown> => {
    const node = Promise.resolve(result) as unknown as Record<string, unknown>;
    node.from = make;
    node.where = make;
    node.leftJoin = make;
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
    insertId?: number;
    affectedRows?: number;
  } = {},
) {
  const queue = [...(options.selectResults ?? [])];
  const select = vi.fn(() => chainFor(queue.shift() ?? []));

  const insertValues = vi
    .fn()
    .mockResolvedValue([{ insertId: options.insertId ?? 1 }]);
  const insert = vi.fn(() => ({ values: insertValues }));

  const deleteWhere = vi.fn().mockResolvedValue(undefined);
  const deleteFn = vi.fn(() => ({ where: deleteWhere }));

  const updateWhere = vi
    .fn()
    .mockResolvedValue([{ affectedRows: options.affectedRows ?? 1 }]);
  const updateSet = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set: updateSet }));

  const txInsertValues = vi.fn().mockResolvedValue(undefined);
  const txInsert = vi.fn(() => ({ values: txInsertValues }));
  const txDeleteWhere = vi.fn().mockResolvedValue(undefined);
  const txDelete = vi.fn(() => ({ where: txDeleteWhere }));
  const txUpdateWhere = vi.fn().mockResolvedValue([{ affectedRows: 1 }]);
  const txUpdateSet = vi.fn(() => ({ where: txUpdateWhere }));
  const txUpdate = vi.fn(() => ({ set: txUpdateSet }));
  const transaction = vi.fn(
    async (callback: (tx: unknown) => Promise<void>) => {
      await callback({
        insert: txInsert,
        update: txUpdate,
        delete: txDelete,
      });
    },
  );

  const service = new CardTypesService({
    db: { select, insert, update, delete: deleteFn, transaction },
  } as never);

  return {
    service,
    select,
    insertValues,
    deleteWhere,
    updateSet,
    txInsertValues,
    txDeleteWhere,
    txUpdateSet,
  };
}

const cardType = (overrides: Row = {}): Row => ({
  id: 1,
  name: '10 次卡',
  price: 8800,
  totalTimes: 10,
  validDays: 365,
  status: 'active',
  ...overrides,
});

describe('CardTypesService（§15.5 次卡卡种）', () => {
  describe('list / findOne', () => {
    it('list 合并各卡种的适用项目，无项目的补空数组', async () => {
      const { service } = createHarness({
        selectResults: [
          [
            { id: 1, name: '10 次卡' },
            { id: 2, name: '5 次卡' },
          ],
          [
            {
              cardTypeId: 1,
              serviceItemId: 11,
              name: '纯色',
              price: 8800,
              status: 'active',
            },
          ],
        ],
      });
      const page = await service.list(1, 20, {});
      expect(page.page).toBe(1);
      expect(page.items[0]!.applicableItems).toEqual([
        { serviceItemId: 11, name: '纯色', price: 8800, status: 'active' },
      ]);
      expect(page.items[1]!.applicableItems).toEqual([]);
    });

    it('findOne 不存在时抛 NotFoundException', async () => {
      const { service } = createHarness({ selectResults: [[]] });
      await expect(service.findOne(404)).rejects.toThrow(NotFoundException);
    });

    it('适用项目被物理删除后展示兜底文案', async () => {
      const { service, select } = createHarness({
        selectResults: [
          [{ serviceItemId: 11, name: null, price: null, status: null }],
        ],
      });
      await expect(
        service.applicableItems({ select } as never, 1),
      ).resolves.toEqual([
        {
          serviceItemId: 11,
          name: '（项目已删除）',
          price: 0,
          status: 'disabled',
        },
      ]);
    });
  });

  describe('requireActiveCardType：发卡 / 兑换前置校验', () => {
    it('卡种不存在时抛 NotFoundException', async () => {
      const { service, select } = createHarness({ selectResults: [[]] });
      await expect(
        service.requireActiveCardType({ select } as never, 1),
      ).rejects.toThrow(NotFoundException);
    });

    it('卡种停用时抛 ConflictException', async () => {
      const { service, select } = createHarness({
        selectResults: [[cardType({ status: 'disabled' })]],
      });
      await expect(
        service.requireActiveCardType({ select } as never, 1),
      ).rejects.toThrow('卡种已停用，不能发卡');
    });
  });

  describe('applicableServiceItemIds：核销时校验项目是否在卡种适用集合内', () => {
    it('按 sort 顺序返回项目 id', async () => {
      const { service, select } = createHarness({
        selectResults: [[{ serviceItemId: 11 }, { serviceItemId: 12 }]],
      });
      await expect(
        service.applicableServiceItemIds({ select } as never, 1),
      ).resolves.toEqual([11, 12]);
    });
  });

  describe('create', () => {
    it('名称重复时抛 ConflictException', async () => {
      const { service } = createHarness({ selectResults: [[{ id: 9 }]] });
      await expect(
        service.create(
          {
            name: '10 次卡',
            price: 8800,
            totalTimes: 10,
            serviceItemIds: [11],
          },
          1,
        ),
      ).rejects.toThrow(ConflictException);
    });

    it('未配置适用项目时抛 BadRequestException', async () => {
      const { service } = createHarness({ selectResults: [[]] });
      await expect(
        service.create({ name: '10 次卡', price: 8800, totalTimes: 10 }, 1),
      ).rejects.toThrow('卡种必须至少配置一个适用项目');
    });

    it('适用项目不存在或已停用时拒绝', async () => {
      const { service } = createHarness({
        selectResults: [[], [{ id: 11, status: 'disabled', deletedAt: null }]],
      });
      await expect(
        service.create(
          {
            name: '10 次卡',
            price: 8800,
            totalTimes: 10,
            serviceItemIds: [11],
          },
          1,
        ),
      ).rejects.toThrow('适用项目不存在或已停用：11');
    });

    it('成功时写主表并按传入顺序（去重后）替换子表', async () => {
      const h = createHarness({
        selectResults: [
          [],
          [
            { id: 11, status: 'active', deletedAt: null },
            { id: 12, status: 'active', deletedAt: null },
          ],
        ],
      });
      await expect(
        h.service.create(
          {
            name: '10 次卡',
            price: 8800,
            totalTimes: 10,
            validDays: 365,
            serviceItemIds: [12, 11, 12],
          },
          7,
        ),
      ).resolves.toEqual({ id: 1 });

      expect(h.insertValues).toHaveBeenCalledWith(
        expect.objectContaining({
          name: '10 次卡',
          price: 8800,
          totalTimes: 10,
          validDays: 365,
          createdBy: 7,
          updatedBy: 7,
        }),
      );
      // 子表整体替换：先物理删
      expect(h.deleteWhere).toHaveBeenCalledTimes(1);
      // 去重后按传入顺序落 sort
      expect(h.insertValues).toHaveBeenLastCalledWith([
        { cardTypeId: 1, serviceItemId: 12, sort: 0 },
        { cardTypeId: 1, serviceItemId: 11, sort: 1 },
      ]);
    });
  });

  describe('update', () => {
    it('卡价不能为负', async () => {
      const { service } = createHarness({ selectResults: [[cardType()]] });
      await expect(service.update(1, { price: -1 }, 1)).rejects.toThrow(
        '卡价不能为负',
      );
    });

    it('总次数必须大于 0', async () => {
      const { service } = createHarness({ selectResults: [[cardType()]] });
      await expect(service.update(1, { totalTimes: 0 }, 1)).rejects.toThrow(
        '总次数必须大于 0',
      );
    });

    it('有效期天数不能为负', async () => {
      const { service } = createHarness({ selectResults: [[cardType()]] });
      await expect(service.update(1, { validDays: -1 }, 1)).rejects.toThrow(
        '有效期天数不能为负',
      );
    });

    it('不传 serviceItemIds 时不触碰子表', async () => {
      const h = createHarness({ selectResults: [[cardType()]] });
      await h.service.update(1, { remark: '备注' }, 1);
      expect(h.txDeleteWhere).not.toHaveBeenCalled();
      expect(h.txUpdateSet).toHaveBeenCalledWith(
        expect.objectContaining({ remark: '备注', updatedBy: 1 }),
      );
    });

    it('传 serviceItemIds 时在同一事务内整体替换子表', async () => {
      const h = createHarness({
        selectResults: [
          [cardType()],
          [{ id: 11, status: 'active', deletedAt: null }],
        ],
      });
      await h.service.update(1, { serviceItemIds: [11] }, 1);
      expect(h.txDeleteWhere).toHaveBeenCalledTimes(1);
      expect(h.txInsertValues).toHaveBeenCalledWith([
        { cardTypeId: 1, serviceItemId: 11, sort: 0 },
      ]);
    });
  });

  describe('remove', () => {
    it('并发下 affectedRows=0 时抛 NotFoundException', async () => {
      const { service } = createHarness({
        selectResults: [[cardType()]],
        affectedRows: 0,
      });
      await expect(service.remove(1, 1)).rejects.toThrow(NotFoundException);
    });

    it('成功时软删并记录操作人', async () => {
      const { service, updateSet } = createHarness({
        selectResults: [[cardType()]],
      });
      await service.remove(1, 3);
      expect(updateSet).toHaveBeenCalledWith(
        expect.objectContaining({ updatedBy: 3, deletedAt: expect.any(Date) }),
      );
    });
  });
});
