/**
 * 顾客模式 ↔ 工作台模式的切换。
 *
 * 关键取舍：**模式只是「偏好」，能不能进工作台由服务端说了算**。
 * 所以 `getMode()` 可能返回 `'staff'`，但 `isStaffMode()` 仍然是 `false`
 * （授权还是 pending / 已经被停用）。这样店长撤权后，小程序下一次 `onShow`
 * 就自动落回顾客模式，不需要额外的同步逻辑，也不会让人卡在空白页。
 *
 * 授权状态只从两处来：登录响应（`staffStatus`）与手机号绑定响应；
 * 每次进工作台页面时再用 `GET /app/staff/me` 复查一次（401/403 即失效）。
 */
import type { StaffGrantStatus } from '../api/types';

export type AppMode = 'customer' | 'staff';

const MODE_KEY = 'manicure:app-mode';
const STAFF_STATUS_KEY = 'manicure:staff-status';

/** 存进 storage 的偏好；读不到一律按顾客模式（最保守） */
export function getMode(): AppMode {
  const raw = wx.getStorageSync(MODE_KEY);
  return raw === 'staff' ? 'staff' : 'customer';
}

export function setMode(mode: AppMode): void {
  wx.setStorageSync(MODE_KEY, mode);
}

export function toggleMode(): AppMode {
  const next: AppMode = getMode() === 'staff' ? 'customer' : 'staff';
  setMode(next);
  return next;
}

/** 缓存的授权状态；`null` = 还没登录过，不知道 */
export function getStaffStatus(): StaffGrantStatus | null {
  const raw = wx.getStorageSync(STAFF_STATUS_KEY);
  if (raw === '' || raw === null || raw === undefined) return null;
  const known: StaffGrantStatus[] = ['none', 'pending', 'active', 'rejected'];
  return known.includes(raw as StaffGrantStatus) ? (raw as StaffGrantStatus) : null;
}

/** 登录 / 绑定手机号后回填授权状态 */
export function rememberStaffStatus(status: StaffGrantStatus): void {
  wx.setStorageSync(STAFF_STATUS_KEY, status);
}

/** 有没有开通工作台（缓存口径，用于决定要不要显示入口） */
export function isGranted(): boolean {
  return getStaffStatus() === 'active';
}

/**
 * 当前是否真的在工作台模式。
 *
 * 注意它和 `getMode()` 的区别：`getMode()` 是用户选的，`isStaffMode()` 是
 * 「用户选了 **且** 服务端确实给开通了」。TabBar 与页面一律以这个为准。
 */
export function isStaffMode(): boolean {
  return getMode() === 'staff' && isGranted();
}

/**
 * 授权失效时把偏好落回顾客模式。
 *
 * 不这么做的话：店长停用档案后用户重启小程序，TabBar 还是工作台三个 tab，
 * 但每个页面都在 403，用户只看到一片「加载失败」而不知道为什么。
 */
export function demoteToCustomer(): void {
  if (getMode() === 'staff') setMode('customer');
}

/** 退出登录时清掉（与 token 一起走） */
export function clearMode(): void {
  wx.removeStorageSync(MODE_KEY);
  wx.removeStorageSync(STAFF_STATUS_KEY);
}
