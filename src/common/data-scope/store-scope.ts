import { ForbiddenException } from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
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
 * ## 三级门店来源（阶段 1.7 起）
 *
 * 1. **显式 `?storeId=`**（列表筛选、写接口 body）—— 最高优先，不可见就 403；
 * 2. **`actor.storeId`**（顶栏切换器的 `x-store-id` 头）—— 「用户现在在哪家店干活」；
 *    不可见时**静默忽略**（授权可能刚被收回，这不是他的显式请求，不该报错刷屏）；
 * 3. **默认门店**（`defaultStoreId`）—— 写入兜底（`store_id` 是 NOT NULL）。
 *
 * 注意 2 与 3 的差别：**列表用 2 做筛选、写入用 2 做落店**，而两者的「都没传」不同 ——
 * 列表不筛（超管看全部/店长看可见集合），写入落默认门店。所以 `activeStoreId`
 * （用户明确选中的门店）与 `currentStoreId`（这次写入落在哪家店）是两个字段。
 *
 * 为什么用「DB 解析」而不是把门店塞进 JWT：与 `resolveDataScope` 同一取舍 ——
 * 权限/门店调整后**立刻生效**，不用等用户重新登录换 token。
 */
export const STORE_ALL_PERMISSION = 'system:store:all';

export type StoreScope = { kind: 'all' } | { kind: 'stores'; ids: number[] };

/** 门店小档（切换器选项用） */
export type StoreBrief = {
  id: number;
  code: string;
  name: string;
  isDefault: boolean;
};

export type StoreContext = {
  scope: StoreScope;
  /**
   * 切换器**明确选中**的门店（已复核可见性）；`null` = 没选（或选的那家已不可见）。
   *
   * 与 `currentStoreId` 的区别见文件头注释：这个只回答「要不要按店过滤」。
   */
  activeStoreId: number | null;
  /** 写入用的当前门店；`null` = 库里一家门店都没有 */
  currentStoreId: number | null;
};

/** 是否具备「看全部门店」的门店特权（无后台身份的调用方也算：小程序/定时任务） */
export function isStorePrivileged(actor: RequestActor | null): boolean {
  return (
    !actor ||
    actor.permissions.includes('*:*:*') ||
    actor.permissions.includes(STORE_ALL_PERMISSION)
  );
}

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

/** 账号被授权的门店 id（未去重/未过滤启用状态，仅取绑定关系） */
async function boundStoreIds(
  db: StoreDb,
  actor: RequestActor | null,
): Promise<number[]> {
  if (!actor) return [];
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
  return [...new Set(rows.map((row) => row.storeId))].sort((a, b) => a - b);
}

/** 启用中的门店（可按 id 收窄），默认门店排最前 —— 切换器选项与后台列表同一排序 */
async function activeStores(
  db: StoreDb,
  ids?: number[],
): Promise<StoreBrief[]> {
  const conditions = [
    eq(sysStores.status, 'active'),
    isNull(sysStores.deletedAt),
  ];
  if (ids) conditions.push(inArray(sysStores.id, ids));
  return db
    .select({
      id: sysStores.id,
      code: sysStores.code,
      name: sysStores.name,
      isDefault: sysStores.isDefault,
    })
    .from(sysStores)
    .where(and(...conditions))
    .orderBy(desc(sysStores.isDefault), asc(sysStores.sort), asc(sysStores.id));
}

/**
 * 当前账号**能看到**哪些门店（`GET /stores/mine` 用它渲染切换器）。
 *
 * 与 `resolveStoreScope` 的差别：这里**不抛 403**。语义是「我有什么」，
 * 没授权就该老老实实回空列表 —— 让顶栏常驻一条「未分配门店」的提示，
 * 而不是每个页面刷新都弹一次错误框（吵，且挡不住真正的问题）。
 */
export async function listVisibleStores(
  db: StoreDb,
  actor: RequestActor | null,
): Promise<{
  /** `all` = 可看全部门店（超管/门店特权）；`none` = 一家可用的都没有 */
  scope: 'all' | 'stores' | 'none';
  stores: StoreBrief[];
}> {
  if (isStorePrivileged(actor)) {
    const stores = await activeStores(db);
    return { scope: 'all', stores };
  }
  const ids = await boundStoreIds(db, actor);
  if (ids.length === 0) return { scope: 'none', stores: [] };
  const stores = await activeStores(db, ids);
  return { scope: stores.length ? 'stores' : 'none', stores };
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
  const privileged = isStorePrivileged(actor);
  const fallbackId = await defaultStoreId(db);
  // 切换器选中的门店（请求头）；非法值在守卫里已经滤掉，这里只差可见性复核
  const headerId = actor?.storeId ?? null;

  if (privileged) {
    // 超管：显式筛选/选中门店直接生效（含已停用门店 —— 历史单据还看得见），
    // 都没传时不筛门店 = 全部门店合并
    const active = requestedStoreId ?? headerId;
    return {
      scope: { kind: 'all' },
      activeStoreId: active ?? null,
      currentStoreId: active ?? fallbackId,
    };
  }

  const ids = await boundStoreIds(db, actor);
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

  // 头里的门店不可见时静默忽略：那是残留的「上次选的门店」，不是这次的显式请求
  const active =
    requestedStoreId ??
    (headerId !== null && ids.includes(headerId) ? headerId : null);
  const current =
    active ??
    (fallbackId !== null && ids.includes(fallbackId) ? fallbackId : null) ??
    ids[0] ??
    null;
  return {
    scope: { kind: 'stores', ids },
    activeStoreId: active,
    currentStoreId: current,
  };
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

/**
 * 列表查询的 where 片段：门店范围 + 门店筛选（每张单据表都适用）。
 *
 * 筛选优先级：**显式 `?storeId=`** → **切换器选中的门店**（`context.activeStoreId`）→
 * 按 `scope` 展开（超管不筛 / 店长限可见集合）。
 * 阶段 1.7 起传的是整个 `StoreContext`（不再只传 `scope`），
 * 这样「顶栏切到某家店」对所有接了门店的单据表自动生效，不必每个调用点自己判一次。
 */
export function storeConditions(
  column: AnyMySqlColumn,
  context: StoreContext,
  requestedStoreId?: number | null,
): SQL[] {
  const conditions: SQL[] = [];
  const filterId = requestedStoreId ?? context.activeStoreId;
  if (filterId !== undefined && filterId !== null) {
    conditions.push(eq(column, filterId));
    return conditions;
  }
  if (context.scope.kind === 'stores')
    conditions.push(inArray(column, context.scope.ids));
  return conditions;
}

/**
 * 门店上下文的另一种读法：**要按哪些门店筛**（`null` = 不筛，看全部）。
 *
 * 用在「没法写成列条件」的地方 —— 比如「美甲师可服务门店」得先算出 id 集合，
 * 再用 `EXISTS(... IN (ids))` 去匹配关联表。与 `storeConditions` 同一套优先顺序，
 * 只是返回 id 而不是 SQL 片段。
 */
export function storeFilterIds(
  context: StoreContext,
  requestedStoreId?: number | null,
): number[] | null {
  const filterId = requestedStoreId ?? context.activeStoreId;
  if (filterId !== undefined && filterId !== null) return [filterId];
  if (context.scope.kind === 'stores') return context.scope.ids;
  return null;
}
