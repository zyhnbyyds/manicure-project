import { bookingApi, memberApi } from '../../api/index';
import type { Booking } from '../../api/types';
import {
  fenToYuan,
  formatDuration,
  formatTimeRange,
  formatDateTimeLabel,
} from '../../utils/format';
import type { IconName } from '../../utils/icons';
import { goCancel, goLogin, goPay, goReview } from '../../utils/nav';
import { definePage } from '../../utils/page';
import { resolveStaffAvatar } from '../../utils/present';
import { isApiFailure } from '../../utils/request';

const PAGE_ICONS: IconName[] = [
  'calendar',
  'clock',
  'person',
  'card',
  'chevron',
];

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
definePage({
  chromeIcons: PAGE_ICONS,

  data: {
    loading: true,
    errorText: '',
    /** 未绑定手机号：仅浏览态，不是错误 */
    guest: false,
    booking: null as Booking | null,
    statusText: '',
    statusTone: '',
    /** 美甲师头像：订单里只有 staffId，用本地占位头像兜底（**不用 emoji**，见视觉口径） */
    staffAvatar: '',
    dateText: '',
    timeText: '',
    durationText: '',
    items: [] as {
      id: number;
      name: string;
      durationText: string;
      priceText: string;
    }[],
    payableText: '0.00',
    paidText: '0.00',
    dueText: '0.00',
    dueAmount: 0,
    canCancel: false,
    canReview: false,
    canPay: false,
    /**
     * 待付但**小程序内自助支付未开放**（合规闸门 / 灰度未命中）→ 显示「到店支付」。
     *
     * 不能只判断 `dueAmount > 0` 就给「去支付」：那样会把人领进支付页，
     * 而支付页里每种方式都是灰的 —— 点进去什么也做不了，比不显示按钮更糟。
     */
    payAtStore: false,
  },

  bookingId: 0,

  onLoad(query: Record<string, string | undefined>) {
    this.bookingId = Number(query.bookingId ?? 0);
    this.load();
  },

  async load() {
    if (!this.bookingId) {
      this.setData({ loading: false, errorText: '没找到这笔订单' });
      return;
    }
    // 未绑定手机号时列表接口必然 401：显示「仅浏览」引导，而不是加载失败
    if (!this.data.bound) {
      this.setData({ loading: false, guest: true, errorText: '' });
      return;
    }
    this.setData({ loading: true, guest: false, errorText: '' });
    try {
      // 能力位与单据一起取：`selfPayEnabled` 决定要不要给「去支付」入口
      const [page, me] = await Promise.all([
        bookingApi.list({ page: 1, pageSize: 50 }),
        memberApi.getMe().catch(() => null),
      ]);
      const selfPayEnabled = me?.selfPayEnabled === true;
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
        staffAvatar: resolveStaffAvatar({ id: found.staffId, avatar: null }),
        dateText: formatDateTimeLabel(found.startAt).replace(
          /\s\d{2}:\d{2}$/,
          '',
        ),
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
        canPay: found.dueAmount > 0 && selfPayEnabled,
        payAtStore: found.dueAmount > 0 && !selfPayEnabled,
      });
    } catch (error) {
      this.setData({
        loading: false,
        errorText: isApiFailure(error) ? error.message : '网络连接失败',
      });
    }
  },

  onGuestLogin() {
    goLogin({
      reason: this.data.loggedIn
        ? '绑定手机号后查看订单详情'
        : '登录后即可查看订单详情',
    });
  },

  onPay() {
    goPay(this.bookingId);
  },

  onCancel() {
    // 取消是「钱的规则」：先进说明页看规则再确认
    goCancel(this.bookingId);
  },

  onReview() {
    // 评价表单页已按设计稿实现（pages/review）
    goReview(this.bookingId);
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
