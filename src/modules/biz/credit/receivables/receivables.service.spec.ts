import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Param } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import {
  bizBookings,
  bizCreditAccounts,
  bizReceivables,
} from '../../../../database/schema/index';
import { addLocalDays, shopToday } from '../../common/shop-time';
import { ReceivablesService, resolveDueDate } from './receivables.service';

type Row = Record<string, unknown>;

/**
 * 把 SQL 节点拍平成文本，便于断言条件表达式的形态。
 *
 * drizzle 的 `sql` 模板里，字面量文本被包成 `StringChunk`（值在 `value` 数组里），
 * 插值的列是带 `name` 的 `Column`，插值的值是 `Param`。
 */
function sqlText(node: unknown): string {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (typeof node !== 'object') return '';
  if (node instanceof Param) return '?';
  const record = node as {
    value?: unknown;
    queryChunks?: unknown[];
    name?: string;
  };
  if (Array.isArray(record.queryChunks))
    return record.queryChunks.map(sqlText).join('');
  if (Array.isArray(record.value)) return record.value.map(sqlText).join('');
  if (typeof record.name === 'string') return record.name;
  return '';
}

/** 造一个「节点本身是 Promise，同时挂满链式方法」的查询链 */
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

/** 只走 where 的写链（update / delete） */
function writeChain(
  results: unknown[][],
  log: string[],
  tag: string,
  whereCalls: unknown[],
) {
  const set = vi.fn((payload: unknown) => {
    log.push(`${tag}.set`);
    void payload;
    return {
      where: vi.fn((condition?: unknown) => {
        whereCalls.push(condition);
        return Promise.resolve(results.shift() ?? [{ affectedRows: 1 }]);
      }),
    };
  });
  // 记下 update() 的第一参（表对象）：用例据此断言「写的是哪张表」
  return { update: vi.fn((_table: unknown) => ({ set })), set };
}

/** 只走 values 的写链（insert） */
function insertChain(
  results: unknown[][],
  log: string[],
  tag: string,
  fallback: unknown[] = [{ insertId: 1 }],
) {
  const values = vi.fn((payload: unknown) => {
    log.push(`${tag}.values`);
    void payload;
    return Promise.resolve(results.shift() ?? fallback);
  });
  return { insert: vi.fn(() => ({ values })), values };
}

const ONLINE_CHANNELS = ['wxpay_native', 'alipay_qr'];

type HarnessOptions = {
  dbSelect?: unknown[][];
  txSelect?: unknown[][];
  dbUpdate?: unknown[][];
  txUpdate?: unknown[][];
  txInsert?: unknown[][];
};

function createHarness(options: HarnessOptions = {}) {
  const log: string[] = [];
  const dbUpdateWhere: unknown[] = [];
  const txUpdateWhere: unknown[] = [];

  const dbSelectQueue = [...(options.dbSelect ?? [])];
  const dbSelect = vi.fn(() => {
    log.push('db.select');
    return chainFor(dbSelectQueue.shift() ?? []);
  });

  const txSelectQueue = [...(options.txSelect ?? [])];
  const txSelect = vi.fn(() => {
    log.push('tx.select');
    return chainFor(txSelectQueue.shift() ?? []);
  });

  const dbWrite = writeChain(
    [...(options.dbUpdate ?? [])],
    log,
    'db.update',
    dbUpdateWhere,
  );
  const txWrite = writeChain(
    [...(options.txUpdate ?? [])],
    log,
    'tx.update',
    txUpdateWhere,
  );
  const txInsertChain = insertChain(
    [...(options.txInsert ?? [])],
    log,
    'tx.insert',
  );

  const tx = {
    select: txSelect,
    insert: txInsertChain.insert,
    update: txWrite.update,
  };
  const transaction = vi.fn(
    async (callback: (t: unknown) => Promise<unknown>) => {
      log.push('transaction.begin');
      return callback(tx);
    },
  );

  const db = {
    select: dbSelect,
    update: dbWrite.update,
    insert: vi.fn(),
    transaction,
  };

  const config = {
    booking: vi.fn(async () => {
      log.push('config.booking');
      return { timezone: 'Asia/Shanghai' };
    }),
  };

  const payments = {
    createInTx: vi.fn(
      async (_tx: unknown, input: { channel: string; amount: number }) => {
        log.push('payments.createInTx');
        const online = ONLINE_CHANNELS.includes(input.channel);
        return {
          paymentId: 101,
          paymentNo: 'P20260911000101',
          status: online ? 'pending' : 'success',
          codeUrl: online ? 'weixin://wxpay/prepay' : null,
          expireAt: online ? new Date('2026-09-11T10:30:00.000Z') : null,
        };
      },
    ),
  };
  const settlements = {
    recalc: vi.fn(async () => {
      log.push('settlements.recalc');
    }),
  };
  const members = {
    recordConsumption: vi.fn(async () => {
      log.push('members.recordConsumption');
    }),
  };
  const customers = {
    requireById: vi.fn(async () => {
      log.push('customers.requireById');
      return { id: 9 };
    }),
  };

  const service = new ReceivablesService(
    { db } as never,
    config as never,
    payments as never,
    settlements as never,
    members as never,
    customers as never,
  );

  return {
    service,
    tx,
    log,
    transaction,
    payments,
    settlements,
    members,
    customers,
    dbSelect,
    txSelect,
    dbWrite,
    txWrite,
    txInsertChain,
    dbUpdateWhere,
    txUpdateWhere,
  };
}

const receivable = (overrides: Row = {}): Row => ({
  id: 1,
  receivableNo: 'A20260911000001',
  creditAccountId: 3,
  bookingId: 55,
  customerId: 9,
  amount: 10000,
  settledAmount: 0,
  dueDate: '2026-09-25',
  status: 'open',
  remark: null,
  deletedAt: null,
  ...overrides,
});

const creditAccount = (overrides: Row = {}): Row => ({
  id: 3,
  name: '张三',
  type: 'customer',
  customerId: 9,
  creditLimit: 50000,
  usedAmount: 0,
  settleDay: 25,
  status: 'active',
  deletedAt: null,
  ...overrides,
});

describe('ReceivablesService（§18 应收台账）', () => {
  /* ------------------------------------------------------------------ *
   * resolveDueDate：账期（纯函数）
   * ------------------------------------------------------------------ */
  describe('resolveDueDate（账期）', () => {
    it.each([[0], [-3], [Number.NaN], [Number.POSITIVE_INFINITY]])(
      'settle_day = %s → 不定期（null）',
      (settleDay) => {
        expect(resolveDueDate(settleDay, '2026-09-11')).toBeNull();
      },
    );

    it('当月结算日尚未到 → 取当月', () => {
      expect(resolveDueDate(25, '2026-09-11')).toBe('2026-09-25');
    });

    it('当月结算日已过或正好当天 → 顺延次月（「之后第一个」不含当天）', () => {
      expect(resolveDueDate(11, '2026-09-11')).toBe('2026-10-11');
      expect(resolveDueDate(5, '2026-09-11')).toBe('2026-10-05');
    });

    it('12 月顺延要跨年', () => {
      expect(resolveDueDate(10, '2026-12-15')).toBe('2027-01-10');
    });

    it('12 月但结算日未到 → 仍在当月，不跨年', () => {
      expect(resolveDueDate(20, '2026-12-15')).toBe('2026-12-20');
    });

    it.each([[31], [29], [30]])(
      '结算日 %s 收敛到 28（避免 2 月无此日）',
      (day) => {
        expect(resolveDueDate(day, '2026-09-11')).toBe('2026-09-28');
      },
    );

    it('小数结算日向下取整', () => {
      expect(resolveDueDate(1.9, '2026-09-11')).toBe('2026-10-01');
    });
  });

  /* ------------------------------------------------------------------ *
   * assertCreditAvailable：额度校验
   * ------------------------------------------------------------------ */
  describe('assertCreditAvailable（额度校验）', () => {
    it('挂账主体不存在 → 404', async () => {
      const h = createHarness({ txSelect: [[]] });
      await expect(
        h.service.assertCreditAvailable(h.tx as never, 3, 10000),
      ).rejects.toThrow(new NotFoundException('挂账主体不存在'));
    });

    it('挂账主体已停用 → 409', async () => {
      const h = createHarness({
        txSelect: [[creditAccount({ status: 'disabled' })]],
      });
      await expect(
        h.service.assertCreditAvailable(h.tx as never, 3, 10000),
      ).rejects.toThrow(new ConflictException('挂账主体已停用，不能挂账'));
    });

    it('credit_limit = 0 表示不限额度，直接放行', async () => {
      const h = createHarness({
        txSelect: [[creditAccount({ creditLimit: 0, usedAmount: 999_999 })]],
      });
      await expect(
        h.service.assertCreditAvailable(h.tx as never, 3, 10000),
      ).resolves.toMatchObject({ id: 3 });
    });

    it('已用 + 本次超出额度 → 409 并给出剩余额度', async () => {
      const h = createHarness({
        txSelect: [[creditAccount({ creditLimit: 50000, usedAmount: 45000 })]],
      });
      await expect(
        h.service.assertCreditAvailable(h.tx as never, 3, 6000),
      ).rejects.toThrow(new ConflictException('超出挂账额度，剩余 ¥50.00'));
    });

    it('正好用满额度（相等）→ 放行，不算超', async () => {
      const h = createHarness({
        txSelect: [[creditAccount({ creditLimit: 50000, usedAmount: 45000 })]],
      });
      await expect(
        h.service.assertCreditAvailable(h.tx as never, 3, 5000),
      ).resolves.toMatchObject({ id: 3 });
    });

    it.each([[0], [-100], [0.4], [Number.NaN]])(
      '金额 %s 不是正整数（分）→ 400',
      async (amount) => {
        const h = createHarness({ txSelect: [[creditAccount()]] });
        await expect(
          h.service.assertCreditAvailable(h.tx as never, 3, amount),
        ).rejects.toThrow(new BadRequestException('金额必须为正整数（分）'));
      },
    );
  });

  /* ------------------------------------------------------------------ *
   * createFromBooking：下单挂账
   * ------------------------------------------------------------------ */
  describe('createFromBooking（下单挂账）', () => {
    it('主体绑定了别的顾客 → 409，不建单', async () => {
      const h = createHarness({
        txSelect: [[creditAccount({ customerId: 8 })]],
      });
      await expect(
        h.service.createFromBooking(h.tx as never, {
          creditAccountId: 3,
          bookingId: 55,
          // 挂账门店由调用方继承预约传入（见 CreditPort.createFromBooking）
          storeId: 1,
          customerId: 9,
          amount: 10000,
        }),
      ).rejects.toThrow(new ConflictException('该挂账主体不属于此顾客'));
      expect(h.txInsertChain.values).not.toHaveBeenCalled();
    });

    it('成功链路：建单 → 回填单号 → 占用额度', async () => {
      const h = createHarness({
        txSelect: [[creditAccount()]],
        txInsert: [[{ insertId: 1 }]],
        txUpdate: [[{ affectedRows: 1 }], [{ affectedRows: 1 }]],
      });
      await expect(
        h.service.createFromBooking(h.tx as never, {
          creditAccountId: 3,
          bookingId: 55,
          // 挂账门店由调用方继承预约传入（见 CreditPort.createFromBooking）
          storeId: 1,
          customerId: 9,
          amount: 10000,
          actorId: 7,
        }),
      ).resolves.toMatchObject({ receivableId: 1 });
      expect(h.log).toEqual([
        'tx.select',
        'customers.requireById',
        'config.booking',
        'tx.insert.values',
        'tx.update.set',
        'tx.update.set',
      ]);
      // 第一次写是「回填单号」，第二次是「占用额度」
      expect(h.txWrite.update.mock.calls[0]?.[0]).toBe(bizReceivables);
      expect(h.txWrite.update.mock.calls[1]?.[0]).toBe(bizCreditAccounts);
    });

    it('receivable_no 用主键回填成 A + 店内日 + 补零 6 位', async () => {
      const h = createHarness({
        txSelect: [[creditAccount()]],
        txInsert: [[{ insertId: 1 }]],
        txUpdate: [[{ affectedRows: 1 }], [{ affectedRows: 1 }]],
      });
      const result = await h.service.createFromBooking(h.tx as never, {
        creditAccountId: 3,
        bookingId: 55,
        storeId: 1,
        customerId: 9,
        amount: 10000,
      });
      expect(result.receivableNo).toMatch(/^A\d{8}000001$/);
      const backfill = h.txWrite.set.mock.calls[0]?.[0] as Row;
      expect(backfill.receivableNo).toBe(result.receivableNo);
    });

    it('新建应收单是 open、settled_amount = 0', async () => {
      const h = createHarness({
        txSelect: [[creditAccount()]],
        txInsert: [[{ insertId: 1 }]],
        txUpdate: [[{ affectedRows: 1 }], [{ affectedRows: 1 }]],
      });
      await h.service.createFromBooking(h.tx as never, {
        creditAccountId: 3,
        bookingId: 55,
        storeId: 1,
        customerId: 9,
        amount: 10000,
        actorId: 7,
      });
      expect(h.txInsertChain.values.mock.calls[0]?.[0]).toMatchObject({
        creditAccountId: 3,
        bookingId: 55,
        storeId: 1,
        customerId: 9,
        amount: 10000,
        settledAmount: 0,
        status: 'open',
        createdBy: 7,
      });
    });

    it('账期跟随主体的 settle_day', async () => {
      const h = createHarness({
        txSelect: [[creditAccount({ settleDay: 25 })]],
        txInsert: [[{ insertId: 1 }]],
        txUpdate: [[{ affectedRows: 1 }], [{ affectedRows: 1 }]],
      });
      const result = await h.service.createFromBooking(h.tx as never, {
        creditAccountId: 3,
        bookingId: 55,
        storeId: 1,
        customerId: 9,
        amount: 10000,
      });
      expect(result.dueDate).toBe(
        resolveDueDate(25, shopToday('Asia/Shanghai')),
      );
    });

    it('settle_day = 0（不定期）时账期为 null', async () => {
      const h = createHarness({
        txSelect: [[creditAccount({ settleDay: 0 })]],
        txInsert: [[{ insertId: 1 }]],
        txUpdate: [[{ affectedRows: 1 }], [{ affectedRows: 1 }]],
      });
      const result = await h.service.createFromBooking(h.tx as never, {
        creditAccountId: 3,
        bookingId: 55,
        storeId: 1,
        customerId: 9,
        amount: 10000,
      });
      expect(result.dueDate).toBeNull();
    });

    it('额度占用的条件更新带 credit_limit 闸门（并发超额由它兜底）', async () => {
      const h = createHarness({
        txSelect: [[creditAccount()]],
        txInsert: [[{ insertId: 1 }]],
        txUpdate: [[{ affectedRows: 1 }], [{ affectedRows: 1 }]],
      });
      await h.service.createFromBooking(h.tx as never, {
        creditAccountId: 3,
        bookingId: 55,
        storeId: 1,
        customerId: 9,
        amount: 10000,
      });
      const claimWhere = h.txUpdateWhere[1];
      expect(sqlText(claimWhere)).toContain('credit_limit = 0 OR');
      expect(sqlText(claimWhere)).toContain(
        'used_amount + 10000 <= credit_limit',
      );
      const claimSet = h.txWrite.set.mock.calls[1]?.[0] as Row;
      expect(sqlText(claimSet.usedAmount)).toBe('used_amount + 10000');
    });

    it('并发下额度被别的单据占满 → 条件更新未命中，抛 409', async () => {
      const h = createHarness({
        txSelect: [[creditAccount()]],
        txInsert: [[{ insertId: 1 }]],
        txUpdate: [[{ affectedRows: 1 }], [{ affectedRows: 0 }]],
      });
      await expect(
        h.service.createFromBooking(h.tx as never, {
          creditAccountId: 3,
          bookingId: 55,
          // 挂账门店由调用方继承预约传入（见 CreditPort.createFromBooking）
          storeId: 1,
          customerId: 9,
          amount: 10000,
        }),
      ).rejects.toThrow(
        new ConflictException('挂账额度不足或已被其它单据占用，请刷新后重试'),
      );
    });

    it('挂账不写支付单（挂账不是收付动作）', async () => {
      const h = createHarness({
        txSelect: [[creditAccount()]],
        txInsert: [[{ insertId: 1 }]],
        txUpdate: [[{ affectedRows: 1 }], [{ affectedRows: 1 }]],
      });
      await h.service.createFromBooking(h.tx as never, {
        creditAccountId: 3,
        bookingId: 55,
        storeId: 1,
        customerId: 9,
        amount: 10000,
      });
      expect(h.payments.createInTx).not.toHaveBeenCalled();
      expect(h.members.recordConsumption).not.toHaveBeenCalled();
      expect(h.settlements.recalc).not.toHaveBeenCalled();
    });
  });

  /* ------------------------------------------------------------------ *
   * settle：销账
   * ------------------------------------------------------------------ */
  describe('settle（销账）', () => {
    it('销账明细为空 → 400，不开事务', async () => {
      const h = createHarness();
      await expect(
        h.service.settle(1, { payments: [], actorId: 7 }),
      ).rejects.toThrow(new BadRequestException('销账明细不能为空'));
      expect(h.transaction).not.toHaveBeenCalled();
    });

    it.each([[0], [-100], [0.4]])('销账金额 %s 非法 → 400', async (amount) => {
      const h = createHarness();
      await expect(
        h.service.settle(1, {
          payments: [{ channel: 'cash', amount }],
          actorId: 7,
        }),
      ).rejects.toThrow(new BadRequestException('金额必须为正整数（分）'));
      expect(h.transaction).not.toHaveBeenCalled();
    });

    it('应收单不存在 → 404', async () => {
      const h = createHarness({ txSelect: [[]] });
      await expect(
        h.service.settle(1, {
          payments: [{ channel: 'cash', amount: 10000 }],
          actorId: 7,
        }),
      ).rejects.toThrow(new NotFoundException('应收单不存在'));
    });

    it.each([['settled'], ['cancelled'], ['partial']])(
      '状态 %s 不可销账 → 409（partial 之外的终态一律拒）',
      async (status) => {
        const h = createHarness({ txSelect: [[receivable({ status })]] });
        if (status === 'partial') {
          // partial 是未结状态，允许继续销账
          await expect(
            h.service.settle(1, {
              payments: [{ channel: 'cash', amount: 4000 }],
              actorId: 7,
            }),
          ).resolves.toBeDefined();
          return;
        }
        await expect(
          h.service.settle(1, {
            payments: [{ channel: 'cash', amount: 10000 }],
            actorId: 7,
          }),
        ).rejects.toThrow(
          new ConflictException(`应收单当前状态（${status}）不可销账`),
        );
      },
    );

    it('销账总额超过未结金额 → 409 并给出剩余', async () => {
      const h = createHarness({
        txSelect: [[receivable({ amount: 10000, settledAmount: 6000 })]],
      });
      await expect(
        h.service.settle(1, {
          payments: [{ channel: 'cash', amount: 5000 }],
          actorId: 7,
        }),
      ).rejects.toThrow(
        new ConflictException('销账金额超出未结金额，剩余 ¥40.00'),
      );
      expect(h.payments.createInTx).not.toHaveBeenCalled();
    });

    it('应收单与主体都没绑顾客 → 400', async () => {
      const h = createHarness({
        txSelect: [[receivable({ customerId: null })], [{ customerId: null }]],
      });
      await expect(
        h.service.settle(1, {
          payments: [{ channel: 'cash', amount: 10000 }],
          actorId: 7,
        }),
      ).rejects.toThrow(
        new BadRequestException('应收单未关联顾客，无法生成销账支付单'),
      );
    });

    it('应收单没绑顾客时回落到主体绑定的顾客', async () => {
      const h = createHarness({
        txSelect: [
          [receivable({ customerId: null })],
          [{ customerId: 9 }],
          [{ settledAmount: 10000, status: 'settled' }],
        ],
        txUpdate: [[{ affectedRows: 1 }], [{ affectedRows: 1 }]],
        txInsert: [[{ insertId: 1 }]],
      });
      await h.service.settle(1, {
        payments: [{ channel: 'cash', amount: 10000 }],
        actorId: 7,
      });
      expect(h.payments.createInTx).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ customerId: 9 }),
        7,
      );
    });

    it('单笔现金销账：落支付单 + 销账记录 + 条件更新 + 回减额度 + 重算 + 计消费', async () => {
      const h = createHarness({
        txSelect: [
          [receivable()],
          [{ settledAmount: 10000, status: 'settled' }],
        ],
        txUpdate: [[{ affectedRows: 1 }], [{ affectedRows: 1 }]],
        txInsert: [[{ insertId: 1 }]],
      });
      await expect(
        h.service.settle(1, {
          payments: [{ channel: 'cash', amount: 10000 }],
          actorId: 7,
        }),
      ).resolves.toMatchObject({
        settledAmount: 10000,
        status: 'settled',
        payments: [{ paymentId: 101, channel: 'cash', status: 'success' }],
      });
      expect(h.payments.createInTx).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          customerId: 9,
          bookingId: 55,
          purpose: 'credit_settle',
          channel: 'cash',
          amount: 10000,
          receivedAmount: 10000,
        }),
        7,
      );
      expect(h.txInsertChain.values.mock.calls[0]?.[0]).toMatchObject({
        receivableId: 1,
        amount: 10000,
        payChannel: 'cash',
        paymentId: 101,
        createdBy: 7,
      });
      expect(h.settlements.recalc).toHaveBeenCalledWith(expect.anything(), 55);
      expect(h.members.recordConsumption).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          customerId: 9,
          paidAmount: 10000,
          bookingId: 55,
          payChannel: 'cash',
        }),
      );
    });

    it('销账闸门条件更新：SET 里 status/settled_at 读加完之后的 settled_amount', async () => {
      const h = createHarness({
        txSelect: [
          [receivable()],
          [{ settledAmount: 10000, status: 'settled' }],
        ],
        txUpdate: [[{ affectedRows: 1 }], [{ affectedRows: 1 }]],
        txInsert: [[{ insertId: 1 }]],
      });
      await h.service.settle(1, {
        payments: [{ channel: 'cash', amount: 10000 }],
        actorId: 7,
      });
      const set = h.txWrite.set.mock.calls[0]?.[0] as Row;
      // 写成 settled_amount + ? 会重复累加本次金额，导致提前置 settled
      expect(sqlText(set.status)).toBe(
        "IF(settled_amount >= amount, 'settled', 'partial')",
      );
      expect(sqlText(set.settledAt)).toBe(
        'IF(settled_amount >= amount, NOW(), settled_at)',
      );
      expect(sqlText(set.settledAmount)).toBe('settled_amount + 10000');
    });

    it('销账闸门的 WHERE 带「不得超额」条件', async () => {
      const h = createHarness({
        txSelect: [
          [receivable()],
          [{ settledAmount: 10000, status: 'settled' }],
        ],
        txUpdate: [[{ affectedRows: 1 }], [{ affectedRows: 1 }]],
        txInsert: [[{ insertId: 1 }]],
      });
      await h.service.settle(1, {
        payments: [{ channel: 'cash', amount: 10000 }],
        actorId: 7,
      });
      const gate = sqlText(h.txUpdateWhere[0]);
      expect(gate).toContain('settled_amount + 10000 <= amount');
      expect(gate).toContain('status');
    });

    it('回减额度用 GREATEST 兜底，无符号列不出现负数', async () => {
      const h = createHarness({
        txSelect: [
          [receivable()],
          [{ settledAmount: 10000, status: 'settled' }],
        ],
        txUpdate: [[{ affectedRows: 1 }], [{ affectedRows: 1 }]],
        txInsert: [[{ insertId: 1 }]],
      });
      await h.service.settle(1, {
        payments: [{ channel: 'cash', amount: 10000 }],
        actorId: 7,
      });
      expect(h.txWrite.update.mock.calls[1]?.[0]).toBe(bizCreditAccounts);
      const set = h.txWrite.set.mock.calls[1]?.[0] as Row;
      expect(sqlText(set.usedAmount)).toContain('GREATEST');
      expect(sqlText(set.usedAmount)).toContain('AS SIGNED');
    });

    it('并发双销账：条件更新未命中 → 409，不回减额度、不计消费', async () => {
      const h = createHarness({
        txSelect: [[receivable()]],
        txUpdate: [[{ affectedRows: 0 }]],
        txInsert: [[{ insertId: 1 }]],
      });
      await expect(
        h.service.settle(1, {
          payments: [{ channel: 'cash', amount: 10000 }],
          actorId: 7,
        }),
      ).rejects.toThrow(
        new ConflictException('应收单已被其它销账操作更新，请刷新后重试'),
      );
      expect(h.members.recordConsumption).not.toHaveBeenCalled();
      expect(h.settlements.recalc).not.toHaveBeenCalled();
    });

    it('在线渠道落 pending 且带 codeUrl，不计消费与积分（钱没到）', async () => {
      const h = createHarness({
        txSelect: [
          [receivable()],
          [{ settledAmount: 10000, status: 'settled' }],
        ],
        txUpdate: [[{ affectedRows: 1 }], [{ affectedRows: 1 }]],
        txInsert: [[{ insertId: 1 }]],
      });
      const result = await h.service.settle(1, {
        payments: [{ channel: 'wxpay_native', amount: 10000 }],
        actorId: 7,
      });
      expect(result.payments[0]).toMatchObject({
        status: 'pending',
        codeUrl: 'weixin://wxpay/prepay',
      });
      expect(result.payments[0]?.expireAt).toBeInstanceOf(Date);
      expect(h.members.recordConsumption).not.toHaveBeenCalled();
      // 但仍要重算预约资金状态，让 paid_amount 跟上已成功的那部分
      expect(h.settlements.recalc).toHaveBeenCalledWith(expect.anything(), 55);
    });

    it('混合渠道：只按已成功的实收金额累计消费一次', async () => {
      const h = createHarness({
        txSelect: [
          [receivable()],
          [{ settledAmount: 10000, status: 'settled' }],
        ],
        txUpdate: [[{ affectedRows: 1 }], [{ affectedRows: 1 }]],
        txInsert: [[{ insertId: 1 }], [{ insertId: 2 }]],
      });
      await h.service.settle(1, {
        payments: [
          { channel: 'cash', amount: 6000 },
          { channel: 'wxpay_native', amount: 4000 },
        ],
        actorId: 7,
      });
      expect(h.members.recordConsumption).toHaveBeenCalledTimes(1);
      expect(h.members.recordConsumption).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ paidAmount: 6000 }),
      );
    });

    it('多笔销账时 payChannel 记 null（渠道不唯一，不能瞎标）', async () => {
      const h = createHarness({
        txSelect: [
          [receivable()],
          [{ settledAmount: 10000, status: 'settled' }],
        ],
        txUpdate: [[{ affectedRows: 1 }], [{ affectedRows: 1 }]],
        txInsert: [[{ insertId: 1 }], [{ insertId: 2 }]],
      });
      await h.service.settle(1, {
        payments: [
          { channel: 'cash', amount: 6000 },
          { channel: 'alipay_offline', amount: 4000 },
        ],
        actorId: 7,
      });
      expect(h.members.recordConsumption).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ payChannel: null }),
      );
    });

    it('部分销账也重算预约资金状态', async () => {
      const h = createHarness({
        txSelect: [
          [receivable({ amount: 10000, settledAmount: 0 })],
          [{ settledAmount: 4000, status: 'partial' }],
        ],
        txUpdate: [[{ affectedRows: 1 }], [{ affectedRows: 1 }]],
        txInsert: [[{ insertId: 1 }]],
      });
      const result = await h.service.settle(1, {
        payments: [{ channel: 'cash', amount: 4000 }],
        actorId: 7,
      });
      expect(result).toMatchObject({ settledAmount: 4000, status: 'partial' });
      expect(h.settlements.recalc).toHaveBeenCalledWith(expect.anything(), 55);
    });

    it('应收单不挂预约时跳过重算', async () => {
      const h = createHarness({
        txSelect: [
          [receivable({ bookingId: null })],
          [{ settledAmount: 10000, status: 'settled' }],
        ],
        txUpdate: [[{ affectedRows: 1 }], [{ affectedRows: 1 }]],
        txInsert: [[{ insertId: 1 }]],
      });
      await h.service.settle(1, {
        payments: [{ channel: 'cash', amount: 10000 }],
        actorId: 7,
      });
      expect(h.settlements.recalc).not.toHaveBeenCalled();
      expect(h.members.recordConsumption).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ bookingId: null }),
      );
    });

    it('销账备注回落顺序：明细备注 → 单据备注 → 默认文案', async () => {
      const h = createHarness({
        txSelect: [
          [receivable({ receivableNo: 'A20260911000001' })],
          [{ settledAmount: 10000, status: 'settled' }],
        ],
        txUpdate: [[{ affectedRows: 1 }], [{ affectedRows: 1 }]],
        txInsert: [[{ insertId: 1 }]],
      });
      await h.service.settle(1, {
        payments: [{ channel: 'cash', amount: 10000, remark: '明细备注' }],
        remark: '单据备注',
        actorId: 7,
      });
      expect(h.payments.createInTx).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ remark: '明细备注' }),
        7,
      );
      expect(h.txInsertChain.values.mock.calls[0]?.[0]).toMatchObject({
        remark: '明细备注',
      });
    });

    it('明细无备注时用单据备注，仍无则用默认文案', async () => {
      const h = createHarness({
        txSelect: [
          [receivable()],
          [{ settledAmount: 10000, status: 'settled' }],
        ],
        txUpdate: [[{ affectedRows: 1 }], [{ affectedRows: 1 }]],
        txInsert: [[{ insertId: 1 }]],
      });
      await h.service.settle(1, {
        payments: [{ channel: 'cash', amount: 10000 }],
        actorId: 7,
      });
      expect(h.payments.createInTx).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          remark: '应收单 A20260911000001 销账',
        }),
        7,
      );
    });
  });

  /* ------------------------------------------------------------------ *
   * cancel：作废
   * ------------------------------------------------------------------ */
  describe('cancel（作废）', () => {
    it.each([[''], ['   ']])(
      '原因为空/纯空白 → 400，且不开事务',
      async (reason) => {
        const h = createHarness();
        await expect(h.service.cancel(1, reason, 7)).rejects.toThrow(
          new BadRequestException('作废原因必填'),
        );
        expect(h.transaction).not.toHaveBeenCalled();
      },
    );

    it('应收单不存在 → 404', async () => {
      const h = createHarness({ txSelect: [[]] });
      await expect(h.service.cancel(1, '挂错主体', 7)).rejects.toThrow(
        new NotFoundException('应收单不存在'),
      );
    });

    it('已有销账金额 → 409，不允许作废', async () => {
      const h = createHarness({
        txSelect: [[receivable({ settledAmount: 500, status: 'partial' })]],
      });
      await expect(h.service.cancel(1, '挂错主体', 7)).rejects.toThrow(
        new ConflictException('仅未销账的应收单可以作废'),
      );
    });

    it.each([['settled'], ['cancelled']])(
      '状态 %s（已终结）→ 409',
      async (status) => {
        const h = createHarness({ txSelect: [[receivable({ status })]] });
        await expect(h.service.cancel(1, '挂错主体', 7)).rejects.toThrow(
          new ConflictException('仅未销账的应收单可以作废'),
        );
      },
    );

    it('overdue 也算未销账，可以作废', async () => {
      const h = createHarness({
        txSelect: [[receivable({ status: 'overdue' })]],
        txUpdate: [
          [{ affectedRows: 1 }],
          [{ affectedRows: 1 }],
          [{ affectedRows: 1 }],
        ],
      });
      await expect(h.service.cancel(1, '挂错主体', 7)).resolves.toBeUndefined();
    });

    it('成功链路：置 cancelled → 回减额度 → 摘掉预约信用 → 重算', async () => {
      const h = createHarness({
        txSelect: [[receivable()]],
        txUpdate: [
          [{ affectedRows: 1 }],
          [{ affectedRows: 1 }],
          [{ affectedRows: 1 }],
        ],
      });
      await h.service.cancel(1, '挂错主体', 7);
      expect(h.log).toEqual([
        'transaction.begin',
        'tx.select',
        'tx.update.set',
        'tx.update.set',
        'tx.update.set',
        'settlements.recalc',
      ]);
      expect(h.txWrite.update.mock.calls[0]?.[0]).toBe(bizReceivables);
      expect(h.txWrite.update.mock.calls[1]?.[0]).toBe(bizCreditAccounts);
      expect(h.txWrite.update.mock.calls[2]?.[0]).toBe(bizBookings);
      expect(h.txWrite.set.mock.calls[2]?.[0]).toEqual({
        creditAccountId: null,
      });
      expect(h.settlements.recalc).toHaveBeenCalledWith(expect.anything(), 55);
    });

    it('作废时回减的额度是整单金额（不是剩余额）', async () => {
      const h = createHarness({
        txSelect: [[receivable({ amount: 12000 })]],
        txUpdate: [
          [{ affectedRows: 1 }],
          [{ affectedRows: 1 }],
          [{ affectedRows: 1 }],
        ],
      });
      await h.service.cancel(1, '挂错主体', 7);
      const set = h.txWrite.set.mock.calls[1]?.[0] as Row;
      expect(sqlText(set.usedAmount)).toBe(
        'GREATEST(CAST(used_amount AS SIGNED) - 12000, 0)',
      );
    });

    it('备注追加作废原因', async () => {
      const h = createHarness({
        txSelect: [[receivable({ remark: '原始备注' })]],
        txUpdate: [
          [{ affectedRows: 1 }],
          [{ affectedRows: 1 }],
          [{ affectedRows: 1 }],
        ],
      });
      await h.service.cancel(1, '挂错主体', 7);
      const set = h.txWrite.set.mock.calls[0]?.[0] as Row;
      expect(set.status).toBe('cancelled');
      expect(set.remark).toBe('原始备注 | 作废：挂错主体');
    });

    it('原备注为空时只写作废原因', async () => {
      const h = createHarness({
        txSelect: [[receivable({ remark: null })]],
        txUpdate: [
          [{ affectedRows: 1 }],
          [{ affectedRows: 1 }],
          [{ affectedRows: 1 }],
        ],
      });
      await h.service.cancel(1, '挂错主体', 7);
      const set = h.txWrite.set.mock.calls[0]?.[0] as Row;
      expect(set.remark).toBe('作废：挂错主体');
    });

    it('备注拼接后截断到 200 字', async () => {
      const h = createHarness({
        txSelect: [[receivable({ remark: 'x'.repeat(190) })]],
        txUpdate: [
          [{ affectedRows: 1 }],
          [{ affectedRows: 1 }],
          [{ affectedRows: 1 }],
        ],
      });
      await h.service.cancel(1, 'y'.repeat(50), 7);
      const set = h.txWrite.set.mock.calls[0]?.[0] as Row;
      expect((set.remark as string).length).toBe(200);
    });

    it('条件更新未命中（并发下状态已变）→ 409，不回减额度', async () => {
      const h = createHarness({
        txSelect: [[receivable()]],
        txUpdate: [[{ affectedRows: 0 }]],
      });
      await expect(h.service.cancel(1, '挂错主体', 7)).rejects.toThrow(
        new ConflictException('应收单状态已变更，请刷新后重试'),
      );
      expect(h.txWrite.set).toHaveBeenCalledTimes(1);
    });

    it('应收单不挂预约时不动预约表', async () => {
      const h = createHarness({
        txSelect: [[receivable({ bookingId: null })]],
        txUpdate: [[{ affectedRows: 1 }], [{ affectedRows: 1 }]],
      });
      await h.service.cancel(1, '挂错主体', 7);
      expect(h.txWrite.update).toHaveBeenCalledTimes(2);
      expect(h.settlements.recalc).not.toHaveBeenCalled();
    });
  });

  /* ------------------------------------------------------------------ *
   * markOverdue：逾期标记
   * ------------------------------------------------------------------ */
  describe('markOverdue（逾期标记）', () => {
    it('返回被标记的条数', async () => {
      const h = createHarness({ dbUpdate: [[{ affectedRows: 3 }]] });
      await expect(h.service.markOverdue()).resolves.toEqual({ overdue: 3 });
    });

    it('只置 overdue 状态，不碰任何金额列', async () => {
      const h = createHarness({ dbUpdate: [[{ affectedRows: 1 }]] });
      await h.service.markOverdue();
      expect(h.dbWrite.update.mock.calls[0]?.[0]).toBe(bizReceivables);
      expect(h.dbWrite.set.mock.calls[0]?.[0]).toEqual({ status: 'overdue' });
    });

    it('只挑「未结 + 有到期日 + 已过期」的单，幂等可重跑', async () => {
      const h = createHarness({ dbUpdate: [[{ affectedRows: 1 }]] });
      await h.service.markOverdue();
      const where = sqlText(h.dbUpdateWhere[0]);
      expect(where).toContain('status');
      expect(where).toContain('due_date');
      expect(where).toContain('<');
      expect(where).toContain('deleted_at');
    });
  });

  /* ------------------------------------------------------------------ *
   * list / findOne：明细
   * ------------------------------------------------------------------ */
  describe('list / findOne', () => {
    it('list 计算剩余额并补主体名', async () => {
      const h = createHarness({
        // 第二次是 count 查询（total），第三次才是主体名
        dbSelect: [
          [receivable({ amount: 10000, settledAmount: 3000 })],
          [],
          [{ id: 3, name: '张三' }],
        ],
      });
      const result = await h.service.list(1, 20, {});
      expect(result.items[0]).toMatchObject({
        accountName: '张三',
        remainingAmount: 7000,
      });
      expect(result).toMatchObject({ page: 1, pageSize: 20 });
    });

    it('list 空结果时不查主体名（省一次往返）', async () => {
      const h = createHarness({ dbSelect: [[], []] });
      const result = await h.service.list(1, 20, {});
      expect(result.items).toEqual([]);
      // page + count 各一次；空结果不再查主体名
      expect(h.dbSelect).toHaveBeenCalledTimes(2);
    });

    it('list 的剩余额不会为负（超额脏数据兜底）', async () => {
      const h = createHarness({
        dbSelect: [
          [receivable({ amount: 10000, settledAmount: 12000 })],
          [],
          [{ id: 3, name: '张三' }],
        ],
      });
      const result = await h.service.list(1, 20, {});
      expect(result.items[0]?.remainingAmount).toBe(0);
    });

    it('findOne 不存在 → 404', async () => {
      const h = createHarness({ dbSelect: [[]] });
      await expect(h.service.findOne(1)).rejects.toThrow(
        new NotFoundException('应收单不存在'),
      );
    });

    it('findOne 带销账明细与主体名', async () => {
      const h = createHarness({
        dbSelect: [
          [receivable({ amount: 10000, settledAmount: 4000 })],
          [{ id: 1, amount: 4000, payChannel: 'cash' }],
          [{ id: 3, name: '张三' }],
        ],
      });
      const result = await h.service.findOne(1);
      expect(result).toMatchObject({
        accountName: '张三',
        remainingAmount: 6000,
      });
      expect(result.payments).toHaveLength(1);
    });
  });

  /* ------------------------------------------------------------------ *
   * summary：账龄汇总
   * ------------------------------------------------------------------ */
  describe('summary（账龄汇总）', () => {
    const today = shopToday('Asia/Shanghai');

    it('按 0-30 / 31-60 / 60+ 分档，逾期金额单列', async () => {
      const h = createHarness({
        dbSelect: [
          [
            {
              id: 3,
              name: '张三',
              type: 'customer',
              creditLimit: 50000,
              usedAmount: 19000,
            },
          ],
          [
            {
              creditAccountId: 3,
              amount: 10000,
              settledAmount: 0,
              dueDate: addLocalDays(today, -10),
              createdAt: new Date(),
            },
            {
              creditAccountId: 3,
              amount: 8000,
              settledAmount: 3000,
              dueDate: addLocalDays(today, -45),
              createdAt: new Date(),
            },
            {
              creditAccountId: 3,
              amount: 6000,
              settledAmount: 6000,
              dueDate: addLocalDays(today, -90),
              createdAt: new Date(),
            },
            {
              creditAccountId: 3,
              amount: 4000,
              settledAmount: 0,
              dueDate: addLocalDays(today, 5),
              createdAt: new Date(),
            },
          ],
        ],
      });
      const [row] = await h.service.summary();
      expect(row).toMatchObject({
        creditAccountId: 3,
        name: '张三',
        creditLimit: 50000,
        usedAmount: 19000,
        totalAmount: 28000,
        settledAmount: 9000,
        balance: 19000,
        age0to30: 14000,
        age31to60: 5000,
        age60plus: 0,
        overdueAmount: 15000,
        openCount: 4,
      });
    });

    it('未到期的单归入 0-30 档，不计逾期', async () => {
      const h = createHarness({
        dbSelect: [
          [
            {
              id: 3,
              name: '张三',
              type: 'customer',
              creditLimit: 0,
              usedAmount: 4000,
            },
          ],
          [
            {
              creditAccountId: 3,
              amount: 4000,
              settledAmount: 0,
              dueDate: addLocalDays(today, 30),
              createdAt: new Date(),
            },
          ],
        ],
      });
      const [row] = await h.service.summary();
      expect(row).toMatchObject({
        age0to30: 4000,
        age31to60: 0,
        age60plus: 0,
        overdueAmount: 0,
      });
    });

    it('无到期日时用 created_at 的店内日算账龄', async () => {
      const h = createHarness({
        dbSelect: [
          [
            {
              id: 3,
              name: '张三',
              type: 'customer',
              creditLimit: 0,
              usedAmount: 7000,
            },
          ],
          [
            {
              creditAccountId: 3,
              amount: 7000,
              settledAmount: 0,
              dueDate: null,
              createdAt: new Date(Date.now() - 20 * 86_400_000),
            },
          ],
        ],
      });
      const [row] = await h.service.summary();
      expect(row).toMatchObject({
        age0to30: 7000,
        overdueAmount: 0,
        openCount: 1,
      });
    });

    it('已结清的单（余额 0）仍计入 openCount 但不占余额', async () => {
      const h = createHarness({
        dbSelect: [
          [
            {
              id: 3,
              name: '张三',
              type: 'customer',
              creditLimit: 0,
              usedAmount: 0,
            },
          ],
          [
            {
              creditAccountId: 3,
              amount: 6000,
              settledAmount: 6000,
              dueDate: addLocalDays(today, -90),
              createdAt: new Date(),
            },
          ],
        ],
      });
      const [row] = await h.service.summary();
      expect(row).toMatchObject({
        totalAmount: 6000,
        settledAmount: 6000,
        balance: 0,
        age60plus: 0,
        overdueAmount: 0,
        openCount: 1,
      });
    });

    it('没有单据的主体补全零桶，不会漏掉主体', async () => {
      const h = createHarness({
        dbSelect: [
          [
            {
              id: 3,
              name: '张三',
              type: 'customer',
              creditLimit: 50000,
              usedAmount: 0,
            },
            {
              id: 4,
              name: '某公司',
              type: 'company',
              creditLimit: 100000,
              usedAmount: 0,
            },
          ],
          [
            {
              creditAccountId: 4,
              amount: 20000,
              settledAmount: 0,
              dueDate: addLocalDays(today, -5),
              createdAt: new Date(),
            },
          ],
        ],
      });
      const rows = await h.service.summary();
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({
        creditAccountId: 3,
        balance: 0,
        openCount: 0,
        overdueAmount: 0,
      });
      expect(rows[1]).toMatchObject({
        creditAccountId: 4,
        balance: 20000,
        openCount: 1,
      });
    });

    it('多个主体的账龄互不串桶', async () => {
      const h = createHarness({
        dbSelect: [
          [
            {
              id: 3,
              name: '张三',
              type: 'customer',
              creditLimit: 0,
              usedAmount: 1000,
            },
            {
              id: 4,
              name: '某公司',
              type: 'company',
              creditLimit: 0,
              usedAmount: 2000,
            },
          ],
          [
            {
              creditAccountId: 3,
              amount: 1000,
              settledAmount: 0,
              dueDate: addLocalDays(today, -5),
              createdAt: new Date(),
            },
            {
              creditAccountId: 4,
              amount: 2000,
              settledAmount: 0,
              dueDate: addLocalDays(today, -80),
              createdAt: new Date(),
            },
          ],
        ],
      });
      const rows = await h.service.summary();
      expect(rows[0]).toMatchObject({ age0to30: 1000, age60plus: 0 });
      expect(rows[1]).toMatchObject({ age0to30: 0, age60plus: 2000 });
    });
  });
});
