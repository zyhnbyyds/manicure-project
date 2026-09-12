import { UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import type { AppConfigService } from '../../../config/app-config.service.js';
import {
  AppAccessTokenGuard,
  type AppRequest,
} from './app-access-token.guard.js';

const SECRET = 'test-secret-test-secret-test-secret';
const ISSUER = 'manicure-test';
const AUDIENCE = 'manicure-test-api';

const config = {
  jwt: {
    JWT_ACCESS_SECRET: SECRET,
    JWT_ISSUER: ISSUER,
    JWT_AUDIENCE: AUDIENCE,
  },
} as unknown as AppConfigService;

const secretKey = new TextEncoder().encode(SECRET);

/** app token：带 `scope: 'app'` + `openid`，**故意不带 username**（§8.3） */
function signAppToken(sub = '7', openid = 'openid-7'): Promise<string> {
  return new SignJWT({ scope: 'app', openid })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(sub)
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setExpirationTime('15m')
    .sign(secretKey);
}

/** 后台 token：带 `username`，**没有 `scope`** —— 打 app 域必须被拒 */
function signBackendToken(): Promise<string> {
  return new SignJWT({ username: 'admin', permissions: [], roles: [] })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('1')
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setExpirationTime('15m')
    .sign(secretKey);
}

/** 只用得到 `getAllAndOverride`：本用例测的是守卫的分支，不是 Reflector 本身 */
function reflectorFor(optionalToken: boolean): Reflector {
  return { getAllAndOverride: () => optionalToken } as unknown as Reflector;
}

function contextFor(request: AppRequest): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;
}

function guardFor(optionalToken: boolean): AppAccessTokenGuard {
  return new AppAccessTokenGuard(config, reflectorFor(optionalToken));
}

/** 断言抛 401，并把响应体里的中文 message 取出来（文案本身就是这次要修的东西） */
async function catchUnauthorized(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(UnauthorizedException);
    const body = (error as UnauthorizedException).getResponse() as {
      statusCode: number;
      message: string;
    };
    expect(body.statusCode).toBe(401);
    return body.message;
  }
  throw new Error('本应抛出 UnauthorizedException，但通过了');
}

describe('AppAccessTokenGuard（app 域身份，§8.3）', () => {
  describe('访客可浏览的路由（@AppOptionalToken）', () => {
    it('没带凭证 → 放行，且不挂 appUser（纯浏览数据谁看都一样）', async () => {
      const request: AppRequest = { headers: {} };
      await expect(
        guardFor(true).canActivate(contextFor(request)),
      ).resolves.toBe(true);
      expect(request.appUser).toBeUndefined();
    });

    it('带了后台 token → 仍然 401（**不能**静默降级成访客，否则双向拒绝就破了）', async () => {
      const request: AppRequest = {
        headers: { authorization: `Bearer ${await signBackendToken()}` },
      };
      const message = await catchUnauthorized(() =>
        guardFor(true).canActivate(contextFor(request)),
      );
      expect(message).toBe('登录状态已失效，请重新进入小程序');
      expect(request.appUser).toBeUndefined();
    });

    it('带了伪造 / 解不开的 token → 仍然 401', async () => {
      const request: AppRequest = {
        headers: { authorization: 'Bearer not-a-jwt' },
      };
      await catchUnauthorized(() =>
        guardFor(true).canActivate(contextFor(request)),
      );
      expect(request.appUser).toBeUndefined();
    });

    it('带了合法 app token → 挂上 appUser', async () => {
      const request: AppRequest = {
        headers: {
          authorization: `Bearer ${await signAppToken('42', 'openid-42')}`,
        },
      };
      await expect(
        guardFor(true).canActivate(contextFor(request)),
      ).resolves.toBe(true);
      expect(request.appUser).toEqual({ id: 42, openid: 'openid-42' });
    });
  });

  describe('需要身份的路由（默认行为）', () => {
    it('没带凭证 → 401，且给的是「该怎么办」的中文，不是英文 Unauthorized', async () => {
      const request: AppRequest = { headers: {} };
      const message = await catchUnauthorized(() =>
        guardFor(false).canActivate(contextFor(request)),
      );
      expect(message).toBe('请先登录后再操作');
      expect(message).not.toBe('Unauthorized');
    });

    it('Authorization 头不是 Bearer → 等同于没带凭证', async () => {
      const request: AppRequest = {
        headers: { authorization: 'Basic YWRtaW46YWRtaW4=' },
      };
      await catchUnauthorized(() =>
        guardFor(false).canActivate(contextFor(request)),
      );
      expect(request.appUser).toBeUndefined();
    });

    it('合法 app token → 放行并挂 appUser', async () => {
      const request: AppRequest = {
        headers: { authorization: `Bearer ${await signAppToken()}` },
      };
      await expect(
        guardFor(false).canActivate(contextFor(request)),
      ).resolves.toBe(true);
      expect(request.appUser).toEqual({ id: 7, openid: 'openid-7' });
    });

    it('后台 token 打 app 域 → 401（独立 token 域）', async () => {
      const request: AppRequest = {
        headers: { authorization: `Bearer ${await signBackendToken()}` },
      };
      await catchUnauthorized(() =>
        guardFor(false).canActivate(contextFor(request)),
      );
      expect(request.appUser).toBeUndefined();
    });

    it('token 过期 → 401 且文案说明「重新进入」（小程序会静默重登并重试一次）', async () => {
      const expired = await new SignJWT({ scope: 'app', openid: 'openid-7' })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject('7')
        .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
        .sign(secretKey);
      const request: AppRequest = {
        headers: { authorization: `Bearer ${expired}` },
      };
      const message = await catchUnauthorized(() =>
        guardFor(false).canActivate(contextFor(request)),
      );
      expect(message).toBe('登录状态已失效，请重新进入小程序');
    });

    it('sub 不是整数 / openid 缺失 → 401（payload 形态不对不算身份）', async () => {
      const malformed = await new SignJWT({ scope: 'app' })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject('not-a-number')
        .setIssuedAt()
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setExpirationTime('15m')
        .sign(secretKey);
      const request: AppRequest = {
        headers: { authorization: `Bearer ${malformed}` },
      };
      await catchUnauthorized(() =>
        guardFor(false).canActivate(contextFor(request)),
      );
      expect(request.appUser).toBeUndefined();
    });
  });
});
