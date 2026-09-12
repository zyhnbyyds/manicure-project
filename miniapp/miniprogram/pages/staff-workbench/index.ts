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
 *
 * 视觉按 docs/manicure-ui-batch2 第 3 屏重做（原版是 emoji + 旧配色）：
 * 渐变卡承载身份与今日班次、三列业绩、四个功能入口、今日待服务列表。
 *
 * **一处对设计稿的解释**：那屏的渐变卡上写的是「会员卡」（生成时把顾客侧的卡串了过来）。
 * 美甲师工作台上放「会员卡」没有意义，所以同一张卡承载**身份 + 今日班次**，
 * 视觉形态（渐变 + 水印 + 卡号位）保持不变。
 */
import { staffApi } from '../../api/index';
import { demoteToCustomer, setMode } from '../../store/mode';
import { fenToYuan, toLocalDateString } from '../../utils/format';
import type { IconName } from '../../utils/icons';
import { runPullDownLoad } from '../../utils/load';
import {
  goStaffBookings,
  goStaffPerformance,
  goStaffReviews,
} from '../../utils/nav';
import { definePage } from '../../utils/page';
import { dialCustomer } from '../../utils/phone';
import { formatPeriod, toStaffBookingRow, type StaffBookingRow } from '../../utils/present';
import { isApiFailure } from '../../utils/request';
import { confirm, toast } from '../../utils/ui';

const PAGE_ICONS: IconName[] = ['calendar', 'card', 'star', 'person', 'headset', 'clock'];

const ENTRIES = [
  { key: 'bookings', label: '我的预约', icon: 'calendar' as IconName },
  { key: 'performance', label: '业绩明细', icon: 'card' as IconName },
  { key: 'reviews', label: '我的评价', icon: 'star' as IconName },
  { key: 'customer', label: '顾客模式', icon: 'person' as IconName },
];

definePage({
  chromeIcons: PAGE_ICONS,

  data: {
    entries: ENTRIES,
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
    void this.load();
  },

  onPullDownRefresh() {
    return runPullDownLoad(() => this.load());
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
          confirmColor: '#B45F6B',
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

  /** 功能入口：前三个跳页，第四个切回顾客模式 */
  onEntryTap(event: WechatMiniprogram.TouchEvent) {
    const key = String(event.currentTarget.dataset.key);
    if (key === 'bookings') {
      goStaffBookings();
      return;
    }
    if (key === 'performance') {
      goStaffPerformance();
      return;
    }
    if (key === 'reviews') {
      goStaffReviews();
      return;
    }
    this.onSwitchToCustomer();
  },

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
