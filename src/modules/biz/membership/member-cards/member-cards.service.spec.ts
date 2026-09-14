import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { RequestActor } from '../../../../common/data-scope/data-scope.js';
import { MemberCardsService } from './member-cards.service.js';

type Row = Record<string, unknown>;

/**
 * 操作人：带门店特权（`*:*:*`）。
 *
 * 阶段 1.12 起购卡 / 退卡要解析「当前门店」（独立收付款没有预约可继承），
 * 特权账号的 `requireCurrentStoreId` 只多查一次默认门店 —— 见 `DEFAULT_STORE`。
 */
const ACTOR: RequestActor = {
  id: 3,
  roles: ['admin'],
  permissions: ['*:*:*'],
};

/** `defaultStoreId()` 的查询结果：解析当前门店时排在所有业务查询之前 */
const DEFAULT_STORE: Row[] = [{ id: 1 }];

function chainFor(result: unknown) {
  const make = (): Record<string, unknown> => {
    const node = Promise.resolve(result) as unknown as Record<string, unknown>;
    node.from = make;
    node.where = make;
    node.leftJoin = make;
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
    /** 按调用顺序喂给 select() 的结果；每项是「一次查询返回的行数组」 */
    selectResults?: unknown[][];
    /** 按调用顺序喂给 execute()（原生 SQL 条件更新）的结果 */
    executeResults?: unknown[][];
    affectedRows?: number;
    applicableIds?: number[];
  } = {},
) {
  const queue = [...(options.selectResults ?? [])];
  const nextSelect = () => chainFor(queue.shift() ?? []);
  const dbSelect = vi.fn(nextSelect);
  const txSelect = vi.fn(nextSelect);

  const executeQueue = [...(options.executeResults ?? [])];
  const execute = vi.fn(() =>
    Promise.resolve(
      executeQueue.shift() ?? [{ affectedRows: options.affectedRows ?? 1 }],
    ),
  );

  const insertValues = vi.fn().mockResolvedValue([{ insertId: 1 }]);
  const insert = vi.fn(() => ({ values: insertValues }));

  const updateWhere = vi
    .fn()
    .mockResolvedValue([{ affectedRows: options.affectedRows ?? 1 }]);
  const updateSet = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set: updateSet }));

  const tx = { select: txSelect, insert, update, execute };
  const transaction = vi.fn(
    async (callback: (t: unknown) => Promise<unknown>) => callback(tx),
  );

  const accounts = {
    lockCustomer: vi.fn().mockResolvedValue(undefined),
    applyEarning: vi.fn().mockResolvedValue(undefined),
    recordLedgerOnly: vi.fn().mockResolvedValue(undefined),
    applyBalancePayment: vi.fn().mockResolvedValue(undefined),
    reverseEarning: vi.fn().mockResolvedValue(undefined),
  };
  const cardTypes = {
    requireActiveCardType: vi.fn().mockResolvedValue({
      id: 1,
      name: '10 次卡',
      price: 8800,
      totalTimes: 10,
      validDays: 365,
    }),
    requireCardType: vi.fn().mockResolvedValue({ id: 1, name: '10 次卡' }),
    applicableServiceItemIds: vi
      .fn()
      .mockResolvedValue(options.applicableIds ?? [11]),
    applicableItems: vi.fn().mockResolvedValue([]),
  };

  const service = new MemberCardsService(
    {
      db: { select: dbSelect, insert, update, execute, transaction },
    } as never,
    {
      booking: vi.fn().mockResolvedValue({ timezone: 'Asia/Shanghai' }),
    } as never,
    accounts as never,
    cardTypes as never,
  );

  return {
    service,
    tx: tx as never,
    accounts,
    cardTypes,
    insertValues,
    updateSet,
    execute,
    dbSelect,
    txSelect,
  };
}

const card = (overrides: Row = {}): Row => ({
  id: 1,
  customerId: 9,
  cardTypeId: 1,
  cardName: '10 次卡',
  totalTimes: 10,
  usedTimes: 0,
  status: 'active',
  expireAt: null,
  ...overrides,
});

describe('MemberCardsService（§15.5 次卡）', () => {
  describe('assertUsable：可用性校验', () => {
    it('卡不存在时抛 NotFoundException', async () => {
      const h = createHarness({ selectResults: [[]] });
      await expect(h.service.assertUsable(h.tx, 1, [11])).rejects.toThrow(
        NotFoundException,
      );
    });

    it('已退卡的卡不能使用', async () => {
      const h = createHarness({
        selectResults: [[card({ status: 'refunded' })]],
      });
      await expect(h.service.assertUsable(h.tx, 1, [11])).rejects.toThrow(
        '次卡已退卡',
      );
    });

    it('状态已置 expired 的卡不能使用', async () => {
      const h = createHarness({
        selectResults: [[card({ status: 'expired' })]],
      });
      await expect(h.service.assertUsable(h.tx, 1, [11])).rejects.toThrow(
        '次卡已过期',
      );
    });

    it('状态已置 used_up 的卡不能使用', async () => {
      const h = createHarness({
        selectResults: [[card({ status: 'used_up' })]],
      });
      await expect(h.service.assertUsable(h.tx, 1, [11])).rejects.toThrow(
        '次卡次数已用完',
      );
    });

    it('usedTimes 已达 totalTimes 时拒绝（即使状态还是 active）', async () => {
      const h = createHarness({
        selectResults: [[card({ usedTimes: 10, totalTimes: 10 })]],
      });
      await expect(h.service.assertUsable(h.tx, 1, [11])).rejects.toThrow(
        '次卡次数已用完',
      );
    });

    it('expireAt 已过但状态尚未刷新时同样拒绝（不依赖定时任务）', async () => {
      const h = createHarness({
        selectResults: [[card({ expireAt: new Date(Date.now() - 1000) })]],
      });
      await expect(h.service.assertUsable(h.tx, 1, [11])).rejects.toThrow(
        '次卡已过期',
      );
    });

    it('项目不在卡种适用集合内时拒绝', async () => {
      const h = createHarness({
        selectResults: [[card()]],
        applicableIds: [11],
      });
      await expect(h.service.assertUsable(h.tx, 1, [99])).rejects.toThrow(
        '次卡不适用于所选项目',
      );
    });

    it('卡种未配置适用项目时拒绝', async () => {
      const h = createHarness({
        selectResults: [[card()]],
        applicableIds: [],
      });
      await expect(h.service.assertUsable(h.tx, 1, [11])).rejects.toThrow(
        '卡种未配置适用项目',
      );
    });

    it('通过校验时返回卡记录', async () => {
      const h = createHarness({
        selectResults: [[card()]],
        applicableIds: [11],
      });
      await expect(
        h.service.assertUsable(h.tx, 1, [11]),
      ).resolves.toMatchObject({ id: 1, status: 'active' });
    });

    it('不传项目时跳过适用性校验（少一次查询）', async () => {
      const h = createHarness({ selectResults: [[card()]] });
      await h.service.assertUsable(h.tx, 1, []);
      expect(h.cardTypes.applicableServiceItemIds).not.toHaveBeenCalled();
    });
  });

  describe('useCard：核销', () => {
    it('条件更新未命中时抛 ConflictException（状态已变或次数已用完）', async () => {
      const h = createHarness({
        selectResults: [[card()]],
        executeResults: [[{ affectedRows: 0 }]],
      });
      await expect(
        h.service.useCard(h.tx, { cardId: 1, serviceItemId: 11 }),
      ).rejects.toThrow('次卡不可核销（状态已变或次数已用完）');
    });

    it('核销成功：写 use 日志 + card_use 流水，并返回最新次数', async () => {
      const h = createHarness({
        selectResults: [[card()], [card({ usedTimes: 1, status: 'active' })]],
      });
      const result = await h.service.useCard(h.tx, {
        cardId: 1,
        serviceItemId: 11,
        bookingId: 5,
        actorId: 3,
      });
      expect(result).toEqual({
        cardId: 1,
        usedTimes: 1,
        totalTimes: 10,
        status: 'active',
      });
      expect(h.insertValues).toHaveBeenCalledWith(
        expect.objectContaining({
          cardId: 1,
          bookingId: 5,
          serviceItemId: 11,
          type: 'use',
          times: 1,
          createdBy: 3,
        }),
      );
      expect(h.accounts.recordLedgerOnly).toHaveBeenCalledWith(
        h.tx,
        expect.objectContaining({
          type: 'card_use',
          payChannel: 'card',
          cardId: 1,
        }),
      );
    });

    it('核销前先锁会员行（锁顺序：先 customer 再 card）', async () => {
      const h = createHarness({
        selectResults: [[card()], [card({ usedTimes: 1 })]],
      });
      await h.service.useCard(h.tx, { cardId: 1, serviceItemId: 11 });
      expect(h.accounts.lockCustomer).toHaveBeenCalledWith(h.tx, 9);
    });
  });

  describe('revertUse：撤销核销', () => {
    it('已退卡的核销记录不能撤销', async () => {
      const h = createHarness({
        selectResults: [[card({ status: 'refunded' })]],
      });
      await expect(h.service.revertUse(h.tx, { cardId: 1 })).rejects.toThrow(
        '已退卡的核销记录不能撤销',
      );
    });

    it('没有可撤销的核销记录时拒绝', async () => {
      const h = createHarness({ selectResults: [[card()], []] });
      await expect(h.service.revertUse(h.tx, { cardId: 1 })).rejects.toThrow(
        '没有可撤销的核销记录',
      );
    });

    it('撤销成功：回补次数并写 revert 日志 + card_revert 流水', async () => {
      const h = createHarness({
        selectResults: [
          [card({ usedTimes: 1, status: 'used_up' })],
          [{ id: 7, serviceItemId: 11, bookingId: 5 }],
        ],
      });
      await h.service.revertUse(h.tx, {
        cardId: 1,
        remark: '客户取消',
        actorId: 3,
      });
      expect(h.insertValues).toHaveBeenCalledWith(
        expect.objectContaining({
          cardId: 1,
          bookingId: 5,
          serviceItemId: 11,
          type: 'revert',
          times: 1,
          remark: '撤销核销：客户取消',
        }),
      );
      expect(h.accounts.recordLedgerOnly).toHaveBeenCalledWith(
        h.tx,
        expect.objectContaining({ type: 'card_revert' }),
      );
    });

    it('未填原因时用兜底文案留痕', async () => {
      const h = createHarness({
        selectResults: [
          [card({ usedTimes: 1 })],
          [{ id: 7, serviceItemId: 11, bookingId: null }],
        ],
      });
      await h.service.revertUse(h.tx, { cardId: 1, remark: '   ' });
      expect(h.insertValues).toHaveBeenCalledWith(
        expect.objectContaining({ remark: '撤销核销：未填写原因' }),
      );
    });

    it('条件更新未命中（已无剩余核销）时抛 ConflictException', async () => {
      const h = createHarness({
        selectResults: [
          [card({ usedTimes: 1 })],
          [{ id: 7, serviceItemId: 11, bookingId: null }],
        ],
        executeResults: [[{ affectedRows: 0 }]],
      });
      await expect(h.service.revertUse(h.tx, { cardId: 1 })).rejects.toThrow(
        '没有可撤销的核销记录',
      );
    });
  });

  describe('expireCards：到期任务', () => {
    it('返回受影响的卡数（幂等，不碰钱）', async () => {
      const h = createHarness({ affectedRows: 3 });
      await expect(h.service.expireCards()).resolves.toEqual({ expired: 3 });
    });
  });

  describe('refund：退卡', () => {
    it('退款金额非法时抛 BadRequestException', async () => {
      const h = createHarness();
      await expect(h.service.refund(1, -1, '原因', ACTOR)).rejects.toThrow(
        '退款金额必须是非负整数（分）',
      );
    });

    it('未填原因时抛 BadRequestException', async () => {
      const h = createHarness();
      await expect(h.service.refund(1, 100, '   ', ACTOR)).rejects.toThrow(
        '退卡必须填写原因',
      );
    });

    it('已退的卡不能重复退', async () => {
      const h = createHarness({
        selectResults: [DEFAULT_STORE, [card({ status: 'refunded' })]],
      });
      await expect(h.service.refund(1, 100, '原因', ACTOR)).rejects.toThrow(
        '该卡已退',
      );
    });

    it('退款金额 > 0 时冲减累计消费与积分', async () => {
      const h = createHarness({
        selectResults: [DEFAULT_STORE, [card()]],
      });
      await h.service.refund(1, 5000, '不再需要', ACTOR);
      expect(h.accounts.reverseEarning).toHaveBeenCalledWith(
        h.tx,
        expect.objectContaining({ amount: 5000, cardId: 1 }),
      );
      expect(h.accounts.recordLedgerOnly).not.toHaveBeenCalled();
    });

    it('退款金额为 0 时只留痕，不冲减消费', async () => {
      const h = createHarness({
        selectResults: [DEFAULT_STORE, [card()]],
      });
      await h.service.refund(1, 0, '作废', ACTOR);
      expect(h.accounts.reverseEarning).not.toHaveBeenCalled();
      expect(h.accounts.recordLedgerOnly).toHaveBeenCalledWith(
        h.tx,
        expect.objectContaining({ type: 'card_revert' }),
      );
    });
  });

  describe('voidCard：废卡（撤销积分兑换时调用）', () => {
    it('已退卡的卡直接返回 false', async () => {
      const h = createHarness({
        selectResults: [[card({ status: 'refunded' })]],
      });
      await expect(h.service.voidCard(h.tx, 1, '撤销兑换', 1)).resolves.toBe(
        false,
      );
    });

    it('条件更新未命中时返回 false', async () => {
      const h = createHarness({
        selectResults: [[card()]],
        affectedRows: 0,
      });
      await expect(h.service.voidCard(h.tx, 1, '撤销兑换', 1)).resolves.toBe(
        false,
      );
    });

    it('作废成功时留痕并返回 true', async () => {
      const h = createHarness({ selectResults: [[card()]] });
      await expect(h.service.voidCard(h.tx, 1, '撤销兑换', 1)).resolves.toBe(
        true,
      );
      expect(h.accounts.recordLedgerOnly).toHaveBeenCalledWith(
        h.tx,
        expect.objectContaining({ type: 'card_revert', cardId: 1 }),
      );
    });
  });

  describe('issue：后台发卡', () => {
    it('储值支付购卡时先条件扣款再发卡', async () => {
      const h = createHarness({ selectResults: [DEFAULT_STORE] });
      const result = await h.service.issue(
        { customerId: 9, cardTypeId: 1, payChannel: 'balance' },
        ACTOR,
      );
      expect(h.accounts.applyBalancePayment).toHaveBeenCalledWith(
        h.tx,
        expect.objectContaining({ customerId: 9, amount: 8800 }),
      );
      // 卡号 = C + 店内本地日 + 主键补零（INSERT 后回填）
      expect(result.cardNo).toMatch(/^C\d{8}000001$/);
      expect(h.accounts.applyEarning).toHaveBeenCalledWith(
        h.tx,
        expect.objectContaining({ type: 'card_buy', amount: 8800 }),
      );
    });

    it('非储值渠道不触发余额扣款', async () => {
      const h = createHarness({ selectResults: [DEFAULT_STORE] });
      await h.service.issue(
        { customerId: 9, cardTypeId: 1, payChannel: 'cash' },
        ACTOR,
      );
      expect(h.accounts.applyBalancePayment).not.toHaveBeenCalled();
    });

    it('卡价非法时拒绝', async () => {
      const h = createHarness({ selectResults: [DEFAULT_STORE] });
      await expect(
        h.service.issue(
          { customerId: 9, cardTypeId: 1, payChannel: 'cash', price: -1 },
          ACTOR,
        ),
      ).rejects.toThrow('卡价不能为负');
    });
  });

  describe('list / findOne / 批量查询', () => {
    it('list 返回 items/page/pageSize（没有 total）', async () => {
      const h = createHarness({
        selectResults: [[{ id: 1, cardNo: 'C20260911000001' }]],
      });
      await expect(h.service.list(1, 20)).resolves.toEqual({
        items: [{ id: 1, cardNo: 'C20260911000001' }],
        page: 1,
        pageSize: 20,
      });
    });

    it('findOne 不存在时抛 NotFoundException', async () => {
      const h = createHarness({ selectResults: [[]] });
      await expect(h.service.findOne(404)).rejects.toThrow(NotFoundException);
    });

    it('listByCustomers 按会员聚合（会员列表展开避免 N+1）', async () => {
      const h = createHarness({
        selectResults: [
          [
            { id: 1, customerId: 9 },
            { id: 2, customerId: 9 },
            { id: 3, customerId: 8 },
          ],
        ],
      });
      const map = await h.service.listByCustomers([9, 8, 9]);
      expect(map.get(9)).toHaveLength(2);
      expect(map.get(8)).toHaveLength(1);
    });

    it('listByCustomers 空入参不查库', async () => {
      const h = createHarness();
      expect((await h.service.listByCustomers([])).size).toBe(0);
      expect(h.dbSelect).not.toHaveBeenCalled();
    });
  });
});
