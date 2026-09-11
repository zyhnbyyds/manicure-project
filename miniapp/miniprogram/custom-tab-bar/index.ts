import { isStaffMode } from '../store/mode';
import { getThemeTokens, themeStyle } from '../theme/theme';

interface TabItem {
  pagePath: string;
  text: string;
  emoji: string;
}

/**
 * 两套 tab：顾客模式与工作台模式。
 *
 * `app.json` 的 `tabBar.list` 必须**两种模式加起来都注册**（`wx.switchTab` 只认
 * 里面出现过的路径），真正「显示哪几个」由这里按模式决定 —— 所以两套路径都写全，
 * 但一次只渲染其中一个子集。
 */
const CUSTOMER_TABS: TabItem[] = [
  { pagePath: 'pages/index/index', text: '首页', emoji: '🏠' },
  { pagePath: 'pages/bookings/index', text: '预约', emoji: '📅' },
  { pagePath: 'pages/mine/index', text: '我的', emoji: '🎀' },
];

const STAFF_TABS: TabItem[] = [
  { pagePath: 'pages/staff-workbench/index', text: '工作台', emoji: '💅' },
  { pagePath: 'pages/staff-bookings/index', text: '我的预约', emoji: '📅' },
  { pagePath: 'pages/mine/index', text: '我的', emoji: '🎀' },
];

/**
 * 自定义 TabBar（而非 app.json 原生 TabBar）的理由：
 * 1. 原生 TabBar 的配色只能由 `wx.setTabBarStyle` 改，图标必须是位图，
 *    而本工程没有设计稿/位图素材（按计划 H11 等素材），emoji + 主题色即可做到「可爱 + 可换主题」；
 * 2. 自定义后 TabBar 本身也吃 `--c-*` 令牌，换主题时底部一起变，主题感完整；
 * 3. **模式切换要换整套 tab**，原生 TabBar 做不到运行时换列表。
 */
Component({
  data: {
    selected: 0,
    currentRoute: '',
    tabs: CUSTOMER_TABS,
    themeStyle: '',
    idleColor: '',
    staffMode: false,
  },

  lifetimes: {
    attached() {
      this.applyTheme();
      this.applyMode();
    },
  },

  /**
   * 自定义 TabBar 是**常驻组件**：切 Tab、从其它页面返回都不会重新 `attached`。
   * 这里用 `pageLifetimes.show` 重新取一次主题与模式即可覆盖真实路径
   * （主题页 / 模式切换都在非 Tab 页或页面 onShow 里发生，返回必然触发 show），
   * 因此不必引入订阅 + 解绑的簿记，也就没有监听器泄漏的风险。
   */
  pageLifetimes: {
    show() {
      this.applyTheme();
      this.applyMode();
    },
  },

  methods: {
    applyTheme() {
      this.setData({
        themeStyle: themeStyle(),
        idleColor: getThemeTokens().textWeak,
      });
    },

    /** 按当前模式换整套 tab，并按当前路由重算下标（两套下标对不上，不能写死） */
    applyMode() {
      const staffMode = isStaffMode();
      const tabs = staffMode ? STAFF_TABS : CUSTOMER_TABS;
      const index = tabs.findIndex((tab) => tab.pagePath === this.data.currentRoute);
      this.setData({
        staffMode,
        tabs,
        // 找不到说明当前页不在这一套里（比如刚切模式），退回第一个 tab
        selected: index >= 0 ? index : 0,
      });
    },

    onTap(event: WechatMiniprogram.TouchEvent) {
      const index = Number(event.currentTarget.dataset.index);
      const tab = this.data.tabs[index];
      if (!tab || index === this.data.selected) return;
      wx.switchTab({ url: `/${tab.pagePath}` });
    },
  },
});
