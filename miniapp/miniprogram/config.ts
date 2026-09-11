/**
 * 小程序端运行时配置。
 *
 * `useMock` 说明（诚实开关，不是绕过实现）：
 *   后端已把 4 个只读接口做成真实现，但要拿到 app token 必须先过一次 `wx.login` →
 *   `POST /app/auth/login`，而该接口在 **未配置 `WX_MINIAPP_APPID` / `WX_MINIAPP_SECRET`
 *   时返回 503「小程序端未启用」**（spec §16.1 的既定降级）。
 *   在凭据到位之前，UI 无法拿到真实数据，所以开发期走演示数据；
 *   **凭据到位后改这里为 false 即可切真接口，页面代码不需要动**。
 */

/** 后端 API 基址（`API_PREFIX=api/v1`，端口取自根 .env 的 PORT=3000） */
export const API_BASE = 'http://127.0.0.1:3000/api/v1';

/** 请求超时（毫秒） */
export const REQUEST_TIMEOUT = 10000;

/** 本地覆盖开关的 storage key：`wx.setStorageSync('manicure:use-mock', false)` 可临时切真接口 */
const MOCK_OVERRIDE_KEY = 'manicure:use-mock';

function readMockOverride(): boolean | null {
  const raw = wx.getStorageSync(MOCK_OVERRIDE_KEY);
  if (raw === '' || raw === null || raw === undefined) return null;
  return raw === true || raw === 'true' || raw === 1 || raw === '1';
}

/**
 * TODO(H3)：拿到 `WX_MINIAPP_APPID` / `WX_MINIAPP_SECRET` 并写进后端 `.env` 后，
 * 把默认值改为 `false` 并删除 `api/mock.ts` 的引用。
 */
export function isMockEnabled(): boolean {
  const override = readMockOverride();
  return override === null ? true : override;
}

export function setMockEnabled(enabled: boolean): void {
  wx.setStorageSync(MOCK_OVERRIDE_KEY, enabled);
}

/** 演示数据在多个页面都要提示，统一一处文案 */
export const MOCK_BADGE_TEXT = '演示数据';
