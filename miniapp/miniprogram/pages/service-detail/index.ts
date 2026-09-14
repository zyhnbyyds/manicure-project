import { getNavMetrics } from '../../utils/metrics';
import { catalogApi, favoriteApi } from '../../api/index';
import { setDraftItems } from '../../store/draft';
import { isBound } from '../../store/auth';
import { requireSession } from '../../store/session';
import { favoriteIcons, type IconName } from '../../utils/icons';
import { runLoad } from '../../utils/load';
import { goBack, goStaffs } from '../../utils/nav';
import { definePage } from '../../utils/page';
import {
  toServiceItemVM,
  toStaffVM,
  type ServiceItemVM,
  type StaffVM,
} from '../../utils/present';
import { isApiFailure } from '../../utils/request';
import { toast } from '../../utils/ui';

const PAGE_ICONS: IconName[] = ['back', 'share', 'heart', 'headset', 'chevron'];
const WHITE_ICONS: IconName[] = ['back', 'share'];

/**
 * 「适合人群」「颜色选择」在数据模型里**没有对应字段**：
 * `biz_service_item` 只有 名称/分类/时长/价格/图。
 * 按目标要求「视觉必须保留、数据可降级」，这里用**静态展示数据**还原设计稿，
 * 颜色可点选但只是本地视觉态（不落库），并在交互上如实说明。
 */
const SUITABLE_FOR = ['日常', '职场', '学生'];

const COLOR_SWATCHES = [
  { name: '透粉裸', hex: '#F2DCD5' },
  { name: '奶咖', hex: '#C99C8C' },
  { name: '豆沙', hex: '#B57A70' },
  { name: '玫瑰木', hex: '#A96A62' },
  { name: '米白', hex: '#EFE2D8' },
];

definePage({
  chromeIcons: PAGE_ICONS,
  /** 心形两态（实心 = 已收藏，描边 = 未收藏），颜色随主题令牌 */
  extra: () => favoriteIcons(),
  whiteIcons: WHITE_ICONS,

  data: {
    statusBarHeight: 20,
    /** 右侧要给微信胶囊让位，否则分享按钮会被盖住（首页已踩过同一个坑） */
    navRightGap: 28,
    loading: true,
    item: null as ServiceItemVM | null,
    /** 推荐美甲师：app 域没有「款式→美甲师」映射，取第一位在职美甲师 */
    staff: null as StaffVM | null,
    suitableFor: SUITABLE_FOR,
    swatches: COLOR_SWATCHES,
    activeSwatch: 0,
    /** 图片张数：契约里只有单图，故为 1/1（保留设计稿的角标视觉） */
    photoCountText: '1/1',
    /** 是否已收藏（进页面时按收藏列表回填，切换时以服务端返回为准） */
    favorited: false,
    /** 防抖：连点两次不会发出两个相反方向的请求 */
    favoriting: false,
  },

  serviceItemId: 0,

  onLoad(query: Record<string, string | undefined>) {
    this.serviceItemId = Number(query.id ?? 0);
    try {
      const metrics = getNavMetrics();
      const statusBarHeight = metrics.statusBarHeight ?? 20;
      const rect = wx.getMenuButtonBoundingClientRect();
      this.setData({
        statusBarHeight,
        navRightGap:
          rect && rect.height > 0 ? metrics.windowWidth - rect.left + 8 : 28,
      });
    } catch {
      /* 取不到就沿用默认值 */
    }
    void this.load();
  },

  async load() {
    if (!this.serviceItemId) {
      this.setData({ loading: false, errorText: '没找到这个款式' });
      return;
    }
    await runLoad(
      this,
      () =>
        Promise.all([
          // app 域没有「单个款式详情」接口（spec §9.7 只有列表），
          // 故拉列表按 id 取；项目量级在几十条，多一次列表请求可接受。
          catalogApi.listServiceItems(1, 100),
          catalogApi.listStaffs(),
          // 收藏态：**未绑定时不发**（接口会 400 + needBind，明知会失败还打一次
          // 只会让「未登录」看起来像「加载失败」）
          isBound()
            ? favoriteApi.list().catch(() => ({ items: [] }))
            : Promise.resolve({ items: [] }),
        ]),
      {
        merge: ([page, staffs, favorites]) => {
          const found = page.items.find(
            (candidate) => candidate.id === this.serviceItemId,
          );
          return {
            item: found ? toServiceItemVM(found) : null,
            staff: staffs.items.length > 0 ? toStaffVM(staffs.items[0]) : null,
            favorited: favorites.items.some(
              (favorite) => favorite.id === this.serviceItemId,
            ),
            // runLoad 成功时会先把 errorText 清空，这里的「下架」态覆盖它
            errorText: found ? '' : '这个款式可能已经下架了',
          };
        },
      },
    );
  },

  onBack() {
    goBack();
  },

  onShare() {
    // 小程序分享需用户主动触发按钮，这里先把入口占住，走系统分享面板
    toast('点右上角「···」可以分享给好友');
  },

  onMoreColors() {
    toast('更多色号以到店实物为准');
  },

  onPickSwatch(event: WechatMiniprogram.TouchEvent) {
    const index = Number(event.currentTarget.dataset.index);
    this.setData({ activeSwatch: index });
    toast(`已选「${COLOR_SWATCHES[index].name}」，到店可与美甲师确认`);
  },

  onFavorite() {
    void this.toggleFavorite();
  },

  /**
   * 收藏 / 取消收藏（先门禁、再切换）。
   *
   * 状态以**服务端返回的目标状态**为准（`{ favorited }`），不在本地取反 ——
   * 双击、慢网或并发点两次时，本地取反一定会与真实状态错位。
   * 未绑定手机号时先引导绑定（收藏是个人数据，服务端也会 400 + needBind）。
   */
  async toggleFavorite() {
    const { item, favorited } = this.data;
    if (!item || this.data.favoriting) return;
    if (
      !(await requireSession({
        needBind: true,
        reason: '收藏需要先绑定手机号',
      }))
    ) {
      return;
    }
    this.setData({ favoriting: true });
    try {
      const result = favorited
        ? await favoriteApi.remove(item.id)
        : await favoriteApi.add(item.id);
      this.setData({ favorited: result.favorited, favoriting: false });
      toast(result.favorited ? '已收藏，可在「我的收藏」查看' : '已取消收藏');
    } catch (error) {
      this.setData({ favoriting: false });
      toast(isApiFailure(error) ? error.message : '操作失败，请稍后再试');
    }
  },

  onService() {
    wx.showModal({
      title: '联系门店',
      content: '客服微信：nailshop001\n到店前可先发款式图，我们帮你估时长～',
      showCancel: false,
      confirmText: '好',
    });
  },

  onStaffTap() {
    goStaffs();
  },

  goBook() {
    const { item } = this.data;
    if (!item) return;
    setDraftItems([
      {
        id: item.id,
        name: item.name,
        category: item.category,
        durationMinutes: item.durationMinutes,
        price: item.price,
        description: item.description,
        image: item.image,
      },
    ]);
    goStaffs();
  },

  onRetry() {
    void this.load();
  },
});
