import type { RequestActor } from '../../../common/data-scope/data-scope';
import type { ToolContext } from '../tool.interface';

/**
 * 业务域 AI 工具的公共小工具。
 *
 * 只做两件所有业务查询都要做的事：**夹分页**、**把 ToolContext 转成 RequestActor**。
 * 业务逻辑一律不写在这里 —— 各域的事归各域的 service。
 */

/** AI 工具默认每页条数：比后台列表小，对话里塞 20 条已经要看半天 */
export const TOOL_PAGE_SIZE = 20;

/**
 * AI 工具单页上限。
 *
 * 刻意压到 100（后台接口是 200）：模型一次拿到两百条只会把上下文烧掉、
 * 还容易漏读中间的记录。要更多数据应该让模型分页取。
 */
export const TOOL_MAX_PAGE_SIZE = 100;

/** 夹分页：非法值回落到默认，超限截断，永远返回合法页码与页大小 */
export function clampPage(
  page?: number,
  pageSize?: number,
): { page: number; pageSize: number } {
  const safePage = Math.max(Math.trunc(Number(page)) || 1, 1);
  const requested = Math.trunc(Number(pageSize)) || TOOL_PAGE_SIZE;
  return {
    page: safePage,
    pageSize: Math.min(Math.max(requested, 1), TOOL_MAX_PAGE_SIZE),
  };
}

/**
 * `ToolContext.actor` → `RequestActor`。
 *
 * **不注入 `storeId`**：`ToolContext` 里没有门店上下文（AI 会话不携带 `x-store-id`），
 * 所以工具的门店范围只能靠两条腿 —— 数据权限（scope）与调用方显式传的 `storeId`。
 * 需要锁店时请让模型带上 `storeId` 参数，别在这里偷偷补一个默认店：
 * 悄悄落到某个店会让「AI 说今天没预约」变成一次静默的错误结论。
 */
export function actorOf(context: ToolContext): RequestActor {
  return {
    id: context.actor.id,
    roles: context.actor.roles,
    permissions: context.actor.permissions,
  };
}

/** 通用只读工具的 limits：查询类工具一律不允许批量写、不允许回滚 */
export const READ_ONLY_LIMITS = {
  maxItems: TOOL_MAX_PAGE_SIZE,
  allowBatch: false,
  dryRun: false,
  undoable: false,
} as const;

/** 去掉 `undefined` 值后的同形对象类型（值类型剔除 undefined，键保持可选） */
type Compact<T> = { [K in keyof T]?: Exclude<T[K], undefined> };

/**
 * 丢掉值为 `undefined` 的键。
 *
 * 为什么需要：项目开了 `exactOptionalPropertyTypes`，`{ keyword: undefined }`
 * **不能**赋给 `{ keyword?: string }` —— 但 LLM 传来的入参里大部分键都是 undefined。
 * 直接构造 filter 会编译不过，而挨个写 `...(x !== undefined ? { x } : {})` 又太吵。
 *
 * 注意它只做「删 undefined」，**不会**把 null 也删掉：
 * 很多过滤条件的「不传」与「显式置空」语义不同。
 */
export function defined<T extends object>(value: T): Compact<T> {
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value)) {
    if (val !== undefined) out[key] = val;
  }
  return out as Compact<T>;
}
