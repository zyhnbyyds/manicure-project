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
  {
    key: 'birthday',
    label: '生日礼遇',
    sub: '专属礼品',
    icon: 'gift' as IconName,
  },
  {
    key: 'priority',
    label: '优先预约',
    sub: '提前 1 天',
    icon: 'calendar' as IconName,
  },
  {
    key: 'points',
    label: '积分兑换',
    sub: '好礼任选',
    icon: 'coupon' as IconName,
  },
];

interface PhoneNumberEventDetail {
  code?: string;
}
interface PhoneNumberEvent {
  detail: PhoneNumberEventDetail;
}

/**
 * 会员卡（docs/design.png 第 6 屏 + 分等级皮肤）。
 *
 * 视觉重心是那张卡：**卡面按等级换肤**（银 / 金 / 钻 / 曜石黑金四档），
 * 装饰圆 + 「M」水印 + 卡号 + 等级徽章。
 *
 * 皮肤为什么按 `levelRank` 而不是 `levelName`：等级名是门店自己起的
 * （可以叫「黑金卡」「VVIP」），前端不可能靠名字判断高低；`levelRank`
 * 是服务端按 `sort/upgradeAmount` 算出来的名次（0 = 最低），随等级单调上升。
 * 超出预设档位时**停在最高档**（门店加第 5、第 6 个等级也不会掉回银卡）。
 *
 * 口径注意：**余额本金与赠送分列**（赠送不可退，必须让顾客看得见差别）；
 * 折扣率是千分比整数（950 → 9.5 折）。
 */
const TIER_CLASSES = ['tier-0', 'tier-1', 'tier-2', 'tier-3'];

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
    /** 卡面皮肤档位（`tier-0` ~ `tier-3`），由 `levelRank` 决定 */
    tierClass: 'tier-0',
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
    /** 优惠券加载失败（与「确实没有券」区分开） */
    offersFailed: false,
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
      /**
       * 可领取的券与会员信息一起取；**失败时区分「拿不到」与「确实没有」**。
       *
       * 以前是一次 `.catch(() => ({ items: [] }))` 静默吞掉：接口挂了也显示
       * 「暂无可领的券」，顾客以为自己没券可领 —— 而真相是这一块没加载出来。
       * 现在失败置 `offersFailed`，促销区如实显示「优惠券加载失败」并给重试入口。
       */
      let offers: Awaited<ReturnType<typeof couponApi.listOffers>> = {
        items: [],
      };
      let offersFailed = false;
      try {
        offers = await couponApi.listOffers();
      } catch {
        offersFailed = true;
      }
      const firstOffer = offers.items[0];
      const activeCards = me.cards.filter((card) => card.status === 'active');
      this.setData({
        loading: false,
        ready: true,
        needBind: false,
        name: me.name,
        levelName: me.levelName ?? '普通会员',
        // 卡面皮肤：名次超出预设档位就停在最高档（不透支到「银卡」）
        tierClass:
          TIER_CLASSES[Math.min(me.levelRank, TIER_CLASSES.length - 1)] ??
          'tier-0',
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
        offersFailed,
        offerId: firstOffer ? firstOffer.id : 0,
        offerName: offersFailed
          ? '优惠券加载失败'
          : firstOffer
            ? firstOffer.name
            : '暂无可领的券',
        offerSubText: offersFailed
          ? '点这里重新加载'
          : firstOffer
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
    // 券列表没加载出来时，这个入口的语义变成「重新加载」——不能点了没反应
    if (this.data.offersFailed) {
      await this.load();
      return;
    }
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
