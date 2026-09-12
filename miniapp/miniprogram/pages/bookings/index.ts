import { bookingApi } from '../../api/index';
import type { BookingStatus } from '../../api/types';
import type { IconName } from '../../utils/icons';
import { runLoad, runPullDownLoad } from '../../utils/load';
import {
  goBookingDetail,
  goCancel,
  goLogin,
  goPay,
  goReview,
  goServices,
} from '../../utils/nav';
import { definePage } from '../../utils/page';
import { toBookingVM, type BookingVM } from '../../utils/present';

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

definePage({
  chromeIcons: PAGE_ICONS,

  data: {
    filters: FILTERS,
    activeFilter: '' as '' | BookingStatus,
    keyword: '',
    /** 未绑定手机号：**不是错误**，而是「仅浏览」态，单独一个标志 */
    guest: false,
    /** 后端返回的原始列表 */
    all: [] as BookingVM[],
    /** 过滤后的展示列表 */
    bookings: [] as BookingVM[],
  },

  /**
   * 只在 onShow 拉取：首次进入也会触发；下单/支付后返回能立刻看到新状态。
   * **不会回骨架屏**：`runLoad` 在已有数据时走静默刷新（切 Tab 回来不再闪白）。
   */
  onShow() {
    void this.load();
  },

  onPullDownRefresh() {
    return runPullDownLoad(() => this.load());
  },

  async load() {
    // 未绑定手机号时 /app/bookings 必然 401（后端 §8.3 只有本人数据）——
    // 明知会失败还打一次，只会让「没登录」看起来像「加载失败」。
    // `loaded: true` 一起置上，否则每次切回本页都会再闪一次骨架屏。
    if (!this.data.bound) {
      this.setData({
        loading: false,
        refreshing: false,
        errorText: '',
        loaded: true,
        guest: true,
        all: [],
        bookings: [],
      });
      return;
    }
    await runLoad(this, () => bookingApi.list({ page: 1, pageSize: 50 }), {
      merge: (page) => ({ guest: false, all: page.items.map(toBookingVM) }),
      after: () => this.applyFilter(),
    });
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

  /** 未登录 / 未绑定时的引导（两种说法不同） */
  onGuestLogin() {
    goLogin({
      reason: this.data.loggedIn
        ? '绑定手机号后查看预约'
        : '登录后即可查看预约记录',
    });
  },

  onFilterSort() {
    // 设计稿的漏斗入口：订单列表没有可筛的字段（后端无价格/时长维度），只做排序
    const options = ['默认排序', '按时间从新到旧', '按时间从旧到新'];
    wx.showActionSheet({
      itemList: options,
      success: (res) => {
        const all = [...this.data.all];
        if (res.tapIndex === 1)
          all.sort((a, b) => (a.startAt < b.startAt ? 1 : -1));
        if (res.tapIndex === 2)
          all.sort((a, b) => (a.startAt > b.startAt ? 1 : -1));
        this.setData({ all }, () => this.applyFilter());
      },
      fail: () => {
        /* 用户取消 */
      },
    });
  },

  onRetry() {
    void this.load();
  },

  /**
   * 点卡片进详情。
   *
   * 之前**只有美甲师端**能进详情页，顾客这边的卡片是不可点的 —— 明明有
   * `pages/booking-detail`，顾客却只能从迷你按钮里操作。卡内按钮用 `catchtap`
   * 阻止冒泡，避免「点取消却先跳了详情」。
   */
  onDetail(event: WechatMiniprogram.TouchEvent) {
    goBookingDetail(Number(event.currentTarget.dataset.id));
  },

  onCancel(event: WechatMiniprogram.TouchEvent) {
    // 取消是「钱的规则」：先进说明页看规则再确认，不用原生 confirm 一句话带过
    goCancel(Number(event.currentTarget.dataset.id));
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
