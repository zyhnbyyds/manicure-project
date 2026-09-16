import { ConflictException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import {
  CreditAccountsService,
  normalizeCreditLimit,
  normalizeSettleDay,
} from './credit-accounts.service';

type Row = Record<string, unknown>;

/**
 * 造一条「怎么链都行、await 得到固定结果」的查询链。
 *
 * 用 Promise 作为节点并挂上链式方法（而不是自定义 thenable）——Promise 天然满足
 * `select().from().where().orderBy().limit().offset()` 与 `...groupBy()` 两种收尾。
 */
function chainFor(result: unknown) {
  const make = (): Record<string, unknown> => {
    const node = Promise.resolve(result) as unknown as Record<string, unknown>;
    node.from = make;
    node.where = make;
    node.orderBy = make;
    node.limit = make;
    node.offset = make;
    node.groupBy = make;
    return node;
  };
  return make();
}

function createHarness(
  options: {
    /** 按调用顺序喂给 `select()` 的结果；每项是「一次查询返回的行数组」 */
    selectResults?: unknown[][];
    insertId?: number;
    creditConfig?: { defaultLimit: number; defaultSettleDay: number };
    /** 事务内「未结应收」查询返回的行 */
    unsettled?: Row[];
  } = {},
) {
  const queue = [...(options.selectResults ?? [])];
  const select = vi.fn(() => chainFor(queue.shift() ?? []));

  const insertValues = vi
    .fn()
    .mockResolvedValue([{ insertId: options.insertId ?? 1 }]);
  const insert = vi.fn(() => ({ values: insertValues }));

  const updateWhere = vi.fn().mockResolvedValue(undefined);
  const updateSet = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set: updateSet }));

  const txUpdateWhere = vi.fn().mockResolvedValue(undefined);
  const txUpdate = vi.fn(() => ({
    set: vi.fn(() => ({ where: txUpdateWhere })),
  }));
  const transaction = vi.fn(
    async (callback: (tx: unknown) => Promise<void>) => {
      await callback({
        select: vi.fn(() => chainFor(options.unsettled ?? [])),
        update: txUpdate,
      });
    },
  );

  const credit = vi.fn().mockResolvedValue({
    defaultLimit: 0,
    defaultSettleDay: 5,
    ...options.creditConfig,
  });
  const requireById = vi.fn().mockResolvedValue(undefined);

  const service = new CreditAccountsService(
    { db: { select, insert, update, transaction } } as never,
    { credit } as never,
    { requireById } as never,
  );

  return {
    service,
    select,
    insertValues,
    updateSet,
    txUpdateWhere,
    credit,
    requireById,
  };
}

const existingAccount = (overrides: Row = {}): Row => ({
  id: 1,
  name: '甲公司',
  usedAmount: 0,
  creditLimit: 0,
  settleDay: 5,
  ...overrides,
});

describe('CreditAccountsService（§18.1 挂账主体）', () => {
  describe('list：主体 + 已挂未结金额', () => {
    it('合并未结金额，无记录的主体补 0', async () => {
      const { service } = createHarness({
        // 第二次是 count 查询（total），第三次才是未结金额聚合
        selectResults: [
          [
            { id: 1, name: '甲公司' },
            { id: 2, name: '乙公司' },
          ],
          [],
          [{ creditAccountId: 1, outstanding: '12345' }],
        ],
      });
      const page = await service.list(1, 20, {});
      expect(page.page).toBe(1);
      expect(page.pageSize).toBe(20);
      expect(page.items).toEqual([
        { id: 1, name: '甲公司', outstandingAmount: 12345 },
        { id: 2, name: '乙公司', outstandingAmount: 0 },
      ]);
    });

    it('本页没有主体时不再多查一次未结金额', async () => {
      const { service, select } = createHarness({ selectResults: [[], []] });
      await service.list(1, 20, {});
      // page + count 各一次；没主体就不再查未结金额
      expect(select).toHaveBeenCalledTimes(2);
    });
  });

  describe('findOne', () => {
    it('不存在时抛 NotFoundException', async () => {
      const { service } = createHarness({ selectResults: [[]] });
      await expect(service.findOne(404)).rejects.toThrow(NotFoundException);
    });
  });

  describe('create', () => {
    it('额度与月结日缺省时取配置值', async () => {
      const { service, insertValues } = createHarness({
        selectResults: [[]],
        creditConfig: { defaultLimit: 500000, defaultSettleDay: 10 },
      });
      await expect(
        service.create({ name: '甲公司', type: 'company' }, 7),
      ).resolves.toEqual({ id: 1 });
      expect(insertValues).toHaveBeenCalledWith(
        expect.objectContaining({
          creditLimit: 500000,
          settleDay: 10,
          customerId: null,
          createdBy: 7,
          updatedBy: 7,
        }),
      );
    });

    it('名称重复时抛 ConflictException', async () => {
      const { service } = createHarness({ selectResults: [[{ id: 9 }]] });
      await expect(
        service.create({ name: '甲公司', type: 'company' }, 1),
      ).rejects.toThrow(ConflictException);
    });

    it('带 customerId 时校验顾客存在', async () => {
      const { service, requireById } = createHarness({ selectResults: [[]] });
      await service.create({ name: '甲', type: 'customer', customerId: 5 }, 1);
      expect(requireById).toHaveBeenCalledWith(5);
    });

    it('非法额度回落 0（0 = 不限）', async () => {
      const { service, insertValues } = createHarness({ selectResults: [[]] });
      await service.create(
        { name: '甲', type: 'company', creditLimit: -100 },
        1,
      );
      expect(insertValues).toHaveBeenCalledWith(
        expect.objectContaining({ creditLimit: 0 }),
      );
    });
  });

  describe('update', () => {
    it('额度不得小于已挂账金额', async () => {
      const { service } = createHarness({
        selectResults: [[existingAccount({ usedAmount: 50000 })]],
      });
      await expect(
        service.update(1, { creditLimit: 10000 }, 1),
      ).rejects.toThrow(ConflictException);
    });

    it('额度 0（不限）不受已挂账金额限制', async () => {
      const { service, updateSet } = createHarness({
        selectResults: [[existingAccount({ usedAmount: 50000 })]],
      });
      await service.update(1, { creditLimit: 0 }, 1);
      expect(updateSet).toHaveBeenCalledWith(
        expect.objectContaining({ creditLimit: 0, updatedBy: 1 }),
      );
    });

    it('空 patch 不触发写库', async () => {
      const { service, updateSet } = createHarness({
        selectResults: [[existingAccount()]],
      });
      await service.update(1, {}, 1);
      expect(updateSet).not.toHaveBeenCalled();
    });

    it('改名时排除自身再查重，并写入 updatedBy', async () => {
      const { service, updateSet } = createHarness({
        selectResults: [[existingAccount()], []],
      });
      await service.update(1, { name: '乙公司' }, 2);
      expect(updateSet).toHaveBeenCalledWith(
        expect.objectContaining({ name: '乙公司', updatedBy: 2 }),
      );
    });

    it('月结日越界时被夹到 [0, 28]', async () => {
      const { service, updateSet } = createHarness({
        selectResults: [[existingAccount()]],
      });
      await service.update(1, { settleDay: 31 }, 1);
      expect(updateSet).toHaveBeenCalledWith(
        expect.objectContaining({ settleDay: 28 }),
      );
    });
  });

  describe('remove', () => {
    it('存在未结应收时拒绝删除', async () => {
      const { service } = createHarness({
        selectResults: [[existingAccount()]],
        unsettled: [{ id: 99 }],
      });
      await expect(service.remove(1, 1)).rejects.toThrow(
        '该主体存在未结应收，不能删除',
      );
    });

    it('无未结应收时软删', async () => {
      const { service, txUpdateWhere } = createHarness({
        selectResults: [[existingAccount()]],
        unsettled: [],
      });
      await service.remove(1, 3);
      expect(txUpdateWhere).toHaveBeenCalledTimes(1);
    });
  });
});

describe('挂账额度与月结日归一化', () => {
  it('额度：非法值回落 0，负数夹到 0，小数截断', () => {
    expect(normalizeCreditLimit(Number.NaN)).toBe(0);
    expect(normalizeCreditLimit(Number.POSITIVE_INFINITY)).toBe(0);
    expect(normalizeCreditLimit(-100)).toBe(0);
    expect(normalizeCreditLimit(1234.9)).toBe(1234);
  });

  it('月结日：0 = 不定期，范围夹在 [0, 28]', () => {
    expect(normalizeSettleDay(Number.NaN)).toBe(0);
    expect(normalizeSettleDay(-1)).toBe(0);
    expect(normalizeSettleDay(5.9)).toBe(5);
    expect(normalizeSettleDay(31)).toBe(28);
  });
});
