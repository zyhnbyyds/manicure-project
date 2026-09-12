/**
 * 自定义 TabBar 的选中态同步。
 *
 * 为什么需要这层：微信只在 **Component** 类型上声明了 `getTabBar()`，
 * `Page` 的 typings 里没有，直接 `this.getTabBar()` 过不了类型检查。
 * 这里用「结构化窄类型」代替 `any`：拿不到（未启用自定义 TabBar）时静默跳过。
 *
 * ## 为什么**不传下标**
 *
 * 顾客模式与工作台模式的 tab 是两套（首页/预约/我的 ↔ 工作台/我的预约/我的），
 * 同一个「我的」在两个模式下下标不同，写死下标会在切模式后立刻错位。
 *
 * 更关键的是：**下标不能让页面来算**。页面只知道自己的 route，
 * 而「哪几个 tab、当前该高亮第几个」是 TabBar 的私有知识
 * （历史 bug：页面只报了 route、没重算 selected，于是「人在我的、高亮在首页」，
 * 而高亮错位又让 `index === selected` 那种提前 return 把点击吞掉 → 切不动）。
 *
 * 所以这里只做一件事：**戳一下让它自己按真实路由重算**（`refresh()`）。
 * 真正的取路由逻辑在 `custom-tab-bar/index.ts`，那边读 `getCurrentPages()`，不依赖任何人。
 */

interface TabBarLike {
  refresh?: () => void;
}

export function syncTabBar(page: unknown): void {
  const holder = page as { getTabBar?: () => TabBarLike | undefined };
  if (typeof holder.getTabBar !== 'function') return;
  const tabBar = holder.getTabBar();
  if (tabBar && typeof tabBar.refresh === 'function') {
    tabBar.refresh();
  }
}
