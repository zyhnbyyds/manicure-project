/**
 * 小程序自助支付的**灰度分桶**。
 *
 * ## 为什么要稳定分桶
 *
 * 「放量 30%」这件事只有落在**同一个身份永远得到同一个答案**时才有意义。
 * 用随机数或时间做判断，用户刷新一次就在「能付 / 不能付」之间跳 ——
 * 既没法排查，也会让「入口可见但下单被拒」变成随机现象。
 * 所以这里用 FNV-1a 哈希：纯函数、无依赖、跨进程结果恒定。
 *
 * ## 键的选择
 *
 * 用 `app_wx_user.id`（微信身份的主键）：
 * - 已是接口入参，**不需要多查一次库**；
 * - 与 openid 一样「一个微信号一个值」，换手机 / 重装小程序都不变。
 *
 * ## 与合规闸门的关系（**不是二选一，是 AND**）
 *
 * 合规（`APP_SELF_PAY_ENABLED`）是**硬闸门**，灰度是它之上的**放量旋钮**：
 * 虚拟支付未接入时，占比设成 100 也不生效 —— 否则这个旋钮就成了绕过合规的口子。
 */

/**
 * 把身份键映射到 `0..99` 的桶。
 *
 * 用 FNV-1a 32 位：`Math.imul` 保证 32 位乘法不丢精度，`>>> 0` 转无符号，
 * 避免负余数导致某些桶永远取不到。
 */
export function bucketOf(key: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % 100;
}

/**
 * 该身份是否落在灰度内。
 *
 * - `percent <= 0` → 恒 `false`（只预约模式）；
 * - `percent >= 100` → 恒 `true`（全量）；
 * - 其余按 `bucket < percent`，所以「30%」真的约等于 30% 的人。
 */
export function inPayRollout(appUserId: number, percent: number): boolean {
  if (percent <= 0) return false;
  if (percent >= 100) return true;
  return bucketOf(String(appUserId)) < percent;
}
