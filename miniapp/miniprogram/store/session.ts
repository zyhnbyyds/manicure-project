/**
 * 会话门面：**统一「有没有身份」的判定与引导**。
 *
 * 为什么需要它：在这之前，每个页面各写各的 `needBind` 判断与提示文案
 * （会员卡弹一句、确认预约弹另一句、收银台又一句），结果是
 * 同一个「你没绑手机号」在不同页面说法不同，而且有的页面点了没反应。
 *
 * 两种身份层次（与后端一致，别混为一谈）：
 * - **已登录** = 有 app token（`wx.login` 静默换来的）。可浏览项目/美甲师/时段；
 * - **已绑定** = 授权过手机号，`customer_id` 非空。可下单、看会员与订单。
 *   未绑定不是错误状态，是「仅浏览」—— 所以引导文案也不能写成报错。
 *
 * 用法（页面里所有需要身份的动作之前）：
 * ```ts
 * if (!(await requireSession({ needBind: true, reason: '预约需要绑定手机号' }))) return;
 * ```
 * 返回 `false` 时门面**已经做过引导**（跳登录页或提示），调用方直接 return 即可。
 */
import { ensureLogin, getCustomerId, isBound, isLoggedIn } from './auth';
import { getMode, getStaffStatus, isGranted, type AppMode } from './mode';
import type { StaffGrantStatus } from '../api/types';
import { goLogin } from '../utils/nav';
import { toast } from '../utils/ui';

export interface SessionState {
  /** 有 app token */
  loggedIn: boolean;
  /** 已绑定手机号（customer_id 非空） */
  bound: boolean;
  customerId: number | null;
  mode: AppMode;
  staffGranted: boolean;
  staffStatus: StaffGrantStatus | null;
}

export function getSession(): SessionState {
  return {
    loggedIn: isLoggedIn(),
    bound: isBound(),
    customerId: getCustomerId(),
    mode: getMode(),
    staffGranted: isGranted(),
    staffStatus: getStaffStatus(),
  };
}

export interface RequireSessionOptions {
  /** 是否必须已绑定手机号（下单/支付/看资产为 true；纯浏览为 false） */
  needBind?: boolean;
  /** 引导文案：说明**为什么**需要身份，避免「凭什么让我登录」 */
  reason?: string;
}

/**
 * 需要身份的动作之前调用。
 *
 * 顺序刻意如此：
 * 1. 先试一次**静默登录**（`ensureLogin` 内部有并发去重，重复调用很便宜）——
 *    绝大多数情况下用户其实已经有 token 了，不该因为没绑手机号就拦两次；
 * 2. 仍不满足才引导：未登录 → 登录页；已登录但未绑定 → 也去登录页
 *    （那页有「手机号登录 / 绑定」按钮），并带上 `reason` 让落地页说明原因。
 */
export async function requireSession(
  options: RequireSessionOptions = {},
): Promise<boolean> {
  const needBind = options.needBind === true;

  try {
    await ensureLogin();
  } catch {
    // 静默登录失败（后端没起 / 凭据未配置）——继续往下走引导，交给登录页展示具体原因
  }

  const state = getSession();
  if (state.loggedIn && (!needBind || state.bound)) return true;

  const reason = options.reason ?? '';
  if (!state.loggedIn) {
    toast(reason || '先登录一下，才能继续哦');
  } else if (!state.bound) {
    toast(reason || '绑定手机号后才能继续');
  }
  goLogin({ reason });
  return false;
}

/**
 * 不进页面、只在当前页弹一次授权引导时的轻量判定。
 * 用于「按钮显隐」这类不需要跳转的场景。
 */
export function canUseIdentity(needBind = false): boolean {
  const state = getSession();
  return state.loggedIn && (!needBind || state.bound);
}
