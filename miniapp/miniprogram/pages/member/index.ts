import { couponApi, memberApi } from '../../api/index';
import { bindPhone, isBound } from '../../store/auth';
import { fenToYuan, formatDiscount } from '../../utils/format';
import type { IconName } from '../../utils/icons';
import { goCardDetail, goPoints, goRecharge } from '../../utils/nav';
import { definePage } from '../../utils/page';
import { isApiFailure } from '../../utils/request';
import { hideLoading, showLoading, toast } from '../../utils/ui';

const PAGE_ICONS: IconName[] = ['gift', 'calendar', 'coupon', 'star'];

/** 会员权益（设计稿四项）。只有「专属折扣」在数据模型里有真实值，其余为权益说明。 */
const BENEFITS = [
  { key: 'discount', label: '专属折扣', sub: '', icon: 'star' as IconName },
  { key: 'birthday', label: '生日礼遇', sub: '专属礼品', icon: 'gift' as IconName },
  { key: 'priority', label: '优先预约', sub: '提前 1 天', icon: 'calendar' as IconName },
  { key: 'points', label: '积分兑换', sub: '好礼任选', icon: 'coupon' as IconName },
];

interface PhoneNumberEventDetail {
  code?: string;
}
interface PhoneNumberEvent {
  detail: PhoneNumberEventDetail;
}

/**
 * 会员卡（docs/design.png 第 6 屏）。
 *
 * 视觉重心是那张卡：浅玫瑰渐变 + 装饰圆 + 「M」水印 + 卡号。
 * 口径注意：**余额本金与赠送分列**（赠送不可退，必须让顾客看得见差别）；
 * 折扣率是千分比整数（950 → 9.5 折）。
 *
 * 数据降级：
 * - 卡号：app 域的 `MemberMe` **没有暴露 `member_no`**（库里 `biz_customer.member_no` 有），
 *   这里用顾客 ID 补零格式化，并在注释里记下应补的字段；
 * - 「生日礼遇 / 优先预约 / 积分兑换」与「新客立减 ¥30」在模型里没有对应配置，
 *   按设计稿保留视觉，点击如实提示。
 */
definePage({
  chromeIcons: PAGE_ICONS,

  data: {
    benefits: BENEFITS,
    /** 活动配图（设计稿右侧有作品图），用本地占位素材 */
    promoImage: '/assets/svc-b.png',
    loading: true,
    errorText: '',
    needBind: false,
    ready: false,
    /** 卡面 */
    name: '',
    levelName: '普通会员',
    cardNo: '',
    discountText: '',
    /** 资产三列 */
    balanceText: '0.00',
    principalText: '0.00',
    bonusText: '0.00',
    points: 0,
    cardCount: 0,
    // 可领取的券（promo 区）
    offerId: 0,
    offerName: '',
    offerSubText: '',
  },

  onLoad() {
    this.load();
  },

  onShow() {
    const bound = isBound();
    this.setData({ needBind: !bound });
    if (bound && !this.data.ready) this.load();
  },

  async load() {
    this.setData({ loading: true, errorText: '' });
    try {
      const me = await memberApi.getMe();
      // 可领取的券与会员信息一起取；取不到不影响本页其它内容
      const offers = await couponApi.listOffers().catch(() => ({ items: [] }));
      const firstOffer = offers.items[0];
      const activeCards = me.cards.filter((card) => card.status === 'active');
      this.setData({
        loading: false,
        ready: true,
        needBind: false,
        name: me.name,
        levelName: me.levelName ?? '普通会员',
        // 真会员号来自 `biz_customer.member_no`（未入会为 null）。
        // **不要再用 customerId 补零编一个** —— 那个号跟门店系统里的对不上，
        // 顾客报给店员时谁也查不到。
        cardNo: me.memberNo ? `NO. ${me.memberNo}` : 'NO. 待入会后生成',
        discountText: formatDiscount(me.discountPermille),
        balanceText: fenToYuan(me.balancePrincipal + me.balanceBonus),
        principalText: fenToYuan(me.balancePrincipal),
        bonusText: fenToYuan(me.balanceBonus),
        points: me.points,
        cardCount: activeCards.length,
        offerId: firstOffer ? firstOffer.id : 0,
        offerName: firstOffer ? firstOffer.name : '暂无可领的券',
        offerSubText: firstOffer
          ? '可领 ' +
            fenToYuan(firstOffer.discountAmount) +
            ' 元券' +
            (firstOffer.thresholdAmount > 0
              ? '（满 ' + fenToYuan(firstOffer.thresholdAmount) + ' 元可用）'
              : '（无门槛）')
          : '门店有活动时会出现在这里',
      });
    } catch (error) {
      if (isApiFailure(error) && error.needBind) {
        this.setData({ loading: false, needBind: true, ready: false });
        return;
      }
      this.setData({
        loading: false,
        errorText: isApiFailure(error) ? error.message : '网络连接失败',
      });
    }
  },

  async onGetPhone(event: PhoneNumberEvent) {
    const code = event.detail.code;
    if (!code) {
      toast('需要你同意授权手机号哦');
      return;
    }
    showLoading('绑定中');
    try {
      await bindPhone(code);
      hideLoading();
      await this.load();
    } catch (error) {
      hideLoading();
      toast(isApiFailure(error) ? error.message : '绑定失败，请稍后再试');
    }
  },

  onBenefit(event: WechatMiniprogram.TouchEvent) {
    const key = String(event.currentTarget.dataset.key);
    if (key === 'discount') {
      toast(`当前等级：${this.data.levelName} · ${this.data.discountText}`);
      return;
    }
    toast('该权益以门店实际活动为准');
  },

  async onClaim() {
    if (!this.data.offerId) return;
    showLoading('领取中');
    try {
      await couponApi.claim(this.data.offerId);
      hideLoading();
      wx.showModal({
        title: '领取成功',
        content: '券已放进「我的优惠券」，下单时可以选择使用。',
        showCancel: false,
        confirmText: '好',
        confirmColor: '#B45F6B',
        complete: () => {
          void this.load();
        },
      });
    } catch (error) {
      hideLoading();
      toast(isApiFailure(error) ? error.message : '领取失败，请稍后再试');
    }
  },

  onRecharge() {
    goRecharge();
  },

  onCards() {
    goCardDetail();
  },

  onPoints() {
    goPoints();
  },

  onRetry() {
    this.load();
  },
});
