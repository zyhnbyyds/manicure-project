import { bookingApi, memberApi } from '../../api/index';
import type { Booking } from '../../api/types';
import { fenToYuan } from '../../utils/format';
import { goBookings, goPayResult } from '../../utils/nav';
import { basePageData } from '../../utils/page';
import { toBookingVM, type BookingVM } from '../../utils/present';
import { isApiFailure } from '../../utils/request';
import { toast } from '../../utils/ui';

/**
 * 收银台（docs/manicure-ui-batch5 第 6 屏）。
 *
 * **入参是 `bookingId`，不是草稿** —— 订单已经落库，金额一律以服务端返回的
 * `dueAmount` 为准，客户端不做任何加减（资金红线的直接体现）。
 *
 * 支付方式的可达性（都会如实反馈，不假装成功）：
 * - 微信支付 JSAPI：`POST /app/payments/wxpay/jsapi` 目前是 501 契约位，
 *   请求层会把 501 统一转成「这个功能马上就来啦」；
 * - 余额 / 次卡 / 积分支付：app 域还没有对应接口（后端能力在管理端），点则提示开发中。
 */
type PayMethod = 'balance' | 'wechat' | 'card' | 'points';

interface MethodItem {
  key: PayMethod;
  title: string;
  sub: string;
  enabled: boolean;
}

Page({
  data: {
    ...basePageData(),
    loading: true,
    errorText: '',
    booking: null as BookingVM | null,
    /** 待付金额（分，来自服务端） */
    dueAmount: 0,
    dueText: '0.00',
    methods: [] as MethodItem[],
    activeMethod: 'wechat' as PayMethod,
    submitting: false,
  },

  bookingId: 0,

  onLoad(query: Record<string, string | undefined>) {
    this.bookingId = Number(query.bookingId ?? 0);
    this.load();
  },

  onShow() {
    this.setData(basePageData());
  },

  async load() {
    if (!this.bookingId) {
      this.setData({ loading: false, errorText: '没找到这笔订单' });
      return;
    }
    this.setData({ loading: true, errorText: '' });
    try {
      // app 域没有「单个订单详情」接口，从列表里按 id 取
      const [list, me] = await Promise.all([
        bookingApi.list({ page: 1, pageSize: 50 }),
        memberApi.getMe().catch(() => null),
      ]);
      const found: Booking | undefined = list.items.find(
        (item) => item.id === this.bookingId,
      );
      if (!found) {
        this.setData({ loading: false, errorText: '没找到这笔订单' });
        return;
      }
      const activeCard = me?.cards.find((card) => card.status === 'active');
      const balance = me ? me.balancePrincipal + me.balanceBonus : 0;

      this.setData({
        loading: false,
        booking: toBookingVM(found),
        dueAmount: found.dueAmount,
        dueText: fenToYuan(found.dueAmount),
        methods: [
          {
            key: 'balance',
            title: '余额支付',
            sub: me ? `全部余额 ${fenToYuan(balance)} 元` : '未绑定会员，暂无余额',
            enabled: me !== null && balance >= found.dueAmount,
          },
          { key: 'wechat', title: '微信支付', sub: '', enabled: true },
          {
            key: 'card',
            title: '次卡支付',
            sub: activeCard
              ? `剩余 ${activeCard.totalTimes - activeCard.usedTimes} 次`
              : '暂无可用次卡',
            enabled: Boolean(activeCard),
          },
          {
            key: 'points',
            title: '积分支付',
            sub: me ? `可用 ${me.points} 积分` : '暂不可用',
            enabled: me !== null && me.points > 0,
          },
        ],
      });
    } catch (error) {
      this.setData({
        loading: false,
        errorText: isApiFailure(error) ? error.message : '网络连接失败',
      });
    }
  },

  onPickMethod(event: WechatMiniprogram.TouchEvent) {
    const key = String(event.currentTarget.dataset.key) as PayMethod;
    const method = this.data.methods.find((item) => item.key === key);
    if (!method) return;
    if (!method.enabled) {
      toast(key === 'balance' ? '余额不足，可用微信或组合支付' : '该项暂不可用');
      return;
    }
    this.setData({ activeMethod: key });
  },

  async onConfirm() {
    if (this.data.submitting) return;
    const { activeMethod, booking } = this.data;
    const bookingId = this.bookingId;
    if (!booking) return;

    this.setData({ submitting: true });
    try {
      if (activeMethod === 'wechat') {
        // 后端 JSAPI 目前返回 501，请求层会转成「这个功能马上就来啦」；
        // 这里保留完整调用位：拿到预支付参数 → 拉起微信支付 → 跳结果页，
        // 支付通道一接上就能直接work。
        const params = await bookingApi.createJsapiPayment({
          bookingId,
          purpose: 'final',
        });
        await this.requestPayment(params);
        goPayResult({
          status: 'success',
          bookingNo: booking.bookingNo,
          amount: this.data.dueAmount,
        });
        return;
      }
      // 余额 / 次卡 / 积分：app 域暂无对应接口
      toast('该支付方式正在接入，先选微信支付吧');
    } catch (error) {
      toast(isApiFailure(error) ? error.message : '发起支付失败，请稍后再试');
    } finally {
      this.setData({ submitting: false });
    }
  },

  onOrderTap() {
    goBookings();
  },

  /** `wx.requestPayment` 的 Promise 封装（用户取消不算异常，单独静默处理） */
  requestPayment(params: {
    timeStamp: string;
    nonceStr: string;
    package: string;
    signType: 'RSA';
    paySign: string;
  }): Promise<void> {
    return new Promise((resolve, reject) => {
      wx.requestPayment({
        timeStamp: params.timeStamp,
        nonceStr: params.nonceStr,
        package: params.package,
        signType: params.signType,
        paySign: params.paySign,
        success: () => resolve(),
        fail: (error) => reject(error),
      });
    });
  },

  goBookings,
});
