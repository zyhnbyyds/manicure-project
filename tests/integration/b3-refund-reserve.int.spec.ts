/**
 * 退款额度预留（资金红线回归）。
 *
 * ## 修的是什么
 *
 * 原实现是「**先打渠道退款、再在本地条件更新已退金额**」。渠道退款是**已经发生的
 * 资金事实**：如果本地「已退金额不得超过支付单总额」的条件更新在渠道退款成功之后
 * 才失败，就变成「钱已经退出去了、本地账上没记」—— 顾客收到了钱，我们只在对账里
 * 才能发现，`biz_refund` 还停在中间态。
 *
 * 现在改成：**先本地占额度（闸门 2）→ 再打渠道 → 成功后落地；渠道失败则释放**。
 * 这样任何时刻「渠道已退的钱」都不会超过「本地已占的额度」。
 *
 * ## 两个必须成立的性质
 *
 * 1. **渠道退款失败 → 预留额度必须释放**（钱没动，额度不能占着，否则这笔单再也退不了）；
 * 2. **同一支付单的两笔退款，第二笔要在打渠道之前就被额度闸门拒掉**
 *    （不能靠渠道侧去兜；超额的那一笔连渠道接口都不该调）。
 *
 * 支付单直接 INSERT：这是「已经结算完成的在线支付」的测试预置，
 * 避免为了造数据去调真实渠道。
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { WxpayNativeProvider } from '../../src/modules/biz/payment/channels/wxpay-native.provider.js';
import { createTestContext, type TestContext } from './harness.js';

let ctx: TestContext;

async function seedCustomer(name: string): Promise<number> {
  const inserted = await ctx.sql<{ insertId: number }>(
    `INSERT INTO biz_customer (name) VALUES (?)`,
    [name],
  );
  return inserted.insertId;
}

/** 造一张「已成功的在线支付单」（不走渠道，直接预置） */
async function seedPaidOnlinePayment(
  customerId: number,
  amount: number,
): Promise<number> {
  const inserted = await ctx.sql<{ insertId: number }>(
    `INSERT INTO biz_payment
       (store_id, payment_no, out_trade_no, customer_id, purpose, channel, amount, received_amount, status, refunded_amount)
     VALUES ((SELECT id FROM sys_store WHERE is_default = 1 LIMIT 1), ?, ?, ?, 'final', 'wxpay_native', ?, ?, 'success', 0)`,
    [
      `P-TEST-${Date.now()}`,
      `OT-TEST-${Date.now()}`,
      customerId,
      amount,
      amount,
    ],
  );
  return inserted.insertId;
}

async function applyRefund(paymentId: number, reason: string): Promise<number> {
  const res = await ctx.request('POST', '/api/v1/biz/refunds', {
    body: { paymentId, mode: 'original', reason },
  });
  expect(res.status).toBe(201);
  return (res.body as { id: number }).id;
}

async function refundedAmountOf(paymentId: number): Promise<number> {
  const rows = await ctx.sql<{ refunded_amount: number }>(
    `SELECT refunded_amount FROM biz_payment WHERE id = ?`,
    [paymentId],
  );
  return Number(rows[0]?.refunded_amount ?? -1);
}

async function statusOf(refundId: number): Promise<string> {
  const rows = await ctx.sql<{ status: string }>(
    `SELECT status FROM biz_refund WHERE id = ?`,
    [refundId],
  );
  return String(rows[0]?.status ?? 'missing');
}

beforeAll(async () => {
  ctx = await createTestContext();
}, 120_000);

beforeEach(async () => {
  await ctx.resetBusinessData();
}, 60_000);

afterAll(async () => {
  await ctx.close();
});

describe('退款额度预留（本目标新增，资金红线）', () => {
  it('**渠道退款失败 → 预留额度必须释放**（钱没动就不能占着）', async () => {
    const customerId = await seedCustomer('退款顾客');
    const paymentId = await seedPaidOnlinePayment(customerId, 10000);
    const refundId = await applyRefund(paymentId, '顾客取消预约');

    // 渠道网络异常
    const wxpay = ctx.app.get(WxpayNativeProvider);
    const spy = vi
      .spyOn(wxpay, 'refund')
      .mockRejectedValue(new Error('network down'));
    const approved = await ctx.request(
      'POST',
      `/api/v1/biz/refunds/${refundId}/approve`,
    );
    spy.mockRestore();

    expect(approved.status).toBe(409);
    // 钱一分没出去 → 额度必须回到 0（否则这笔支付单再也退不了）
    expect(await refundedAmountOf(paymentId)).toBe(0);
    // 退款单标记失败，允许重试
    expect(await statusOf(refundId)).toBe('failed');
  });

  it('**渠道退款成功 → 额度被占用并落地为 success**', async () => {
    const customerId = await seedCustomer('正常退款顾客');
    const paymentId = await seedPaidOnlinePayment(customerId, 10000);
    const refundId = await applyRefund(paymentId, '顾客取消预约');

    const wxpay = ctx.app.get(WxpayNativeProvider);
    const spy = vi.spyOn(wxpay, 'refund').mockResolvedValue({
      channelRefundId: 'CH-REFUND-1',
      status: 'success',
      raw: { ok: true },
    });
    const approved = await ctx.request(
      'POST',
      `/api/v1/biz/refunds/${refundId}/approve`,
    );
    spy.mockRestore();

    expect([200, 201]).toContain(approved.status);
    expect(await refundedAmountOf(paymentId)).toBe(10000);
    expect(await statusOf(refundId)).toBe('success');
  });

  it('**两笔退款：第二笔在打渠道之前就被额度闸门拒掉，绝不过额**', async () => {
    const customerId = await seedCustomer('并发退款顾客');
    const paymentId = await seedPaidOnlinePayment(customerId, 10000);

    // 两笔都在「已退金额还是 0」时申请（这正是真实的竞态：先各申请、再逐笔审批）
    const first = await applyRefund(paymentId, '第一笔退款申请');
    const second = await applyRefund(paymentId, '第二笔退款申请');

    const wxpay = ctx.app.get(WxpayNativeProvider);
    const spy = vi.spyOn(wxpay, 'refund').mockResolvedValue({
      channelRefundId: 'CH-REFUND-1',
      status: 'success',
      raw: {},
    });

    const okFirst = await ctx.request(
      'POST',
      `/api/v1/biz/refunds/${first}/approve`,
    );
    expect([200, 201]).toContain(okFirst.status);

    // 关键：第二笔不该再打渠道（mock 调用次数证明），也不该把额度翻倍
    const callsBefore = spy.mock.calls.length;
    const overSecond = await ctx.request(
      'POST',
      `/api/v1/biz/refunds/${second}/approve`,
    );
    const callsAfter = spy.mock.calls.length;
    spy.mockRestore();

    expect(overSecond.status).toBe(409);
    // **一笔都不能多退**：额度恰好等于支付单金额
    expect(await refundedAmountOf(paymentId)).toBe(10000);
    // **超额的那一笔连渠道接口都没调**（否则就是拿渠道当兜底，钱可能真的出去）
    expect(callsAfter).toBe(callsBefore);
    // 第二笔停在 approved（可人工改为现金退/退余额），不是被悄悄标成失败
    expect(await statusOf(second)).toBe('approved');
  });
});
