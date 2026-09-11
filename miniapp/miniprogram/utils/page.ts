/**
 * 页面公共数据：**每个页面 `onShow` 调一次 `this.setData(basePageData())` 即可**。
 *
 * 为什么要这么一个函数：
 * 主题是全局的，但小程序里没有「全局 CSS 变量」这种东西可以跨页面生效，
 * 每个页面都得把当前主题令牌挂到自己的根节点上。放在这里统一，
 * 页面就只剩一行调用，不会各写各的。
 *
 * 放在 `onShow` 而不是 `onLoad`：从主题页返回时要立刻生效，`onShow` 恰好触发。
 */
import { isMockEnabled, MOCK_BADGE_TEXT } from '../config';
import { getThemeState, getThemeTokens, themeStyle } from '../theme/theme';

export interface BasePageData {
  /** `--c-*` 自定义属性串，挂在页面根节点 style 上 */
  themeStyle: string;
  themePrimary: string;
  /** 主色上的可读前景色，供需要内联色值的场景使用 */
  onPrimary: string;
  themeName: string;
  themeEmoji: string;
  /** 当前是否在演示数据模式（UI 上必须可见，避免被误当成真实数据） */
  isMock: boolean;
  mockBadge: string;
}

export function basePageData(): BasePageData {
  const theme = getThemeState();
  const tokens = getThemeTokens();
  return {
    themeStyle: themeStyle(),
    themePrimary: tokens.primary,
    onPrimary: tokens.onPrimary,
    themeName: theme.name,
    themeEmoji: theme.emoji,
    isMock: isMockEnabled(),
    mockBadge: MOCK_BADGE_TEXT,
  };
}
