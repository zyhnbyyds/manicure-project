import { catalogApi } from '../../api/index';
import { getThemeTokens } from '../../theme/theme';
import { buildIcons, type IconName } from '../../utils/icons';
import {
  goBookings,
  goNotices,
  goServiceDetail,
  goServices,
  goShop,
  goStaffs,
} from '../../utils/nav';
import { basePageData } from '../../utils/page';
import {
  HERO_IMAGE,
  toServiceItemVM,
  toStaffVM,
  type ServiceItemVM,
  type StaffVM,
} from '../../utils/present';
import { isApiFailure } from '../../utils/request';
import { syncTabBar } from '../../utils/tabbar';

/** 本页用到的细线图标（设计稿：导航栏 2 个 + 快捷入口 4 个 + 「全部 ›」） */
const PAGE_ICONS: IconName[] = [
  'shop',
  'chat',
  'calendar',
  'grid',
  'clock',
  'card',
  'chevron',
];

interface QuickEntry {
  icon: IconName;
  label: string;
  action: 'services' | 'staffs' | 'bookings';
}

const QUICK_ENTRIES: QuickEntry[] = [
  { icon: 'calendar', label: '预约美甲', action: 'services' },
  { icon: 'grid', label: '款式库', action: 'services' },
  { icon: 'clock', label: '我的预约', action: 'bookings' },
  { icon: 'card', label: '会员卡', action: 'staffs' },
];

Page({
  data: {
    ...basePageData(),
    /** 自定义导航栏几何：状态栏高度 + 导航栏高度（对齐胶囊）+ 右侧给胶囊让位的宽度 */
    statusBarHeight: 20,
    navBarHeight: 44,
    navRightGap: 16,
    hero: HERO_IMAGE,
    icons: buildIcons(PAGE_ICONS, '#2D221E'),
    quickEntries: QUICK_ENTRIES,
    loading: true,
    errorText: '',
    services: [] as ServiceItemVM[],
    staffs: [] as StaffVM[],
  },

  onLoad() {
    this.applyNavMetrics();
    this.load();
  },

  /**
   * 计算自定义导航栏的几何。
   *
   * **必须给右侧胶囊按钮让位**：微信把「···⊙」固定在右上角，
   * 自绘内容压在那里会被盖住（设计稿里没有这个胶囊，直接照搬会踩坑）。
   * 做法：拿胶囊的 left 边界，导航栏右侧留出 `窗口宽 - 胶囊left` 的间距。
   */
  applyNavMetrics() {
    try {
      const info = wx.getSystemInfoSync();
      const statusBarHeight = info.statusBarHeight ?? 20;
      const rect = wx.getMenuButtonBoundingClientRect();
      if (rect && rect.height > 0) {
        this.setData({
          statusBarHeight,
          // 导航栏高度与胶囊垂直居中对齐（微信推荐的经典公式）
          navBarHeight: (rect.top - statusBarHeight) * 2 + rect.height,
          navRightGap: info.windowWidth - rect.left + 8,
        });
        return;
      }
      this.setData({ statusBarHeight });
    } catch {
      /* 取不到就沿用默认值，不影响页面主体 */
    }
  },

  onShow() {
    this.setData({
      ...basePageData(),
      // 图标颜色跟随主题，否则换主题后图标不跟着变
      icons: buildIcons(PAGE_ICONS, getThemeTokens().text),
    });
    // 只报「当前在哪个页面」，下标由 TabBar 按当前模式自己算
    // （顾客模式与工作台模式是两套 tab，写死下标切模式后会错位）
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
        // 设计稿「人气款式」横向滑动、一屏露出约 2.5 张，取前 4 个足够
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

  onQuickTap(event: WechatMiniprogram.TouchEvent) {
    const action = String(event.currentTarget.dataset.action);
    if (action === 'bookings') {
      goBookings();
      return;
    }
    if (action === 'staffs') {
      goStaffs();
      return;
    }
    goServices();
  },

  openService(event: WechatMiniprogram.TouchEvent) {
    goServiceDetail(Number(event.currentTarget.dataset.id));
  },

  onNavShop() {
    goShop();
  },

  onNavChat() {
    goNotices();
  },
});
