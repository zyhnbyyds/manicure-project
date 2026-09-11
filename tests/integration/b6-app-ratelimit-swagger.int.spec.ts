/**
 * G9：限流是否**真的生效** + Swagger 的 app 分组。
 *
 * 为什么单独一个文件：默认 harness 起的 app **不注册** `@fastify/rate-limit`
 * （那是 `src/main.ts` 的 bootstrap 行为），所以「登录 10 次/分钟」这条安全约束
 * 在既往所有用例里都等于没验过。这里用 `createTestContext({ configure })` 补上注册，
 * 复刻 main.ts 的写法，才算真的把它跑了一遍。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './harness.js';

let ctx: TestContext;

/**
 * 与 `src/main.ts` 保持一致：全局 100/min。
 * 登录接口再靠 `@RouteConfig({ rateLimit: { max: 10 } })` 收紧到 10/min。
 */
async function registerRateLimit(app: TestContext['app']): Promise<void> {
  const rateLimit = (await import('@fastify/rate-limit')).default;
  await app.register(rateLimit, { max: 100, timeWindow: '1 minute' });
}

beforeAll(async () => {
  ctx = await createTestContext({ configure: registerRateLimit });
}, 120_000);

beforeEach(async () => {
  await ctx.resetBusinessData();
});

afterAll(async () => {
  await ctx.close();
});

describe('B6 限流：登录接口 10 次/分钟（G9）', () => {
  it('第 11 次登录被限流 → 429，并带重试提示头', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 11; i += 1) {
      // 每次换 code：避免命中「同一 openid 复用身份」而干扰计数口径
      const response = await ctx.request('POST', '/api/v1/app/auth/login', {
        token: null,
        body: { code: `rate-${i}` },
      });
      statuses.push(response.status);
    }

    expect(statuses.slice(0, 10).every((s) => s === 201)).toBe(true);
    expect(statuses[10]).toBe(429);

    const limited = await ctx.request('POST', '/api/v1/app/auth/login', {
      token: null,
      body: { code: 'rate-again' },
    });
    expect(limited.status).toBe(429);
    // 必须是「被限流」而不是「服务器坏了」：客户端据此退避，而不是当成 500 猛重试
    expect(String(limited.body.message)).toContain('请求过于频繁');
    expect(limited.headers['retry-after']).toBeDefined();
    expect(Number(limited.headers['x-ratelimit-limit'])).toBe(10);
  });

  it('别的 app 端点不受 10 次限制 → 限流是**按路由**收紧的，不是全局一刀切', async () => {
    for (let i = 0; i < 20; i += 1) {
      const wx = await ctx.sql<{ insertId: number }>(
        `INSERT INTO app_wx_user (openid) VALUES (?)`,
        [`openid-rl-${i}`],
      );
      const token = await ctx.appToken(`openid-rl-${i}`, wx.insertId);
      const response = await ctx.request('GET', '/api/v1/app/service-items', {
        token,
      });
      expect(response.status, `第 ${i + 1} 次`).toBe(200);
    }
  });
});

describe('B6 Swagger：app 域独立分组（G9）', () => {
  it('app 端点都归到「小程序端」分组，且挂的是 app-token 而不是后台 token', async () => {
    const { DocumentBuilder, SwaggerModule } = await import('@nestjs/swagger');
    const config = new DocumentBuilder()
      .setTitle('t')
      .addBearerAuth({ type: 'http', scheme: 'bearer' }, 'access-token')
      .addBearerAuth({ type: 'http', scheme: 'bearer' }, 'app-token')
      .build();
    const document = SwaggerModule.createDocument(ctx.app, config);

    const appPaths = Object.entries(document.paths as Record<string, any>)
      .filter(([path]) => path.startsWith('/api/v1/app/'))
      .map(([path, item]) => ({ path, item }));
    // 至少有登录 / 绑定手机号 / 目录 / 会员 / 工作台这些端点
    expect(appPaths.length).toBeGreaterThan(10);

    for (const { path, item } of appPaths) {
      for (const [method, operation] of Object.entries<any>(item)) {
        if (method === 'parameters') continue;
        // 美甲师工作台单独分了一组（`小程序端 - 美甲师`），这里只要求归在小程序端之下
        expect(
          operation.tags?.[0],
          `${method.toUpperCase()} ${path} 没归到小程序端分组`,
        ).toMatch(/^小程序端/);
      }
    }

    // 支付回调是渠道方向，不能挂 app-token 安全要求
    const notify =
      (document.paths as Record<string, any>)['/api/v1/app/payments/wxpay/notify']
        ?.post;
    expect(notify).toBeDefined();
    expect(notify.security ?? []).toEqual([]);

    // 需要 app token 的端点必须显式声明 app-token（否则前端文档会误导成后台 token）
    const login = (document.paths as Record<string, any>)['/api/v1/app/auth/login']
      ?.post;
    expect(login).toBeDefined();

    const schemes = document.components?.securitySchemes ?? {};
    expect(Object.keys(schemes)).toContain('app-token');
    expect(Object.keys(schemes)).toContain('access-token');
  });
});
