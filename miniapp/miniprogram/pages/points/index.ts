import { memberApi, pointsApi, type PointsGoods } from '../../api/index';
import { requireSession } from '../../store/session';
import { getThemeTokens } from '../../theme/theme';
import { buildIcons, type IconName } from '../../utils/icons';
import { basePageData } from '../../utils/page';
import { isApiFailure } from '../../utils/request';
import { hideLoading, showLoading, toast } from '../../utils/ui';

const PAGE_ICONS: IconName[] = ['gift'];

/**
 * 商品配图轮转占位。
 *
 * `biz_points_goods` **没有图片列**（只有 name/points/stock/per_limit/status/card_type_id），
 * 所以设计稿里每件商品的配图在数据层没有来源。这里用本地作品素材轮转**保留视觉**，
 * 不伪造图片地址；正式做法是给该表加 `images` 列（与 `biz_service_item` 同样走图集 + 派生封面）。
 */
const PLACEHOLDER_IMAGES = ['/assets/svc-a.png', '/assets/svc-b.png', '/assets/svc-c.png'];

/** 分类（设计稿有；后端目录没有分类字段，故仅作前端筛选骨架） */
const CATEGORIES = ['全部', '美甲项目', '周边好物', '优惠券', '会员权益'];

interface GoodsRow extends PointsGoods {
  image: string;
}

/**
 * 积分兑换（docs/manicure-ui-batch4 第 3 屏）。
 *
 * 两处与后端口径对齐的设计：
 * 1. **目录对所有人可见**：后端 `GET /app/points-goods` 只要求 app token、
 *    不要求绑定手机号。所以这一页**未绑定也展示能换什么**，只在「看积分」与
 *    「兑换」两处需要身份 —— 先让人看到价值再引导授权，比一进门就拦好得多；
 * 2. **兑换走 `requireSession`**：未绑定会引导到登录页并说明原因，不静默失败。
 *
 * 设计稿的「今日获得」已移除：`MemberMe` 没有这个字段，显示 `+0` 等于给出**假数据**。
 * 若确实需要，可由后端从 `biz_member_transaction` 的 `points_delta` 按当日汇总后提供。
 */
Page({
  data: {
    ...basePageData(),
    icons: buildIcons(PAGE_ICONS, '#2D221E'),
    loading: true,
    errorText: '',
    points: 0,
    categories: CATEGORIES,
    activeCategory: '全部',
    goods: [] as GoodsRow[],
  },

  /** 防连点：兑换是权益写入，重复提交会多发一张卡 */
  redeeming: false,

  onLoad() {
    void this.load();
  },

  onShow() {
    this.setData({
      ...basePageData(),
      icons: buildIcons(PAGE_ICONS, getThemeTokens().text),
    });
  },

  async load() {
    this.setData({ loading: true, errorText: '' });
    try {
      const [list, me] = await Promise.all([
        pointsApi.listGoods(1, 50),
        this.data.bound
          ? memberApi.getMe().catch(() => null)
          : Promise.resolve(null),
      ]);
      this.setData({
        loading: false,
        points: me ? me.points : 0,
        goods: list.items.map((item, index) => ({
          ...item,
          image: PLACEHOLDER_IMAGES[index % PLACEHOLDER_IMAGES.length] ?? '',
        })),
      });
    } catch (error) {
      this.setData({
        loading: false,
        goods: [],
        errorText: isApiFailure(error) ? error.message : '网络连接失败',
      });
    }
  },

  onCategory(event: WechatMiniprogram.TouchEvent) {
    this.setData({ activeCategory: String(event.currentTarget.dataset.name) });
  },

  async onRedeem(event: WechatMiniprogram.TouchEvent) {
    const id = Number(event.currentTarget.dataset.id);
    const good = this.data.goods.find((item) => item.id === id);
    if (!good) return;
    const ready = await requireSession({
      needBind: true,
      reason: '兑换需要先绑定手机号',
    });
    if (!ready) return;
    if (this.data.points < good.points) {
      toast('还差 ' + (good.points - this.data.points) + ' 积分，再攒攒～');
      return;
    }
    if (this.redeeming) return;
    this.redeeming = true;
    showLoading('兑换中');
    try {
      // 扣分与发卡都在服务端同一条事务里完成；这里只在成功后刷新余额与卡
      const result = await pointsApi.redeem(good.id);
      hideLoading();
      wx.showModal({
        title: '兑换成功',
        content:
          '已扣除 ' +
          result.points +
          ' 积分，次卡 ' +
          result.cardNo +
          ' 已到账，可在「会员卡 - 有效次卡」里查看。',
        showCancel: false,
        confirmText: '好',
        confirmColor: '#B45F6B',
        complete: () => {
          void this.load();
        },
      });
    } catch (error) {
      hideLoading();
      toast(isApiFailure(error) ? error.message : '兑换失败，请稍后再试');
    } finally {
      this.redeeming = false;
    }
  },

  onRetry() {
    void this.load();
  },

  onGuestLogin() {
    void requireSession({ needBind: true, reason: '绑定手机号后查看可用积分' });
  },
});