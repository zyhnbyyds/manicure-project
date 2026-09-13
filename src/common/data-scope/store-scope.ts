import { ForbiddenException } from '@nestjs/common';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { AnyMySqlColumn } from 'drizzle-orm/mysql-core';
import type { MySql2Database } from 'drizzle-orm/mysql2';
import {
  sysStores,
  sysUserStores,
  type relations,
} from '../../database/schema/index';
import type { RequestActor } from './data-scope.js';

type Schema = typeof relations;
/** 只要求「能 select」的最小能力，好让 service 既传 `db` 也传 `tx` */
type StoreDb = Pick<MySql2Database<Schema>, 'select'>;

/**
 * 门店范围（连锁直营）。
 *
 * | 账号 | 规则 |
 * | --- | --- |
 * | 超级管理员（`*:*:*`）或拥有 `system:store:all` | 全部门店，**可按门店筛选** |
 * | 普通后台账号 | 只看 `sys_user_store` 里分给自己的门店；可按其中任意门店筛选 |
 * | 一个门店都没分到（且不是超管） | **403 + 明确原因**，而不是静默返回空列表 |
 *
 * `currentStoreId` 是「写入时这笔单据属于哪家店」：优先用请求显式指定的门店，
 * 否则取可见集合里的默认门店（单店期就是唯一那家）。
 *
 * 为什么用「DB 解析」而不是把门店塞进 JWT：与 `resolveDataScope` 同一取舍 ——
 * 权限/门店调整后**立刻生效**，不用等用户重新登录换 token。
 */
export const STORE_ALL_PERMISSION = 'system:store:all';

export type StoreScope = { kind: 'all' } | { kind: 'stores'; ids: number[] };

export type StoreContext = {
  scope: StoreScope;
  /** 写入用的当前门店；`null` = 库里一家门店都没有 */
  currentStoreId: number | null;
};

/** 默认门店（没有标记默认时回落到第一个启用门店） */
export async function defaultStoreId(db: StoreDb): Promise<number | null> {
  const [marked] = await db
    .select({ id: sysStores.id })
    .from(sysStores)
    .where(
      and(
        eq(sysStores.isDefault, true),
        eq(sysStores.status, 'active'),
        isNull(sysStores.deletedAt),
      ),
    )
    .orderBy(asc(sysStores.sort), asc(sysStores.id))
    .limit(1);
  if (marked) return marked.id;

  const [fallback] = await db
    .select({ id: sysStores.id })
    .from(sysStores)
    .where(and(eq(sysStores.status, 'active'), isNull(sysStores.deletedAt)))
    .orderBy(asc(sysStores.sort), asc(sysStores.id))
    .limit(1);
  return fallback?.id ?? null;
}

/**
 * 解析门店范围与「当前门店」。
 *
 * `actor` 传 `null` = 无后台身份的调用方（小程序顾客、定时任务）→ 不限制范围，
 * 当前门店取默认门店；跨店写入由调用方显式传 `requestedStoreId`。
 */
export async function resolveStoreScope(
  db: StoreDb,
  actor: RequestActor | null,
  requestedStoreId?: number | null,
): Promise<StoreContext> {
  const privileged =
    !actor ||
    actor.permissions.includes('*:*:*') ||
    actor.permissions.includes(STORE_ALL_PERMISSION);
  const fallbackId = await defaultStoreId(db);

  if (privileged) {
    return {
      scope: { kind: 'all' },
      currentStoreId: requestedStoreId ?? fallbackId,
    };
  }

  const rows = await db
    .select({ storeId: sysUserStores.storeId })
    .from(sysUserStores)
    .innerJoin(sysStores, eq(sysStores.id, sysUserStores.storeId))
    .where(
      and(
        eq(sysUserStores.userId, actor.id),
        eq(sysStores.status, 'active'),
        isNull(sysStores.deletedAt),
      ),
    );
  const ids = [...new Set(rows.map((row) => row.storeId))].sort(
    (a, b) => a - b,
  );
  if (ids.length === 0)
    throw new ForbiddenException(
      '当前账号未分配门店，请联系管理员分配门店后再操作',
    );
  if (
    requestedStoreId !== undefined &&
    requestedStoreId !== null &&
    !ids.includes(requestedStoreId)
  )
    throw new ForbiddenException('无权查看或操作该门店的数据');

  const current =
    requestedStoreId ??
    (fallbackId !== null && ids.includes(fallbackId) ? fallbackId : ids[0]) ??
    null;
  return { scope: { kind: 'stores', ids }, currentStoreId: current };
}

/** 写入用：拿不到具体门店就直接拒绝（`store_id` 是 NOT NULL，硬塞 0 会变成脏数据） */
export async function requireCurrentStoreId(
  db: StoreDb,
  actor: RequestActor | null,
  requestedStoreId?: number | null,
): Promise<number> {
  const { currentStoreId } = await resolveStoreScope(
    db,
    actor,
    requestedStoreId,
  );
  if (currentStoreId === null)
    throw new ForbiddenException(
      '系统里还没有门店，请先在「门店管理」里建一家门店',
    );
  return currentStoreId;
}

/** 列表查询的 where 片段：门店范围 + 可选的门店筛选（每张单据表都适用） */
export function storeConditions(
  column: AnyMySqlColumn,
  scope: StoreScope,
  requestedStoreId?: number | null,
): SQL[] {
  const conditions: SQL[] = [];
  // 显式筛选优先：它一定在可见集合内（否则 resolveStoreScope 已经 403）
  if (requestedStoreId !== undefined && requestedStoreId !== null) {
    conditions.push(eq(column, requestedStoreId));
    return conditions;
  }
  if (scope.kind === 'stores') conditions.push(inArray(column, scope.ids));
  return conditions;
}
