import type { MySql2Database } from 'drizzle-orm/mysql2';
import type { relations } from '../../../database/schema/index';

/** 带关系定义的 Drizzle 实例类型 */
export type BizDatabase = MySql2Database<typeof relations>;

/**
 * 事务句柄类型。
 *
 * 事务内一切读写都必须用这个 `tx`（§6.2 硬约束 2）——跑到 `this.database.db`
 * 上就等于绕开了行锁，防超订会失效。
 */
export type BizTx = Parameters<Parameters<BizDatabase['transaction']>[0]>[0];

/** 事务或普通连接（服务方法同时支持两种调用方式时使用） */
export type BizExecutor = BizDatabase | BizTx;

/** 去掉值为 `undefined` 的字段，便于 `update().set(patch)` 局部更新 */
export function withoutUndefined<T extends object>(
  value: T,
): { [K in keyof T]: Exclude<T[K], undefined> } {
  return Object.fromEntries(
    Object.entries(value).filter(([, field]) => field !== undefined),
  ) as { [K in keyof T]: Exclude<T[K], undefined> };
}
