import type { IconName } from '../../utils/icons';
import { goServices } from '../../utils/nav';
import { definePage } from '../../utils/page';
import { toast } from '../../utils/ui';

const PAGE_ICONS: IconName[] = ['heart'];

/** 分类胶囊（设计稿有；收藏本身按款式分类过滤） */
const CATEGORIES = ['全部', '单色', '款式', '设计', '基础护理'];

/**
 * 我的收藏（docs/manicure-ui-batch4 第 4 屏）。
 *
 * **整个功能在数据模型里不存在**：没有「顾客 ↔ 款式」的收藏关联表
 * （`biz_*` 里没有任何 favorite / collection 表），后端也没有对应接口。
 *
 * 因此这里**只还原设计稿的骨架**（标题、分类胶囊、空态与引导），
 * **不塞假收藏数据** —— 收藏列表塞假数据比空着更糟：顾客会以为自己收藏过。
 * 补这个功能需要：新表 `biz_customer_favorite`（customer_id + service_item_id + 唯一约束）
 * + `POST/DELETE /app/favorites` + `GET /app/favorites`。
 */
definePage({
  chromeIcons: PAGE_ICONS,
  data: {
    categories: CATEGORIES,
    activeCategory: '全部',
    /** 收藏数：模型里没有，恒为 0，等后端补表后再接 */
    total: 0,
    items: [] as unknown[],
  },

  onCategory(event: WechatMiniprogram.TouchEvent) {
    const name = String(event.currentTarget.dataset.name);
    if (name === this.data.activeCategory) return;
    this.setData({ activeCategory: name });
    if (this.data.total === 0) return;
    toast('分类筛选待收藏接口接入后可用');
  },

  goServices,
});
