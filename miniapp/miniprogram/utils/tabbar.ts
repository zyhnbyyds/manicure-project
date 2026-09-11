/**
 * 自定义 TabBar 的选中态同步。
 *
 * 为什么需要这层：微信只在 **Component** 类型上声明了 `getTabBar()`，
 * `Page` 的 typings 里没有，直接 `this.getTabBar()` 过不了类型检查。
 * 这里用「结构化窄类型」代替 `any`：拿不到（未启用自定义 TabBar）时静默跳过。
 */

interface TabBarLike {
  setData(data: Record<string, unknown>): void;
}

export function syncTabBar(page: unknown, selected: number): void {
  const holder = page as { getTabBar?: () => TabBarLike | undefined };
  if (typeof holder.getTabBar !== 'function') return;
  const tabBar = holder.getTabBar();
  if (tabBar && typeof tabBar.setData === 'function') {
    tabBar.setData({ selected });
  }
}
