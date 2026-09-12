import { bookingApi, memberApi } from '../../api/index';
import type { Booking } from '../../api/types';
import { fenToYuan } from '../../utils/format';
import { goBookings, goLogin, goPayResult } from '../../utils/nav';
import { definePage } from '../../utils/page';
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
 * 余额 / 次卡 / 积分走 app 域自助结算（与后台 `settle` **共用同一份资金核心**），
 * 它们**不依赖任何支付通道**。但在小程序里提供这些渠道落在「小程序内虚拟支付业务」
 * 的判定范围内，所以服务端有**合规闸门** `APP_SELF_PAY_ENABLED`（默认关闭）：
 * 虚拟支付接入 / 法务确认之前，接口返回 501，页面据此把入口**如实地**置灰并说明原因。
 *
 * 微信 JSAPI 仍是 501 契约位（要等支付通道对接），因此同样标为不可用 ——
 * 不给「显示可用、点了才报错」的假象。
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

definePage({
  data: {
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
    /** 次卡核销要用的卡片 id（结算时作为 `memberCardId` 上送，服务端据此重算应付） */
    activeCardId: 0,
    /**
     * 积分抵扣数。取「本人全部积分」，**上限由服务端复算**（`maxPointsPermille`，默认 30%）——
     * 客户端不自己算上限，正是为了不重演「前端硬编码 500、后端默认 300」那次漂移。
     */
    pointsToUse: 0,
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
      /**
       * **合规闸门**（服务端 `APP_SELF_PAY_ENABLED`）。
       *
       * 余额 / 次卡 / 积分虽然不需要任何支付通道对接，但在小程序里提供它们落在
       * 「小程序内虚拟支付业务」的判定范围内 —— **虚拟支付接入（或法务确认无需接入）
       * 之前不得开放**。这里只如实反映服务端给的能力位，不自行判断合规；
       * 真正的闸门在 `POST /app/bookings/:id/settle`（客户端藏起来挡不住手写请求）。
       */
      const selfPay = me?.selfPayEnabled === true;
      const gate = selfPay ? '' : ' · 合规审核中，暂未开放';

      this.setData({
        loading: false,
        booking: toBookingVM(booking),
        dueAmount: booking.dueAmount,
        dueText: fenToYuan(booking.dueAmount),
        activeCardId: activeCard?.id ?? 0,
        pointsToUse: me?.points ?? 0,
        methods: [
          {
            key: 'balance',
            title: '余额支付',
            sub: me
              ? `全部余额 ${fenToYuan(balance)} 元${gate}`
              : '未绑定会员，暂无余额',
            // 余额要够付全额才让选：服务端不做部分扣减，余额不足会直接失败
            enabled: selfPay && balance >= booking.dueAmount,
          },
          // 微信 JSAPI 仍是 501 契约位（要等支付通道对接），所以**如实标为不可用**
          { key: 'wechat', title: '微信支付', sub: '即将开放', enabled: false },
          {
            key: 'card',
            title: '次卡核销',
            // 次卡是整单核销，只有一个项目的预约才能用（与下单/结算口径一致）
            sub: activeCard
              ? `剩余 ${activeCard.totalTimes - activeCard.usedTimes} 次${
                  booking.items.length === 1 ? '' : ' · 仅限单个项目的预约'
                }${gate}`
              : '暂无可用次卡',
            enabled:
              selfPay && Boolean(activeCard) && booking.items.length === 1,
          },
          {
            key: 'points',
            title: '积分抵扣',
            // 有上限（maxPointsPermille），所以它抵不完全款，剩余仍要余额或到店付
            sub: me
              ? `${me.points} 积分，最多抵 ${me.maxPointsPermille / 10}%${gate}`
              : '暂不可用',
            enabled: selfPay && me.points > 0,
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
      toast(
        method.key === 'wechat'
          ? '微信支付还没开放，请到店支付'
          : '该支付方式暂未开放，请到店支付',
      );
      return;
    }
    this.setData({ activeMethod: key });
  },

  async onConfirm() {
    if (this.data.submitting) return;
    const { activeMethod, booking, dueAmount, activeCardId } = this.data;
    const bookingId = this.bookingId;
    if (!booking) return;

    this.setData({ submitting: true });
    try {
      // ---- 余额 / 次卡 / 积分：走 app 域自助结算（与后台 settle 共用资金核心）----
      // 这三个渠道**不依赖任何支付通道**；服务端有合规闸门，未开放时返回 501。
      if (
        activeMethod === 'balance' ||
        activeMethod === 'card' ||
        activeMethod === 'points'
      ) {
        const result = await bookingApi.settle(
          bookingId,
          activeMethod === 'balance'
            ? { payments: [{ channel: 'balance', amount: dueAmount }] }
            : activeMethod === 'card'
              ? {
                  memberCardId: activeCardId,
                  // 次卡核销不产生金额：支付行金额恒为 0（服务端也会强制归零）
                  payments: [
                    { channel: 'card', amount: 0, memberCardId: activeCardId },
                  ],
                }
              : { pointsUsed: this.data.pointsToUse },
        );
        // 成功与否**以服务端返回的金额事实为准**，不看本地推算：
        // 积分抵扣有上限，抵完仍可能有尾款（那时状态是 partial 而不是 paid）
        goPayResult({
          status: result.payStatus === 'paid' ? 'success' : 'pending',
          bookingId,
          bookingNo: booking.bookingNo,
          amount: result.paidAmount,
        });
        return;
      }

      // ---- 微信支付：JSAPI 下单仍是 501 契约位，保留完整调用位 ----
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
      reason: this.data.loggedIn
        ? '绑定手机号后才能支付'
        : '登录后即可继续支付',
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
