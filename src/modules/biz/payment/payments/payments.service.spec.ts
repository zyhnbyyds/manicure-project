import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { bizPayments, bizPaymentLogs } from '../../../../database/schema/index.js';
import type { PaymentDraft } from '../../common/ports.js';
import { PaymentsService } from './payments.service.js';

type Row = Record<string, unknown>;

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

function createHarness(options: {
  dbSelect?: unknown[][];
  txSelect?: unknown[][];
  txUpdate?: unknown[][];
  dbUpdate?: unknown[][];
  txInsert?: unknown[][];
  qrExpireMinutes?: number;
  wxpayConfigured?: boolean;
  alipayConfigured?: boolean;
} = {}) {
  const log: string[] = [];

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
  const txUpdate = vi.fn((table: unknown) => {
    void table;
    return { set: txUpdateSet };
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
    insert: txInsert,
    update: dbUpdate,
    transaction,
  };

  const bizConfig = {
    payment: vi.fn(async () => ({
      qrExpireMinutes: options.qrExpireMinutes ?? 5,
      reconcileHour: 6,
    })),
    booking: vi.fn(async () => ({ timezone: 'Asia/Shanghai' })),
  };

  const appConfig = {
    wxpay: { notifyUrl: 'https://shop.test/notify/wxpay' },
    alipay: { notifyUrl: 'https://shop.test/notify/alipay' },
  };

  const settlement = {
    recalc: vi.fn(async () => {
      log.push('settlement.recalc');
    }),
  };
  const members = {
    applyBalancePayment: vi.fn(async () => {
      log.push('members.applyBalancePayment');
    }),
    recordConsumption: vi.fn(async () => {
      log.push('members.recordConsumption');
    }),
  };
  const memberCards = {
    useCard: vi.fn(async () => {
      log.push('memberCards.useCard');
    }),
  };
  const notices = {
    send: vi.fn(async () => {
      log.push('notices.send');
      return { id: 1 };
    }),
  };

  const wxpay = {
    channel: 'wxpay_native',
    label: '微信支付',
    configured: options.wxpayConfigured ?? true,
    createNativeOrder: vi.fn(async () => {
      log.push('wxpay.createNativeOrder');
      return {
        codeUrl: 'weixin://wxpay/prepay',
        expireAt: new Date(),
        raw: { prepay_id: 'wx123' },
      };
    }),
    queryOrder: vi.fn(async () => {
      log.push('wxpay.queryOrder');
      return {
        status: 'pending',
        transactionId: null,
        amount: 0,
        paidAt: null,
        raw: {},
      };
    }),
    refund: vi.fn(),
    verifyNotify: vi.fn(async () => {
      log.push('wxpay.verifyNotify');
      return {
        outTradeNo: 'P000001ABC',
        transactionId: '4200001',
        amount: 10000,
        successTime: new Date('2026-09-11T02:00:00.000Z'),
        raw: { event: 'pay' },
      };
    }),
    downloadBill: vi.fn(),
    successReply: vi.fn(() => ({
      statusCode: 200,
      body: '{"code":"SUCCESS"}',
    })),
    failureReply: vi.fn((message: string) => ({
      statusCode: 500,
      body: JSON.stringify({ code: 'FAIL', message }),
    })),
  };

  const alipay = {
    channel: 'alipay_qr',
    label: '支付宝',
    configured: options.alipayConfigured ?? true,
    createNativeOrder: vi.fn(async () => ({
      codeUrl: 'https://qr.alipay.com/abc',
      expireAt: new Date(),
      raw: {},
    })),
    queryOrder: vi.fn(async () => ({
      status: 'pending',
      transactionId: null,
      amount: 0,
      paidAt: null,
      raw: {},
    })),
    refund: vi.fn(),
    verifyNotify: vi.fn(),
    downloadBill: vi.fn(),
    successReply: vi.fn(() => ({ statusCode: 200, body: 'success' })),
    failureReply: vi.fn((message: string) => ({
      statusCode: 500,
      body: `fail:${message}`,
    })),
  };

  const diffs = {
    reconcile: vi.fn(async () => {
      log.push('diffs.reconcile');
      return { diffs: 2 };
    }),
  };

  const service = new PaymentsService(
    { db } as never,
    bizConfig as never,
    appConfig as never,
    settlement as never,
    members as never,
    memberCards as never,
    notices as never,
    wxpay as never,
    alipay as never,
    diffs as never,
  );

  return {
    service,
    tx,
    log,
    transaction,
    bizConfig,
    settlement,
    members,
    memberCards,
    notices,
    wxpay,
    alipay,
    diffs,
    dbSelect,
    txSelect,
    txUpdate,
    txUpdateSet,
    txInsert,
    txInsertValues,
    dbUpdateSet,
  };
}

const draft = (overrides: Partial<PaymentDraft> = {}): PaymentDraft => ({
  customerId: 9,
  bookingId: 55,
  purpose: 'final',
  channel: 'cash',
  amount: 10000,
  ...overrides,
});

const payment = (overrides: Row = {}): Row => ({
  id: 1,
  paymentNo: 'P20260911000001',
  outTradeNo: 'P000001ABCDEF',
  bookingId: 55,
  customerId: 9,
  purpose: 'final',
  channel: 'wxpay_native',
  amount: 10000,
  receivedAmount: 10000,
  status: 'pending',
  codeUrl: null,
  transactionId: null,
  paidAt: null,
  expireAt: new Date(Date.now() + 300_000),
  refundedAmount: 0,
  callbackAt: null,
  remark: null,
  deletedAt: null,
  ...overrides,
});

describe('PaymentsService（§17 收银台）', () => {
  /* ------------------------------------------------------------------ *
   * createInTx：收款核心
   * ------------------------------------------------------------------ */
  describe('createInTx（同事务落支付单）', () => {
    it('credit 渠道被拒（挂账走 CreditPort，不走收银台）', async () => {
      const h = createHarness();
      await expect(
        h.service.createInTx(h.tx as never, draft({ channel: 'credit' })),
      ).rejects.toThrow(
        new BadRequestException('挂账请使用 creditAccountId'),
      );
      expect(h.txInsertValues).not.toHaveBeenCalled();
    });

    it.each([[Number.NaN], [-1], [Number.POSITIVE_INFINITY]])(
      '金额 %s 不合法 → 400',
      async (amount) => {
        const h = createHarness();
        await expect(
          h.service.createInTx(h.tx as never, draft({ amount })),
        ).rejects.toThrow(new BadRequestException('金额不合法'));
      },
    );

    it.each([['wechat'], ['alipay']])(
      '端口渠道 %s 不是合法列值 → 400（必须收窄成 offline / native）',
      async (channel) => {
        const h = createHarness();
        await expect(
          h.service.createInTx(
            h.tx as never,
            draft({ channel: channel as never }),
          ),
        ).rejects.toThrow(
          new BadRequestException(
            '在线收款请使用 wxpay_native / alipay_qr，店家收款码请使用 wechat_offline / alipay_offline',
          ),
        );
      },
    );

    it('非现金渠道实收超过应收 → 400', async () => {
      const h = createHarness();
      await expect(
        h.service.createInTx(
          h.tx as never,
          draft({ channel: 'wechat_offline', amount: 10000, receivedAmount: 12000 }),
        ),
      ).rejects.toThrow(
        new BadRequestException('实收金额不得超过应收金额'),
      );
    });

    it('现金允许多收（找零）', async () => {
      const h = createHarness({ txInsert: [[{ insertId: 1 }]] });
      await expect(
        h.service.createInTx(
          h.tx as never,
          draft({ channel: 'cash', amount: 10000, receivedAmount: 12000 }),
        ),
      ).resolves.toMatchObject({ receivedAmount: 12000 });
    });

    it('实收为负 → 400', async () => {
      const h = createHarness();
      await expect(
        h.service.createInTx(h.tx as never, draft({ receivedAmount: -1 })),
      ).rejects.toThrow(new BadRequestException('实收金额不合法'));
    });

    it('次卡渠道缺 memberCardId → 400', async () => {
      const h = createHarness();
      await expect(
        h.service.createInTx(h.tx as never, draft({ channel: 'card' })),
      ).rejects.toThrow(
        new BadRequestException('次卡核销必须指定 memberCardId'),
      );
    });

    it('线下现金：直接 success，落 paidAt', async () => {
      const h = createHarness({ txInsert: [[{ insertId: 1 }]] });
      const result = await h.service.createInTx(h.tx as never, draft());
      expect(result).toMatchObject({
        status: 'success',
        channel: 'cash',
        amount: 10000,
        receivedAmount: 10000,
        codeUrl: null,
        expireAt: null,
      });
      const payload = h.txInsertValues.mock.calls[0]?.[0] as Row;
      expect(payload.status).toBe('success');
      expect(payload.paidAt).toBeInstanceOf(Date);
      expect(payload.expireAt).toBeNull();
    });

    it('线下渠道 status=success 且不等渠道', async () => {
      const h = createHarness({ txInsert: [[{ insertId: 1 }]] });
      await h.service.createInTx(
        h.tx as never,
        draft({ channel: 'wechat_offline' }),
      );
      expect(h.wxpay.createNativeOrder).not.toHaveBeenCalled();
      expect(h.alipay.createNativeOrder).not.toHaveBeenCalled();
    });

    it('在线渠道：落 pending + expireAt = now + qrExpireMinutes，写 code_url', async () => {
      const h = createHarness({ txInsert: [[{ insertId: 1 }]] });
      const before = Date.now();
      const result = await h.service.createInTx(
        h.tx as never,
        draft({ channel: 'wxpay_native' }),
      );
      expect(result.status).toBe('pending');
      expect(result.codeUrl).toBe('weixin://wxpay/prepay');
      expect(result.expireAt).toBeInstanceOf(Date);
      const delta = (result.expireAt as Date).getTime() - before;
      // qrExpireMinutes = 5 → 300000ms（留 5s 容差给执行时间）
      expect(delta).toBeGreaterThan(295_000);
      expect(delta).toBeLessThanOrEqual(300_000);
      const payload = h.txInsertValues.mock.calls[0]?.[0] as Row;
      expect(payload.status).toBe('pending');
      expect(payload.paidAt).toBeNull();
      expect(payload.transactionId).toBeNull();
    });

    it('在线渠道下单参数：商户订单号、金额、过期时间、回调地址', async () => {
      const h = createHarness({ txInsert: [[{ insertId: 1 }]] });
      await h.service.createInTx(
        h.tx as never,
        draft({ channel: 'wxpay_native', purpose: 'recharge' }),
      );
      expect(h.wxpay.createNativeOrder).toHaveBeenCalledWith(
        expect.objectContaining({
          amount: 10000,
          notifyUrl: 'https://shop.test/notify/wxpay',
          description: expect.stringContaining('储值充值'),
        }),
      );
    });

    it('支付宝走自己的回调地址', async () => {
      const h = createHarness({ txInsert: [[{ insertId: 1 }]] });
      await h.service.createInTx(
        h.tx as never,
        draft({ channel: 'alipay_qr' }),
      );
      expect(h.alipay.createNativeOrder).toHaveBeenCalledWith(
        expect.objectContaining({
          notifyUrl: 'https://shop.test/notify/alipay',
        }),
      );
    });

    it('在线通道未启用 → 抛错且不留 pending 单', async () => {
      const h = createHarness({
        wxpayConfigured: false,
        txInsert: [[{ insertId: 1 }]],
      });
      await expect(
        h.service.createInTx(h.tx as never, draft({ channel: 'wxpay_native' })),
      ).rejects.toThrow(new ConflictException('微信支付通道未启用'));
      // 抛错前已经 insert 过一次，但同事务回滚 → 由调用方的事务保证
      expect(h.wxpay.createNativeOrder).not.toHaveBeenCalled();
    });

    it('单号回填：paymentNo = P+店内日+主键，outTradeNo 带时间戳后缀', async () => {
      const h = createHarness({ txInsert: [[{ insertId: 1 }]] });
      const result = await h.service.createInTx(h.tx as never, draft());
      expect(result.paymentNo).toMatch(/^P\d{8}000001$/);
      expect(result.outTradeNo).toMatch(/^P000001[0-9A-Z]+$/);
      const backfill = h.txUpdateSet.mock.calls[0]?.[0] as Row;
      expect(backfill.paymentNo).toBe(result.paymentNo);
      expect(backfill.outTradeNo).toBe(result.outTradeNo);
    });

    it('插入时的单号是一次性占位（保证 UNIQUE 不冲突），不是空串', async () => {
      const h = createHarness({ txInsert: [[{ insertId: 1 }]] });
      await h.service.createInTx(h.tx as never, draft());
      const payload = h.txInsertValues.mock.calls[0]?.[0] as Row;
      expect(payload.paymentNo).toMatch(/^[0-9a-f]{32}$/);
      expect(payload.outTradeNo).toMatch(/^[0-9a-f]{32}$/);
      expect(payload.paymentNo).not.toBe(payload.outTradeNo);
    });

    it('储值支付必须先扣余额、再落支付单（锁顺序 biz_customer → biz_payment）', async () => {
      const h = createHarness({ txInsert: [[{ insertId: 1 }]] });
      await h.service.createInTx(h.tx as never, draft({ channel: 'balance' }));
      expect(h.log).toEqual([
        'members.applyBalancePayment',
        'tx.insert.values',
        'tx.update.set',
        'tx.insert.values',
      ]);
      expect(h.members.applyBalancePayment).toHaveBeenCalledWith(
        h.tx,
        expect.objectContaining({ customerId: 9, amount: 10000, bookingId: 55 }),
      );
    });

    it('非储值渠道不碰余额', async () => {
      const h = createHarness({ txInsert: [[{ insertId: 1 }]] });
      await h.service.createInTx(h.tx as never, draft());
      expect(h.members.applyBalancePayment).not.toHaveBeenCalled();
    });

    it('次卡渠道：amount / receivedAmount 一律 0，且在支付单之后核销（锁顺序 biz_payment → biz_member_card）', async () => {
      const h = createHarness({
        txInsert: [[{ insertId: 1 }]],
        txSelect: [[{ serviceItemId: 11 }]],
      });
      const result = await h.service.createInTx(
        h.tx as never,
        draft({ channel: 'card', amount: 10000, memberCardId: 7 }),
      );
      expect(result).toMatchObject({ amount: 0, receivedAmount: 0 });
      expect(h.log).toEqual([
        'tx.insert.values',
        'tx.update.set',
        'tx.select',
        'memberCards.useCard',
        'tx.insert.values',
      ]);
      expect(h.memberCards.useCard).toHaveBeenCalledWith(
        h.tx,
        expect.objectContaining({
          cardId: 7,
          serviceItemId: 11,
          bookingId: 55,
        }),
      );
    });

    it('次卡核销按预约第一个项目（按 sort、id 排序取一条）', async () => {
      const h = createHarness({
        txInsert: [[{ insertId: 1 }]],
        txSelect: [[{ serviceItemId: 12 }]],
      });
      await h.service.createInTx(
        h.tx as never,
        draft({ channel: 'card', memberCardId: 7 }),
      );
      expect(h.txInsert.mock.calls[0]?.[0]).toBe(bizPayments);
      expect(h.txSelect).toHaveBeenCalledTimes(1);
    });

    it('次卡核销不关联预约 → 400', async () => {
      const h = createHarness({ txInsert: [[{ insertId: 1 }]] });
      await expect(
        h.service.createInTx(
          h.tx as never,
          draft({ channel: 'card', memberCardId: 7, bookingId: null }),
        ),
      ).rejects.toThrow(new BadRequestException('次卡核销必须关联预约'));
    });

    it('预约没有项目明细 → 400', async () => {
      const h = createHarness({
        txInsert: [[{ insertId: 1 }]],
        txSelect: [[]],
      });
      await expect(
        h.service.createInTx(
          h.tx as never,
          draft({ channel: 'card', memberCardId: 7 }),
        ),
      ).rejects.toThrow(
        new BadRequestException('预约没有项目明细，无法核销次卡'),
      );
    });

    it('每次落单都写 create 日志', async () => {
      const h = createHarness({ txInsert: [[{ insertId: 1 }]] });
      await h.service.createInTx(h.tx as never, draft({ channel: 'cash' }), 7);
      const logCall = h.txInsert.mock.calls[1];
      expect(logCall?.[0]).toBe(bizPaymentLogs);
      expect(h.txInsertValues.mock.calls[1]?.[0]).toMatchObject({
        paymentId: 1,
        event: 'create',
      });
    });

    it('create 日志带渠道/金额/状态/操作人，供对账取证', async () => {
      const h = createHarness({ txInsert: [[{ insertId: 1 }]] });
      await h.service.createInTx(h.tx as never, draft({ channel: 'cash' }), 7);
      const logPayload = h.txInsertValues.mock.calls[1]?.[0] as Row;
      const raw = logPayload.raw as Row;
      expect(raw).toMatchObject({
        channel: 'cash',
        purpose: 'final',
        amount: 10000,
        status: 'success',
        operator: 7,
      });
    });
  });

  /* ------------------------------------------------------------------ *
   * create：独立收款项
   * ------------------------------------------------------------------ */
  describe('create（自己开事务）', () => {
    it('开事务后委托给 createInTx', async () => {
      const h = createHarness({ txInsert: [[{ insertId: 1 }]] });
      await h.service.create(draft({ purpose: 'recharge' }), 7);
      expect(h.transaction).toHaveBeenCalledTimes(1);
      expect(h.txInsertValues.mock.calls[0]?.[0]).toMatchObject({
        purpose: 'recharge',
        createdBy: 7,
      });
    });
  });

  /* ------------------------------------------------------------------ *
   * closePendingOfBooking
   * ------------------------------------------------------------------ */
  describe('closePendingOfBooking（重新收款前关掉旧单）', () => {
    it('逐笔条件更新为 closed 并写 close 日志', async () => {
      const h = createHarness({
        txSelect: [[{ id: 1 }, { id: 2 }]],
        txUpdate: [[{ affectedRows: 1 }], [{ affectedRows: 1 }]],
      });
      await expect(
        h.service.closePendingOfBooking(h.tx as never, 55, 7),
      ).resolves.toEqual({ closed: 2 });
      const logPayloads = h.txInsertValues.mock.calls.map(
        (call) => call[0] as Row,
      );
      expect(logPayloads.every((payload) => payload.event === 'close')).toBe(
        true,
      );
      expect(logPayloads[0]?.raw).toMatchObject({ reason: 'recollect' });
    });

    it('条件更新未命中的（已被回调抢走）不计数', async () => {
      const h = createHarness({
        txSelect: [[{ id: 1 }, { id: 2 }]],
        txUpdate: [[{ affectedRows: 0 }], [{ affectedRows: 1 }]],
      });
      await expect(
        h.service.closePendingOfBooking(h.tx as never, 55, 7),
      ).resolves.toEqual({ closed: 1 });
      expect(h.txInsertValues).toHaveBeenCalledTimes(1);
    });

    it('没有 pending 单时不开写', async () => {
      const h = createHarness({ txSelect: [[]] });
      await expect(
        h.service.closePendingOfBooking(h.tx as never, 55, 7),
      ).resolves.toEqual({ closed: 0 });
      expect(h.txUpdateSet).not.toHaveBeenCalled();
    });
  });

  /* ------------------------------------------------------------------ *
   * handleNotify：渠道回调
   * ------------------------------------------------------------------ */
  describe('handleNotify（回调）', () => {
    const notify = { headers: {}, body: {}, rawBody: '{}' };

    it('通道未配置 → 返回失败应答，不放行', async () => {
      const h = createHarness({ wxpayConfigured: false });
      const reply = await h.service.handleNotify('wxpay_native', notify);
      expect(reply.statusCode).toBe(500);
      expect(h.wxpay.verifyNotify).not.toHaveBeenCalled();
      expect(h.transaction).not.toHaveBeenCalled();
    });

    it('验签失败 → 返回失败应答，不查单', async () => {
      const h = createHarness();
      h.wxpay.verifyNotify.mockRejectedValueOnce(new Error('签名不匹配'));
      const reply = await h.service.handleNotify('wxpay_native', notify);
      expect(reply.statusCode).toBe(500);
      expect(reply.body).toContain('签名不匹配');
      expect(h.transaction).not.toHaveBeenCalled();
    });

    it('支付单不存在 → 失败应答', async () => {
      const h = createHarness({ dbSelect: [[]] });
      const reply = await h.service.handleNotify('wxpay_native', notify);
      expect(reply.statusCode).toBe(500);
      expect(reply.body).toContain('支付单不存在');
    });

    it('金额不一致 → 写 callback_invalid 日志并拒绝，绝不按回调金额改账', async () => {
      const h = createHarness({
        dbSelect: [[payment({ amount: 10000 })]],
      });
      h.wxpay.verifyNotify.mockResolvedValueOnce({
        outTradeNo: 'P000001ABCDEF',
        transactionId: '4200001',
        amount: 1,
        successTime: new Date(),
        raw: {},
      });
      const reply = await h.service.handleNotify('wxpay_native', notify);
      expect(reply.statusCode).toBe(500);
      expect(reply.body).toContain('回调金额与订单不一致');
      const logPayload = h.txInsertValues.mock.calls[0]?.[0] as Row;
      expect(logPayload).toMatchObject({
        paymentId: 1,
        event: 'callback_invalid',
      });
      expect(logPayload.raw).toMatchObject({
        reason: 'amount_mismatch',
        expected: 10000,
        actual: 1,
      });
      expect(h.transaction).not.toHaveBeenCalled();
    });

    it('金额一致 → 事务内落地并发通知', async () => {
      const h = createHarness({
        dbSelect: [[payment()]],
        txUpdate: [[{ affectedRows: 1 }]],
      });
      const reply = await h.service.handleNotify('wxpay_native', notify);
      expect(reply).toEqual({ statusCode: 200, body: '{"code":"SUCCESS"}' });
      const set = h.txUpdateSet.mock.calls[0]?.[0] as Row;
      expect(set).toMatchObject({
        status: 'success',
        transactionId: '4200001',
      });
      expect(set.paidAt).toBeInstanceOf(Date);
      expect(set.callbackAt).toBeInstanceOf(Date);
    });

    it('幂等闸门：只认 status=pending 的单', async () => {
      const h = createHarness({
        dbSelect: [[payment()]],
        txUpdate: [[{ affectedRows: 1 }]],
      });
      await h.service.handleNotify('wxpay_native', notify);
      const where = h.txUpdate.mock.calls[0]?.[0];
      expect(where).toBe(bizPayments);
      // WHERE 里同时约束 out_trade_no 与 status（幂等键）
      expect(h.txUpdateSet).toHaveBeenCalledTimes(1);
    });

    it('重复回调（影响行数 0）→ 仍答成功，且不重复发货', async () => {
      const h = createHarness({
        dbSelect: [[payment()]],
        txUpdate: [[{ affectedRows: 0 }]],
      });
      const reply = await h.service.handleNotify('wxpay_native', notify);
      expect(reply.statusCode).toBe(200);
      expect(h.settlement.recalc).not.toHaveBeenCalled();
      expect(h.members.recordConsumption).not.toHaveBeenCalled();
      expect(h.notices.send).not.toHaveBeenCalled();
    });

    it('落地后「发货」：预约重算 + 会员消费落账', async () => {
      const h = createHarness({
        dbSelect: [[payment()]],
        txUpdate: [[{ affectedRows: 1 }]],
      });
      await h.service.handleNotify('wxpay_native', notify);
      expect(h.settlement.recalc).toHaveBeenCalledWith(h.tx, 55);
      expect(h.members.recordConsumption).toHaveBeenCalledWith(
        h.tx,
        expect.objectContaining({
          customerId: 9,
          paidAmount: 10000,
          bookingId: 55,
          payChannel: 'wechat',
        }),
      );
    });

    it('发货时写 callback 事件日志', async () => {
      const h = createHarness({
        dbSelect: [[payment()]],
        txUpdate: [[{ affectedRows: 1 }]],
      });
      await h.service.handleNotify('wxpay_native', notify);
      const logPayload = h.txInsertValues.mock.calls[0]?.[0] as Row;
      expect(logPayload).toMatchObject({ paymentId: 1, event: 'callback' });
    });

    it('通知发送失败不影响回调应答（账已落）', async () => {
      const h = createHarness({
        dbSelect: [[payment({ purpose: 'recharge' })]],
        txUpdate: [[{ affectedRows: 1 }]],
      });
      h.notices.send.mockRejectedValueOnce(new Error('短信网关 500'));
      await expect(
        h.service.handleNotify('wxpay_native', notify),
      ).resolves.toMatchObject({ statusCode: 200 });
    });

    it('预约类收款不发「付款成功」通知（由预约链路负责，避免重复）', async () => {
      const h = createHarness({
        dbSelect: [[payment({ purpose: 'final' })]],
        txUpdate: [[{ affectedRows: 1 }]],
      });
      await h.service.handleNotify('wxpay_native', notify);
      expect(h.notices.send).not.toHaveBeenCalled();
    });

    it('充值类收款发通知，金额按元保留两位', async () => {
      const h = createHarness({
        dbSelect: [[payment({ purpose: 'recharge', receivedAmount: 12345 })]],
        txUpdate: [[{ affectedRows: 1 }]],
      });
      await h.service.handleNotify('wxpay_native', notify);
      expect(h.notices.send).toHaveBeenCalledWith(
        expect.objectContaining({
          templateCode: 'recharge_success',
          recipientType: 'customer',
          recipientId: 9,
          variables: expect.objectContaining({ amount: '123.45' }),
        }),
      );
    });

    it('支付单不挂预约时跳过重算，但仍计消费', async () => {
      const h = createHarness({
        dbSelect: [[payment({ bookingId: null })]],
        txUpdate: [[{ affectedRows: 1 }]],
      });
      await h.service.handleNotify('wxpay_native', notify);
      expect(h.settlement.recalc).not.toHaveBeenCalled();
      expect(h.members.recordConsumption).toHaveBeenCalledWith(
        h.tx,
        expect.objectContaining({ bookingId: null }),
      );
    });
  });

  /* ------------------------------------------------------------------ *
   * queryChannel：主动查单
   * ------------------------------------------------------------------ */
  describe('queryChannel（主动查单）', () => {
    it('支付单不存在 → 404', async () => {
      const h = createHarness({ dbSelect: [[]] });
      await expect(h.service.queryChannel(1, 7)).rejects.toThrow(
        new NotFoundException('支付单不存在'),
      );
    });

    it('非在线渠道 → 400（线下不需要查单）', async () => {
      const h = createHarness({
        dbSelect: [[payment({ channel: 'cash', status: 'pending' })]],
      });
      await expect(h.service.queryChannel(1, 7)).rejects.toThrow(
        new BadRequestException('该支付单不是在线支付，无需查单'),
      );
    });

    it('已是终态 → 直接返回本地状态，不打扰渠道', async () => {
      const h = createHarness({
        dbSelect: [[payment({ status: 'success' })]],
      });
      await expect(h.service.queryChannel(1, 7)).resolves.toEqual({
        status: 'success',
      });
      expect(h.wxpay.queryOrder).not.toHaveBeenCalled();
    });

    it('渠道返回 pending → 原样返回，不改本地状态', async () => {
      const h = createHarness({ dbSelect: [[payment()]] });
      h.wxpay.queryOrder.mockResolvedValueOnce({
        status: 'pending',
        transactionId: null,
        amount: 10000,
        paidAt: null,
        raw: {},
      });
      await expect(h.service.queryChannel(1, 7)).resolves.toEqual({
        status: 'pending',
      });
      expect(h.txUpdateSet).not.toHaveBeenCalled();
    });

    it('渠道返回 failed → 本地置 failed 并留痕', async () => {
      const h = createHarness({
        dbSelect: [[payment()]],
        txUpdate: [[{ affectedRows: 1 }]],
      });
      h.wxpay.queryOrder.mockResolvedValueOnce({
        status: 'failed',
        transactionId: null,
        amount: 10000,
        paidAt: null,
        raw: { err: 'x' },
      });
      await expect(h.service.queryChannel(1, 7)).resolves.toEqual({
        status: 'failed',
      });
      expect(h.txUpdateSet.mock.calls[0]?.[0]).toMatchObject({
        status: 'failed',
      });
      expect(h.txInsertValues.mock.calls[0]?.[0]).toMatchObject({
        event: 'query',
      });
    });

    it('渠道返回 closed → 本地置 closed', async () => {
      const h = createHarness({
        dbSelect: [[payment()]],
        txUpdate: [[{ affectedRows: 1 }]],
      });
      h.wxpay.queryOrder.mockResolvedValueOnce({
        status: 'closed',
        transactionId: null,
        amount: 10000,
        paidAt: null,
        raw: {},
      });
      await expect(h.service.queryChannel(1, 7)).resolves.toEqual({
        status: 'closed',
      });
      expect(h.txUpdateSet.mock.calls[0]?.[0]).toMatchObject({
        status: 'closed',
      });
    });

    it('渠道已终态但本地已被别的操作改掉（影响行数 0）→ 不写日志', async () => {
      const h = createHarness({
        dbSelect: [[payment()]],
        txUpdate: [[{ affectedRows: 0 }]],
      });
      h.wxpay.queryOrder.mockResolvedValueOnce({
        status: 'failed',
        transactionId: null,
        amount: 10000,
        paidAt: null,
        raw: {},
      });
      await h.service.queryChannel(1, 7);
      expect(h.txInsertValues).not.toHaveBeenCalled();
    });

    it('渠道成功但金额不一致 → 留证 + 409，不改账', async () => {
      const h = createHarness({ dbSelect: [[payment({ amount: 10000 })]] });
      h.wxpay.queryOrder.mockResolvedValueOnce({
        status: 'success',
        transactionId: '4200001',
        amount: 1,
        paidAt: new Date(),
        raw: {},
      });
      await expect(h.service.queryChannel(1, 7)).rejects.toThrow(
        new ConflictException('渠道金额与支付单不一致，请人工核对'),
      );
      const logPayload = h.txInsertValues.mock.calls[0]?.[0] as Row;
      expect(logPayload).toMatchObject({ event: 'callback_invalid' });
      expect(logPayload.raw).toMatchObject({
        reason: 'query_amount_mismatch',
      });
      expect(h.transaction).not.toHaveBeenCalled();
    });

    it('渠道成功但没给交易号 → 409', async () => {
      const h = createHarness({ dbSelect: [[payment()]] });
      h.wxpay.queryOrder.mockResolvedValueOnce({
        status: 'success',
        transactionId: null,
        amount: 10000,
        paidAt: new Date(),
        raw: {},
      });
      await expect(h.service.queryChannel(1, 7)).rejects.toThrow(
        new ConflictException('渠道未返回交易号，无法落地'),
      );
    });

    it('渠道成功 → 走与回调同一条幂等落地（event=query）', async () => {
      const h = createHarness({
        dbSelect: [[payment()]],
        txUpdate: [[{ affectedRows: 1 }]],
      });
      h.wxpay.queryOrder.mockResolvedValueOnce({
        status: 'success',
        transactionId: '4200001',
        amount: 10000,
        paidAt: new Date('2026-09-11T02:00:00.000Z'),
        raw: {},
      });
      await expect(h.service.queryChannel(1, 7)).resolves.toEqual({
        status: 'success',
      });
      const logPayload = h.txInsertValues.mock.calls[0]?.[0] as Row;
      expect(logPayload).toMatchObject({ event: 'query' });
      expect(h.settlement.recalc).toHaveBeenCalledWith(h.tx, 55);
    });

    it('查单落地成功才发通知', async () => {
      const h = createHarness({
        dbSelect: [[payment({ purpose: 'card_buy' })]],
        txUpdate: [[{ affectedRows: 1 }]],
      });
      h.wxpay.queryOrder.mockResolvedValueOnce({
        status: 'success',
        transactionId: '4200001',
        amount: 10000,
        paidAt: new Date(),
        raw: {},
      });
      await h.service.queryChannel(1, 7);
      expect(h.notices.send).toHaveBeenCalledWith(
        expect.objectContaining({ templateCode: 'recharge_success' }),
      );
    });
  });

  /* ------------------------------------------------------------------ *
   * queryPending：批量兜底
   * ------------------------------------------------------------------ */
  describe('queryPending（批量兜底）', () => {
    it('只挑「pending + 在线渠道 + 未过期」的单', async () => {
      const h = createHarness({ dbSelect: [[]] });
      await expect(h.service.queryPending()).resolves.toEqual({
        checked: 0,
        settled: 0,
      });
    });

    it('单笔查单失败被隔离，不影响其它单', async () => {
      const h = createHarness({
        dbSelect: [
          [{ id: 1 }, { id: 2 }],
          [payment({ id: 1 })],
          [payment({ id: 2 })],
        ],
      });
      h.wxpay.queryOrder
        .mockRejectedValueOnce(new Error('渠道超时'))
        .mockResolvedValueOnce({
          status: 'success',
          transactionId: '4200002',
          amount: 10000,
          paidAt: new Date(),
          raw: {},
        });
      await expect(h.service.queryPending()).resolves.toEqual({        checked: 2,
        settled: 1,
      });
    });
  });

  /* ------------------------------------------------------------------ *
   * 关单
   * ------------------------------------------------------------------ */
  describe('closeExpired（超时关单）', () => {
    it('没有过期单 → 不开事务', async () => {
      const h = createHarness({ dbSelect: [[]] });
      await expect(h.service.closeExpired()).resolves.toEqual({ closed: 0 });
      expect(h.transaction).not.toHaveBeenCalled();
    });

    it('逐笔条件更新为 closed 并写 close 日志（reason=expired）', async () => {
      const h = createHarness({
        dbSelect: [[{ id: 1 }, { id: 2 }]],
        txUpdate: [[{ affectedRows: 1 }], [{ affectedRows: 0 }]],
      });
      await expect(h.service.closeExpired()).resolves.toEqual({ closed: 1 });
      const logPayload = h.txInsertValues.mock.calls[0]?.[0] as Row;
      expect(logPayload.raw).toMatchObject({ reason: 'expired' });
    });

    it('只改状态、不碰钱', async () => {
      const h = createHarness({
        dbSelect: [[{ id: 1 }]],
        txUpdate: [[{ affectedRows: 1 }]],
      });
      await h.service.closeExpired();
      expect(h.txUpdateSet.mock.calls[0]?.[0]).toEqual({ status: 'closed' });
    });
  });

  describe('close（手动关单）', () => {
    it('支付单不存在 → 404', async () => {
      const h = createHarness({ dbSelect: [[]] });
      await expect(h.service.close(1, 7)).rejects.toThrow(
        new NotFoundException('支付单不存在'),
      );
    });

    it('非 pending → 409', async () => {
      const h = createHarness({
        dbSelect: [[payment()]],
        txUpdate: [[{ affectedRows: 0 }]],
      });
      await expect(h.service.close(1, 7)).rejects.toThrow(
        new ConflictException('只有待支付的支付单可以关单'),
      );
      expect(h.txInsertValues).not.toHaveBeenCalled();
    });

    it('成功 → 置 closed 并写 manual 日志', async () => {
      const h = createHarness({
        dbSelect: [[payment()]],
        txUpdate: [[{ affectedRows: 1 }]],
      });
      await expect(h.service.close(1, 7)).resolves.toBeUndefined();
      expect(h.txUpdateSet.mock.calls[0]?.[0]).toEqual({
        status: 'closed',
        updatedBy: 7,
      });
      expect(h.txInsertValues.mock.calls[0]?.[0]).toMatchObject({
        event: 'close',
      });
    });
  });

  /* ------------------------------------------------------------------ *
   * 查询
   * ------------------------------------------------------------------ */
  describe('list / findOne / statusOf / reconcile', () => {
    it('list 返回 items/page/pageSize', async () => {
      const h = createHarness({ dbSelect: [[payment()]] });
      await expect(h.service.list(2, 10, {})).resolves.toMatchObject({
        page: 2,
        pageSize: 10,
      });
    });

    it('list 空结果也返回分页壳', async () => {
      const h = createHarness({ dbSelect: [[]] });
      await expect(h.service.list(1, 20, {})).resolves.toEqual({
        items: [],
        page: 1,
        pageSize: 20,
      });
    });

    it('findOne 带日志明细', async () => {
      const h = createHarness({
        dbSelect: [[payment()], [{ id: 1, event: 'create' }]],
      });
      const result = await h.service.findOne(1);
      expect(result.logs).toHaveLength(1);
      expect(result.paymentNo).toBe('P20260911000001');
    });

    it('findOne 支付单不存在 → 404', async () => {
      const h = createHarness({ dbSelect: [[]] });
      await expect(h.service.findOne(1)).rejects.toThrow(
        new NotFoundException('支付单不存在'),
      );
    });

    it('statusOf 只取 id/status/paidAt', async () => {
      const h = createHarness({
        dbSelect: [[{ id: 1, status: 'success', paidAt: new Date() }]],
      });
      await expect(h.service.statusOf(1)).resolves.toMatchObject({
        id: 1,
        status: 'success',
      });
    });

    it('statusOf 不存在 → 404', async () => {
      const h = createHarness({ dbSelect: [[]] });
      await expect(h.service.statusOf(1)).rejects.toThrow(
        new NotFoundException('支付单不存在'),
      );
    });

    it('reconcile 只做端口转发', async () => {
      const h = createHarness();
      await expect(h.service.reconcile('2026-09-10')).resolves.toEqual({
        diffs: 2,
      });
      expect(h.diffs.reconcile).toHaveBeenCalledWith('2026-09-10');
    });
  });

  /* ------------------------------------------------------------------ *
   * 渠道归并（memberPayChannel）
   * ------------------------------------------------------------------ */
  describe('会员流水的渠道归并（biz_member_transaction 只有 5 个值）', () => {
    it('微信在线支付 → 会员流水渠道 wechat', async () => {
      const h = createHarness({
        dbSelect: [[payment({ channel: 'wxpay_native' })]],
        txUpdate: [[{ affectedRows: 1 }]],
      });
      h.wxpay.queryOrder.mockResolvedValueOnce({
        status: 'success',
        transactionId: '4200001',
        amount: 10000,
        paidAt: new Date(),
        raw: {},
      });
      await h.service.queryChannel(1, 7);
      expect(h.members.recordConsumption).toHaveBeenCalledWith(
        h.tx,
        expect.objectContaining({ payChannel: 'wechat' }),
      );
    });

    it('支付宝在线支付 → 会员流水渠道 alipay', async () => {
      const h = createHarness({
        dbSelect: [[payment({ channel: 'alipay_qr' })]],
        txUpdate: [[{ affectedRows: 1 }]],
      });
      h.alipay.queryOrder.mockResolvedValueOnce({
        status: 'success',
        transactionId: '2026091122001',
        amount: 10000,
        paidAt: new Date(),
        raw: {},
      });
      await h.service.queryChannel(1, 7);
      expect(h.members.recordConsumption).toHaveBeenCalledWith(
        h.tx,
        expect.objectContaining({ payChannel: 'alipay' }),
      );
    });

    it('次卡不写会员消费流水（金额恒为 0，核销本身已落卡流水）', async () => {
      const h = createHarness({
        txInsert: [[{ insertId: 1 }]],
        txSelect: [[{ serviceItemId: 11 }]],
      });
      const result = await h.service.createInTx(
        h.tx as never,
        draft({ channel: 'card', memberCardId: 7 }),
      );
      expect(result.receivedAmount).toBe(0);
      // 线下/储值/次卡路径不经过 deliver —— 会员消费由预约结算链路统一落账，
      // 这里重复落一次会双记消费与积分。
      expect(h.members.recordConsumption).not.toHaveBeenCalled();
    });

    it('线下渠道同样不经过 deliver（消费由结算链路落账）', async () => {
      const h = createHarness({ txInsert: [[{ insertId: 1 }]] });
      await h.service.createInTx(h.tx as never, draft({ channel: 'cash' }));
      expect(h.members.recordConsumption).not.toHaveBeenCalled();
      expect(h.settlement.recalc).not.toHaveBeenCalled();
    });
  });
});
