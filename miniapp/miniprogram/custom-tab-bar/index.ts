import { isStaffMode } from '../store/mode';
import { getThemeTokens, themeStyle } from '../theme/theme';
import { buildIcons, type IconName } from '../utils/icons';

interface TabItem {
  pagePath: string;
  text: string;
  icon: IconName;
}

/**
 * 两套 tab：顾客模式与工作台模式。
 *
 * `app.json` 的 `tabBar.list` 必须**两种模式加起来都注册**（`wx.switchTab` 只认
 * 里面出现过的路径），真正「显示哪几个」由这里按模式决定 —— 所以两套路径都写全，
 * 但一次只渲染其中一个子集。
 */
const CUSTOMER_TABS: TabItem[] = [
  { pagePath: 'pages/index/index', text: '首页', icon: 'home' },
  { pagePath: 'pages/bookings/index', text: '预约', icon: 'calendar' },
  { pagePath: 'pages/mine/index', text: '我的', icon: 'person' },
];

const STAFF_TABS: TabItem[] = [
  { pagePath: 'pages/staff-workbench/index', text: '工作台', icon: 'grid' },
  { pagePath: 'pages/staff-bookings/index', text: '我的预约', icon: 'calendar' },
  { pagePath: 'pages/mine/index', text: '我的', icon: 'person' },
];

const TAB_ICONS: IconName[] = ['home', 'calendar', 'person', 'grid'];

/**
 * 自定义 TabBar（而非 app.json 原生 TabBar）的理由：
 * 1. 原生 TabBar 的配色只能由 `wx.setTabBarStyle` 改，图标必须是位图，
 *    而本工程没有设计稿/位图素材（按计划 H11 等素材），内联 SVG 图标即可做到「可换主题」；
 * 2. 自定义后 TabBar 本身也吃 `--c-*` 令牌，换主题时底部一起变，主题感完整；
 * 3. **模式切换要换整套 tab**，原生 TabBar 做不到运行时换列表。
 *
 * ## 两个曾真踩过的坑（改动前务必读）
 *
 * **① 高亮必须由「真实路由」算，不能由页面报上来。**
 * 组件是**每个 tab 页各有一个实例**：新页面的实例带着 `currentRoute: ''` 出生，
 * `attached` / `pageLifetimes.show` 里算出 `findIndex === -1` → 退回 `selected: 0`；
 * 而页面 `onShow` 里的 `syncTabBar()` 只写了 `currentRoute`、**不会重算 `selected`**。
 * 结果：人在「我的」，高亮却在「首页」。
 * → 现在 `refresh()` 自己读 `getCurrentPages()`，一次算清，不依赖任何页面配合。
 *
 * **② 有了错位的高亮，`index === selected` 的提前 return 就会把点击吞掉。**
 * 人在「我的」、高亮在「首页」时点「首页」：`index(0) === selected(0)` → 直接 return，
 * 页面一动不动 —— 这就是用户说的「切不动」。
 * → 现在只对「真实当前页」短路，且短路时顺手把高亮校准回来。
 */
Component({
  data: {
    /** 当前高亮下标（由 `refresh()` 从真实路由算出；点击时先乐观更新） */
    selected: 0,
    /** 真实当前路由（排障与自动化断言用） */
    currentRoute: '',
    tabs: CUSTOMER_TABS,
    themeStyle: '',
    staffMode: false,
    /** 细线图标两态：未选弱色、选中主色；两态**同时渲染**靠透明度交叉淡入（见 wxml） */
    iconsIdle: buildIcons(TAB_ICONS, '#B9B3AE'),
    iconsActive: buildIcons(TAB_ICONS, '#B45F6B'),
    /** `switchTab` 在途：连点保护，避免动画/路由打架 */
    switching: false,
  },

  lifetimes: {
    attached() {
      this.refresh();
    },
  },

  /**
   * 自定义 TabBar 是**常驻组件**：切 Tab、从其它页面返回都不会重新 `attached`。
   * `pageLifetimes.show` 覆盖「主题页 / 模式切换后返回」这条路径。
   */
  pageLifetimes: {
    show() {
      this.refresh();
    },
  },

  methods: {
    /** 页面栈顶的真实路由；拿不到时返回空串（调用方自行兜底） */
    realRoute(): string {
      const pages = getCurrentPages() as { route?: string }[];
      const last = pages[pages.length - 1];
      return typeof last?.route === 'string' ? last.route : '';
    },

    /**
     * 一次算清「主题 + 模式 + 高亮」。
     *
     * 路由找不到对应 tab（理论上只在极端时序下发生）时**保留当前高亮**，
     * 不退回 0 —— 退回 0 正是坑 ① 的症状来源。
     */
    refresh() {
      const tokens = getThemeTokens();
      const staffMode = isStaffMode();
      const tabs = staffMode ? STAFF_TABS : CUSTOMER_TABS;
      const route = this.realRoute();
      const index = tabs.findIndex((tab) => tab.pagePath === route);
      this.setData({
        themeStyle: themeStyle(),
        iconsIdle: buildIcons(TAB_ICONS, tokens.textWeak),
        iconsActive: buildIcons(TAB_ICONS, tokens.primary),
        staffMode,
        tabs,
        currentRoute: route,
        selected: index >= 0 ? index : this.data.selected,
      });
    },

    onTap(event: WechatMiniprogram.TouchEvent) {
      const index = Number(event.currentTarget.dataset.index);
      const tab = this.data.tabs[index];
      if (!tab) return;

      // ① 已经在目标页：不发请求，只把高亮校准回来。
      //    **不能**用 `index === selected` 短路 —— 高亮可能来自上一次的乐观更新或脏数据，
      //    那样会把「点当前高亮那个 tab」变成一次死点击（历史 bug）。
      if (this.realRoute() === tab.pagePath) {
        if (this.data.selected !== index) this.setData({ selected: index });
        return;
      }

      // ② 连点保护：switchTab 在途时忽略后续点击（否则会出现「点了两次、回到原地」）
      if (this.data.switching) return;
      this.setData({ switching: true, selected: index });

      wx.switchTab({
        url: `/${tab.pagePath}`,
        fail: (error) => {
          // 静默失败最糟：用户只会觉得「点了没反应」。这里校准高亮并给一次明确反馈。
          this.refresh();
          wx.showToast({ title: '切换失败，请重试', icon: 'none' });
          console.warn('[tabbar] switchTab 失败', error);
        },
        complete: () => {
          this.setData({ switching: false });
        },
      });
    },
  },
});
