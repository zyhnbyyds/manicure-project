import { bookingApi } from '../../api/index';
import type { Booking } from '../../api/types';
import { getThemeTokens } from '../../theme/theme';
import { fenToYuan, formatDateTimeLabel, formatTimeRange } from '../../utils/format';
import { buildIcons, type IconName } from '../../utils/icons';
import { goBack, goBookings } from '../../utils/nav';
import { basePageData } from '../../utils/page';
import { isApiFailure } from '../../utils/request';
import { hideLoading, showLoading, toast } from '../../utils/ui';

const PAGE_ICONS: IconName[] = ['clock', 'check', 'headset'];

/**
 * 取消规则（**原则性表述，不写具体金额**）。
 *
 * ⚠️ 为什么不写「扣 30%」这类数字：**app 域读不到门店的判责规则**。
 * 后端的判责能力在 `RefundPort.preview`（管理端 `/biz/refunds/preview`），
 * 顾客侧没有对应接口。写死数字会给出**错误的金额预期** —— 比不写更糟。
 *
 * 正解：加 `GET /app/bookings/:id/cancel-preview`，复用后台同一套判责规则
 * （提前量 → 建议退款额），页面就能显示**真实可退金额**再让顾客确认。
 * 这也符合「金额只在服务端算」的红线。
 */
const RULES = [
  { icon: 'clock' as IconName, title: '提前取消', text: '越早取消，越不影响门店安排，通常可全额退还定金' },
  { icon: 'check' as IconName, title: '临近取消', text: '临近开始时间取消，门店可能按规则扣除部分定金' },
  { icon: 'headset' as IconName, title: '特殊情况', text: '临时有事请联系门店，我们会尽力帮你协调改期' },
];

Page({
  data: {
    ...basePageData(),
    icons: buildIcons(PAGE_ICONS, '#2D221E'),
    rules: RULES,
    loading: true,
    errorText: '',
    booking: null as Booking | null,
    itemNames: '',
    whenText: '',
    paidText: '0.00',
    dueText: '0.00',
    submitting: false,
  },

  bookingId: 0,

  onLoad(query: Record<string, string | undefined>) {
    this.bookingId = Number(query.bookingId ?? 0);
    this.load();
  },

  onShow() {
    this.setData({
      ...basePageData(),
      icons: buildIcons(PAGE_ICONS, getThemeTokens().text),
    });
  },

  async load() {
    if (!this.bookingId) {
      this.setData({ loading: false, errorText: '没找到这笔订单' });
      return;
    }
    this.setData({ loading: true, errorText: '' });
    try {
      const page = await bookingApi.list({ page: 1, pageSize: 50 });
      const found = page.items.find((item) => item.id === this.bookingId);
      if (!found) {
        this.setData({ loading: false, errorText: '没找到这笔订单' });
        return;
      }
      this.setData({
        loading: false,
        booking: found,
        itemNames: found.items.map((item) => item.name).join(' · '),
        whenText: `${formatDateTimeLabel(found.startAt).replace(/\s\d{2}:\d{2}$/, '')} ${formatTimeRange(found.startAt, found.endAt)}`,
        paidText: fenToYuan(found.paidAmount),
        dueText: fenToYuan(found.dueAmount),
      });
    } catch (error) {
      this.setData({
        loading: false,
        errorText: isApiFailure(error) ? error.message : '网络连接失败',
      });
    }
  },

  /** 「我再想想」：直接返回，不做任何变更 */
  onThinkAgain() {
    goBack();
  },

  async onConfirm() {
    if (this.data.submitting) return;
    if (!this.data.booking) return;
    this.setData({ submitting: true });
    showLoading('正在取消');
    try {
      await bookingApi.cancel(this.bookingId, '顾客在小程序内取消');
      hideLoading();
      wx.showModal({
        title: '已取消预约',
        content: '退款金额由门店按判责规则处理，可在「我的预约」查看进度。',
        showCancel: false,
        confirmText: '好',
        confirmColor: '#B45F6B',
        complete: () => goBookings(),
      });
    } catch (error) {
      hideLoading();
      toast(isApiFailure(error) ? error.message : '取消失败，请稍后再试');
    } finally {
      this.setData({ submitting: false });
    }
  },
});
