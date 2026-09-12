import { couponApi } from '../../api/index';
import { bookingApi, memberApi } from '../../api/index';
import { ensureLogin, isBound } from '../../store/auth';
import {
  clearDraft,
  getDraftSnapshot,
  getDraftTotals,
  getDraftRemark,
} from '../../store/draft';
import {
  fenToYuan,
  formatDateTimeLabel,
  formatDiscount,
  formatDuration,
  formatTimeRange,
} from '../../utils/format';
import { goBookings } from '../../utils/nav';
import { definePage } from '../../utils/page';
import { resolveStaffAvatar, staffEmoji } from '../../utils/present';
import { isApiFailure } from '../../utils/request';
import { hideLoading, showLoading, toast } from '../../utils/ui';

/**
 * 积分兑换比例与抵扣上限**本地常量**。
 *
 * ⚠️ 为什么是常量而不是配置：app 域目前没有「算价预览」接口
 * （后台的 `POST /biz/points/preview` 是管理端权限），
 * 所以客户端拿不到门店配置的兑换比例与抵扣上限。
 * 这里按设计稿（100 分兑 1 元）取默认值，**只用于展示预估**；
 * 真正的金额一律由服务端算（spec §5.7「金额只在服务端算」）。
 * 待补：`GET /app/member/pricing-preview`（入参 serviceItemIds / pointsToUse / memberCardId）。
 */
const POINTS_PER_YUAN = 100;
/**
 * 积分抵扣上限的**兜底值**（后端默认 300‰）。
 *
 * 真值来自服务端 `GET /app/member/me` 的 `maxPointsPermille` ——
 * 这里曾经硬编码 500，比后端默认（300）大，导致**预估比服务端允许的多**，
 * 顾客按预估下单、服务端一夹取就對不上。**不要在页面里再用这个常量算钱。**
 */
const FALLBACK_MAX_POINTS_PERMILLE = 300;

definePage({
  data: {
    ready: false,
    items: [] as {
      id: number;
      name: string;
      durationText: string;
      priceText: string;
      /** 价格（分）：预估算价用数值，避免从展示字符串反解 */
      price: number;
    }[],
    staffName: '',
    staffEmoji: '',
    staffAvatar: '',
    /** 积分兑换比例说明文案（比例是本地常量，见文件头注释） */
    pointsRateText: `${POINTS_PER_YUAN} 积分抵 1 元`,
    dateText: '',
    timeText: '',
    durationText: '',
    /** 项目原价合计 */
    originalText: '0.00',
    /** 会员信息（用于预估折扣） */
    levelName: '',
    discountText: '',
    /** 等级折扣率千分比（预估用；真实算价在服务端） */
    discountPermille: 1000,
    points: 0,
    /** 单笔积分抵扣上限（千分比，来自服务端；未取到时用兜底值） */
    maxPointsPermille: FALLBACK_MAX_POINTS_PERMILLE,
    /** 可用次卡（取第一张在用卡） */
    cardId: 0,
    cardName: '',
    cardRemain: 0,
    hasCard: false,
    /** 三个抵扣开关 */
    usePoints: false,
    useCard: false,
    /**
     * 服务端能力位：**次卡核销 / 积分抵扣是否开放**（合规闸门 + 灰度，见 `/app/member/me`）。
     *
     * 这两个开关会把单据直接算成 0 元 / 已付清，与支付页的 `settle` 是同一个暴露面 ——
     * 所以「小程序只做预约」时它们也必须关闭，否则顾客照样能自助把价格抹平。
     * 服务端 `POST /app/bookings` 有同一道闸门（客户端置灰挡不住手写请求）。
     */
    selfPayEnabled: false,
    couponText: '选择',
    /** 可用券列表（真实接口） */
    /** 可选券（已按门槛过滤）；未达门槛的在 `allCoupons` 里 */
    coupons: [] as {
      id: number;
      nameText: string;
      thresholdText: string;
      discountAmount: number;
      thresholdAmount: number;
    }[],
    allCoupons: [] as {
      id: number;
      nameText: string;
      thresholdText: string;
      discountAmount: number;
      thresholdAmount: number;
    }[],
    /** 因未达门槛而不可选的券数量（用于给顾客一个解释，而不是凭空少了几张） */
    blockedCouponCount: 0,
    /** 本单是否使用券；与 usePoints **互斥**（服务端也会拒绝同时传） */
    useCoupon: false,
    couponId: 0,
    couponDiscount: 0,
    couponDiscountText: '0.00',
    /** 本次预估要抵扣的积分数（提交时带给服务端） */
    pointsToUse: 0,
    /** 预估金额 */
    levelDiscountText: '0.00',
    pointsDiscountText: '0.00',
    totalDiscountText: '0.00',
    payableText: '0.00',
    remark: '',
    submitting: false,
    needBind: false,
  },

  onLoad() {
    const snapshot = getDraftSnapshot();
    if (!snapshot.staff || !snapshot.slot || snapshot.items.length === 0) {
      // `ready: false` 本身就是「草稿不完整」这一种状态（页面上只有这一个空洞），
      // 原来还额外 setData 了一个从未声明、也从未被 wxml 读过的 `emptyDraft`，属死状态，已删。
      this.setData({ ready: false });
      return;
    }
    const totals = getDraftTotals();
    this.setData({
      ready: true,
      items: snapshot.items.map((item) => ({
        id: item.id,
        name: item.name,
        durationText: formatDuration(item.durationMinutes),
        priceText: fenToYuan(item.price),
        price: item.price,
      })),
      staffName: snapshot.staff.nickname,
      staffEmoji: staffEmoji(snapshot.staff.id),
      staffAvatar: resolveStaffAvatar({
        id: snapshot.staff.id,
        avatar: snapshot.staff.avatar,
      }),
      dateText: formatDateTimeLabel(snapshot.slot.startAt).replace(
        /\s\d{2}:\d{2}$/,
        '',
      ),
      timeText: formatTimeRange(snapshot.slot.startAt, snapshot.slot.endAt),
      durationText: formatDuration(totals.durationMinutes),
      originalText: fenToYuan(totals.originalPrice),
      remark: getDraftRemark(),
      needBind: !isBound(),
    });
    this.loadMember();
  },

  onShow() {
    this.setData({ needBind: !isBound() });
  },

  /** 会员信息只用于**预估**展示；算价以服务端为准 */
  async loadMember() {
    try {
      // 可用券与会员信息一起取；券取不到不影响下单（各自 catch）
      const [me, couponPage] = await Promise.all([
        memberApi.getMe(),
        couponApi.listMine('usable', 1, 50).catch(() => null),
      ]);
      const activeCard = me.cards.find((card) => card.status === 'active');
      const selfPayEnabled = me.selfPayEnabled === true;
      this.setData(
        {
          levelName: me.levelName ?? '',
          discountText: formatDiscount(me.discountPermille),
          points: me.points,
          maxPointsPermille:
            me.maxPointsPermille ?? FALLBACK_MAX_POINTS_PERMILLE,
          hasCard: Boolean(activeCard),
          cardId: activeCard ? activeCard.id : 0,
          cardName: activeCard ? activeCard.cardName : '',
          cardRemain: activeCard
            ? activeCard.totalTimes - activeCard.usedTimes
            : 0,
          discountPermille: me.discountPermille,
          selfPayEnabled,
          // 闸门关闭时**强制**关掉两个抵扣开关：页面置灰只是提示，
          // 状态里若残留 true，提交时仍会把 memberCardId / pointsToUse 发出去
          ...(selfPayEnabled ? {} : { usePoints: false, useCard: false }),
          allCoupons: (couponPage ? couponPage.items : []).map((c) => ({
            id: c.id,
            nameText: c.templateName ?? '优惠券',
            thresholdText:
              c.thresholdAmount > 0
                ? '满 ' + fenToYuan(c.thresholdAmount) + ' 元'
                : '无门槛',
            discountAmount: c.discountAmount,
            thresholdAmount: c.thresholdAmount,
          })),
        },
        () => this.recalc(),
      );
    } catch {
      // 未绑定手机号或接口失败：不影响下单，只是不能预估优惠与选券
      this.setData({
        coupons: [],
        allCoupons: [],
        blockedCouponCount: 0,
        useCoupon: false,
        couponId: 0,
        couponDiscount: 0,
      });
      this.recalc();
    }
  },

  /** 预估金额（与服务端同一套公开公式；最终以提交后的结算为准） */
  recalc() {
    const {
      items,
      usePoints,
      points,
      discountPermille,
      useCoupon,
      couponId,
      couponDiscount,
    } = this.data;
    const original = items.reduce((sum, item) => sum + item.price, 0);
    const permille = discountPermille;
    const levelDisc = Math.floor((original * (1000 - permille)) / 1000);
    const base = Math.max(original - levelDisc, 0);

    // 券按**门槛**过滤：不让前端展示注定被服务端拒绝的选项。
    // 门槛按「等级折扣之后」的金额判 —— 与核销处同一口径。
    const selectable = this.data.allCoupons.filter(
      (c) => c.thresholdAmount <= base,
    );
    const blockedCouponCount = this.data.allCoupons.length - selectable.length;
    // 已选券若已不满足门槛（例如换了项目），就地清掉 —— 否则预估会与实际不一致
    const keepCoupon = useCoupon && selectable.some((c) => c.id === couponId);

    // 券在**等级折扣之后、积分之前**；且与积分**同一单二选一**（与服务端一致）。
    // 页面上的开关互斥（见 onTogglePoints / onPickCoupon），这里再兜一层。
    const couponDisc = keepCoupon ? Math.min(couponDiscount, base) : 0;

    // 积分抵扣：与后端 `money.ts` **完全同口径**（`rate` 积分 = 1 元 = 100 分）
    //   可抵金额（分） = floor(积分 / rate) × 100
    //   所需积分       = ceil(金额分 / 100) × rate
    // 这里曾经写成 `floor(points / 100)`（得到的是**元**）再与「分」的
    // `maxByRatio` 取 min —— 单位混用：显示出来的抵扣额小了 100 倍，
    // 而发给服务端的 `pointsToUse` 又是另一套算法，顾客会**少看抵扣、多花积分**。
    const rate = POINTS_PER_YUAN;
    const maxRatioFen = Math.floor((base * this.data.maxPointsPermille) / 1000);
    const maxPointsAllowed = Math.max(Math.ceil(maxRatioFen / 100), 0) * rate;
    const usablePoints = Math.min(points - (points % rate), maxPointsAllowed);
    const pointsDisc =
      usePoints && couponDisc === 0 ? Math.floor(usablePoints / rate) * 100 : 0;

    const totalDisc = levelDisc + couponDisc + pointsDisc;
    const payable = Math.max(original - totalDisc, 0);

    this.setData({
      coupons: selectable,
      blockedCouponCount,
      useCoupon: keepCoupon,
      couponId: keepCoupon ? couponId : 0,
      couponDiscount: keepCoupon ? couponDiscount : 0,
      couponText: keepCoupon ? this.data.couponText : '选择',
      levelDiscountText: fenToYuan(levelDisc),
      couponDiscountText: fenToYuan(couponDisc),
      pointsDiscountText: fenToYuan(pointsDisc),
      totalDiscountText: fenToYuan(totalDisc),
      payableText: fenToYuan(payable),
      // 用多少积分：与抵扣额同口径（不用积分时为 0）
      pointsToUse: pointsDisc > 0 ? usablePoints : 0,
    });
  },

  onTogglePoints(event: WechatMiniprogram.SwitchChange) {
    if (!this.data.selfPayEnabled) {
      toast('积分抵扣暂未开放，可到店结算');
      return;
    }
    const usePoints = event.detail.value;
    // 与券互斥：打开积分就**明确告知**并取消已选的券，不静默改掉用户的另一个选择
    if (usePoints && this.data.useCoupon) {
      toast('优惠券与积分抵扣不能同时使用，已取消优惠券');
    }
    this.setData(
      {
        usePoints,
        ...(usePoints
          ? {
              useCoupon: false,
              couponId: 0,
              couponDiscount: 0,
              couponText: '选择',
            }
          : {}),
      },
      () => this.recalc(),
    );
  },

  onToggleCard(event: WechatMiniprogram.SwitchChange) {
    if (!this.data.selfPayEnabled) {
      toast('次卡核销暂未开放，可到店结算');
      return;
    }
    this.setData({ useCard: event.detail.value });
    if (event.detail.value) {
      toast('次卡抵扣金额由门店结算时确认');
    }
  },

  onPickCoupon() {
    if (this.data.coupons.length === 0) {
      toast(
        this.data.blockedCouponCount > 0
          ? '有 ' + this.data.blockedCouponCount + ' 张券，但未达到使用门槛'
          : '暂无可用优惠券',
      );
      return;
    }
    wx.showActionSheet({
      itemList: [
        ...this.data.coupons.map(
          (c) => c.nameText + '（' + c.thresholdText + '）',
        ),
        '不使用优惠券',
      ],
      success: (res) => {
        const picked = this.data.coupons[res.tapIndex];
        if (!picked) {
          this.setData(
            {
              useCoupon: false,
              couponId: 0,
              couponDiscount: 0,
              couponText: '选择',
            },
            () => this.recalc(),
          );
          return;
        }
        const patch: Record<string, unknown> = {
          useCoupon: true,
          couponId: picked.id,
          couponDiscount: picked.discountAmount,
          couponText: picked.nameText,
        };
        // 与积分互斥：同样明确告知，而不是悄悄把积分关掉
        if (this.data.usePoints) {
          toast('优惠券与积分抵扣不能同时使用，已关闭积分抵扣');
          patch.usePoints = false;
        }
        this.setData(patch, () => this.recalc());
      },
      fail: () => {
        /* 用户取消 */
      },
    });
  },

  onRemarkInput(event: WechatMiniprogram.Input) {
    const value = event.detail.value;
    this.setData({ remark: value });
  },

  async onSubmit() {
    if (this.data.submitting) return;
    if (!isBound()) {
      toast('请先授权手机号');
      return;
    }
    const snapshot = getDraftSnapshot();
    if (!snapshot.staff || !snapshot.slot) return;

    this.setData({ submitting: true });
    showLoading('提交中');
    try {
      await ensureLogin();
      const booking = await bookingApi.create({
        staffId: snapshot.staff.id,
        startAt: snapshot.slot.startAt,
        serviceItemIds: snapshot.items.map((item) => item.id),
        pointsToUse: this.data.usePoints ? this.data.pointsToUse : 0,
        couponId: this.data.useCoupon ? this.data.couponId : undefined,
        memberCardId: this.data.useCard ? this.data.cardId : null,
        remark: snapshot.remark ? snapshot.remark : null,
      });
      hideLoading();
      clearDraft();
      wx.showModal({
        title: '预约提交成功',
        content: `单号 ${booking.bookingNo}\n我们会尽快与美甲师确认，请留意通知`,
        showCancel: false,
        confirmText: '看我的预约',
        confirmColor: '#B45F6B',
        complete: () => goBookings(),
      });
    } catch (error) {
      hideLoading();
      if (isApiFailure(error) && error.needBind) {
        this.setData({ needBind: true });
        toast('请先授权手机号');
      } else {
        toast(isApiFailure(error) ? error.message : '提交失败，请稍后再试');
      }
    } finally {
      this.setData({ submitting: false });
    }
  },

  goPickService() {
    wx.navigateBack();
  },
});
