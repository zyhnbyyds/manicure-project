import { memberApi, pointsApi, type PointsGoods } from '../../api/index';
import { requireSession } from '../../store/session';
import { absoluteAssetUrl } from '../../utils/asset-url';
import type { IconName } from '../../utils/icons';
import { runLoad } from '../../utils/load';
import { definePage } from '../../utils/page';
import { isApiFailure } from '../../utils/request';
import { hideLoading, showLoading, toast } from '../../utils/ui';

const PAGE_ICONS: IconName[] = ['gift'];

/**
 * 商品配图的**兜底**轮转（`biz_points_goods.image` 为空时用）。
 *
 * 门店可以在后台给兑换品上传图片；没上传时用本地作品素材轮转保留视觉，
 * **不伪造图片地址**。
 */
const PLACEHOLDER_IMAGES = [
  '/assets/svc-a.png',
  '/assets/svc-b.png',
  '/assets/svc-c.png',
];

interface GoodsRow extends PointsGoods {
  /** 已解析成可直接绑定到 `<image src>` 的地址（DB 图或本地占位图） */
  image: string;
}

/**
 * 积分兑换（docs/manicure-ui-batch4 第 3 屏）。
 *
 * 三处与后端口径对齐的设计：
 * 1. **目录对所有人可见**：`GET /app/points-goods` 只要求 app token、不要求绑定手机号。
 *    所以这一页**未绑定也展示能换什么**，只在「看积分」与「兑换」两处需要身份 ——
 *    先让人看到价值再引导授权，比一进门就拦好得多；
 * 2. **兑换走 `requireSession`**：未绑定会引导到登录页并说明原因，不静默失败；
 * 3. **分类胶囊真的能筛**：选项来自响应里的 `categories`（后端按在架商品去重出来的），
 *    切换时**重新请求**（筛选下推服务端，分页才正确）—— 以前这里是死控件。
 *
 * 设计稿的「今日获得」已移除：`MemberMe` 没有这个字段，显示 `+0` 等于给出**假数据**。
 * 若确实需要，可由后端从 `biz_member_transaction` 的 `points_delta` 按当日汇总后提供。
 */
definePage({
  chromeIcons: PAGE_ICONS,

  data: {
    loading: true,
    errorText: '',
    points: 0,
    /** 「全部」+ 后端给的分类清单 */
    categories: ['全部'] as string[],
    activeCategory: '全部',
    goods: [] as GoodsRow[],
  },

  /** 防连点：兑换是权益写入，重复提交会多发一张卡 */
  redeeming: false,

  onLoad() {
    void this.load();
  },

  async load(force = false) {
    const category = this.data.activeCategory;
    await runLoad(
      this,
      async () => {
        const [list, me] = await Promise.all([
          pointsApi.listGoods(
            1,
            50,
            category === '全部' ? undefined : category,
          ),
          this.data.bound
            ? memberApi.getMe().catch(() => null)
            : Promise.resolve(null),
        ]);
        return { list, me };
      },
      {
        // 换分类 = 数据源整体换了 → 回骨架屏（与「时段页换日期」同一口径）
        force,
        merge: ({ list, me }) => {
          const goods = list.items.map((item, index) => ({
            ...item,
            image:
              absoluteAssetUrl(item.image) ??
              PLACEHOLDER_IMAGES[index % PLACEHOLDER_IMAGES.length] ??
              '',
          }));
          // 选中的分类若已消失（门店下架了最后一款），回落「全部」
          const categories = ['全部', ...list.categories];
          return {
            points: me ? me.points : 0,
            goods,
            categories,
            activeCategory: categories.includes(category) ? category : '全部',
          };
        },
      },
    );
  },

  onCategory(event: WechatMiniprogram.TouchEvent) {
    const name = String(event.currentTarget.dataset.name);
    if (name === this.data.activeCategory) return;
    this.setData({ activeCategory: name });
    void this.load(true);
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
