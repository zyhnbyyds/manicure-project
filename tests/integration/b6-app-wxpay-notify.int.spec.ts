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
 * - 应答语义**按微信 V3 的官方约定**：验签通过 → HTTP 200（微信不再重投）；
 *   验签不通过 / 业务不接受 → **HTTP 4xx**（微信按 15 次、约 24 小时重投，
 *   探测流量 `WECHATPAY/SIGNTEST/` 也靠这个判断商户是否真的验签）。
 *   ⚠️ 原实现返回「恒 200 + body code=FAIL」，那是 **APIv2** 的约定 ——
 *   V3 不看 body，回 200 等于「受理成功，别再发了」，会把可自愈的验签失败变成丢单。
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
    // 业务不接受 → 4xx（微信会重投；回 200 会被当成受理成功而不再发）
    expect(response.status).toBe(400);
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
    // **验签失败必须 4xx**：微信据此携带正确签名重投
    expect(response.status).toBe(401);
    expect(response.body.code).toBe('FAIL');

    const row = await paymentRow(payment.id);
    expect(row.status).toBe('pending');
  });

  it('缺验签头 → 拒绝，且必须回 4xx（回 200 会让微信停止重投）', async () => {
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
    expect(response.status).toBe(401);
    expect(response.body.code).toBe('FAIL');
    expect((await paymentRow(payment.id)).status).toBe('pending');
  });

  it('**本地已关单（closed）+ 回调成功 → 仍要落地**（迟到的支付成功不能记丢）', async () => {
    const payment = await seedPendingPayment(10000);
    // 模拟关单任务已经把它关掉：顾客随后在最后一刻付款成功
    await ctx.sql(`UPDATE biz_payment SET status = 'closed' WHERE id = ?`, [
      payment.id,
    ]);
    const notify = buildWxpayNotify({
      outTradeNo: payment.outTradeNo,
      amount: 10000,
    });

    const response = await ctx.request(
      'POST',
      '/api/v1/app/payments/wxpay/notify',
      { token: null, headers: notify.headers, body: notify.body },
    );

    // 只认 pending 的实现会在这里 0 行命中 → 当成「已处理」答 SUCCESS → 这笔钱永远记不上
    expect(response.status).toBe(200);
    expect(response.body.code).toBe('SUCCESS');

    const row = await paymentRow(payment.id);
    expect(row.status).toBe('success');
    expect(row.transaction_id).toBeTruthy();

    // 预约侧也要跟着重算（钱到账了）
    const booking = await ctx.sql<{ paid_amount: number; pay_status: string }[]>(
      `SELECT paid_amount, pay_status FROM biz_booking WHERE id = ?`,
      [payment.bookingId],
    );
    expect(Number(booking[0].paid_amount)).toBe(10000);
    expect(booking[0].pay_status).toBe('paid');

    // 迟到落地要留痕，便于对账/复盘
    const rows = await ctx.sql<{ raw: unknown }[]>(
      `SELECT raw FROM biz_payment_log WHERE payment_id = ? AND event = 'callback'`,
      [payment.id],
    );
    // `raw` 是 JSON 列，mysql2 直接给对象；序列化后再找标记
    expect(JSON.stringify(rows[0]?.raw)).toContain('reopenedFrom');
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
