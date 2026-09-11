import { bookingApi } from '../../api/index';
import type { BookingStatus } from '../../api/types';
import { goServices } from '../../utils/nav';
import { basePageData } from '../../utils/page';
import { toBookingVM, type BookingVM } from '../../utils/present';
import { isApiFailure } from '../../utils/request';
import { syncTabBar } from '../../utils/tabbar';
import { confirm, notOpenYet, toast } from '../../utils/ui';

interface FilterItem {
  /** 空串 = 不传 status（全部） */
  key: '' | BookingStatus;
  label: string;
}

const FILTERS: FilterItem[] = [
  { key: '', label: '全部' },
  { key: 'pending', label: '待确认' },
  { key: 'confirmed', label: '已确认' },
  { key: 'completed', label: '已完成' },
];

Page({
  data: {
    ...basePageData(),
    filters: FILTERS,
    activeFilter: '' as '' | BookingStatus,
    loading: true,
    errorText: '',
    bookings: [] as BookingVM[],
  },

  /** 只在 onShow 拉取：首次进入 onShow 也会触发；下单后返回本页能立刻看到新单 */
  onShow() {
    this.setData(basePageData());
    syncTabBar(this);
    this.load();
  },

  async load() {
    this.setData({ loading: true, errorText: '' });
    try {
      const page = await bookingApi.list({
        status:
          this.data.activeFilter === '' ? undefined : this.data.activeFilter,
        page: 1,
        pageSize: 20,
      });
      this.setData({ loading: false, bookings: page.items.map(toBookingVM) });
    } catch (error) {
      this.setData({
        loading: false,
        errorText: isApiFailure(error) ? error.message : '加载失败，请稍后再试',
      });
    }
  },

  onFilter(event: WechatMiniprogram.TouchEvent) {
    const key = String(event.currentTarget.dataset.key) as '' | BookingStatus;
    if (key === this.data.activeFilter) return;
    this.setData({ activeFilter: key }, () => {
      this.load();
    });
  },

  async onCancel(event: WechatMiniprogram.TouchEvent) {
    const id = Number(event.currentTarget.dataset.id);
    const agreed = await confirm({
      title: '取消预约',
      content: '取消后这个时间段会释放给其他顾客哦，确定要取消吗？',
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

  onReview() {
    // 后端 `POST /app/reviews`（A11）已是真实现（仅本人 + 仅已完成 + 一单一评），
    // 但「评分弹窗」这一块前端交互本期还没做 —— 先如实告知，不假装成功。
    // P2 做评价弹窗时换成 `bookingApi.createReview({ bookingId: item.id, rating, content })`。
    notOpenYet('评价', '评价功能正在接入，很快就能给美甲师打分啦～');
  },

  goServices,
});
