import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Param } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { PointsGoodsService } from './points-goods.service.js';

type Row = Record<string, unknown>;

/** 递归取出 SQL 条件里的绑定参数值（`and()` 会嵌子节点，必须递归） */
function boundValues(condition: unknown): unknown[] {
  const collected: unknown[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === 'string' || typeof node === 'number') {
      collected.push(node);
      return;
    }
    if (!node || typeof node !== 'object') return;
    if (node instanceof Param) {
      collected.push(node.value);
      return;
    }
    const chunks = (node as { queryChunks?: unknown[] }).queryChunks;
    if (Array.isArray(chunks)) chunks.forEach(walk);
  };
  walk(condition);
  return collected;
}

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
function chainFor(result: unknown, whereCalls?: unknown[]) {
  const make = (): Record<string, unknown> => {
    const node = Promise.resolve(result) as unknown as Record<string, unknown>;
    node.from = make;
    node.where = (condition?: unknown) => {
      whereCalls?.push(condition);
      return make();
    };
    node.leftJoin = make;
    node.orderBy = make;
    node.limit = make;
    node.offset = make;
    node.groupBy = make;
    return node;
  };
  return make();
}

type HarnessOptions = {
  /** `db.select()` 队列；每项是「一次查询返回的行数组」 */
  dbSelect?: unknown[][];
  /** `tx.select()` 队列 */
  txSelect?: unknown[][];
  /** `db.update().set().where()` 队列；每项是 `[{ affectedRows }]` */
  dbUpdate?: unknown[][];
  /** `tx.update().set().where()` 队列 */
  txUpdate?: unknown[][];
  /** `db.insert().values()` 队列；每项是 `[{ insertId }]` */
  dbInsert?: unknown[][];
  /** `tx.insert().values()` 队列 */
  txInsert?: unknown[][];
};

function createHarness(options: HarnessOptions = {}) {
  const log: string[] = [];
  const whereCalls: unknown[] = [];

  const dbSelectQueue = [...(options.dbSelect ?? [])];
  const dbSelect = vi.fn(() => {
    log.push('db.select');
    return chainFor(dbSelectQueue.shift() ?? [], whereCalls);
  });

  const txSelectQueue = [...(options.txSelect ?? [])];
  const txSelect = vi.fn(() => {
    log.push('tx.select');
    return chainFor(txSelectQueue.shift() ?? [], whereCalls);
  });

  const dbUpdateQueue = [...(options.dbUpdate ?? [])];
  const dbUpdateSet = vi.fn((payload: unknown) => {
    log.push('db.update.set');
    void payload;
    return {
      where: vi.fn(() =>
        Promise.resolve(dbUpdateQueue.shift() ?? [{ affectedRows: 1 }]),
      ),
    };
  });
  const dbUpdate = vi.fn(() => ({ set: dbUpdateSet }));

  const txUpdateQueue = [...(options.txUpdate ?? [])];
  const txUpdateSet = vi.fn((payload: unknown) => {
    log.push('tx.update.set');
    void payload;
    return {
      where: vi.fn(() =>
        Promise.resolve(txUpdateQueue.shift() ?? [{ affectedRows: 1 }]),
      ),
    };
  });
  const txUpdate = vi.fn(() => ({ set: txUpdateSet }));

  const dbInsertQueue = [...(options.dbInsert ?? [])];
  const dbInsertValues = vi.fn((payload: unknown) => {
    log.push('db.insert.values');
    void payload;
    return Promise.resolve(dbInsertQueue.shift() ?? [{ insertId: 1 }]);
  });
  const dbInsert = vi.fn(() => ({ values: dbInsertValues }));

  const txInsertQueue = [...(options.txInsert ?? [])];
  const txInsertValues = vi.fn((payload: unknown) => {
    log.push('tx.insert.values');
    void payload;
    return Promise.resolve(txInsertQueue.shift() ?? [{ insertId: 1 }]);
  });
  const txInsert = vi.fn(() => ({ values: txInsertValues }));

  const tx = { select: txSelect, insert: txInsert, update: txUpdate };
  const transaction = vi.fn(
    async (callback: (t: unknown) => Promise<unknown>) => {
      log.push('transaction.begin');
      return callback(tx);
    },
  );

  const db = {
    select: dbSelect,
    insert: dbInsert,
    update: dbUpdate,
    transaction,
  };

  const config = {
    booking: vi.fn(async () => {
      log.push('config.booking');
      return { timezone: 'Asia/Shanghai' };
    }),
    member: vi.fn(async () => {
      log.push('config.member');
      return { pointsDiscountPerYuan: 100, maxPointsPermille: 300 };
    }),
  };

  const accounts = {
    getPricingContext: vi.fn(async () => {
      log.push('accounts.getPricingContext');
      return {
        customerId: 9,
        levelId: 1,
        levelDiscountPermille: 900,
        points: 500,
        balancePrincipal: 0,
        balanceBonus: 0,
      };
    }),
    deductPoints: vi.fn(async () => {
      log.push('accounts.deductPoints');
      return { transactionId: 77, amount: 3000 };
    }),
    creditPoints: vi.fn(async () => {
      log.push('accounts.creditPoints');
      return { transactionId: 78 };
    }),
  };

  const cards = {
    issueCard: vi.fn(async () => {
      log.push('cards.issueCard');
      return { id: 5, cardNo: 'C20260911000005', expireAt: null };
    }),
    voidCard: vi.fn(async () => {
      log.push('cards.voidCard');
      return true;
    }),
  };

  const cardTypes = {
    requireActiveCardType: vi.fn(async () => {
      log.push('cardTypes.requireActiveCardType');
      return {
        id: 3,
        name: '纯色美甲单次卡',
        price: 8800,
        totalTimes: 1,
        validDays: 365,
      };
    }),
  };

  const serviceItems = {
    requireActiveItems: vi.fn(async () => {
      log.push('serviceItems.requireActiveItems');
      return [
        {
          id: 11,
          name: '纯色美甲',
          durationMinutes: 60,
          bufferMinutes: 10,
          price: 10000,
        },
      ];
    }),
  };

  const service = new PointsGoodsService(
    { db } as never,
    config as never,
    accounts as never,
    cards as never,
    cardTypes as never,
    serviceItems as never,
  );

  return {
    service,
    log,
    whereCalls,
    transaction,
    config,
    accounts,
    cards,
    cardTypes,
    serviceItems,
    dbSelect,
    txSelect,
    dbUpdateSet,
    txUpdateSet,
    dbInsertValues,
    txInsertValues,
  };
}

const goods = (overrides: Row = {}): Row => ({
  id: 1,
  name: '纯色美甲体验卡',
  cardTypeId: 3,
  points: 500,
  stock: 10,
  perLimit: 1,
  status: 'active',
  sort: 0,
  remark: null,
  deletedAt: null,
  ...overrides,
});

const redeemRow = (overrides: Row = {}): Row => ({
  id: 42,
  redeemNo: 'X20260911000042',
  customerId: 9,
  goodsId: 1,
  points: 500,
  memberCardId: 5,
  status: 'success',
  remark: '积分兑换：纯色美甲体验卡',
  ...overrides,
});

describe('PointsGoodsService（§15.3 积分兑换 / §9.10 抵扣试算）', () => {
  /* ------------------------------------------------------------------ *
   * create：校验 + 取整 + 唯一性
   * ------------------------------------------------------------------ */
  describe('create', () => {
    it('名称重复直接 409，不写库', async () => {
      const h = createHarness({ dbSelect: [[{ id: 2 }]] });
      await expect(
        h.service.create({ name: '纯色美甲体验卡', cardTypeId: 3, points: 500 }, 7),
      ).rejects.toThrow(new ConflictException('兑换品名称已存在'));
      expect(h.dbInsertValues).not.toHaveBeenCalled();
    });

    it('卡种未启用时透传卡种域的异常，不写库', async () => {
      const h = createHarness({ dbSelect: [[]] });
      h.cardTypes.requireActiveCardType.mockRejectedValueOnce(
        new BadRequestException('卡种不存在或已停用'),
      );
      await expect(
        h.service.create({ name: '新兑换品', cardTypeId: 3, points: 500 }, 7),
      ).rejects.toThrow('卡种不存在或已停用');
      expect(h.dbInsertValues).not.toHaveBeenCalled();
    });

    it.each([
      [0, '所需积分必须是大于 0 的整数'],
      [-5, '所需积分必须是大于 0 的整数'],
      [0.5, '所需积分必须是大于 0 的整数'],
    ])('所需积分 %s 非法（取整后不足 1）→ 400', async (points, message) => {
      const h = createHarness({ dbSelect: [[]] });
      await expect(
        h.service.create({ name: '新兑换品', cardTypeId: 3, points }, 7),
      ).rejects.toThrow(new BadRequestException(message));
    });

    it('库存小于 -1 → 400', async () => {
      const h = createHarness({ dbSelect: [[]] });
      await expect(
        h.service.create(
          { name: '新兑换品', cardTypeId: 3, points: 500, stock: -2 },
          7,
        ),
      ).rejects.toThrow(new BadRequestException('库存必须是 -1（不限）或非负整数'));
    });

    it('每人限兑为负 → 400', async () => {
      const h = createHarness({ dbSelect: [[]] });
      await expect(
        h.service.create(
          { name: '新兑换品', cardTypeId: 3, points: 500, perLimit: -1 },
          7,
        ),
      ).rejects.toThrow(
        new BadRequestException('每人限兑必须是 0（不限）或正整数'),
      );
    });

    it('库存/限兑缺省时落 -1（不限库存）与 0（不限次数）', async () => {
      const h = createHarness({ dbSelect: [[]], dbInsert: [[{ insertId: 7 }]] });
      await h.service.create({ name: '新兑换品', cardTypeId: 3, points: 500 }, 7);
      const payload = h.dbInsertValues.mock.calls[0]?.[0] as Row;
      expect(payload.stock).toBe(-1);
      expect(payload.perLimit).toBe(0);
      expect(payload.points).toBe(500);
    });

    it('积分/库存/限兑/排序一律向下取整，不落小数', async () => {
      const h = createHarness({ dbSelect: [[]], dbInsert: [[{ insertId: 7 }]] });
      await h.service.create(
        {
          name: '新兑换品',
          cardTypeId: 3,
          points: 100.9,
          stock: 5.9,
          perLimit: 2.9,
          sort: 3.7,
        },
        7,
      );
      const payload = h.dbInsertValues.mock.calls[0]?.[0] as Row;
      expect(payload).toMatchObject({
        points: 100,
        stock: 5,
        perLimit: 2,
        sort: 3,
      });
    });

    it('未传 status 时不写入该列，交给库默认值', async () => {
      const h = createHarness({ dbSelect: [[]], dbInsert: [[{ insertId: 7 }]] });
      await h.service.create({ name: '新兑换品', cardTypeId: 3, points: 500 }, 7);
      const payload = h.dbInsertValues.mock.calls[0]?.[0] as Row;
      expect(payload).not.toHaveProperty('status');
      expect(payload).not.toHaveProperty('remark');
      expect(payload.createdBy).toBe(7);
      expect(payload.updatedBy).toBe(7);
    });

    it('返回自增主键', async () => {
      const h = createHarness({ dbSelect: [[]], dbInsert: [[{ insertId: 7 }]] });
      await expect(
        h.service.create({ name: '新兑换品', cardTypeId: 3, points: 500 }, 7),
      ).resolves.toEqual({ id: 7 });
    });
  });

  /* ------------------------------------------------------------------ *
   * update：存在性 + 条件校验（只在显式传参时校验）
   * ------------------------------------------------------------------ */
  describe('update', () => {
    it('兑换品不存在 → 404', async () => {
      const h = createHarness({ dbSelect: [[]] });
      await expect(
        h.service.update(1, { points: 600 }, 7),
      ).rejects.toThrow(new NotFoundException('积分兑换品不存在'));
      expect(h.dbUpdateSet).not.toHaveBeenCalled();
    });

    it('改名撞到别的兑换品 → 409', async () => {
      const h = createHarness({
        dbSelect: [[goods()], [{ id: 2 }]],
        dbUpdate: [[{ affectedRows: 1 }]],
      });
      await expect(
        h.service.update(1, { name: '已被占用的名字' }, 7),
      ).rejects.toThrow(new ConflictException('兑换品名称已存在'));
      expect(h.dbUpdateSet).not.toHaveBeenCalled();
    });

    it('唯一性检查带 excludeId，改成自己原名不算冲突', async () => {
      const h = createHarness({
        dbSelect: [[goods()], []],
        dbUpdate: [[{ affectedRows: 1 }]],
      });
      await h.service.update(1, { name: '纯色美甲体验卡' }, 7);
      // 第二次 select 是唯一性检查：条件里同时绑定了名称与自身 id
      const uniqueness = h.whereCalls[1];
      expect(boundValues(uniqueness)).toEqual(['纯色美甲体验卡', 1]);
    });

    it('只改状态时不会拿历史脏库存去校验（避免误报）', async () => {
      const h = createHarness({
        dbSelect: [[goods({ stock: -5 })]],
        dbUpdate: [[{ affectedRows: 1 }]],
      });
      await expect(
        h.service.update(1, { status: 'disabled' }, 7),
      ).resolves.toBeUndefined();
      const payload = h.dbUpdateSet.mock.calls[0]?.[0] as Row;
      expect(payload.status).toBe('disabled');
      expect(payload).not.toHaveProperty('stock');
    });

    it('显式传非法库存才校验 → 400', async () => {
      const h = createHarness({ dbSelect: [[goods()]] });
      await expect(h.service.update(1, { stock: -2 }, 7)).rejects.toThrow(
        new BadRequestException('库存必须是 -1（不限）或非负整数'),
      );
    });

    it('显式传非法积分才校验 → 400', async () => {
      const h = createHarness({ dbSelect: [[goods()]] });
      await expect(h.service.update(1, { points: 0 }, 7)).rejects.toThrow(
        new BadRequestException('所需积分必须是大于 0 的整数'),
      );
    });

    it('改卡种时校验新卡种处于启用状态', async () => {
      const h = createHarness({
        dbSelect: [[goods()]],
        dbUpdate: [[{ affectedRows: 1 }]],
      });
      await h.service.update(1, { cardTypeId: 8 }, 7);
      expect(h.cardTypes.requireActiveCardType).toHaveBeenCalledTimes(1);
    });

    it('只更新显式传入的字段，未传的列不写进 SET', async () => {
      const h = createHarness({
        dbSelect: [[goods()]],
        dbUpdate: [[{ affectedRows: 1 }]],
      });
      await h.service.update(1, { points: 600 }, 7);
      const payload = h.dbUpdateSet.mock.calls[0]?.[0] as Row;
      expect(payload.points).toBe(600);
      expect(payload.updatedBy).toBe(7);
      expect(payload).not.toHaveProperty('name');
      expect(payload).not.toHaveProperty('stock');
      expect(payload).not.toHaveProperty('perLimit');
    });

    it('条件更新未命中（并发下被删）→ 404', async () => {
      const h = createHarness({
        dbSelect: [[goods()]],
        dbUpdate: [[{ affectedRows: 0 }]],
      });
      await expect(
        h.service.update(1, { points: 600 }, 7),
      ).rejects.toThrow(new NotFoundException('积分兑换品不存在'));
    });
  });

  /* ------------------------------------------------------------------ *
   * remove：软删
   * ------------------------------------------------------------------ */
  describe('remove', () => {
    it('软删写 deletedAt，不物理删除', async () => {
      const h = createHarness({ dbUpdate: [[{ affectedRows: 1 }]] });
      await expect(h.service.remove(1, 7)).resolves.toBeUndefined();
      const payload = h.dbUpdateSet.mock.calls[0]?.[0] as Row;
      expect(payload.deletedAt).toBeInstanceOf(Date);
      expect(payload.updatedBy).toBe(7);
    });

    it('条件更新未命中 → 404', async () => {
      const h = createHarness({ dbUpdate: [[{ affectedRows: 0 }]] });
      await expect(h.service.remove(1, 7)).rejects.toThrow(
        new NotFoundException('积分兑换品不存在'),
      );
    });
  });

  /* ------------------------------------------------------------------ *
   * preview：只读试算（§9.10）
   * ------------------------------------------------------------------ */
  describe('preview（抵扣试算）', () => {
    it('按 §5.7 复算：maxPoints 是实际可用，capPoints 是上限本身', async () => {
      const h = createHarness();
      const result = await h.service.preview(9, [11]);
      // 原价 10000 → 9 折减 1000 → 折后 9000
      // 上限 300‰ = 2700 分；顾客 500 分按 100 分/元 = 500 分
      expect(result).toEqual({
        customerId: 9,
        points: 500,
        originalPrice: 10000,
        levelDiscountPermille: 900,
        levelDiscountAmount: 1000,
        maxPoints: 500,
        maxDiscountAmount: 500,
        capPoints: 2700,
        capDiscountAmount: 2700,
        pointsDiscountPerYuan: 100,
        maxPointsPermille: 300,
        payableAmount: 8500,
      });
    });

    it('顾客积分低于上限时 maxPoints 取积分、capPoints 仍是上限', async () => {
      const h = createHarness();
      h.accounts.getPricingContext.mockResolvedValueOnce({
        customerId: 9,
        levelId: 1,
        levelDiscountPermille: 900,
        points: 300,
        balancePrincipal: 0,
        balanceBonus: 0,
      });
      const result = await h.service.preview(9, [11]);
      expect(result.maxPoints).toBe(300);
      expect(result.maxDiscountAmount).toBe(300);
      expect(result.capPoints).toBe(2700);
      expect(result.capDiscountAmount).toBe(2700);
      expect(result.payableAmount).toBe(8700);
    });

    it('顾客积分远超上限时收敛到上限，两个字段相等', async () => {
      const h = createHarness();
      h.accounts.getPricingContext.mockResolvedValueOnce({
        customerId: 9,
        levelId: 1,
        levelDiscountPermille: 900,
        points: 99_999,
        balancePrincipal: 0,
        balanceBonus: 0,
      });
      const result = await h.service.preview(9, [11]);
      expect(result.maxPoints).toBe(2700);
      expect(result.capPoints).toBe(2700);
      expect(result.payableAmount).toBe(6300);
    });

    it('没有可用项目时原价与应付均为 0，不报错', async () => {
      const h = createHarness();
      h.serviceItems.requireActiveItems.mockResolvedValueOnce([]);
      const result = await h.service.preview(9, [11]);
      expect(result.originalPrice).toBe(0);
      expect(result.payableAmount).toBe(0);
      expect(result.maxPoints).toBe(0);
      expect(result.capPoints).toBe(0);
    });

    it('是只读操作：不开事务、不写任何表', async () => {
      const h = createHarness();
      await h.service.preview(9, [11]);
      expect(h.transaction).not.toHaveBeenCalled();
      expect(h.dbUpdateSet).not.toHaveBeenCalled();
      expect(h.dbInsertValues).not.toHaveBeenCalled();
      expect(h.accounts.deductPoints).not.toHaveBeenCalled();
    });
  });

  /* ------------------------------------------------------------------ *
   * redeem：扣分 + 发卡 + 写记录（同事务）
   * ------------------------------------------------------------------ */
  describe('redeem（兑换）', () => {
    it('兑换品不存在 → 404，不开事务', async () => {
      const h = createHarness({ dbSelect: [[]] });
      await expect(h.service.redeem(9, 1, 7)).rejects.toThrow(
        new NotFoundException('积分兑换品不存在'),
      );
      expect(h.transaction).not.toHaveBeenCalled();
    });

    it('兑换品已下架 → 409，不开事务', async () => {
      const h = createHarness({ dbSelect: [[goods({ status: 'disabled' })]] });
      await expect(h.service.redeem(9, 1, 7)).rejects.toThrow(
        new ConflictException('积分兑换品已下架'),
      );
      expect(h.transaction).not.toHaveBeenCalled();
    });

    it('库存条件更新未命中（已兑完）→ 409，且不扣积分', async () => {
      const h = createHarness({
        dbSelect: [[goods({ stock: 0 })]],
        txUpdate: [[{ affectedRows: 0 }]],
      });
      await expect(h.service.redeem(9, 1, 7)).rejects.toThrow(
        new ConflictException('积分兑换品已下架或已兑完'),
      );
      expect(h.accounts.deductPoints).not.toHaveBeenCalled();
      expect(h.cards.issueCard).not.toHaveBeenCalled();
    });

    it('达到每人限兑次数 → 409，且不扣积分', async () => {
      const h = createHarness({
        dbSelect: [[goods({ perLimit: 2 })]],
        txUpdate: [[{ affectedRows: 1 }]],
        txSelect: [[{ total: 2 }]],
      });
      await expect(h.service.redeem(9, 1, 7)).rejects.toThrow(
        new ConflictException('已达每人限兑次数'),
      );
      expect(h.accounts.deductPoints).not.toHaveBeenCalled();
    });

    it('限兑未达上限则放行', async () => {
      const h = createHarness({
        dbSelect: [[goods({ perLimit: 2 })]],
        txUpdate: [[{ affectedRows: 1 }], [{ affectedRows: 1 }]],
        txSelect: [[{ total: 1 }]],
        txInsert: [[{ insertId: 42 }]],
      });
      await expect(h.service.redeem(9, 1, 7)).resolves.toMatchObject({
        redeemId: 42,
      });
    });

    it('不限限兑（perLimit=0）时不查历史兑换次数', async () => {
      const h = createHarness({
        dbSelect: [[goods({ perLimit: 0 })]],
        txUpdate: [[{ affectedRows: 1 }], [{ affectedRows: 1 }]],
        txInsert: [[{ insertId: 42 }]],
      });
      await h.service.redeem(9, 1, 7);
      expect(h.txSelect).not.toHaveBeenCalled();
    });

    it('成功链路顺序：库存闸门 → 扣积分 → 发卡 → 写兑换记录 → 回填单号', async () => {
      const h = createHarness({
        dbSelect: [[goods({ perLimit: 0 })]],
        txUpdate: [[{ affectedRows: 1 }], [{ affectedRows: 1 }]],
        txInsert: [[{ insertId: 42 }]],
      });
      await h.service.redeem(9, 1, 7);
      expect(h.log).toEqual([
        'db.select', // requireActiveGoods
        'config.booking',
        'transaction.begin',
        'tx.update.set', // 1) 库存条件更新
        'accounts.deductPoints', // 2) 扣积分
        'cards.issueCard', // 3) 发卡
        'tx.insert.values', // 4) 兑换记录
        'tx.update.set', // 5) 回填 redeem_no
      ]);
    });

    it('扣积分参数：类型 points_redeem、积分取兑换品所需、备注带兑换品名', async () => {
      const h = createHarness({
        dbSelect: [[goods({ points: 800, perLimit: 0 })]],
        txUpdate: [[{ affectedRows: 1 }], [{ affectedRows: 1 }]],
        txInsert: [[{ insertId: 42 }]],
      });
      await h.service.redeem(9, 1, 7);
      expect(h.accounts.deductPoints).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          customerId: 9,
          points: 800,
          type: 'points_redeem',
          remark: '积分兑换：纯色美甲体验卡',
          actorId: 7,
        }),
      );
    });

    it('发卡参数：price=0、skipLedger=true（兑换卡不写购卡流水）', async () => {
      const h = createHarness({
        dbSelect: [[goods({ perLimit: 0 })]],
        txUpdate: [[{ affectedRows: 1 }], [{ affectedRows: 1 }]],
        txInsert: [[{ insertId: 42 }]],
      });
      await h.service.redeem(9, 1, 7);
      expect(h.cards.issueCard).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          customerId: 9,
          cardTypeId: 3,
          payChannel: 'cash',
          price: 0,
          skipLedger: true,
          actorId: 7,
        }),
      );
    });

    it('兑换记录 status=success 且 memberCardId 指向新发的卡', async () => {
      const h = createHarness({
        dbSelect: [[goods({ perLimit: 0 })]],
        txUpdate: [[{ affectedRows: 1 }], [{ affectedRows: 1 }]],
        txInsert: [[{ insertId: 42 }]],
      });
      await h.service.redeem(9, 1, 7);
      const payload = h.txInsertValues.mock.calls[0]?.[0] as Row;
      expect(payload).toMatchObject({
        customerId: 9,
        goodsId: 1,
        points: 500,
        memberCardId: 5,
        status: 'success',
        createdBy: 7,
      });
    });

    it('redeem_no 用主键回填成 X + 店内日 + 补零 6 位', async () => {
      const h = createHarness({
        dbSelect: [[goods({ perLimit: 0 })]],
        txUpdate: [[{ affectedRows: 1 }], [{ affectedRows: 1 }]],
        txInsert: [[{ insertId: 42 }]],
      });
      const result = await h.service.redeem(9, 1, 7);
      expect(result.redeemNo).toMatch(/^X\d{8}000042$/);
      const backfill = h.txUpdateSet.mock.calls[1]?.[0] as Row;
      expect(backfill.redeemNo).toBe(result.redeemNo);
    });

    it('返回兑换单号、扣分流水号、卡号与卡 id', async () => {
      const h = createHarness({
        dbSelect: [[goods({ perLimit: 0 })]],
        txUpdate: [[{ affectedRows: 1 }], [{ affectedRows: 1 }]],
        txInsert: [[{ insertId: 42 }]],
      });
      const result = await h.service.redeem(9, 1, 7);
      expect(result).toMatchObject({
        redeemId: 42,
        transactionId: 77,
        cardId: 5,
        cardNo: 'C20260911000005',
        points: 500,
      });
    });

    it('扣积分失败（积分不足）→ 整单抛出，不发卡、不写记录', async () => {
      const h = createHarness({
        dbSelect: [[goods({ perLimit: 0 })]],
        txUpdate: [[{ affectedRows: 1 }]],
      });
      h.accounts.deductPoints.mockRejectedValueOnce(
        new ConflictException('积分不足'),
      );
      await expect(h.service.redeem(9, 1, 7)).rejects.toThrow(
        new ConflictException('积分不足'),
      );
      expect(h.cards.issueCard).not.toHaveBeenCalled();
      expect(h.txInsertValues).not.toHaveBeenCalled();
    });

    it('发卡失败 → 整单抛出，不写兑换记录', async () => {
      const h = createHarness({
        dbSelect: [[goods({ perLimit: 0 })]],
        txUpdate: [[{ affectedRows: 1 }]],
      });
      h.cards.issueCard.mockRejectedValueOnce(
        new BadRequestException('卡种已停用'),
      );
      await expect(h.service.redeem(9, 1, 7)).rejects.toThrow('卡种已停用');
      expect(h.txInsertValues).not.toHaveBeenCalled();
    });
  });

  /* ------------------------------------------------------------------ *
   * revertRedeem：回补积分 + 废卡 + 回补库存
   * ------------------------------------------------------------------ */
  describe('revertRedeem（撤销兑换）', () => {
    it.each([[''], ['   ']])('原因为空/纯空白 → 400，且不开事务', async (reason) => {
      const h = createHarness();
      await expect(h.service.revertRedeem(42, reason, 7)).rejects.toThrow(
        new BadRequestException('撤销兑换必须填写原因'),
      );
      expect(h.transaction).not.toHaveBeenCalled();
    });

    it('兑换记录不存在 → 404', async () => {
      const h = createHarness({ txSelect: [[]] });
      await expect(h.service.revertRedeem(42, '顾客反悔', 7)).rejects.toThrow(
        new NotFoundException('兑换记录不存在'),
      );
    });

    it('已是撤销态 → 409，不再回补', async () => {
      const h = createHarness({
        txSelect: [[redeemRow({ status: 'reverted' })]],
      });
      await expect(h.service.revertRedeem(42, '顾客反悔', 7)).rejects.toThrow(
        new ConflictException('该兑换已撤销'),
      );
      expect(h.accounts.creditPoints).not.toHaveBeenCalled();
    });

    it('条件更新未命中（并发下已被撤销）→ 409，不回补', async () => {
      const h = createHarness({
        txSelect: [[redeemRow()]],
        txUpdate: [[{ affectedRows: 0 }]],
      });
      await expect(h.service.revertRedeem(42, '顾客反悔', 7)).rejects.toThrow(
        new ConflictException('该兑换已撤销'),
      );
      expect(h.accounts.creditPoints).not.toHaveBeenCalled();
    });

    it('成功链路：置 reverted → 回补积分 → 废卡 → 回补库存', async () => {
      const h = createHarness({
        txSelect: [[redeemRow()]],
        txUpdate: [[{ affectedRows: 1 }], [{ affectedRows: 1 }]],
      });
      await expect(h.service.revertRedeem(42, '顾客反悔', 7)).resolves.toEqual({
        redeemId: 42,
        points: 500,
        cardId: 5,
      });
      expect(h.log).toEqual([
        'transaction.begin',
        'tx.select',
        'tx.update.set',
        'accounts.creditPoints',
        'cards.voidCard',
        'tx.update.set',
      ]);
    });

    it('状态置 reverted 并把撤销原因追加进备注', async () => {
      const h = createHarness({
        txSelect: [[redeemRow({ remark: '积分兑换：纯色美甲体验卡' })]],
        txUpdate: [[{ affectedRows: 1 }], [{ affectedRows: 1 }]],
      });
      await h.service.revertRedeem(42, '顾客反悔', 7);
      const payload = h.txUpdateSet.mock.calls[0]?.[0] as Row;
      expect(payload.status).toBe('reverted');
      expect(payload.remark).toBe(
        '积分兑换：纯色美甲体验卡｜撤销原因：顾客反悔',
      );
    });

    it('回补积分数等于当初扣减数', async () => {
      const h = createHarness({
        txSelect: [[redeemRow({ points: 800 })]],
        txUpdate: [[{ affectedRows: 1 }], [{ affectedRows: 1 }]],
      });
      await h.service.revertRedeem(42, '顾客反悔', 7);
      expect(h.accounts.creditPoints).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          customerId: 9,
          points: 800,
          remark: '撤销兑换回补积分：顾客反悔',
          actorId: 7,
        }),
      );
    });

    it('废卡原因带上撤销原因，卡 id 取兑换记录上的卡', async () => {
      const h = createHarness({
        txSelect: [[redeemRow()]],
        txUpdate: [[{ affectedRows: 1 }], [{ affectedRows: 1 }]],
      });
      await h.service.revertRedeem(42, '顾客反悔', 7);
      expect(h.cards.voidCard).toHaveBeenCalledWith(
        expect.anything(),
        5,
        '撤销兑换：顾客反悔',
        7,
      );
    });

    it('兑换记录没关联卡时跳过废卡', async () => {
      const h = createHarness({
        txSelect: [[redeemRow({ memberCardId: null })]],
        txUpdate: [[{ affectedRows: 1 }], [{ affectedRows: 1 }]],
      });
      await expect(h.service.revertRedeem(42, '顾客反悔', 7)).resolves.toEqual({
        redeemId: 42,
        points: 500,
        cardId: null,
      });
      expect(h.cards.voidCard).not.toHaveBeenCalled();
    });

    it('备注拼接后截断到 200 字', async () => {
      const h = createHarness({
        txSelect: [[redeemRow({ remark: 'a'.repeat(190) })]],
        txUpdate: [[{ affectedRows: 1 }], [{ affectedRows: 1 }]],
      });
      await h.service.revertRedeem(42, 'b'.repeat(50), 7);
      const payload = h.txUpdateSet.mock.calls[0]?.[0] as Row;
      expect((payload.remark as string).length).toBe(200);
      expect((payload.remark as string).startsWith('a'.repeat(190))).toBe(true);
    });

    it('原备注为空时拼接结果以分隔符开头（不产生 null 字面量）', async () => {
      const h = createHarness({
        txSelect: [[redeemRow({ remark: null })]],
        txUpdate: [[{ affectedRows: 1 }], [{ affectedRows: 1 }]],
      });
      await h.service.revertRedeem(42, '顾客反悔', 7);
      const payload = h.txUpdateSet.mock.calls[0]?.[0] as Row;
      expect(payload.remark).toBe('｜撤销原因：顾客反悔');
    });

    it('回补库存用条件表达式，不限库存（-1）保持 -1', async () => {
      const h = createHarness({
        txSelect: [[redeemRow()]],
        txUpdate: [[{ affectedRows: 1 }], [{ affectedRows: 1 }]],
      });
      await h.service.revertRedeem(42, '顾客反悔', 7);
      const stockPayload = h.txUpdateSet.mock.calls[1]?.[0] as Row;
      // SET 里是原生 SQL 片段：IF(stock = -1, -1, stock + 1)
      // 直接写 stock + 1 会把「不限库存」从 -1 变成 0，等于凭空限量。
      expect(sqlText(stockPayload.stock)).toBe(
        'IF(stock = -1, -1, stock + 1)',
      );
    });
  });

  /* ------------------------------------------------------------------ *
   * 查询
   * ------------------------------------------------------------------ */
  describe('list / findOne / listRedeems', () => {
    it('findOne 不存在 → 404', async () => {
      const h = createHarness({ dbSelect: [[]] });
      await expect(h.service.findOne(1)).rejects.toThrow(
        new NotFoundException('积分兑换品不存在'),
      );
    });

    it('findOne 带上卡种名', async () => {
      const h = createHarness({
        dbSelect: [[{ ...goods(), cardTypeName: '纯色美甲单次卡' }]],
      });
      await expect(h.service.findOne(1)).resolves.toMatchObject({
        id: 1,
        cardTypeName: '纯色美甲单次卡',
      });
    });

    it('list 返回 items/page/pageSize（无 total）', async () => {
      const h = createHarness({ dbSelect: [[goods()]] });
      const result = await h.service.list(1, 20);
      expect(result).toEqual({ items: [goods()], page: 1, pageSize: 20 });
      expect(result).not.toHaveProperty('total');
    });

    it('listRedeems 返回 items/page/pageSize（无 total）', async () => {
      const h = createHarness({
        dbSelect: [[{ ...redeemRow(), customerName: '张三' }]],
      });
      const result = await h.service.listRedeems(2, 10, { status: 'success' });
      expect(result.page).toBe(2);
      expect(result.pageSize).toBe(10);
      expect(result).not.toHaveProperty('total');
    });
  });
});
