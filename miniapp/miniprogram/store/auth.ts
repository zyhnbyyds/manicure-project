/**
 * 登录态与「绑定手机号」状态。
 *
 * 与 spec §16.2 的流程一致：
 *   wx.login → code → POST /app/auth/login → app token（可浏览）
 *   → 授权手机号 → POST /app/auth/phone → 绑定 customer_id（可下单 / 看会员）
 *
 * 关键取舍：
 * - `ensureLogin()` 用模块级 promise 做**并发去重**：首页、项目页、会员页可能同时触发，
 *   不加锁会打出多个 `wx.login` + 多次登录请求；
 * - 未绑定手机号不是错误状态，是「仅浏览」状态，所以 `isBound()` 与 `isLoggedIn()` 分开。
 */
import { authApi } from '../api';
import { DEMO_CUSTOMER_ID, isMockEnabled } from '../config';
import { setBoundCustomerId, clearAuth, getBoundCustomerId, getToken, setToken } from '../utils/token';

let loginPromise: Promise<void> | null = null;

function wxLogin(): Promise<string> {
  return new Promise((resolve, reject) => {
    wx.login({
      success: (res) => {
        if (res.code) resolve(res.code);
        else reject(new Error('wx.login 未返回 code'));
      },
      fail: () => reject(new Error('wx.login 调用失败')),
    });
  });
}

/** 已登录（有 app token） */
export function isLoggedIn(): boolean {
  return getToken() !== null;
}

/** 已绑定手机号（可下单、可看会员信息） */
export function isBound(): boolean {
  return getBoundCustomerId() !== null;
}

export function getCustomerId(): number | null {
  return getBoundCustomerId();
}

/**
 * 保证有登录态：已登录直接返回；否则走一次 wx.login 换 token。
 * 并发调用共享同一个 promise。
 */
export function ensureLogin(): Promise<void> {
  if (isLoggedIn()) return Promise.resolve();
  if (loginPromise) return loginPromise;

  loginPromise = (async () => {
    const code = await wxLogin();
    const result = await authApi.login({ code });
    setToken(result.accessToken);
    setBoundCustomerId(result.customerId);
  })();

  // 失败后允许下次重试，否则一次网络抖动会把用户永久卡在未登录
  loginPromise.catch(() => {
    loginPromise = null;
  });

  return loginPromise;
}

/**
 * 绑定手机号。`code` 来自 `<button open-type="getPhoneNumber">` 的回调。
 *
 * 演示模式下直接把身份置为已绑定，方便把「会员中心 / 下单」链路走完；
 * 真实模式下**不在前端臆造 customerId**——绑定结果以服务端为准，
 * 由调用方紧接着拉一次 `GET /app/member/me` 再 `rememberCustomerId()` 回填。
 */
export async function bindPhone(code: string): Promise<void> {
  await authApi.bindPhone(code);
  if (isMockEnabled()) setBoundCustomerId(DEMO_CUSTOMER_ID);
}

/** 用服务端返回的 customerId 回填本地绑定状态（`/app/member/me` 的响应里带） */
export function rememberCustomerId(customerId: number): void {
  setBoundCustomerId(customerId);
}

/** 退出登录（清 token 与绑定状态，不动主题偏好） */
export function logout(): void {
  clearAuth();
}
