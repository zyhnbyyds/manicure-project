/**
 * 应用启动。
 *
 * 两件事，都不阻塞首屏：
 * 1. `initTheme()`：读本地主题偏好并套用（含导航栏配色），保证首屏就是用户选的主题；
 * 2. `ensureLogin()`：静默登录换 app token。**失败只降级为「仅浏览」**——
 *    未配置微信凭据时后端按 spec §16.1 返回 503，此时项目 / 美甲师 / 可约时段
 *    仍应能看（这也是后端把浏览类接口设计成免手机号的原因）。
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
