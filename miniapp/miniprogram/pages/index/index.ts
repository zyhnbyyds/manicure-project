import { catalogApi, favoriteApi, shopApi } from '../../api/index';
import type { Favorite } from '../../api/types';
import { isBound } from '../../store/auth';
import { requireSession } from '../../store/session';
import { absoluteAssetUrl } from '../../utils/asset-url';
import { buildIcons, type IconName } from '../../utils/icons';
import { runLoad } from '../../utils/load';
import { getNavMetrics } from '../../utils/metrics';
import {
  goBookings,
  goMember,
  goNotices,
  goServiceDetail,
  goServices,
  goShop,
  goStaffs,
} from '../../utils/nav';
import { definePage } from '../../utils/page';
import {
  HERO_IMAGE,
  resolveServiceImage,
  toServiceItemVM,
  toStaffVM,
  type ServiceItemVM,
  type StaffVM,
} from '../../utils/present';
import { isApiFailure } from '../../utils/request';
import { getThemeTokens } from '../../theme/theme';
import { toast } from '../../utils/ui';

/**
 * 首页 = 顾客端第一屏（设计稿 `manicure-ui-home`）。
 *
 * ## 一屏有哪些东西
 *
 * 导航栏（品牌名 + 门店/消息两个圆钮）→ 头图轮播（「今日灵感」+ 圆点）→
 * 四个快捷入口 → 人气款式（3 张一屏，**卡上可收藏**）→ 我们的美甲师 → TabBar。
 *
 * ## 三条改动前必读
 *
 * 1. **心形必须用 `catchtap`**：它长在「点卡片进详情」的卡片里，
 *    用 `bindtap` 会连详情一起跳（点收藏却进了详情页）。
 * 2. **收藏态以服务端返回的目标状态为准**（`{ favorited }`），不在本地取反 ——
 *    慢网或连点时本地取反一定与真实状态错位（与款式详情页同一套写法）。
 * 3. **未绑定手机号不发收藏请求**：接口会 400 + needBind，
 *    明知会失败还打一次只会让「未登录」看起来像「加载失败」。
 */

/** 快捷入口：图标底是**主色实心圆 + 白图标**，所以图标名走 `whiteIcons` */
const QUICK_ICONS: IconName[] = ['calendar', 'grid', 'clock', 'card'];

/** 一屏展示量：款式 3 张一排、美甲师 4 个一排（设计稿） */
const HOME_SERVICE_LIMIT = 3;
const HOME_STAFF_LIMIT = 4;
/** 头图轮播最多几张（设计稿是 3 个圆点） */
const HERO_SLIDE_LIMIT = 3;

interface QuickEntry {
  icon: IconName;
  label: string;
  /** 四个入口各自的落地页 —— 见 `onQuickTap` */
  action: 'book' | 'services' | 'bookings' | 'member';
}

/**
 * 四个快捷入口。
 *
 * `会员卡` 曾经错指到「我们的美甲师」列表（点会员卡进美甲师页，纯属指错），
 * 现在落到会员卡页 `pages/member`；`预约美甲` 与`款式库` 也要分开 ——
 * 两个入口跳同一个页面，用户会以为其中一个坏了（预约要先选款式，所以落美甲师→时段）。
 */
const QUICK_ENTRIES: QuickEntry[] = [
  { icon: 'calendar', label: '预约美甲', action: 'book' },
  { icon: 'grid', label: '款式库', action: 'services' },
  { icon: 'clock', label: '我的预约', action: 'bookings' },
  { icon: 'card', label: '会员卡', action: 'member' },
];

/** 头图一屏（文案固定，只有图在换） */
interface HeroSlide {
  url: string;
  title: string;
  sub: string;
}

const HERO_TITLE = '今日灵感';
const HERO_SUB = '把喜欢的样子，做在手上。';

/** 首页的款式卡：在通用 VM 上多一个「我收藏了没」 */
export interface HomeServiceVM extends ServiceItemVM {
  favorited: boolean;
}

/**
 * 组装头图轮播。
 *
 * 优先**门店图集**（后台上传，最多 5 张）—— 那是门店自己的作品照；
 * 图集没传过就拿「人气款式」的封面顶上，这样设计稿那个「多张轮播 + 圆点」不是摆设；
 * 一张都凑不出来才退回包内 `hero.png`。
 *
 * ⚠️ 只有服务端图集需要 `absoluteAssetUrl`：包内素材（`/assets/hero.png`）与
 * 款式占位图已经是可用地址，再拼一次 origin 会被当成服务端路径而 404。
 */
function buildHeroSlides(
  shopImages: string[],
  serviceImages: (string | null)[],
): HeroSlide[] {
  const urls: string[] = [];
  const push = (value: string | null | undefined) => {
    if (value && !urls.includes(value)) urls.push(value);
  };

  shopImages.forEach((image) => push(absoluteAssetUrl(image)));
  if (urls.length < 2) serviceImages.forEach(push);
  if (!urls.length) push(HERO_IMAGE);

  return urls
    .slice(0, HERO_SLIDE_LIMIT)
    .map((url) => ({ url, title: HERO_TITLE, sub: HERO_SUB }));
}

definePage({
  /**
   * ⚠️ 本页**刻意不用 `chromeIcons`**：导航圆钮与「全部 ›」箭头在 `extra` 里（要按主题取色、
   * 而且不是同一个色），快捷入口的图标走 `whiteIcons`（主色实心圆上的白图标）。
   *
   * **删顶层常量时，声明和引用必须一次改完**：先删 `const PAGE_ICONS`、过一会儿才改
   * `chromeIcons: PAGE_ICONS`，中间那几秒文件是「有引用无声明」的坏状态 ——
   * 开发者工具的编译/热重载会正好把那一瞬间编进 bundle，之后改回来也一直报
   * `PAGE_ICONS is not defined`，**只能「清除缓存 → 重新编译」（或重启工具）才好**
   * （tsc 是过不了的，所以 tsc 绿 ≠ 运行时不报，两者查的是不同一份东西）。
   */
  whiteIcons: QUICK_ICONS,
  /**
   * 跟主题走的其余 chrome：
   * - 收藏两态：实心=已收藏（主色），描边=未收藏；
   *   首页的心形压在**照片**上，未收藏态特意用 `textWeak` 而不是全局那套 `border`
   *   —— `--c-border`（#efe7e2）压在白药丸底上几乎看不见；
   * - 导航栏两个圆钮里的图标用主色；
   * - 「全部 ›」的小箭头用弱色（设计稿里跟文字同色，比正文浅）。
   */
  extra: () => {
    const tokens = getThemeTokens();
    return {
      iconsHeartOn: buildIcons(['heart'], tokens.primary, 24, true),
      iconsHeartOff: buildIcons(['heart'], tokens.textWeak, 24),
      iconsNav: buildIcons(['shop', 'chat'], tokens.primary, 24),
      iconChevron: buildIcons(['chevron'], tokens.textSub, 24).chevron,
    };
  },

  data: {
    /** 自定义导航栏几何：状态栏高度 + 导航栏高度（对齐胶囊）+ 右侧给胶囊让位的宽度 */
    statusBarHeight: 20,
    navBarHeight: 44,
    navRightGap: 16,
    /** 品牌英文副标题（设计稿里跟在中文名下方；门店没配英文名时整行不显示） */
    brandNameEn: 'BEAUTY NAILS',
    /** 品牌中文名：先用设计稿的默认值播一次种，加载后换成**当前门店**的名字 */
    brandName: '美甲小铺',
    /**
     * 头图轮播。**先用包内 hero.png 播一次种**：数据没回来之前那一屏也要有图，
     * 否则首帧是一张空卡片（旧版是静态图，天然没这个问题）。
     */
    heroSlides: [
      { url: HERO_IMAGE, title: HERO_TITLE, sub: HERO_SUB },
    ] as HeroSlide[],
    /** 当前轮播下标（自定义圆点用它高亮） */
    heroCurrent: 0,
    quickEntries: QUICK_ENTRIES,
    services: [] as HomeServiceVM[],
    staffs: [] as StaffVM[],
    /** 正在切换收藏的款式 id（0 = 空闲）：防连点造成状态错位 */
    favoritingId: 0,
  },

  onLoad() {
    this.applyNavMetrics();
  },

  /**
   * 回到本页就刷新一次（与 `pages/bookings` / `pages/mine` 同一套时机）。
   *
   * 必须刷：用户可能在款式详情/收藏页改了收藏态，不刷就会出现「详情里取消了收藏，
   * 首页的心还是实的」。`runLoad` 在已有数据时是**静默刷新**（保留内容 + 顶部细提示），
   * 只有首次进来才回骨架屏 —— 所以这里不用自己判断 loaded。
   */
  onShow() {
    void this.load();
  },

  /**
   * 计算自定义导航栏的几何。
   *
   * **必须给右侧胶囊按钮让位**：微信把「···⊙」固定在右上角，
   * 自绘内容压在那里会被盖住（设计稿里没有这个胶囊，直接照搬会踩坑）。
   * 做法：拿胶囊的 left 边界，导航栏右侧留出 `窗口宽 - 胶囊left` 的间距。
   */
  applyNavMetrics() {
    try {
      const metrics = getNavMetrics();
      const statusBarHeight = metrics.statusBarHeight ?? 20;
      const rect = wx.getMenuButtonBoundingClientRect();
      if (rect && rect.height > 0) {
        this.setData({
          statusBarHeight,
          // 导航栏高度与胶囊垂直居中对齐（微信推荐的经典公式）
          navBarHeight: (rect.top - statusBarHeight) * 2 + rect.height,
          navRightGap: metrics.windowWidth - rect.left + 8,
        });
        return;
      }
      this.setData({ statusBarHeight });
    } catch {
      /* 取不到就沿用默认值，不影响页面主体 */
    }
  },

  async load() {
    await runLoad(
      this,
      () =>
        Promise.all([
          catalogApi.listServiceItems(1, 50),
          catalogApi.listStaffs(),
          // 头图轮播的图源：门店图集（没配也返回空数组，不抛错）
          shopApi.get().catch(() => null),
          isBound()
            ? favoriteApi.list().catch(() => ({ items: [] as Favorite[] }))
            : Promise.resolve({ items: [] as Favorite[] }),
        ]),
      {
        merge: ([services, staffs, shop, favorites]) => {
          const favoritedIds = new Set(
            favorites.items.map((favorite) => favorite.id),
          );
          const picked = services.items.slice(0, HOME_SERVICE_LIMIT);
          return {
            // 品牌名跟着**当前门店**走：多店下小程序可以切店，标题不该永远写着「美甲小铺」
            ...(shop
              ? {
                  brandName: shop.name || '美甲小铺',
                  brandNameEn: shop.nameEn || '',
                }
              : {}),
            services: picked.map((item) => ({
              ...toServiceItemVM(item),
              favorited: favoritedIds.has(item.id),
            })),
            staffs: staffs.items.slice(0, HOME_STAFF_LIMIT).map(toStaffVM),
            heroSlides: buildHeroSlides(
              shop?.images ?? [],
              services.items
                .slice(0, HERO_SLIDE_LIMIT)
                .map((item) => resolveServiceImage(item)),
            ),
          };
        },
      },
    );
  },

  onRetry() {
    void this.load();
  },

  /** 轮播换页 → 只更新圆点高亮（不重新拉数据） */
  onHeroChange(event: { detail: { current: number } }) {
    this.setData({ heroCurrent: event.detail.current });
  },

  goServices,
  goStaffs,
  goBookings,

  onQuickTap(event: WechatMiniprogram.TouchEvent) {
    const action = String(event.currentTarget.dataset.action);
    if (action === 'bookings') {
      goBookings();
      return;
    }
    if (action === 'member') {
      goMember();
      return;
    }
    if (action === 'book') {
      // 预约要先有款式，所以先进「选美甲师」；草稿为空时那一页会引导去款式库
      goStaffs();
      return;
    }
    goServices();
  },

  openService(event: WechatMiniprogram.TouchEvent) {
    goServiceDetail(Number(event.currentTarget.dataset.id));
  },

  onFavoriteTap(event: WechatMiniprogram.TouchEvent) {
    void this.toggleFavorite(Number(event.currentTarget.dataset.id));
  },

  /**
   * 卡片上收藏 / 取消收藏。
   *
   * 状态以**服务端返回的目标状态**为准（`{ favorited }`），不在本地取反 ——
   * 双击、慢网或并发点两次时，本地取反一定会与真实状态错位。
   * 未绑定手机号时先引导绑定（收藏是个人数据，服务端也会 400 + needBind）。
   */
  async toggleFavorite(serviceItemId: number) {
    if (!serviceItemId || this.data.favoritingId) return;
    const target = this.data.services.find((item) => item.id === serviceItemId);
    if (!target) return;
    if (
      !(await requireSession({
        needBind: true,
        reason: '收藏需要先绑定手机号',
      }))
    ) {
      return;
    }
    this.setData({ favoritingId: serviceItemId });
    try {
      const result = target.favorited
        ? await favoriteApi.remove(serviceItemId)
        : await favoriteApi.add(serviceItemId);
      this.setData({
        services: this.data.services.map((item) =>
          item.id === serviceItemId
            ? { ...item, favorited: result.favorited }
            : item,
        ),
        favoritingId: 0,
      });
      toast(result.favorited ? '已收藏，可在「我的收藏」查看' : '已取消收藏');
    } catch (error) {
      this.setData({ favoritingId: 0 });
      toast(isApiFailure(error) ? error.message : '操作失败，请稍后再试');
    }
  },

  onNavShop() {
    goShop();
  },

  onNavChat() {
    goNotices();
  },
});
