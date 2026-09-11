/**
 * app 域 access token 与绑定状态的本地持有者。
 *
 * 单独成模块（而不是放进 `store/auth.ts`）是为了**打断循环依赖**：
 * `request.ts` 需要 token，`store/auth.ts` 需要 `request.ts` 去登录。
 */

const TOKEN_KEY = 'manicure:token';
const CUSTOMER_KEY = 'manicure:customer-id';

/** `undefined` = 还没读过 storage；`null` = 明确没有 */
let cachedToken: string | null | undefined;

export function getToken(): string | null {
  if (cachedToken === undefined) {
    const raw = wx.getStorageSync(TOKEN_KEY);
    cachedToken = typeof raw === 'string' && raw.length > 0 ? raw : null;
  }
  return cachedToken;
}

export function setToken(token: string | null): void {
  cachedToken = token;
  if (token) {
    wx.setStorageSync(TOKEN_KEY, token);
  } else {
    wx.removeStorageSync(TOKEN_KEY);
  }
}

/** 已绑定的顾客 ID；`null` = 仅浏览（未授权手机号） */
export function getBoundCustomerId(): number | null {
  const raw = wx.getStorageSync(CUSTOMER_KEY);
  if (raw === '' || raw === null || raw === undefined) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function setBoundCustomerId(customerId: number | null): void {
  if (customerId && customerId > 0) {
    wx.setStorageSync(CUSTOMER_KEY, customerId);
  } else {
    wx.removeStorageSync(CUSTOMER_KEY);
  }
}

/** 仅清登录态，不动主题等其它本地偏好 */
export function clearAuth(): void {
  setToken(null);
  setBoundCustomerId(null);
}
