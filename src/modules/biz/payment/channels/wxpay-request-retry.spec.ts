/**
 * 微信支付出站调用的**有界重试**与 `Request-Id` 留痕。
 *
 * ## 为什么需要
 *
 * 原来出站调用只设了 5 秒超时、**没有任何重试**：一次瞬时抖动就直接失败 ——
 * 下单失败要店员重来；退款失败更糟，`refunds.service` 会把它标成 `failed`
 * 并把重试责任推给人（「可重试或改为现金退」）。
 *
 * ## 为什么重试是安全的
 *
 * 本 provider 的写操作都以**商户单号**为幂等键：下单 `out_trade_no`、
 * 退款 `out_refund_no`（同号重试微信返回同一笔），查单是 GET。
 *
 * ## 本文件锁死的三条边界
 *
 * 1. **网络异常 / 5xx / 429 → 重试**；
 * 2. **4xx → 绝不重试**（参数错、签名错重试多少次都一样）；
 * 3. **重试有上限**（不能变成无限循环），且**报错要带 `Request-Id`**。
 */
import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi, afterEach } from 'vitest';
import type { AppConfigService } from '../../../app-config/app-config.service.js';
import { WxpayNativeProvider } from './wxpay-native.provider.js';

/** 真密钥：签名走 `createSign`，假 PEM 会直接抛错 */
const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const config = {
  wxpay: {
    configured: true,
    appId: 'wx-test-appid',
    mchId: '1900000001',
    serialNo: 'SERIAL-1',
    privateKey: String(privateKey),
    apiV3Key: '0'.repeat(32),
    notifyUrl: null,
  },
} as unknown as AppConfigService;

function jsonResponse(
  status: number,
  body: unknown,
  requestId?: string,
): Response {
  return {
    status,
    text: async () => JSON.stringify(body),
    headers: {
      get: (name: string) =>
        name.toLowerCase() === 'request-id' ? (requestId ?? null) : null,
    },
  } as unknown as Response;
}

const OK_ORDER = {
  trade_state: 'SUCCESS',
  transaction_id: '4200001',
  amount: { total: 10000 },
  success_time: '2026-09-12T10:00:00+08:00',
};

/** 构造 provider，并把退避 sleep 换成立即返回（否则测试要真等） */
function makeProvider(): WxpayNativeProvider {
  const provider = new WxpayNativeProvider(config);
  vi.spyOn(
    provider as unknown as { sleep: (ms: number) => Promise<void> },
    'sleep',
  ).mockResolvedValue(undefined);
  return provider;
}

/** bun test 的 vitest 兼容层没有 `vi.stubGlobal`，直接替换并还原 */
const realFetch = globalThis.fetch;
function stubFetch(mock: unknown): void {
  globalThis.fetch = mock as typeof fetch;
}

afterEach(() => {
  vi.restoreAllMocks();
  globalThis.fetch = realFetch;
});

describe('微信支付出站调用：有界重试', () => {
  it('网络异常 → 重试一次后成功', async () => {
    const provider = makeProvider();
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockResolvedValueOnce(jsonResponse(200, OK_ORDER));
    stubFetch(fetchMock);

    const state = await provider.queryOrder('OT-1');

    expect(state.status).toBe('success');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('5xx → 重试（服务端瞬时问题）', async () => {
    const provider = makeProvider();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(500, { code: 'SYSTEM_ERROR' }))
      .mockResolvedValueOnce(jsonResponse(200, OK_ORDER));
    stubFetch(fetchMock);

    const state = await provider.queryOrder('OT-1');

    expect(state.status).toBe('success');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('**4xx → 绝不重试**（参数错重试多少次都一样）', async () => {
    const provider = makeProvider();
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(400, { code: 'PARAM_ERROR' }));
    stubFetch(fetchMock);

    await expect(provider.queryOrder('OT-1')).rejects.toThrow(/查单失败/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('重试有上限：一直失败就抛错，不是无限循环', async () => {
    const provider = makeProvider();
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
    stubFetch(fetchMock);

    await expect(provider.queryOrder('OT-1')).rejects.toThrow(/network down/);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe('微信支付出站调用：Request-Id 留痕', () => {
  it('**失败时的报错带上渠道返回的 Request-Id**（微信侧凭它定位）', async () => {
    const provider = makeProvider();
    stubFetch(
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse(400, { code: 'PARAM_ERROR' }, 'REQ-TRACE-123'),
        ),
    );

    await expect(provider.queryOrder('OT-1')).rejects.toThrow(/REQ-TRACE-123/);
  });
});
