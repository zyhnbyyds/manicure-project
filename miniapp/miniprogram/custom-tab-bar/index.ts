import { getThemeTokens, themeStyle } from '../theme/theme';

interface TabItem {
  pagePath: string;
  text: string;
  emoji: string;
}

/** 与 `app.json` 的 `tabBar.list` 顺序**必须一致**（`selected` 用下标对齐） */
const TABS: TabItem[] = [
  { pagePath: 'pages/index/index', text: '首页', emoji: '🏠' },
  { pagePath: 'pages/bookings/index', text: '预约', emoji: '📅' },
  { pagePath: 'pages/mine/index', text: '我的', emoji: '🎀' },
];

/**
 * 自定义 TabBar（而非 app.json 原生 TabBar）的理由：
 * 1. 原生 TabBar 的配色只能由 `wx.setTabBarStyle` 改，图标必须是位图，
 *    而本工程没有设计稿/位图素材（按计划 H11 等素材），emoji + 主题色即可做到「可爱 + 可换主题」；
 * 2. 自定义后 TabBar 本身也吃 `--c-*` 令牌，换主题时底部一起变，主题感完整。
 */
Component({
  data: {
    selected: 0,
    tabs: TABS,
    themeStyle: '',
    idleColor: '',
  },

  lifetimes: {
    attached() {
      this.applyTheme();
    },
  },

  /**
   * 自定义 TabBar 是**常驻组件**：切 Tab、从其它页面返回都不会重新 `attached`。
   * 这里用 `pageLifetimes.show` 重新取一次主题即可覆盖真实路径
   * （主题页是非 Tab 页，改完主题返回必然触发 show），
   * 因此不必引入订阅 + 解绑的簿记，也就没有监听器泄漏的风险。
   */
  pageLifetimes: {
    show() {
      this.applyTheme();
    },
  },

  methods: {
    applyTheme() {
      this.setData({
        themeStyle: themeStyle(),
        idleColor: getThemeTokens().textWeak,
      });
    },

    onTap(event: WechatMiniprogram.TouchEvent) {
      const index = Number(event.currentTarget.dataset.index);
      const tab = TABS[index];
      if (!tab || index === this.data.selected) return;
      wx.switchTab({ url: `/${tab.pagePath}` });
    },
  },
});
