/**
 * 轻交互封装：把 `wx.*` 的回调式 API 收敛成 Promise，页面里少写嵌套。
 */

export type ToastIcon = 'success' | 'error' | 'none';

export function toast(title: string, icon: ToastIcon = 'none'): void {
  wx.showToast({ title, icon, duration: 1800 });
}

let loadingDepth = 0;

/** 支持嵌套调用：只有最外层 `hideLoading` 才真正关闭 */
export function showLoading(title = '加载中'): void {
  loadingDepth += 1;
  if (loadingDepth === 1) {
    wx.showLoading({ title, mask: true });
  }
}

export function hideLoading(): void {
  loadingDepth = Math.max(0, loadingDepth - 1);
  if (loadingDepth === 0) {
    wx.hideLoading();
  }
}

export function confirm(options: {
  content: string;
  title?: string;
  confirmText?: string;
  cancelText?: string;
}): Promise<boolean> {
  return new Promise((resolve) => {
    wx.showModal({
      title: options.title ?? '提示',
      content: options.content,
      confirmText: options.confirmText ?? '确定',
      cancelText: options.cancelText ?? '再想想',
      confirmColor: '#FF8BA7',
      success: (res) => resolve(Boolean(res.confirm)),
      fail: () => resolve(false),
    });
  });
}

/** 通用「功能未开放」提示：本期骨架接口（501）被点到时的统一说法 */
export function notOpenYet(feature: string, hint = '这个功能马上就来啦～'): void {
  wx.showModal({
    title: `${feature}还没开放`,
    content: hint,
    showCancel: false,
    confirmText: '知道啦',
    confirmColor: '#FF8BA7',
  });
}
