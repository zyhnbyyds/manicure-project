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
 * 注意：退款流程已改为「**建单即执行**」（服务开始前无理由退，不再走待审批中间态），
 * 所以打渠道的时点从 `approve` 挪到了 `apply`——本文件因此**必须先装好渠道 mock、
 * 再调 `POST /biz/refunds`**；`approve` 现在只用于 `failed` 单的重试。
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

/**
 * 发起退款（**建单即执行**：没有待审批中间态，所以调用前必须先 mock 好渠道）。
 *
 * 传 `paymentId` 而不是 `bookingId`：这条链路本身与预约无关，
 * 没有 `start_at` 时按「服务开始前」处理 → 金额锁定为该支付单剩余可退全额。
 */
function applyRefund(paymentId: number, reason: string) {
  return ctx.request('POST', '/api/v1/biz/refunds', {
    body: { paymentId, mode: 'original', reason },
  });
}

/** 该支付单最近一张退款单的 id（失败时接口不回 id，只能从库里取） */
async function latestRefundId(paymentId: number): Promise<number> {
  const rows = await ctx.sql<{ id: number }>(
    `SELECT id FROM biz_refund WHERE payment_id = ? ORDER BY id DESC LIMIT 1`,
    [paymentId],
  );
  return Number(rows[0]?.id ?? 0);
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

describe('退款额度预留（资金红线）', () => {
  it('**渠道退款失败 → 预留额度必须释放**，且失败单可以重试', async () => {
    const customerId = await seedCustomer('退款顾客');
    const paymentId = await seedPaidOnlinePayment(customerId, 10000);

    // 渠道网络异常：发起退款会**当场**打渠道，所以失败就发生在 apply 这一步
    const wxpay = ctx.app.get(WxpayNativeProvider);
    const spy = vi
      .spyOn(wxpay, 'refund')
      .mockRejectedValue(new Error('network down'));
    const failed = await applyRefund(paymentId, '顾客取消预约');
    spy.mockRestore();

    expect(failed.status).toBe(409);
    // 钱一分没出去 → 额度必须回到 0（否则这笔支付单再也退不了）
    expect(await refundedAmountOf(paymentId)).toBe(0);
    // 退款单标记失败，允许重试
    const refundId = await latestRefundId(paymentId);
    expect(await statusOf(refundId)).toBe('failed');

    // 渠道恢复后重试同一张单：商户退款单号不变，渠道侧天然幂等
    const retrySpy = vi.spyOn(wxpay, 'refund').mockResolvedValue({
      channelRefundId: 'CH-RETRY-1',
      status: 'success',
      raw: { ok: true },
    });
    const retried = await ctx.request(
      'POST',
      `/api/v1/biz/refunds/${refundId}/approve`,
    );
    retrySpy.mockRestore();

    expect([200, 201]).toContain(retried.status);
    expect(await refundedAmountOf(paymentId)).toBe(10000);
    expect(await statusOf(refundId)).toBe('success');
  });

  it('**渠道退款成功 → 额度被占用并落地为 success**', async () => {
    const customerId = await seedCustomer('正常退款顾客');
    const paymentId = await seedPaidOnlinePayment(customerId, 10000);

    const wxpay = ctx.app.get(WxpayNativeProvider);
    const spy = vi.spyOn(wxpay, 'refund').mockResolvedValue({
      channelRefundId: 'CH-REFUND-1',
      status: 'success',
      raw: { ok: true },
    });
    const applied = await applyRefund(paymentId, '顾客取消预约');
    spy.mockRestore();

    expect(applied.status).toBe(201);
    expect(applied.body.status).toBe('success');
    expect(applied.body.executed).toBe(true);
    expect(await refundedAmountOf(paymentId)).toBe(10000);
    expect(await statusOf(applied.body.id)).toBe('success');
  });

  it('**两笔并发退款：只能成功一笔，另一笔在打渠道之前就被额度闸门拒掉**', async () => {
    const customerId = await seedCustomer('并发退款顾客');
    const paymentId = await seedPaidOnlinePayment(customerId, 10000);

    const wxpay = ctx.app.get(WxpayNativeProvider);
    const spy = vi.spyOn(wxpay, 'refund').mockResolvedValue({
      channelRefundId: 'CH-REFUND-1',
      status: 'success',
      raw: {},
    });

    // 两笔都在「已退金额还是 0」时发起——这就是真实的竞态：
    // 两笔都能通过「还有可退余额」的前置检查，最终必须由额度闸门（条件更新）挡下一笔
    const [first, second] = await Promise.all([
      applyRefund(paymentId, '第一笔退款申请'),
      applyRefund(paymentId, '第二笔退款申请'),
    ]);
    const channelCalls = spy.mock.calls.length;
    spy.mockRestore();

    const codes = [first.status, second.status];
    expect(codes.filter((code) => code === 201)).toHaveLength(1);
    // 被挡下的那笔：要么在申请阶段 409（已无可退），要么在执行闸门 409/400
    expect(codes.filter((code) => code !== 201)).toHaveLength(1);

    // **一笔都不能多退**：额度恰好等于支付单金额
    expect(await refundedAmountOf(paymentId)).toBe(10000);
    // **超额的那一笔连渠道接口都没调**（否则就是拿渠道当兜底，钱可能真的出去）
    expect(channelCalls).toBe(1);

    const rows = await ctx.sql<{
      status: string;
      channel_refund_id: string | null;
    }>(
      `SELECT status, channel_refund_id FROM biz_refund WHERE payment_id = ?`,
      [paymentId],
    );
    const statuses = rows.map((row) => row.status);
    expect(statuses.filter((status) => status === 'success')).toHaveLength(1);
    // 被挡下的那笔不会落地成功：
    // - `failed` = 渠道失败后已释放额度；
    // - `approved` = 被额度闸门拒掉，停在人工处理态（可改现金退/退余额）。
    expect(
      statuses.every(
        (status) =>
          status === 'success' || status === 'failed' || status === 'approved',
      ),
    ).toBe(true);
    // 未成功的那笔**没有渠道退款单号** → 证明它确实没打渠道
    expect(
      rows
        .filter((row) => row.status !== 'success')
        .every((row) => row.channel_refund_id === null),
    ).toBe(true);
  });
});
