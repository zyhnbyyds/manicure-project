import { ServiceUnavailableException } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppConfigService } from '../../../config/app-config.service';
import {
  FakeWxMiniappProvider,
  HttpWxMiniappProvider,
} from './wx-miniapp.provider';

/**
 * G2「未配置凭据 → 503」。
 *
 * 为什么必须专门验：spec §16.1 要求「未配置微信凭据时要能正常启动，登录返回『小程序端未启用』」，
 * 而集成测试环境**固定注入假实现**（`harness.ts` 里 `WX_MINIAPP_FAKE=true`），
 * 真实现这条分支永远跑不到——只能在这里用「空凭据 + 假 fetch」把它钉住。
 */
function configWith(miniapp: {
  appId?: string;
  secret?: string;
  configured?: boolean;
}): AppConfigService {
  return {
    wxMiniapp: {
      appId: miniapp.appId,
      secret: miniapp.secret,
      // `configured` 由 AppConfigService 的 complete() 算出，这里允许显式覆盖以模拟各种配错姿势
      configured:
        miniapp.configured ?? Boolean(miniapp.appId && miniapp.secret),
      fake: false,
    },
  } as unknown as AppConfigService;
}

/** 断言「是 503 且消息是『小程序端未启用』」，而不是笼统地 rejects */
async function expectServiceUnavailable(
  promise: Promise<unknown>,
): Promise<void> {
  const error = await promise.then(
    () => null,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(ServiceUnavailableException);
  expect((error as ServiceUnavailableException).getStatus()).toBe(503);
  expect(
    (
      (error as ServiceUnavailableException).getResponse() as {
        message: string;
      }
    ).message,
  ).toBe('小程序端未启用');
}

/** 用一个不会真联网的假 fetch 顶掉全局的，缺省回包为「成功」 */
function stubFetch(
  response: unknown = { openid: 'o-fake', unionid: null },
): ReturnType<typeof vi.spyOn> {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async () => new Response(JSON.stringify(response)));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('HttpWxMiniappProvider：凭据未配置 → 503（G2）', () => {
  it('appid / secret 都没配 → code2Session 503，且**根本不发请求**', async () => {
    const fetchSpy = stubFetch();
    const provider = new HttpWxMiniappProvider(configWith({}));

    await expectServiceUnavailable(provider.code2Session('code-1'));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('只配了 appid → 仍然 503（半套凭据等于没配）', async () => {
    const fetchSpy = stubFetch();
    const provider = new HttpWxMiniappProvider(configWith({ appId: 'wx123' }));

    await expectServiceUnavailable(provider.code2Session('code-1'));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('只配了 secret → 仍然 503', async () => {
    const provider = new HttpWxMiniappProvider(
      configWith({ secret: 's3cret' }),
    );
    await expectServiceUnavailable(provider.code2Session('code-1'));
  });

  it('两个值都在但 configured=false → 以 configured 为准，仍然 503', async () => {
    const provider = new HttpWxMiniappProvider(
      configWith({ appId: 'wx123', secret: 's3cret', configured: false }),
    );
    await expectServiceUnavailable(provider.code2Session('code-1'));
  });

  it('getPhoneNumber 同样 503，且不会先去换 access_token', async () => {
    const fetchSpy = stubFetch();
    const provider = new HttpWxMiniappProvider(configWith({}));

    await expectServiceUnavailable(provider.getPhoneNumber('phone-code'));
    // 拿 token 那一步也在 requireCredentials 之后，所以一次网络请求都不该有
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('HttpWxMiniappProvider：凭据齐全时**不**503（防止「永远 503」假绿）', () => {
  it('code2Session 走真实请求并解析 openid', async () => {
    const fetchSpy = stubFetch({ openid: 'o-real', unionid: 'u-real' });
    const provider = new HttpWxMiniappProvider(
      configWith({ appId: 'wx123', secret: 's3cret' }),
    );

    await expect(provider.code2Session('code-1')).resolves.toEqual({
      openid: 'o-real',
      unionid: 'u-real',
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('微信返回 !ok（如 5xx）→ 503「微信服务不可用」，与「未配置」区分开', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () => new Response('boom', { status: 500 }),
    );
    const provider = new HttpWxMiniappProvider(
      configWith({ appId: 'wx123', secret: 's3cret' }),
    );

    const error = await provider.code2Session('code-1').then(
      () => null,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect(
      (
        (error as ServiceUnavailableException).getResponse() as {
          message: string;
        }
      ).message,
    ).toBe('微信服务不可用');
  });
});

describe('FakeWxMiniappProvider：生产环境必须拒绝构造（安全底线）', () => {
  it('NODE_ENV=production 时构造即抛错，避免「改一个环境变量就能登录成任意顾客」', () => {
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(() => new FakeWxMiniappProvider()).toThrow(/生产环境/);
    } finally {
      if (original === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = original;
    }
  });
});
