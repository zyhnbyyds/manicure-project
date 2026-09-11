/**
 * 自定义 TabBar 的选中态同步。
 *
 * 为什么需要这层：微信只在 **Component** 类型上声明了 `getTabBar()`，
 * `Page` 的 typings 里没有，直接 `this.getTabBar()` 过不了类型检查。
 * 这里用「结构化窄类型」代替 `any`：拿不到（未启用自定义 TabBar）时静默跳过。
 *
 * 为什么**不传下标**而是让 TabBar 自己按路由认：
 * 顾客模式与工作台模式的 tab 是两套（首页/预约/我的 ↔ 工作台/我的预约/我的），
 * 同一个「我的」在两个模式下下标不同。写死下标会在切模式后立刻错位，
 * 所以这里只报「当前是哪个页面」，由 TabBar 按当前模式自己算下标。
 */

interface TabBarLike {
  setData(data: Record<string, unknown>): void;
}

/** 当前页面路径，如 `pages/mine/index` */
function currentRoute(): string {
  const pages = getCurrentPages() as { route?: string }[];
  const last = pages[pages.length - 1];
  return typeof last?.route === 'string' ? last.route : '';
}

export function syncTabBar(page: unknown): void {
  const holder = page as { getTabBar?: () => TabBarLike | undefined };
  if (typeof holder.getTabBar !== 'function') return;
  const tabBar = holder.getTabBar();
  if (tabBar && typeof tabBar.setData === 'function') {
    tabBar.setData({ currentRoute: currentRoute() });
  }
}
