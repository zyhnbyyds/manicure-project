import { favoriteApi } from '../../api/index';
import type { Favorite } from '../../api/types';
import { isBound } from '../../store/auth';
import { requireSession } from '../../store/session';
import type { IconName } from '../../utils/icons';
import { goServiceDetail, goServices } from '../../utils/nav';
import { isApiFailure } from '../../utils/request';
import { definePage } from '../../utils/page';
import { toServiceItemVM, type ServiceItemVM } from '../../utils/present';
import { hideLoading, showLoading, toast } from '../../utils/ui';

const PAGE_ICONS: IconName[] = ['heart'];

/** 设计稿里胶囊的顺序；实际选项从「收藏里真实出现过的分类」推出来 */
const CATEGORY_ORDER = ['单色', '款式', '设计', '基础护理'];

/**
 * 收藏项视图模型：直接复用款式卡片的展示映射（`toServiceItemVM`），
 * 只多一个收藏时间 —— 收藏页与款式库看到的是同一种卡片，
 * 图片解析 / 价格元角分 / 时长文案都不该在这里再写一遍。
 */
type FavoriteVM = ServiceItemVM & { favoritedAt: string };

/**
 * 我的收藏（`docs/manicure-ui-batch4` 第 4 屏）。
 *
 * ## 分类胶囊这次真的能用
 *
 * 早先它是个**死控件**（点了只改高亮）：那时后端没有收藏表，胶囊分类也是硬编码的。
 * 现在分类来自款式自己的 `category`，并且**在本地过滤** —— 一位顾客的收藏是几十条的量级
 * （不是分页列表），本地过滤省一次往返、切分类也不闪。
 * 胶囊选项也从「收藏里真实出现过的分类」推出来，不再硬编码一份可能与门店实际分类对不上的
 * 清单（门店把「款式设计」改成「法式」，硬编码的胶囊就永远是空的）。
 *
 * ## 卡片是两列宫格
 *
 * 图 + 名称 + 「时长 · 价格」+ 心形。心形在这里是**取消收藏**（就地移除 + toast），
 * 收藏入口在款式详情页。
 */
definePage({
  chromeIcons: PAGE_ICONS,

  data: {
    loading: true,
    errorText: '',
    needBind: false,
    /** 服务端返回的全部收藏 */
    all: [] as FavoriteVM[],
    /** 当前分类下要展示的 */
    items: [] as FavoriteVM[],
    categories: ['全部'] as string[],
    activeCategory: '全部',
    total: 0,
  },

  onLoad() {
    if (!isBound()) {
      this.setData({ loading: false, needBind: true });
      return;
    }
    void this.load();
  },

  /** 从详情页收藏后返回本页，要看到最新列表 */
  onShow() {
    if (this.data.needBind) return;
    if (!isBound()) {
      this.setData({ needBind: true, loading: false });
      return;
    }
    if (!this.data.loading) void this.load();
  },

  async load() {
    this.setData({ errorText: '' });
    try {
      const result = await favoriteApi.list();
      const all: FavoriteVM[] = result.items.map((item: Favorite) => ({
        ...toServiceItemVM(item),
        favoritedAt: item.favoritedAt,
      }));
      // 胶囊 = 「全部」+ 收藏里真实出现过的分类（设计稿顺序优先，未知的排后面）
      const present = [
        ...new Set(all.map((item) => item.category ?? '')),
      ].filter((name) => name !== '');
      const ordered = [
        ...CATEGORY_ORDER.filter((name) => present.includes(name)),
        ...present.filter((name) => !CATEGORY_ORDER.includes(name)),
      ];
      const categories = ['全部', ...ordered];
      // 原来选中的分类可能因为取消收藏而消失 → 回落「全部」
      const activeCategory = categories.includes(this.data.activeCategory)
        ? this.data.activeCategory
        : '全部';
      this.setData({
        loading: false,
        needBind: false,
        all,
        categories,
        activeCategory,
        total: all.length,
        items: this.filterBy(all, activeCategory),
      });
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

  filterBy(list: FavoriteVM[], category: string): FavoriteVM[] {
    if (category === '全部') return list;
    return list.filter((item) => (item.category ?? '') === category);
  },

  onRetry() {
    void this.load();
  },

  async onGuestLogin() {
    await requireSession({
      needBind: true,
      reason: '查看收藏需要先绑定手机号',
    });
    if (isBound()) void this.load();
  },

  onCategory(event: WechatMiniprogram.TouchEvent) {
    const name = String(event.currentTarget.dataset.name);
    if (name === this.data.activeCategory) return;
    this.setData({
      activeCategory: name,
      items: this.filterBy(this.data.all, name),
    });
  },

  onOpen(event: WechatMiniprogram.TouchEvent) {
    goServiceDetail(Number(event.currentTarget.dataset.id));
  },

  /** 心形 = 取消收藏：就地移除，不整页重载（重载会让列表闪一下） */
  async onRemove(event: WechatMiniprogram.TouchEvent) {
    const id = Number(event.currentTarget.dataset.id);
    showLoading('处理中');
    try {
      await favoriteApi.remove(id);
      hideLoading();
      const all = this.data.all.filter((item) => item.id !== id);
      this.setData({
        all,
        total: all.length,
        items: this.filterBy(all, this.data.activeCategory),
      });
      toast('已取消收藏');
    } catch (error) {
      hideLoading();
      toast(isApiFailure(error) ? error.message : '操作失败，请稍后再试');
    }
  },

  goServices,
});
