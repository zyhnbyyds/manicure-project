/**
 * 真实 MySQL 集成测试入口（`.agents/skills/testing-acceptance`）。
 *
 * 本期关键验收（并发「恰好 1 个成功」、时区、幂等、余额不为负）**必须**跑在真库上：
 * mock db 永远测不出超订。做法：
 * 1. 从 `TEST_DATABASE_URL` / `.env.test` / `<DATABASE_URL>_test` 推导独立测试库，缺库则建库；
 * 2. 跑一遍 drizzle 迁移建表；
 * 3. **重建一份干净的环境变量**（见 `applyTestEnv`）后再 import `AppModule`，
 *    让整个 Nest 依赖图（含 `BizModule` 的端口绑定）都指向测试库；
 * 4. 用 Fastify 的 `app.inject()` 打真实 HTTP，validation / guard / 事务全是真的。
 */
import { readFile } from 'node:fs/promises';
import { migrate } from 'drizzle-orm/mysql2/migrator';
import { drizzle } from 'drizzle-orm/mysql2';
import mysql from 'mysql2/promise';
import { SignJWT } from 'jose';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

/** 兜底测试库（`.env.test` 与 `.env` 都读不到时使用） */
export const FALLBACK_TEST_DATABASE_URL =
  'mysql://root:123456@127.0.0.1/ruoyi_nest_test';

/** 直接读 env 文件：**不能被其它用例改写 `process.env` 影响** */
async function readEnvFile(file: string): Promise<Record<string, string>> {
  const text = await readFile(file, 'utf8').catch(() => null);
  if (!text) return {};
  const values: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match?.[1]) values[match[1]] = (match[2] ?? '').trim();
  }
  return values;
}

/** 测试库 URL：`TEST_DATABASE_URL` → `.env.test` → `.env` 的主库名 + `_test` → 兜底 */
export async function resolveTestDatabaseUrl(): Promise<string> {
  if (process.env.TEST_DATABASE_URL) return process.env.TEST_DATABASE_URL;
  const fromFiles = {
    ...(await readEnvFile('.env')),
    ...(await readEnvFile('.env.test')),
  };
  if (fromFiles.TEST_DATABASE_URL) return fromFiles.TEST_DATABASE_URL;
  const base =
    fromFiles.DATABASE_URL ??
    (process.env.DATABASE_URL?.includes('@')
      ? process.env.DATABASE_URL
      : undefined) ??
    FALLBACK_TEST_DATABASE_URL;
  const url = new URL(base);
  url.pathname = `${url.pathname.replace(/\/$/, '')}_test`;
  return url.toString();
}

/**
 * 重建测试环境变量。
 *
 * 基线的 `src/config/app-config.service.spec.ts` 会 `process.env = {...}` 覆盖
 * `DATABASE_URL` / `JWT_*`（且不还原），如果集成测试直接用 `process.env`，
 * 整套用例会连到错误的库、甚至因为密钥太短而启动失败。
 * 这里从 env 文件重新铺一遍，保证与其它用例的执行顺序无关。
 */
async function applyTestEnv(testUrl: string): Promise<void> {
  const fromFiles = {
    ...(await readEnvFile('.env')),
    ...(await readEnvFile('.env.test')),
  };
  for (const [key, value] of Object.entries(fromFiles)) {
    if (value !== '') process.env[key] = value;
  }
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = testUrl;
  process.env.SWAGGER_ENABLED = 'false';
  process.env.AI_ENABLED = 'false';
  process.env.SMS_PROVIDER = 'none';
  // Redis 是可选依赖：留空字符串会让 z.url() 校验失败，必须删除变量
  delete process.env.REDIS_URL;
}

/** 建库（若不存在）+ 执行迁移 */
export async function prepareTestDatabase(): Promise<string> {
  const url = await resolveTestDatabaseUrl();
  const parsed = new URL(url);
  const database = parsed.pathname.replace(/^\//, '');
  const adminUrl = new URL(url);
  adminUrl.pathname = '/';
  const admin = await mysql.createConnection(adminUrl.toString());
  await admin.query(
    `CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
  );
  await admin.end();

  const connection = await mysql.createConnection(url);
  const db = drizzle({ client: connection });
  await migrate(db, { migrationsFolder: './src/database/migrations' });
  await connection.end();
  return url;
}

export type TestContext = {
  app: NestFastifyApplication;
  url: string;
  close: () => Promise<void>;
  token: (overrides?: Record<string, unknown>) => Promise<string>;
  /** 小程序端 app token：**故意不含 username / permissions / roles**（§8.3 双向拒绝） */
  appToken: (openid: string, appUserId: number) => Promise<string>;
  request: (
    method: string,
    path: string,
    options?: {
      body?: unknown;
      token?: string | null;
      headers?: Record<string, string>;
    },
  ) => Promise<{ status: number; body: any }>;
  sql: <T = any>(statement: string, params?: unknown[]) => Promise<T>;
  resetBusinessData: () => Promise<void>;
};

/**
 * 启动一个指向测试库的完整 Nest 应用。
 *
 * 必须在 import `AppModule` **之前**覆盖 `process.env.DATABASE_URL`：
 * `AppConfigService` 在构造时读环境变量，晚一步就会连到主库。
 */
export async function createTestContext(): Promise<TestContext> {
  const url = await prepareTestDatabase();
  // 必须在 import AppModule 之前铺好环境变量（AppConfigService 构造时读 env）
  await applyTestEnv(url);

  const [{ Test }, { AppModule }, { FastifyAdapter }] = await Promise.all([
    import('@nestjs/testing'),
    import('../../src/app.module.js'),
    import('@nestjs/platform-fastify'),
  ]);

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter({ logger: false }),
  );
  const { AppConfigService } =
    await import('../../src/config/app-config.service.js');
  const { GlobalExceptionFilter } =
    await import('../../src/common/filters/global-exception.filter.js');
  const { z } = await import('zod');
  const { zhCN } = await import('zod/v4/locales');
  // 与 src/main.ts 保持一致：中文校验提示 + 全局异常过滤器（否则错误响应体形状不同）
  z.config(zhCN());
  app.useGlobalFilters(new GlobalExceptionFilter());
  app.setGlobalPrefix(moduleRef.get(AppConfigService).apiPrefix);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  const pool = mysql.createPool({
    uri: url,
    timezone: 'Z',
    connectionLimit: 10,
  });
  const accessSecret = process.env.JWT_ACCESS_SECRET as string;
  const issuer = process.env.JWT_ISSUER as string;
  const audience = process.env.JWT_AUDIENCE as string;

  /** 统一签发：后台 token 带 `username`（app token 故意不带，见 §8.3） */
  const sign = (
    payload: Record<string, unknown>,
    subject: string,
  ): Promise<string> =>
    new SignJWT(payload)
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(subject)
      .setIssuer(issuer)
      .setAudience(audience)
      .setIssuedAt()
      .setExpirationTime('2h')
      .sign(new TextEncoder().encode(accessSecret));

  const context: TestContext = {
    app,
    url,
    close: async () => {
      await app.close();
      await pool.end();
    },
    token: async (overrides = {}) =>
      sign(
        {
          username: 'admin',
          permissions: ['*:*:*'],
          roles: ['admin'],
          scope: 'access',
          ...overrides,
        },
        '1',
      ),
    appToken: async (openid, appUserId) =>
      sign({ scope: 'app', openid }, String(appUserId)),
    request: async (method, path, options = {}) => {
      const headers: Record<string, string> = { ...options.headers };
      if (options.token !== null) {
        headers.authorization = `Bearer ${options.token ?? (await context.token())}`;
      }
      const response = await app.inject({
        method: method as 'GET',
        url: path.startsWith('/') ? path : `/${path}`,
        headers,
        payload: options.body as never,
      });
      const text = response.body;
      let body: any = text;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        /* 保留原始文本 */
      }
      return { status: response.statusCode, body };
    },
    sql: async <T>(statement: string, params: unknown[] = []) => {
      const [rows] = await pool.query(statement, params);
      return rows as T;
    },
    resetBusinessData: async () => {
      await pool.query('SET FOREIGN_KEY_CHECKS = 0');
      const [rows] = await pool.query<mysql.RowDataPacket[]>(
        `SELECT table_name AS name FROM information_schema.tables
          WHERE table_schema = DATABASE()
            AND (table_name LIKE 'biz\\_%' OR table_name LIKE 'app\\_%'
                 OR table_name LIKE 'sys\\_notice\\_%' OR table_name LIKE 'sys\\_job\\_log')`,
      );
      for (const row of rows)
        await pool.query(`TRUNCATE TABLE \`${row.name}\``);
      // 定时任务在测试里必须静默（否则 CronJob 会在用例中途改数据）
      await pool.query(`UPDATE sys_job SET status = 'disabled'`);
      await pool.query('SET FOREIGN_KEY_CHECKS = 1');
    },
  };
  await context.resetBusinessData();
  return context;
}

/** 断言辅助：取分页列表的 items（列表接口没有 total） */
export function itemsOf(body: any): any[] {
  return Array.isArray(body?.items) ? body.items : [];
}
