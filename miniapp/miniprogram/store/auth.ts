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
// 必须写显式文件路径：小程序的模块解析不认目录导入（`'../api'` 编译成 require('../api') 会报
// module 'api.js' is not defined），这点和 Node/TS 的默认行为不同。
import { authApi } from '../api/index';
import type { BindPhoneVo } from '../api/types';
import { clearMode, rememberStaffStatus } from './mode';
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
    // 授权状态每请求都在服务端复查，这里只是决定「要不要显示工作台入口」
    rememberStaffStatus(result.staffStatus);
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
 * 返回服务端给的绑定结果（含工作台候选与授权状态）：
 * - `staffCandidate` 非空只说明手机号命中了某位美甲师的档案，**不代表已开通**，
 *   必须由店长在后台确认（仅凭手机号提权 = 提权漏洞）；
 * - 演示模式下 `staffStatus` 直接是 `active`，好把工作台链路走完。
 */
export async function bindPhone(code: string): Promise<BindPhoneVo> {
  const result = await authApi.bindPhone(code);
  setBoundCustomerId(result.customerId);
  rememberStaffStatus(result.staffStatus);
  return result;
}

/** 用服务端返回的 customerId 回填本地绑定状态（`/app/member/me` 的响应里带） */
export function rememberCustomerId(customerId: number): void {
  setBoundCustomerId(customerId);
}

/** 退出登录（清 token、绑定状态与工作台模式，不动主题偏好） */
export function logout(): void {
  clearAuth();
  clearMode();
}
