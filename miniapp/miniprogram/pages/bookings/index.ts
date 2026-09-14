import { bookingApi, catalogApi, memberApi } from '../../api/index';
import type { BookingStatus, Staff } from '../../api/types';
import type { IconName } from '../../utils/icons';
import { runLoad, runPullDownLoad } from '../../utils/load';
import {
  goBookingDetail,
  goCancel,
  goLogin,
  goPay,
  goReview,
  goServices,
  goSlots,
} from '../../utils/nav';
import { definePage } from '../../utils/page';
import { toBookingVM, type BookingVM } from '../../utils/present';
import { setDraftItems, setDraftStaff } from '../../store/draft';
import { hideLoading, showLoading, toast } from '../../utils/ui';

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

const PAGE_ICONS: IconName[] = ['search', 'funnel', 'calendar', 'card'];

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
    /**
     * 服务端能力位：**小程序内自助支付是否开放**（合规闸门 + 灰度）。
     *
     * 未付清的卡片据此显示「去支付」还是「到店支付」—— 关闭时若还给「去支付」，
     * 点进去是一个每种方式都灰掉的支付页，等于死路。
     */
    selfPayEnabled: false,
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
        // 退出登录后不要把上一轮的能力位留着（否则「去支付」会在未登录时又冒出来）
        selfPayEnabled: false,
      });
      return;
    }
    await runLoad(
      this,
      async () => {
        // 三个请求一起发：
        // - 能力位 `selfPayEnabled` 决定未付清的卡片上显示「去支付」还是「到店支付」；
        // - 美甲师列表**只为拿头像**（预约接口只回 staffId / staffName），
        //   拉失败不影响主流程，`catch → null` 后退回本地占位图。
        const [page, me, staffs] = await Promise.all([
          bookingApi.list({ page: 1, pageSize: 50 }),
          memberApi.getMe().catch(() => null),
          catalogApi.listStaffs().catch(() => null),
        ]);
        return { page, selfPayEnabled: me?.selfPayEnabled === true, staffs };
      },
      {
        merge: ({ page, selfPayEnabled, staffs }) => {
          const staffById = new Map<number, Pick<Staff, 'id' | 'avatar'>>(
            (staffs?.items ?? []).map((staff) => [staff.id, staff]),
          );
          return {
            guest: false,
            selfPayEnabled,
            all: page.items.map((booking) => toBookingVM(booking, staffById)),
          };
        },
        after: () => this.applyFilter(),
      },
    );
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

  /**
   * 再次预约：把原单的项目与美甲师拼回草稿，直接进「选时段」。
   *
   * 为什么还要拉一次项目列表：预约单里只有 `serviceItemId / name / price`（下单时的快照），
   * 而草稿要的是完整 `ServiceItem`（含 `category` / `image` / `description`，
   * 款式库与选时段页都依赖它们）。项目下架了就只带上还在的那些；
   * 一个都不剩就引导去款式库重挑，**不留一个点进去必然空转的按钮**。
   *
   * 顺序不能反：`setDraftItems` 内部会清掉美甲师与时段（改项目 → 时长变了），
   * 所以必须先写项目、再写美甲师。
   */
  async onRebook(event: WechatMiniprogram.TouchEvent) {
    const id = Number(event.currentTarget.dataset.id);
    const booking = this.data.all.find((item) => item.id === id);
    if (!booking) return;
    showLoading('准备中');
    try {
      const page = await catalogApi.listServiceItems(1, 100);
      const wanted = new Set(booking.serviceItemIds);
      const picked = page.items.filter((item) => wanted.has(item.id));
      if (picked.length === 0) {
        toast('原来的项目已下架，去挑个新款吧');
        goServices();
        return;
      }
      setDraftItems(picked);
      if (booking.staffId) {
        setDraftStaff({
          id: booking.staffId,
          nickname: booking.staffName,
          avatar: null,
        });
      }
      goSlots();
    } catch {
      toast('网络连接失败，请稍后再试');
    } finally {
      hideLoading();
    }
  },

  onPay(event: WechatMiniprogram.TouchEvent) {
    goPay(Number(event.currentTarget.dataset.id));
  },

  goServices,
});
