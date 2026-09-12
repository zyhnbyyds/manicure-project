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
import { getSession } from '../store/session';
import { getThemeState, getThemeTokens, themeStyle } from '../theme/theme';

export interface BasePageData {
  /** `--c-*` 自定义属性串，挂在页面根节点 style 上 */
  themeStyle: string;
  themePrimary: string;
  /** 主色上的可读前景色，供需要内联色值的场景使用 */
  onPrimary: string;
  themeName: string;
  themeEmoji: string;
  /**
   * 登录态两个标志 —— 放进公共数据，**所有页面天然可用**：
   * - `loggedIn`：有 app token，可浏览项目/美甲师/时段
   * - `bound`：已绑定手机号，可下单、看会员与订单
   *
   * 页面用它们决定展示（如未登录时把「会员资产」换成「登录后查看」入口）；
   * 需要身份的动作则统一走 `store/session.ts` 的 `requireSession()` 做引导。
   */
  loggedIn: boolean;
  bound: boolean;
}

export function basePageData(): BasePageData {
  const theme = getThemeState();
  const tokens = getThemeTokens();
  const session = getSession();
  return {
    themeStyle: themeStyle(),
    themePrimary: tokens.primary,
    onPrimary: tokens.onPrimary,
    themeName: theme.name,
    themeEmoji: theme.emoji,
    loggedIn: session.loggedIn,
    bound: session.bound,
  };
}
