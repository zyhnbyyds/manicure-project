/**
 * 美甲师工作台（S5）。
 *
 * 一屏三件事：**今天上什么班** → **今天有几单、分别几点** → **这个月做得怎么样**。
 *
 * 两条不能省的口径：
 * 1. 日期一律用**设备本地日**（`toLocalDateString`），不能用 `toISOString()` 反推，
 *    否则凌晨会整体偏一天（后端铁律 §3 的同一件事）；
 * 2. 进页面先自查一次授权：403 说明店长已经撤权 / 停用了档案，这时**主动退回顾客模式**
 *    并说明原因 —— 否则用户只会看到一片「加载失败」，不知道自己被撤权了。
 */
import { staffApi } from '../../api/index';
import { demoteToCustomer, setMode } from '../../store/mode';
import { fenToYuan, toLocalDateString } from '../../utils/format';
import {
  goStaffBookings,
  goStaffPerformance,
  goStaffReviews,
} from '../../utils/nav';
import { basePageData } from '../../utils/page';
import { dialCustomer } from '../../utils/phone';
import { formatPeriod, toStaffBookingRow, type StaffBookingRow } from '../../utils/present';
import { isApiFailure } from '../../utils/request';
import { syncTabBar } from '../../utils/tabbar';
import { confirm, toast } from '../../utils/ui';

Page({
  data: {
    ...basePageData(),
    loading: true,
    errorText: '',
    today: '',
    nickname: '',
    bio: '',
    shiftText: '',
    off: false,
    bookings: [] as StaffBookingRow[],
    completedCount: 0,
    paidText: '0.00',
    accruedText: '0.00',
    settledText: '0.00',
    ratingText: '暂无评分',
    periodText: '',
  },

  onShow() {
    this.setData({ ...basePageData() });
    syncTabBar(this);
    void this.load();
  },

  async onPullDownRefresh() {
    await this.load();
    wx.stopPullDownRefresh();
  },

  async load() {
    this.setData({ loading: true, errorText: '' });
    const today = toLocalDateString(new Date());
    try {
      const [me, schedule, list, perf] = await Promise.all([
        staffApi.me(),
        staffApi.getSchedule(today),
        staffApi.listBookings({ date: today }),
        staffApi.getPerformance(),
      ]);
      const rating =
        perf.rating.average === null
          ? '暂无评分'
          : `${perf.rating.average} 分（${perf.rating.count} 条）`;
      this.setData({
        loading: false,
        today,
        nickname: me.nickname,
        bio: me.bio ?? '',
        off: schedule.off,
        shiftText: schedule.off
          ? '今天休息'
          : schedule.segments
              .map((segment) => `${segment.startTime.slice(0, 5)}-${segment.endTime.slice(0, 5)}`)
              .join('、') || '今天没有排班',
        bookings: list.items.map(toStaffBookingRow),
        completedCount: perf.completedCount,
        paidText: fenToYuan(perf.paidAmount),
        accruedText: fenToYuan(perf.commission.accrued),
        settledText: fenToYuan(perf.commission.settled),
        ratingText: rating,
        periodText: formatPeriod(perf.period),
      });
    } catch (error) {
      // 403 = 授权被撤（店长停用档案 / 驳回）。留在这一页只会一直失败，退回顾客模式并讲清楚
      if (isApiFailure(error) && error.statusCode === 403) {
        demoteToCustomer();
        this.setData({ loading: false });
        wx.showModal({
          title: '工作台已停用',
          content: '你的美甲师工作台已被关闭（档案停用或授权被撤），已切回顾客模式。',
          showCancel: false,
          confirmText: '知道啦',
          confirmColor: '#FF8BA7',
        });
        wx.switchTab({ url: '/pages/index/index' });
        return;
      }
      this.setData({
        loading: false,
        errorText: isApiFailure(error) ? error.message : '加载失败，请下拉重试',
      });
    }
  },

  goStaffBookings,
  goStaffPerformance,
  goStaffReviews,

  /** 切回顾客模式（TabBar 会跟着换成「首页/预约/我的」） */
  onSwitchToCustomer() {
    setMode('customer');
    wx.switchTab({ url: '/pages/index/index' });
  },

  async onCall(event: WechatMiniprogram.TouchEvent) {
    const id = Number(event.currentTarget.dataset.id);
    const row = this.data.bookings.find((item) => item.id === id);
    if (!row) return;
    await dialCustomer({ bookingId: id, masked: row.customerPhoneMasked });
  },

  async onArrive(event: WechatMiniprogram.TouchEvent) {
    const id = Number(event.currentTarget.dataset.id);
    try {
      const result = await staffApi.markArrived(id);
      // changed:false = 已经是到店状态（别人刚点过 / 网络重试），不是失败
      toast(result.changed ? '已标记到店' : '这单已经记过到店啦', 'success');
      await this.load();
    } catch (error) {
      toast(isApiFailure(error) ? error.message : '操作失败，请稍后再试');
    }
  },

  async onComplete(event: WechatMiniprogram.TouchEvent) {
    const id = Number(event.currentTarget.dataset.id);
    const agreed = await confirm({
      title: '标记服务完成',
      content: '完成后会立即计提这一单的提成，确定吗？',
      confirmText: '完成服务',
    });
    if (!agreed) return;
    try {
      const result = await staffApi.markCompleted(id);
      // 尾款没结清时后端会带一句提醒，直接转述，别自己编
      if (result.warning) toast(result.warning);
      else toast(result.changed ? '已标记完成' : '这单已经完成过啦', 'success');
      await this.load();
    } catch (error) {
      toast(isApiFailure(error) ? error.message : '操作失败，请稍后再试');
    }
  },
});
