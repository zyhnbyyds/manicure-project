import { memberApi } from '../../api/index';
import { getThemeTokens } from '../../theme/theme';
import { buildIcons, type IconName } from '../../utils/icons';
import { basePageData } from '../../utils/page';
import { isApiFailure } from '../../utils/request';
import { toast } from '../../utils/ui';

const PAGE_ICONS: IconName[] = ['gift'];

/**
 * 兑换商品（设计稿的四个卡位）。
 *
 * ⚠️ **后端有表但没有 app 接口，而且表里没有图片字段**：
 * `biz_points_goods` 只有 `name / points / stock / perLimit / status / card_type_id`
 * ——**兑换的本质是发一张次卡**（外键指向 `biz_member_card_types`），所以设计稿里
 * 每件商品的配图在后端**没有对应列**。
 *
 * 正解（两步，都在后端）：
 * 1. `PointsGoodsPort` + `GET /app/points-goods` 暴露 name/points/stock/perLimit；
 * 2. 若要配图，`biz_points_goods` 需要加 `images` 列（与 `biz_service_item` 同样走图集 + 派生封面）。
 * 在此之前这里用本地数据还原视觉，兑换动作如实提示。
 */
const GOODS = [
  { id: 1, name: '单色甲油胶一次', points: 1500, image: '/assets/svc-a.png' },
  { id: 2, name: '美甲护甲护理', points: 800, image: '/assets/svc-b.png' },
  { id: 3, name: '定制美甲挂件套餐', points: 2000, image: '/assets/svc-c.png' },
  { id: 4, name: '50 元无门槛券', points: 1000, image: '/assets/svc-a.png' },
];

const CATEGORIES = ['全部', '美甲项目', '周边好物', '优惠券', '会员权益'];

Page({
  data: {
    ...basePageData(),
    icons: buildIcons(PAGE_ICONS, '#2D221E'),
    loading: true,
    errorText: '',
    needBind: false,
    points: 0,
    /** 今日获得：`MemberMe` 没有这个字段，先按 0 展示（保留设计稿位置） */
    todayGained: 0,
    categories: CATEGORIES,
    activeCategory: '全部',
    goods: GOODS,
  },

  onLoad() {
    this.load();
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
      const me = await memberApi.getMe();
      this.setData({ loading: false, points: me.points });
    } catch (error) {
      if (isApiFailure(error) && error.needBind) {
        this.setData({ loading: false, needBind: true });
        return;
      }
      this.setData({
        loading: false,
        errorText: isApiFailure(error) ? error.message : '网络连接失败',
      });
    }
  },

  onCategory(event: WechatMiniprogram.TouchEvent) {
    this.setData({ activeCategory: String(event.currentTarget.dataset.name) });
  },

  onRedeem(event: WechatMiniprogram.TouchEvent) {
    const id = Number(event.currentTarget.dataset.id);
    const good = GOODS.find((item) => item.id === id);
    if (!good) return;
    if (this.data.needBind) {
      toast('请先绑定手机号');
      return;
    }
    if (this.data.points < good.points) {
      toast(`还差 ${good.points - this.data.points} 积分，再攒攒～`);
      return;
    }
    // app 域没有兑换接口（后端兑换会「同事务扣积分 + 发次卡」），如实提示
    toast('兑换通道正在接入，可先到店兑换');
  },

  onRetry() {
    this.load();
  },
});
