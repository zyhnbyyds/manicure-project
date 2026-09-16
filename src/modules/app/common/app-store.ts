import { StorePort, type StoreRow } from '../../biz/common/ports';

/**
 * 小程序传「当前门店」用的请求头。
 *
 * 与后台切换器**同名**，但两者取值规则完全不同（见下面 `resolveAppStore`）——
 * 复用同一个名字是为了「门店是请求级上下文」这件事在两端长得一样。
 */
export const STORE_HEADER = 'x-store-id';

/**
 * 小程序（app 域）的「当前门店」解析。
 *
 * ## 为什么不复用后台的 `resolveStoreScope`
 *
 * 后台那套回答的是「**这个账号被授权了哪些门店**」（`sys_user_store` 的范围问题）；
 * 而小程序的顾客**没有**这个范围，他只能选「一家店」。所以这里规则简单得多：
 *
 * 1. 头里的 id 存在、**启用**、未软删 → 用它；
 * 2. 其它一切情况（没传 / 传了乱值 / 门店已停用）→ **回落默认门店** ——
 *    宁可退化成单店期的老行为，也不要因为一个小程序本地缓存过期就让顾客下不了单；
 * 3. 连默认门店都没有（老库还没跑迁移）→ `null`，调用方自己兜。
 *
 * 返回的是**整行门店**（而不只是 id）：调用方通常马上要用名称 / 坐标 / 图集，
 * 再查一次纯属浪费。
 */
export async function resolveAppStore(
  stores: StorePort,
  headerValue: unknown,
): Promise<StoreRow | null> {
  const parsed = Number(headerValue);
  if (Number.isSafeInteger(parsed) && parsed > 0) {
    const store = await stores.findById(parsed);
    if (store && store.status === 'active' && !store.deletedAt) return store;
  }
  return stores.findDefault();
}
