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
import { basePageData } from '../../utils/page';
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
const MAX_POINTS_PERMILLE = 500;

Page({
  data: {
    ...basePageData(),
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
    /** 可用次卡（取第一张在用卡） */
    cardId: 0,
    cardName: '',
    cardRemain: 0,
    hasCard: false,
    /** 三个抵扣开关 */
    usePoints: false,
    useCard: false,
    couponText: '选择',
    /** 可用券列表（真实接口） */
    coupons: [] as {
      id: number;
      nameText: string;
      thresholdText: string;
      discountAmount: number;
    }[],
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
      this.setData({ ready: false, emptyDraft: true });
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
      staffAvatar: resolveStaffAvatar({ id: snapshot.staff.id, avatar: snapshot.staff.avatar }),
      dateText: formatDateTimeLabel(snapshot.slot.startAt).replace(/\s\d{2}:\d{2}$/, ''),
      timeText: formatTimeRange(snapshot.slot.startAt, snapshot.slot.endAt),
      durationText: formatDuration(totals.durationMinutes),
      originalText: fenToYuan(totals.originalPrice),
      remark: getDraftRemark(),
      needBind: !isBound(),
    });
    this.loadMember();
  },

  onShow() {
    this.setData({ ...basePageData(), needBind: !isBound() });
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
      this.setData(
        {
          levelName: me.levelName ?? '',
          discountText: formatDiscount(me.discountPermille),
          points: me.points,
          hasCard: Boolean(activeCard),
          cardId: activeCard ? activeCard.id : 0,
          cardName: activeCard ? activeCard.cardName : '',
          cardRemain: activeCard ? activeCard.totalTimes - activeCard.usedTimes : 0,
          discountPermille: me.discountPermille,
          coupons: (couponPage ? couponPage.items : []).map((c) => ({
            id: c.id,
            nameText: c.templateName ?? '优惠券',
            thresholdText:
              c.thresholdAmount > 0
                ? '满 ' + fenToYuan(c.thresholdAmount) + ' 元'
                : '无门槛',
            discountAmount: c.discountAmount,
          })),
        },
        () => this.recalc(),
      );
    } catch {
      // 未绑定手机号或接口失败：不影响下单，只是不能预估优惠与选券
      this.setData({ coupons: [], useCoupon: false, couponId: 0, couponDiscount: 0 });
      this.recalc();
    }
  },

  /** 预估金额（与服务端同一套公开公式；最终以提交后的结算为准） */
  recalc() {
    const { items, usePoints, points, discountPermille, useCoupon, couponDiscount } =
      this.data;
    const original = items.reduce((sum, item) => sum + item.price, 0);
    const permille = discountPermille;
    const levelDisc = Math.floor((original * (1000 - permille)) / 1000);
    const base = Math.max(original - levelDisc, 0);

    // 券在**等级折扣之后、积分之前**；且与积分**同一单二选一**（与服务端一致）。
    // 页面上的开关互斥（见 onTogglePoints / onPickCoupon），这里再兜一层。
    const couponDisc = useCoupon ? Math.min(couponDiscount, base) : 0;

    const maxByPoints = Math.floor(points / POINTS_PER_YUAN);
    const maxByRatio = Math.floor((base * MAX_POINTS_PERMILLE) / 1000);
    const pointsDisc =
      usePoints && couponDisc === 0 ? Math.min(maxByPoints, maxByRatio) : 0;

    const totalDisc = levelDisc + couponDisc + pointsDisc;
    const payable = Math.max(original - totalDisc, 0);

    this.setData({
      levelDiscountText: fenToYuan(levelDisc),
      couponDiscountText: fenToYuan(couponDisc),
      pointsDiscountText: fenToYuan(pointsDisc),
      totalDiscountText: fenToYuan(totalDisc),
      payableText: fenToYuan(payable),
      pointsToUse: pointsDisc * POINTS_PER_YUAN,
    });
  },

  onTogglePoints(event: WechatMiniprogram.SwitchChange) {
    const usePoints = event.detail.value;
    // 与券互斥：打开积分就**明确告知**并取消已选的券，不静默改掉用户的另一个选择
    if (usePoints && this.data.useCoupon) {
      toast('优惠券与积分抵扣不能同时使用，已取消优惠券');
    }
    this.setData(
      {
        usePoints,
        ...(usePoints
          ? { useCoupon: false, couponId: 0, couponDiscount: 0, couponText: '选择' }
          : {}),
      },
      () => this.recalc(),
    );
  },

  onToggleCard(event: WechatMiniprogram.SwitchChange) {
    this.setData({ useCard: event.detail.value });
    if (event.detail.value) {
      toast('次卡抵扣金额由门店结算时确认');
    }
  },

  onPickCoupon() {
    if (this.data.coupons.length === 0) {
      toast('暂无可用优惠券');
      return;
    }
    wx.showActionSheet({
      itemList: [
        ...this.data.coupons.map((c) => c.nameText + '（' + c.thresholdText + '）'),
        '不使用优惠券',
      ],
      success: (res) => {
        const picked = this.data.coupons[res.tapIndex];
        if (!picked) {
          this.setData(
            { useCoupon: false, couponId: 0, couponDiscount: 0, couponText: '选择' },
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
