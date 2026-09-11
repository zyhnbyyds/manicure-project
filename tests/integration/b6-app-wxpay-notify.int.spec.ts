/**
 * 微信支付回调：**真验签 + 真解密 + 真资金链路**（A13，money-invariants §3 / §7 / §8）。
 *
 * 之前 `/biz/payments/notify/wxpay`（B3）只有单测、回调端点从未跑过端到端——
 * 这是整套系统里最该被守住的一条链路，却是裸奔的。这里用 harness 现造的 RSA 密钥对
 * 造出**能被真验签通过**的报文，一次把两个端点（app / 后台）都覆盖掉。
 *
 * 断言的每一条都对着 `money-invariants`：
 * - §8 验签失败 → 拒绝，且**一毛钱都不动**；
 * - §8 金额与订单不一致 → 记 `callback_invalid` 并拒绝，**绝不按回调金额改账**；
 * - §3 条件更新是唯一幂等闸门 → 重复通知不重复发货；
 * - §7 HTTP 恒 200，成败看应答体（返回 4xx/5xx 只会招来无意义重试）。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './harness.js';
import { buildWxpayNotify, tamperSignature } from './wxpay-notify.helper.js';

let ctx: TestContext;

/** 造一张 pending 的微信支付单（金额 10000 分） */
async function seedPendingPayment(amount = 10000): Promise<{
  id: number;
  outTradeNo: string;
  bookingId: number;
  customerId: number;
}> {
  const customers = await ctx.sql<{ insertId: number }>(
    `INSERT INTO biz_customer (name, phone) VALUES ('回调顾客', '13800000081')`,
  );
  const customerId = customers.insertId;
  const staffs = await ctx.sql<{ insertId: number }>(
    `INSERT INTO biz_staff (nickname, status, sort) VALUES ('美甲师-回调', 'active', 1)`,
  );
  const bookings = await ctx.sql<{ insertId: number }>(
    `INSERT INTO biz_booking
       (booking_no, customer_id, staff_id, start_at, end_at, duration_minutes,
        original_price, payable_amount, paid_amount, due_amount, status, pay_status,
        customer_name, customer_phone)
     VALUES ('B-NOTIFY', ?, ?, NOW(), DATE_ADD(NOW(), INTERVAL 1 HOUR), 60,
             ?, ?, 0, ?, 'confirmed', 'unpaid', '回调顾客', '13800000081')`,
    [customerId, staffs.insertId, amount, amount, amount],
  );
  const bookingId = bookings.insertId;
  const outTradeNo = `P${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const payments = await ctx.sql<{ insertId: number }>(
    // `received_amount` 必须一起给：`paid_amount = Σ received_amount`（§15.7 不变量 4），
    // 只写 `amount` 的话 recalc 求出来是 0，会把「发货成功」误判成没发货。
    `INSERT INTO biz_payment
       (payment_no, out_trade_no, booking_id, customer_id, purpose, channel,
        amount, received_amount, status, expire_at)
     VALUES (?, ?, ?, ?, 'final', 'wxpay_native', ?, ?, 'pending', DATE_ADD(NOW(), INTERVAL 5 MINUTE))`,
    [
      `PAY-${outTradeNo}`,
      outTradeNo,
      bookingId,
      customerId,
      amount,
      amount,
    ],
  );
  return { id: payments.insertId, outTradeNo, bookingId, customerId };
}

async function paymentRow(id: number) {
  const rows = await ctx.sql<
    { status: string; transaction_id: string | null; paid_at: string | null }[]
  >(
    `SELECT status, transaction_id, paid_at FROM biz_payment WHERE id = ?`,
    [id],
  );
  return rows[0];
}

async function logCount(paymentId: number, event: string): Promise<number> {
  const rows = await ctx.sql<{ total: number }[]>(
    `SELECT COUNT(*) AS total FROM biz_payment_log WHERE payment_id = ? AND event = ?`,
    [paymentId, event],
  );
  return Number(rows[0].total);
}

beforeAll(async () => {
  ctx = await createTestContext();
}, 180_000);

beforeEach(async () => {
  await ctx.resetBusinessData();
});

afterAll(async () => {
  await ctx.close();
});

/* ------------------------------------------------------------------ */

describe('微信支付回调 /app/payments/wxpay/notify（A13）', () => {
  it('验签通过 + 金额一致 → 发货：支付单 success，且应答 SUCCESS', async () => {
    const payment = await seedPendingPayment();
    const notify = buildWxpayNotify({
      outTradeNo: payment.outTradeNo,
      amount: 10000,
    });

    const response = await ctx.request(
      'POST',
      '/api/v1/app/payments/wxpay/notify',
      { token: null, headers: notify.headers, body: notify.body },
    );
    expect(response.status).toBe(200);
    expect(response.body.code).toBe('SUCCESS');

    const row = await paymentRow(payment.id);
    expect(row.status).toBe('success');
    // 渠道流水号是从**密文**里解出来的，对得上才说明解密链路是真的
    expect(row.transaction_id).toBe(notify.transactionId);
    expect(row.paid_at).not.toBeNull();

    // 同事务发货：预约的金额事实被 recalc 重算（paid_amount 由 0 变成 10000）
    const booking = await ctx.sql<{ paid_amount: number; pay_status: string }[]>(
      `SELECT paid_amount, pay_status FROM biz_booking WHERE id = ?`,
      [payment.bookingId],
    );
    expect(Number(booking[0].paid_amount)).toBe(10000);
  });

  it('重复通知 → 幂等：仍答 SUCCESS，但只发货一次（不重复落流水）', async () => {
    const payment = await seedPendingPayment();
    const notify = buildWxpayNotify({
      outTradeNo: payment.outTradeNo,
      amount: 10000,
    });

    const first = await ctx.request(
      'POST',
      '/api/v1/app/payments/wxpay/notify',
      { token: null, headers: notify.headers, body: notify.body },
    );
    expect(first.body.code).toBe('SUCCESS');

    // 微信会重复推同一条通知（headers 重算时间戳也无所谓，幂等靠 out_trade_no）
    const again = buildWxpayNotify({
      outTradeNo: payment.outTradeNo,
      amount: 10000,
    });
    const second = await ctx.request(
      'POST',
      '/api/v1/app/payments/wxpay/notify',
      { token: null, headers: again.headers, body: again.body },
    );
    expect(second.status).toBe(200);
    expect(second.body.code).toBe('SUCCESS');

    // 关键：条件更新 WHERE status='pending' 在第二轮影响行数 0 → 不再记一次成功日志
    const rows = await ctx.sql<{ total: number }[]>(
      `SELECT COUNT(*) AS total FROM biz_payment_log WHERE payment_id = ? AND event = 'callback'`,
      [payment.id],
    );
    expect(Number(rows[0].total)).toBe(1);
  });

  it('金额与订单不一致 → 拒绝：记 callback_invalid，且支付单一动不动', async () => {
    const payment = await seedPendingPayment(10000);
    const notify = buildWxpayNotify({
      outTradeNo: payment.outTradeNo,
      amount: 1, // 回调说只付了 1 分
    });

    const response = await ctx.request(
      'POST',
      '/api/v1/app/payments/wxpay/notify',
      { token: null, headers: notify.headers, body: notify.body },
    );
    expect(response.status).toBe(200);
    expect(response.body.code).toBe('FAIL');

    expect(await logCount(payment.id, 'callback_invalid')).toBe(1);
    const row = await paymentRow(payment.id);
    expect(row.status).toBe('pending');
    expect(row.paid_at).toBeNull();

    const booking = await ctx.sql<{ paid_amount: number }[]>(
      `SELECT paid_amount FROM biz_booking WHERE id = ?`,
      [payment.bookingId],
    );
    expect(Number(booking[0].paid_amount)).toBe(0);
  });

  it('签名被篡改 → 拒绝：一毛钱都不动', async () => {
    const payment = await seedPendingPayment();
    const notify = tamperSignature(
      buildWxpayNotify({ outTradeNo: payment.outTradeNo, amount: 10000 }),
    );

    const response = await ctx.request(
      'POST',
      '/api/v1/app/payments/wxpay/notify',
      { token: null, headers: notify.headers, body: notify.body },
    );
    expect(response.status).toBe(200);
    expect(response.body.code).toBe('FAIL');

    const row = await paymentRow(payment.id);
    expect(row.status).toBe('pending');
  });

  it('缺验签头 → 拒绝；HTTP 仍恒为 200（返回 4xx 只会招来重试）', async () => {
    const payment = await seedPendingPayment();
    const notify = buildWxpayNotify({
      outTradeNo: payment.outTradeNo,
      amount: 10000,
    });
    const { 'wechatpay-signature': _drop, ...headers } = notify.headers;

    const response = await ctx.request(
      'POST',
      '/api/v1/app/payments/wxpay/notify',
      { token: null, headers, body: notify.body },
    );
    expect(response.status).toBe(200);
    expect(response.body.code).toBe('FAIL');
    expect((await paymentRow(payment.id)).status).toBe('pending');
  });
});

/* ------------------------------------------------------------------ */

describe('后台回调 /biz/payments/notify/wxpay（B3 补集成覆盖）', () => {
  it('与 app 端同一套资金逻辑：验签通过则发货，重复通知幂等', async () => {
    const payment = await seedPendingPayment();
    const notify = buildWxpayNotify({
      outTradeNo: payment.outTradeNo,
      amount: 10000,
    });

    const first = await ctx.request('POST', '/api/v1/biz/payments/notify/wxpay', {
      token: null,
      headers: notify.headers,
      body: notify.body,
    });
    expect(first.status).toBe(200);
    expect(first.body.code).toBe('SUCCESS');
    expect((await paymentRow(payment.id)).status).toBe('success');

    const again = buildWxpayNotify({
      outTradeNo: payment.outTradeNo,
      amount: 10000,
    });
    const second = await ctx.request('POST', '/api/v1/biz/payments/notify/wxpay', {
      token: null,
      headers: again.headers,
      body: again.body,
    });
    expect(second.body.code).toBe('SUCCESS');
    const rows = await ctx.sql<{ total: number }[]>(
      `SELECT COUNT(*) AS total FROM biz_payment_log WHERE payment_id = ? AND event = 'callback'`,
      [payment.id],
    );
    expect(Number(rows[0].total)).toBe(1);
  });
});
