/**
 * 渠道回调应答契约（**直接测真实实现，不用 mock**）。
 *
 * ## 为什么必须有这个文件
 *
 * `PaymentsService` 的 spec 用的是 **mock provider**，而 mock 的 `failureReply`
 * 返回 `500`、真实 provider 返回的是 **`200`** —— 于是「微信回调失败必须回 4xx/5xx」
 * 这条红线**测试一直全绿、实际却是错的**。
 *
 * 教训：**契约类断言必须落到真实实现上**，否则 mock 与实现分叉时没人会发现。
 * 这里把两个渠道的状态码钉死，并显式固定「微信与支付宝不同」这件事，
 * 免得以后有人为了「统一」把它们改成一样。
 */
import { describe, expect, it } from 'vitest';
import type { AppConfigService } from '../../../app-config/app-config.service.js';
import { AlipayQrProvider } from './alipay-qr.provider.js';
import { WxpayNativeProvider } from './wxpay-native.provider.js';

/** 应答方法不读配置，空对象即可 */
const noConfig = {} as unknown as AppConfigService;

/** 验签路径需要「已配置」的凭据（密钥长度会被校验） */
const configured = {
  wxpay: {
    configured: true,
    appId: 'wx-test-appid',
    mchId: '1900000001',
    serialNo: 'SERIAL-1',
    privateKey: 'dummy',
    apiV3Key: '0'.repeat(32),
    notifyUrl: 'https://example.com/api/v1/app/payments/wxpay/notify',
  },
} as unknown as AppConfigService;

describe('微信支付回调应答（V3：HTTP 状态码表达受理结果）', () => {
  const wxpay = () => new WxpayNativeProvider(noConfig);

  it('成功应答 → 200', () => {
    expect(wxpay().successReply().statusCode).toBe(200);
  });

  it('**验签失败必须 4xx**（回 200 会被当成接收成功、微信不再重投）', () => {
    const reply = wxpay().failureReply('微信支付回调验签失败', 'verify');

    expect(reply.statusCode).toBe(401);
    // 红线：绝不能是 2xx
    expect(reply.statusCode).toBeGreaterThanOrEqual(400);
    expect(reply.statusCode).toBeLessThan(500);
  });

  it('**探测流量（SIGNTEST）经这条路径也必须拿到非 2xx**', () => {
    // 微信会下发签名值带 `WECHATPAY/SIGNTEST/` 前缀的探测流量检验商户是否真的验签；
    // 它同样验签失败 → 走 verify 类别 → 必须失败应答，否则等于承认「没验签也放行」。
    const reply = wxpay().failureReply(
      '微信支付回调验签失败：WECHATPAY/SIGNTEST/abc',
      'verify',
    );

    expect(reply.statusCode).not.toBe(200);
    expect(reply.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('业务不接受（订单不存在 / 金额不一致 / 通道未启用）→ 4xx', () => {
    const reply = wxpay().failureReply('回调金额与订单不一致', 'business');

    expect(reply.statusCode).toBe(400);
    expect(reply.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('应答体保留原因，便于排障留痕', () => {
    const reply = wxpay().failureReply('回调金额与订单不一致', 'business');

    expect(reply.body).toContain('FAIL');
    expect(reply.body).toContain('回调金额与订单不一致');
  });

  it('缺验签头 → 拒绝（异常报文不得进业务）', async () => {
    const provider = new WxpayNativeProvider(configured);

    await expect(
      provider.verifyNotify({ headers: {}, body: {} }),
    ).rejects.toThrow(/缺少验签头/);
  });

  it('时间戳超出容差 → 拒绝（防重放）', async () => {
    const provider = new WxpayNativeProvider(configured);
    const stale = String(Math.floor(Date.now() / 1000) - 3600);

    await expect(
      provider.verifyNotify({
        headers: {
          'wechatpay-signature': 'sig',
          'wechatpay-timestamp': stale,
          'wechatpay-nonce': 'nonce',
        },
        body: {},
      }),
    ).rejects.toThrow(/时间戳超出容差/);
  });
});

describe('支付宝回调应答（与微信**不同**：固定 200 + 响应体文本）', () => {
  const alipay = () => new AlipayQrProvider(noConfig);

  it('成功应答 → 200 + 文本 success', () => {
    const reply = alipay().successReply();

    expect(reply.statusCode).toBe(200);
    expect(reply.body).toBe('success');
  });

  it('失败应答 → **仍然是 200**，靠响应体文本让支付宝重投', () => {
    const reply = alipay().failureReply('支付宝回调验签失败', 'verify');

    // 支付宝的约定：返回 `success` 才停止重投，其它内容都会重投 ——
    // 所以这里**不能**跟着微信改成 4xx/5xx，否则重投机制失效。
    expect(reply.statusCode).toBe(200);
    expect(reply.body).toBe('failure');
  });
});
