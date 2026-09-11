import { catalogApi } from '../../api/index';
import { goBookings, goServiceDetail, goServices, goStaffs } from '../../utils/nav';
import { basePageData } from '../../utils/page';
import {
  toServiceItemVM,
  toStaffVM,
  type ServiceItemVM,
  type StaffVM,
} from '../../utils/present';
import { isApiFailure } from '../../utils/request';
import { syncTabBar } from '../../utils/tabbar';

Page({
  data: {
    ...basePageData(),
    loading: true,
    errorText: '',
    services: [] as ServiceItemVM[],
    staffs: [] as StaffVM[],
  },

  onLoad() {
    this.load();
  },

  /** 主题在 onShow 重新取：从主题页返回时恰好触发，无需订阅 */
  onShow() {
    this.setData(basePageData());
    syncTabBar(this);
  },

  async load() {
    this.setData({ loading: true, errorText: '' });
    try {
      const [services, staffs] = await Promise.all([
        catalogApi.listServiceItems(1, 50),
        catalogApi.listStaffs(),
      ]);
      this.setData({
        loading: false,
        // 首页只展示 4 个，避免首屏过长；「全部」交给项目列表页
        services: services.items.slice(0, 4).map(toServiceItemVM),
        staffs: staffs.items.slice(0, 4).map(toStaffVM),
      });
    } catch (error) {
      this.setData({
        loading: false,
        errorText: isApiFailure(error) ? error.message : '加载失败，请稍后再试',
      });
    }
  },

  onRetry() {
    this.load();
  },

  goServices,
  goStaffs,
  goBookings,

  openService(event: WechatMiniprogram.TouchEvent) {
    goServiceDetail(Number(event.currentTarget.dataset.id));
  },
});
