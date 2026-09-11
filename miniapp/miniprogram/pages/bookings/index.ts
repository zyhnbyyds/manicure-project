import { bookingApi } from '../../api/index';
import type { BookingStatus } from '../../api/types';
import { getThemeTokens } from '../../theme/theme';
import { buildIcons, type IconName } from '../../utils/icons';
import { goPay, goReview, goServices } from '../../utils/nav';
import { basePageData } from '../../utils/page';
import { toBookingVM, type BookingVM } from '../../utils/present';
import { isApiFailure } from '../../utils/request';
import { syncTabBar } from '../../utils/tabbar';
import { confirm, toast } from '../../utils/ui';

interface FilterItem {
  /** 空串 = 不传 status（全部） */
  key: '' | BookingStatus;
  label: string;
}

/** 与 docs/manicure-ui-batch1 第 1 屏的状态筛选一致 */
const FILTERS: FilterItem[] = [
  { key: '', label: '全部' },
  { key: 'pending', label: '待确认' },
  { key: 'confirmed', label: '已确认' },
  { key: 'cancelled', label: '已取消' },
  { key: 'completed', label: '已完成' },
];

const PAGE_ICONS: IconName[] = ['search', 'funnel', 'calendar'];

Page({
  data: {
    ...basePageData(),
    icons: buildIcons(PAGE_ICONS, '#2D221E'),
    filters: FILTERS,
    activeFilter: '' as '' | BookingStatus,
    keyword: '',
    loading: true,
    errorText: '',
    /** 后端返回的原始列表 */
    all: [] as BookingVM[],
    /** 过滤后的展示列表 */
    bookings: [] as BookingVM[],
  },

  /** 只在 onShow 拉取：首次进入也会触发；下单/支付后返回能立刻看到新状态 */
  onShow() {
    this.setData({
      ...basePageData(),
      icons: buildIcons(PAGE_ICONS, getThemeTokens().text),
    });
    syncTabBar(this);
    this.load();
  },

  async onPullDownRefresh() {
    await this.load();
    wx.stopPullDownRefresh();
  },

  async load() {
    this.setData({ loading: true, errorText: '' });
    try {
      const page = await bookingApi.list({ page: 1, pageSize: 50 });
      this.setData({ loading: false, all: page.items.map(toBookingVM) }, () => {
        this.applyFilter();
      });
    } catch (error) {
      this.setData({
        loading: false,
        all: [],
        bookings: [],
        // batch3 第 3 屏就是「网络连接失败」态
        errorText: isApiFailure(error) ? error.message : '网络连接失败',
      });
    }
  },

  /** 状态筛选在服务端也支持，但列表一次取回后本地过滤更顺滑（切筛不闪） */
  applyFilter() {
    const { all, activeFilter, keyword } = this.data;
    const lowered = keyword.trim().toLowerCase();
    let list = all;
    if (activeFilter) {
      list = list.filter((item) => item.status === activeFilter);
    }
    if (lowered) {
      list = list.filter(
        (item) =>
          item.bookingNo.toLowerCase().includes(lowered) ||
          item.itemNames.toLowerCase().includes(lowered) ||
          item.staffName.toLowerCase().includes(lowered),
      );
    }
    this.setData({ bookings: list });
  },

  onFilter(event: WechatMiniprogram.TouchEvent) {
    const key = String(event.currentTarget.dataset.key) as '' | BookingStatus;
    if (key === this.data.activeFilter) return;
    this.setData({ activeFilter: key }, () => this.applyFilter());
  },

  onSearchInput(event: WechatMiniprogram.Input) {
    this.setData({ keyword: event.detail.value }, () => this.applyFilter());
  },

  onSearchClear() {
    this.setData({ keyword: '' }, () => this.applyFilter());
  },

  onFilterSort() {
    // 设计稿的漏斗入口：订单列表没有可筛的字段（后端无价格/时长维度），只做排序
    const options = ['默认排序', '按时间从新到旧', '按时间从旧到新'];
    wx.showActionSheet({
      itemList: options,
      success: (res) => {
        const all = [...this.data.all];
        if (res.tapIndex === 1) all.sort((a, b) => (a.startAt < b.startAt ? 1 : -1));
        if (res.tapIndex === 2) all.sort((a, b) => (a.startAt > b.startAt ? 1 : -1));
        this.setData({ all }, () => this.applyFilter());
      },
      fail: () => {
        /* 用户取消 */
      },
    });
  },

  async onCancel(event: WechatMiniprogram.TouchEvent) {
    const id = Number(event.currentTarget.dataset.id);
    const agreed = await confirm({
      title: '取消预约',
      content: '取消后这个时间段会释放给其他顾客，是否继续？',
      confirmText: '确定取消',
    });
    if (!agreed) return;
    try {
      await bookingApi.cancel(id, '顾客自主取消');
      toast('已取消', 'success');
      this.load();
    } catch (error) {
      toast(isApiFailure(error) ? error.message : '取消失败，请稍后再试');
    }
  },

  onReview(event: WechatMiniprogram.TouchEvent) {
    // 评价表单页已按设计稿实现（pages/review）
    goReview(Number(event.currentTarget.dataset.id));
  },

  onPay(event: WechatMiniprogram.TouchEvent) {
    goPay(Number(event.currentTarget.dataset.id));
  },

  goServices,
});
