import { catalogApi } from '../../api/index';
import { setDraftItems } from '../../store/draft';
import { getThemeTokens } from '../../theme/theme';
import { fenToYuan, formatDuration } from '../../utils/format';
import { buildIcons, type IconName } from '../../utils/icons';
import { goServiceDetail, goSlots } from '../../utils/nav';
import { basePageData } from '../../utils/page';
import { toServiceItemVM, type ServiceItemVM } from '../../utils/present';
import { isApiFailure } from '../../utils/request';
import { toast } from '../../utils/ui';

/** 列表项 = VM + 选中态 */
interface SelectableService extends ServiceItemVM {
  checked: boolean;
}

/** 与后端 `appServiceItemIdsSchema` 一致：去重后 1~3 个 */
const MAX_SELECT = 3;

const PAGE_ICONS: IconName[] = ['search', 'funnel', 'plus'];
/** 选中态的对勾画在白底主色圆上，需要**白色**版本；图标是内联 SVG，颜色只能在生成时定 */
const WHITE_ICONS: IconName[] = ['check'];

/** 骨架屏行数：设计稿（batch3）里是 3 行 */
const SKELETON_ROWS = [1, 2, 3];

Page({
  data: {
    ...basePageData(),
    icons: buildIcons(PAGE_ICONS, '#2D221E'),
    iconsWhite: buildIcons(WHITE_ICONS, '#FFFFFF'),
    skeletonRows: SKELETON_ROWS,
    loading: true,
    errorText: '',
    refreshing: false,
    /** 搜索关键词（客户端过滤已加载列表；app 域列表接口没有 keyword 参数） */
    keyword: '',
    /** 原始列表（不过滤），切换分类/搜索时不必重新请求 */
    allItems: [] as ServiceItemVM[],
    items: [] as SelectableService[],
    categories: ['全部'] as string[],
    activeCategory: '全部',
    selectedIds: [] as number[],
    selectedCount: 0,
    totalText: '0.00',
    durationText: '',
    /** 排序方式：设计稿的漏斗图标需要有落点 */
    sort: 'default' as 'default' | 'priceAsc' | 'durationAsc',
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

  /** 下拉刷新（batch5 有「下拉刷新 / 正在刷新…」态） */
  async onPullDownRefresh() {
    await this.load();
    wx.stopPullDownRefresh();
  },

  async load() {
    this.setData({ loading: true, errorText: '' });
    try {
      const page = await catalogApi.listServiceItems(1, 100);
      const allItems = page.items.map(toServiceItemVM);
      // 分类从数据里现取：后端没有「分类字典」接口，硬编码分类会与真实数据脱节
      const categories = ['全部'];
      allItems.forEach((item) => {
        if (!categories.includes(item.category)) categories.push(item.category);
      });
      this.setData({ loading: false, allItems, categories }, () => {
        this.refresh();
      });
    } catch (error) {
      this.setData({
        loading: false,
        errorText: isApiFailure(error) ? error.message : '网络连接失败',
      });
    }
  },

  /** 由 allItems + 分类 + 关键词 + 排序 + 选中集推导视图，避免多处状态不同步 */
  refresh() {
    const { allItems, activeCategory, selectedIds, keyword, sort } = this.data;
    const lowered = keyword.trim().toLowerCase();

    let list = allItems.filter(
      (item) => activeCategory === '全部' || item.category === activeCategory,
    );
    if (lowered) {
      list = list.filter(
        (item) =>
          item.name.toLowerCase().includes(lowered) ||
          item.category.toLowerCase().includes(lowered),
      );
    }
    if (sort === 'priceAsc') {
      list = [...list].sort((a, b) => a.price - b.price);
    } else if (sort === 'durationAsc') {
      list = [...list].sort((a, b) => a.durationMinutes - b.durationMinutes);
    }

    const items: SelectableService[] = list.map((item) => ({
      ...item,
      checked: selectedIds.includes(item.id),
    }));

    const selected = allItems.filter((item) => selectedIds.includes(item.id));
    this.setData({
      items,
      selectedCount: selected.length,
      totalText: fenToYuan(selected.reduce((sum, item) => sum + item.price, 0)),
      durationText: formatDuration(
        selected.reduce((sum, item) => sum + item.durationMinutes, 0),
      ),
    });
  },

  onCategory(event: WechatMiniprogram.TouchEvent) {
    this.setData({ activeCategory: String(event.currentTarget.dataset.name) }, () => {
      this.refresh();
    });
  },

  onSearchInput(event: WechatMiniprogram.Input) {
    this.setData({ keyword: event.detail.value }, () => this.refresh());
  },

  onSearchClear() {
    this.setData({ keyword: '' }, () => this.refresh());
  },

  /**
   * 漏斗图标：设计稿只画了入口（还带一个红点）。
   * 后端款式表没有「风格/价格区间」等筛选字段，所以这里只做**排序**，
   * 不假装有筛选维度（真做筛选需要先加字段）。
   */
  onFilter() {
    const options = ['默认排序', '价格从低到高', '时长从短到长'];
    wx.showActionSheet({
      itemList: options,
      success: (res) => {
        const sort =
          res.tapIndex === 1
            ? 'priceAsc'
            : res.tapIndex === 2
              ? 'durationAsc'
              : 'default';
        this.setData({ sort }, () => this.refresh());
      },
      fail: () => {
        /* 用户取消，不处理 */
      },
    });
  },

  toggle(event: WechatMiniprogram.TouchEvent) {
    const id = Number(event.currentTarget.dataset.id);
    const { selectedIds } = this.data;
    if (selectedIds.includes(id)) {
      this.setData({ selectedIds: selectedIds.filter((item) => item !== id) }, () =>
        this.refresh(),
      );
      return;
    }
    if (selectedIds.length >= MAX_SELECT) {
      toast(`最多同时选 ${MAX_SELECT} 个项目哦～`);
      return;
    }
    this.setData({ selectedIds: [...selectedIds, id] }, () => this.refresh());
  },

  openDetail(event: WechatMiniprogram.TouchEvent) {
    goServiceDetail(Number(event.currentTarget.dataset.id));
  },

  goNext() {
    const selected = this.data.allItems.filter((item) =>
      this.data.selectedIds.includes(item.id),
    );
    if (selected.length === 0) {
      toast('先挑一个想做的款式吧～');
      return;
    }
    // 写草稿时会自动清空下游选择（美甲师/时段），见 store/draft.ts
    setDraftItems(selected);
    // **直接进「预约美甲」页**：设计稿第 4 屏把「选时间 + 选美甲师」合并在一页，
    // 若先跳独立的「选美甲师」页会让人选两遍（验证时实际踩到过）。
    goSlots();
  },

  onRetry() {
    this.load();
  },
});
