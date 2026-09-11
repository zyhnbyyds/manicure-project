/**
 * 页面跳转工具。
 *
 * 存在的理由：`wx.switchTab` **只能**跳 `app.json` 里注册为 tabBar 的页面，
 * 而 tabBar 会在「个人中心那批页面」落地后才启用。与其在各页面里写死一种跳法，
 * 不如统一走这里：优先 `switchTab`（TabBar 启用后的正确行为，能清空页面栈），
 * 失败再降级 `navigateTo`——两种工程状态下都能跑。
 */

function switchOrNavigate(url: string): void {
  wx.switchTab({
    url,
    fail: () => {
      wx.navigateTo({ url });
    },
  });
}

export function goHome(): void {
  switchOrNavigate('/pages/index/index');
}

export function goBookings(): void {
  switchOrNavigate('/pages/bookings/index');
}

export function goMine(): void {
  switchOrNavigate('/pages/mine/index');
}

export function goServices(): void {
  wx.navigateTo({ url: '/pages/services/index' });
}

export function goStaffs(): void {
  wx.navigateTo({ url: '/pages/staffs/index' });
}

export function goSlots(): void {
  wx.navigateTo({ url: '/pages/slots/index' });
}

export function goConfirm(): void {
  wx.navigateTo({ url: '/pages/confirm/index' });
}

export function goTheme(): void {
  wx.navigateTo({ url: '/pages/theme/index' });
}

export function goMember(): void {
  wx.navigateTo({ url: '/pages/member/index' });
}

export function goServiceDetail(serviceItemId: number): void {
  wx.navigateTo({ url: `/pages/service-detail/index?id=${serviceItemId}` });
}

export function goBack(delta = 1): void {
  const pages = getCurrentPages();
  if (pages.length > delta) {
    wx.navigateBack({ delta });
    return;
  }
  // 直接进入某页（如从分享/扫码）时没有上一页，退化为回首页
  goHome();
}
