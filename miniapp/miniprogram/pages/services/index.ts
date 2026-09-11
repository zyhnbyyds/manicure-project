import { catalogApi } from '../../api';
import { setDraftItems } from '../../store/draft';
import { fenToYuan, formatDuration } from '../../utils/format';
import { goServiceDetail, goStaffs } from '../../utils/nav';
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

Page({
  data: {
    ...basePageData(),
    loading: true,
    errorText: '',
    /** 原始列表（不过滤），切换分类时不必重新请求 */
    allItems: [] as ServiceItemVM[],
    items: [] as SelectableService[],
    categories: ['全部'] as string[],
    activeCategory: '全部',
    selectedIds: [] as number[],
    selectedCount: 0,
    totalText: '0.00',
    durationText: '',
  },

  onLoad() {
    this.load();
  },

  onShow() {
    this.setData(basePageData());
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
      this.setData({ loading: false, allItems, categories, selectedIds: [] }, () => {
        this.refresh();
      });
    } catch (error) {
      this.setData({
        loading: false,
        errorText: isApiFailure(error) ? error.message : '加载失败，请稍后再试',
      });
    }
  },

  /** 由 `allItems + activeCategory + selectedIds` 推导出视图，避免多处状态不同步 */
  refresh() {
    const { allItems, activeCategory, selectedIds } = this.data;
    const items: SelectableService[] = allItems
      .filter((item) => activeCategory === '全部' || item.category === activeCategory)
      .map((item) => ({ ...item, checked: selectedIds.includes(item.id) }));

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
    const selected = this.data.allItems.filter((item) => this.data.selectedIds.includes(item.id));
    if (selected.length === 0) {
      toast('先挑一个想做的款式吧～');
      return;
    }
    // 写草稿时会自动清空下游选择（美甲师/时段），见 store/draft.ts 的说明
    setDraftItems(selected);
    goStaffs();
  },
});
