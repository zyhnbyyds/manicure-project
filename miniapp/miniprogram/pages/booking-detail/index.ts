import { bookingApi } from '../../api/index';
import type { Booking } from '../../api/types';
import { getThemeTokens } from '../../theme/theme';
import { fenToYuan, formatDuration, formatTimeRange, formatDateTimeLabel } from '../../utils/format';
import { buildIcons, type IconName } from '../../utils/icons';
import { goPay } from '../../utils/nav';
import { basePageData } from '../../utils/page';
import { staffEmoji } from '../../utils/present';
import { isApiFailure } from '../../utils/request';
import { confirm, notOpenYet, toast } from '../../utils/ui';

const PAGE_ICONS: IconName[] = ['calendar', 'clock', 'person', 'card', 'chevron'];

/** 状态 → 顶部渐变卡的文案与色调 */
const STATUS_TEXT: Record<Booking['status'], string> = {
  pending: '待确认',
  confirmed: '已确认',
  arrived: '已到店',
  completed: '已完成',
  cancelled: '已取消',
  no_show: '未到店',
};

/**
 * 订单详情（docs/manicure-ui-batch1 第 2 屏）。
 *
 * 入参 `bookingId`；金额全部取服务端的 `payableAmount / paidAmount / dueAmount`，
 * 客户端不参与任何计算（资金红线）。
 */
Page({
  data: {
    ...basePageData(),
    icons: buildIcons(PAGE_ICONS, '#2D221E'),
    loading: true,
    errorText: '',
    booking: null as Booking | null,
    statusText: '',
    statusTone: '',
    staffEmojiText: '',
    dateText: '',
    timeText: '',
    durationText: '',
    items: [] as { id: number; name: string; durationText: string; priceText: string }[],
    payableText: '0.00',
    paidText: '0.00',
    dueText: '0.00',
    dueAmount: 0,
    canCancel: false,
    canReview: false,
    canPay: false,
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
      const durationMinutes = found.items.reduce(
        (sum, item) => sum + item.durationMinutes,
        0,
      );
      this.setData({
        loading: false,
        booking: found,
        statusText: STATUS_TEXT[found.status],
        statusTone:
          found.status === 'cancelled' || found.status === 'no_show'
            ? 'muted'
            : found.status === 'completed'
              ? 'done'
              : 'active',
        staffEmojiText: staffEmoji(found.staffId),
        dateText: formatDateTimeLabel(found.startAt).replace(/\s\d{2}:\d{2}$/, ''),
        timeText: formatTimeRange(found.startAt, found.endAt),
        durationText: formatDuration(durationMinutes),
        items: found.items.map((item) => ({
          id: item.serviceItemId,
          name: item.name,
          durationText: formatDuration(item.durationMinutes),
          priceText: fenToYuan(item.price),
        })),
        payableText: fenToYuan(found.payableAmount),
        paidText: fenToYuan(found.paidAmount),
        dueText: fenToYuan(found.dueAmount),
        dueAmount: found.dueAmount,
        canCancel: found.status === 'pending' || found.status === 'confirmed',
        canReview: found.status === 'completed',
        canPay: found.dueAmount > 0,
      });
    } catch (error) {
      this.setData({
        loading: false,
        errorText: isApiFailure(error) ? error.message : '网络连接失败',
      });
    }
  },

  onPay() {
    goPay(this.bookingId);
  },

  async onCancel() {
    const agreed = await confirm({
      title: '取消预约',
      content: '取消后这个时间段会释放给其他顾客，是否继续？',
      confirmText: '确定取消',
    });
    if (!agreed) return;
    try {
      await bookingApi.cancel(this.bookingId, '顾客自主取消');
      toast('已取消', 'success');
      this.load();
    } catch (error) {
      toast(isApiFailure(error) ? error.message : '取消失败，请稍后再试');
    }
  },

  onReview() {
    notOpenYet('评价', '评价功能正在接入，很快就能给美甲师打分啦～');
  },

  onService() {
    wx.showModal({
      title: '联系门店',
      content: '客服微信：nailshop001\n改期或疑问都可以直接找我们～',
      showCancel: false,
      confirmText: '好',
    });
  },
});
