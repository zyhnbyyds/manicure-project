/**
 * 应用启动。
 *
 * 两件事，都不阻塞首屏：
 * 1. `initTheme()`：读本地主题偏好并套用（含导航栏配色），保证首屏就是用户选的主题；
 * 2. `ensureLogin()`：静默登录换 app token。**失败只降级为「仅浏览」** ——
 *    这个降级是真的成立：项目 / 美甲师 / 可约时段在后端标了 `@AppOptionalToken()`，
 *    不带凭证按**访客**放行（见 `app-catalog.controller.ts`）。所以静默登录失败
 *    （微信凭据没配、网络抖动、用户没授权）时首屏照样有内容，而不是弹一个 401。
 *    需要身份的动作（下单 / 会员 / 订单）仍由 `requireSession()` 引导去登录。
 */
import { ensureLogin } from './store/auth';
import { initTheme } from './theme/theme';

App<IAppOption>({
  globalData: {},

  onLaunch() {
    initTheme();

    ensureLogin().catch((error: unknown) => {
      console.warn('[manicure] 静默登录失败，进入仅浏览模式', error);
    });
  },
});
