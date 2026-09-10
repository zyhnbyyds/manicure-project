/* 自检脚本（临时，跑完删除）：验证 app 域 token 双向拒绝 + 参数归一化 + VO 字段集合 */
import 'reflect-metadata';
import { Reflector } from '@nestjs/core';
import { SignJWT } from 'jose';
import { AppConfigService } from './src/config/app-config.service.js';
import { DatabaseService } from './src/database/database.service.js';
import { AccessTokenGuard } from './src/common/auth/access-token.guard.js';
import { AppAccessTokenGuard } from './src/modules/app/auth/app-access-token.guard.js';
import { AppAuthService } from './src/modules/app/auth/app-auth.service.js';
import {
  appAvailableSlotsQuerySchema,
  appServiceItemIdsSchema,
  appServiceItemVo,
  normalizeServiceItemIds,
} from './src/modules/app/dto/app-vo.js';

process.env['NODE_ENV'] = 'test';
process.env['DATABASE_URL'] = 'mysql://root:root@127.0.0.1:3306/nail';
process.env['JWT_ISSUER'] = 'nail-salon';
process.env['JWT_AUDIENCE'] = 'nail-salon-web';
process.env['JWT_ACCESS_SECRET'] = 'a'.repeat(40);
process.env['JWT_REFRESH_SECRET'] = 'b'.repeat(40);

const config = new AppConfigService();
const secrets = new TextEncoder();

function context(token?: string) {
  const request: { headers: Record<string, string>; user?: unknown; appUser?: unknown } = {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  };
  return {
    request,
    ctx: {
      getHandler: () => () => undefined,
      getClass: () => class {},
      switchToHttp: () => ({ getRequest: () => request }),
    },
  } as never as {
    request: typeof request;
    ctx: Parameters<AccessTokenGuard['canActivate']>[0];
  };
}

async function allow(guard: { canActivate: (c: never) => Promise<boolean> }, token: string) {
  try {
    return await guard.canActivate(context(token).ctx as never);
  } catch {
    return false;
  }
}

// 1) 用真实 service 签发 app token
const auth = new AppAuthService(new DatabaseService(config), config);
const sign = (auth as unknown as { signAppToken: (id: number, openid: string) => Promise<string> })
  .signAppToken;
const appToken = await sign.call(auth, 7, 'openid-check');

// 2) 后台风格 token（有 username、无 scope）
const backendToken = await new SignJWT({ username: 'admin', permissions: ['*:*:*'], roles: ['admin'] })
  .setProtectedHeader({ alg: 'HS256' })
  .setSubject('1')
  .setIssuedAt()
  .setIssuer(config.jwt.JWT_ISSUER)
  .setAudience(config.jwt.JWT_AUDIENCE)
  .setExpirationTime('15m')
  .sign(secrets.encode(config.jwt.JWT_ACCESS_SECRET));

const appGuard = new AppAccessTokenGuard(config);
const backendGuard = new AccessTokenGuard(new Reflector(), config);

const { request, ctx } = context(appToken);
await appGuard.canActivate(ctx as never);
console.log('app token → appUser:', JSON.stringify(request.appUser));
console.log('app token  → app guard   :', await allow(appGuard, appToken), '(期望 true)');
console.log('app token  → admin guard :', await allow(backendGuard, appToken), '(期望 false)');
console.log('be  token  → app guard   :', await allow(appGuard, backendToken), '(期望 false)');
console.log('be  token  → admin guard :', await allow(backendGuard, backendToken), '(期望 true)');
console.log('无 token   → app guard   :', await allow(appGuard, ''), '(期望 false)');

// 3) serviceItemIds 归一化：逗号 / 重复 query / 去重 / 越界
console.log('ids "1,2"      :', JSON.stringify(normalizeServiceItemIds('1,2')));
console.log('ids ["1","2,3"]:', JSON.stringify(normalizeServiceItemIds(['1', '2,3'])));
console.log('ids "2,2,3"    :', JSON.stringify(normalizeServiceItemIds('2,2,3')));
console.log(
  'query parse    :',
  JSON.stringify(
    appAvailableSlotsQuerySchema.parse({ staffId: '3', date: '2026-09-11', serviceItemIds: '1,2' }),
  ),
);
for (const bad of ['', '1,2,3,4', 'x']) {
  try {
    appServiceItemIdsSchema.parse(normalizeServiceItemIds(bad));
    console.log(`ids ${JSON.stringify(bad)} → 未报错（期望 400）`);
  } catch {
    console.log(`ids ${JSON.stringify(bad)} → 400 ✓`);
  }
}

// 4) 内部字段泄露检查：带内部字段的行 → VO 字段集合
const row = {
  id: 1,
  name: '单色甲',
  category: '基础',
  durationMinutes: 60,
  bufferMinutes: 15,
  price: 12800,
  description: 'x',
  image: null,
  status: 'active',
  sort: 1,
  remark: '内部备注',
  createdBy: 9,
  deletedAt: null,
};
const vo = appServiceItemVo.parse(row);
console.log('VO keys:', Object.keys(vo).join(','), '| 泄露:', ['bufferMinutes', 'status', 'sort', 'remark', 'createdBy'].filter((k) => k in vo));

// 5) 登录接口限流装饰器是否真的挂到了路由 metadata（@fastify/rate-limit 读 config.rateLimit）
const { AppAuthController } = await import('./src/modules/app/auth/app-auth.controller.js');
console.log(
  'login @RouteConfig:',
  JSON.stringify(Reflect.getMetadata('__fastify_route_config__', AppAuthController.prototype.login)),
);
console.log('login @Public:', Reflect.getMetadata('isPublic', AppAuthController) !== undefined);

