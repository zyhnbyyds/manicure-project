import { bookingApi, memberApi } from '../../api/index';
import type { Booking } from '../../api/types';
import { fenToYuan } from '../../utils/format';
import { goBookings, goLogin, goPayResult } from '../../utils/nav';
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
 * ## 支付结果必须向**服务端**确认（本次修正的核心）
 *
 * `wx.requestPayment` 的 success **只代表微信收银台走完了**：回调可能延迟、
 * 可能验签失败、可能还没落库。原先直接在 success 后跳「支付成功」，会出现
 * 「顾客看到已支付、账上仍 `unpaid`」—— 店员在收银台会**再收一次钱**。
 *
 * 现在的流程：拉起支付 → **轮询本人预约详情**（`payStatus` 是服务端事实）→
 * 只有 `payStatus === 'paid'` 才跳「支付成功」；轮询到上限仍未确认则跳
 * **「等待支付结果」**（不是失败），顾客可在「我的预约」里再看。
 *
 * ## 支付方式的可用性如实反馈
 *
 * 余额 / 次卡 / 积分：app 域还没有对应接口 → **标为不可用**（不是「显示可用、
 * 点了才说正在接入」）。微信 JSAPI 目前是 501 契约位，请求层会转成
 * 「这个功能马上就来啦」。
 */
type PayMethod = 'balance' | 'wechat' | 'card' | 'points';

interface MethodItem {
  key: PayMethod;
  title: string;
  sub: string;
  enabled: boolean;
}

/** 确认支付结果的轮询节奏：5 次 × 1.5s（首次快一点，别让用户等） */
const PAID_POLL_TRIES = 5;
const PAID_POLL_INTERVAL_MS = 1500;

/** 判断是不是「用户主动取消支付」 */
function isPaymentCancel(error: unknown): boolean {
  const result = error as { errMsg?: string; errCode?: number } | undefined;
  if (!result) return false;
  if (result.errCode === -2) return true;
  const message = String(result.errMsg ?? '');
  return message.includes('cancel');
}

Page({
  data: {
    ...basePageData(),
    loading: true,
    errorText: '',
    /** 未绑定手机号：仅浏览态，不是错误 */
    guest: false,
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
    // 收银台是纯身份页面：未绑定时不发请求，直接引导（避免 401 被当成加载失败）
    if (!this.data.bound) {
      this.setData({ loading: false, guest: true, errorText: '' });
      return;
    }
    this.setData({ loading: true, guest: false, errorText: '' });
    try {
      // 按 id 直取（原来从列表前 50 条里 find，老单会查不到 → 误报「没找到」）
      const [booking, me] = await Promise.all([
        bookingApi.detail(this.bookingId),
        memberApi.getMe().catch(() => null),
      ]);
      if (booking.payStatus === 'paid') {
        // 已付清的单不该再进收银台（可能在别处已收）
        this.setData({
          loading: false,
          booking: toBookingVM(booking),
          dueAmount: 0,
          dueText: fenToYuan(0),
          methods: [],
          errorText: '这笔订单已经付清了',
        });
        return;
      }
      const activeCard = me?.cards.find((card) => card.status === 'active');
      const balance = me ? me.balancePrincipal + me.balanceBonus : 0;

      this.setData({
        loading: false,
        booking: toBookingVM(booking),
        dueAmount: booking.dueAmount,
        dueText: fenToYuan(booking.dueAmount),
        methods: [
          {
            key: 'balance',
            title: '余额支付',
            sub: me
              ? `全部余额 ${fenToYuan(balance)} 元 · 暂未开放`
              : '未绑定会员，暂无余额',
            // app 域没有余额支付接口：**如实标为不可用**，不展示「伪可用」
            enabled: false,
          },
          { key: 'wechat', title: '微信支付', sub: '', enabled: true },
          {
            key: 'card',
            title: '次卡支付',
            sub: activeCard
              ? `剩余 ${activeCard.totalTimes - activeCard.usedTimes} 次 · 暂未开放`
              : '暂无可用次卡',
            enabled: false,
          },
          {
            key: 'points',
            title: '积分支付',
            sub: me ? `${me.points} 积分 · 暂未开放` : '暂不可用',
            enabled: false,
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
      toast('该支付方式暂未开放，先选微信支付吧');
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
      if (activeMethod !== 'wechat') {
        toast('该支付方式暂未开放，先选微信支付吧');
        return;
      }
      // 后端 JSAPI 目前返回 501，请求层会转成「这个功能马上就来啦」；
      // 这里保留完整调用位：拿到预支付参数 → 拉起微信支付 → **向服务端确认**。
      const params = await bookingApi.createJsapiPayment({
        bookingId,
        purpose: 'final',
      });
      try {
        await this.requestPayment(params);
      } catch (error) {
        if (isPaymentCancel(error)) return; // 用户自己取消：静默，不提示
        toast('支付未完成，请重试');
        return;
      }
      // **关键**：不把 requestPayment 的成功当结果，向服务端要事实
      const confirmed = await this.waitForPaid(bookingId);
      goPayResult({
        status: confirmed ? 'success' : 'pending',
        bookingId,
        bookingNo: booking.bookingNo,
        amount: confirmed ? confirmed.paidAmount : this.data.dueAmount,
      });
    } catch (error) {
      // 带上**请求号**：用户报「付了钱但没到账」时，客服凭它就能在服务端日志里
      // 定位到那一次请求（前后端说的是同一个号）
      const detail =
        isApiFailure(error) && error.requestId
          ? `（请求号 ${error.requestId}）`
          : '';
      toast(
        `${isApiFailure(error) ? error.message : '发起支付失败，请稍后再试'}${detail}`,
      );
    } finally {
      this.setData({ submitting: false });
    }
  },

  /**
   * 轮询等待服务端确认收款。
   *
   * 返回**已确认的预约**（`payStatus === 'paid'`）或 `null`（到上限仍未确认）。
   * `null` 不是失败：回调可能还在路上，主动查单任务（每 2 分钟）也会兜底；
   * 结果页会显示「等待支付结果」并引导去「我的预约」查看。
   */
  async waitForPaid(bookingId: number): Promise<Booking | null> {
    for (let i = 0; i < PAID_POLL_TRIES; i += 1) {
      // 首次等短一点（回调通常很快），之后按固定间隔
      await this.sleep(i === 0 ? 800 : PAID_POLL_INTERVAL_MS);
      try {
        const latest = await bookingApi.detail(bookingId);
        if (latest.payStatus === 'paid') return latest;
      } catch {
        /* 单次查询失败不放弃，继续轮询 */
      }
    }
    return null;
  },

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  },

  onGuestLogin() {
    goLogin({
      reason: this.data.loggedIn ? '绑定手机号后才能支付' : '登录后即可继续支付',
    });
  },

  onOrderTap() {
    goBookings();
  },

  /**
   * `wx.requestPayment` 的 Promise 封装。
   *
   * `fail` 会同时收到「用户取消」与「支付失败」，这里**只做原样抛出**，
   * 由调用方用 `isPaymentCancel` 区分 —— 用户主动取消不该看到报错。
   */
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
