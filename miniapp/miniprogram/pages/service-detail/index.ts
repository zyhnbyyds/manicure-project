import { getNavMetrics } from '../../utils/metrics';
import { catalogApi } from '../../api/index';
import { setDraftItems } from '../../store/draft';
import { getThemeTokens } from '../../theme/theme';
import { buildIcons, type IconName } from '../../utils/icons';
import { goBack, goStaffs } from '../../utils/nav';
import { basePageData } from '../../utils/page';
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

Page({
  data: {
    ...basePageData(),
    statusBarHeight: 20,
    /** 右侧要给微信胶囊让位，否则分享按钮会被盖住（首页已踩过同一个坑） */
    navRightGap: 28,
    icons: buildIcons(PAGE_ICONS, '#2D221E'),
    iconsWhite: buildIcons(WHITE_ICONS, '#FFFFFF'),
    loading: true,
    errorText: '',
    item: null as ServiceItemVM | null,
    /** 推荐美甲师：app 域没有「款式→美甲师」映射，取第一位在职美甲师 */
    staff: null as StaffVM | null,
    suitableFor: SUITABLE_FOR,
    swatches: COLOR_SWATCHES,
    activeSwatch: 0,
    /** 图片张数：契约里只有单图，故为 1/1（保留设计稿的角标视觉） */
    photoCountText: '1/1',
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
    this.load();
  },

  onShow() {
    this.setData({
      ...basePageData(),
      icons: buildIcons(PAGE_ICONS, getThemeTokens().text),
    });
  },

  async load() {
    if (!this.serviceItemId) {
      this.setData({ loading: false, errorText: '没找到这个款式' });
      return;
    }
    this.setData({ loading: true, errorText: '' });
    try {
      // app 域没有「单个款式详情」接口（spec §9.7 只有列表），
      // 故拉列表按 id 取；项目量级在几十条，多一次列表请求可接受。
      const [page, staffs] = await Promise.all([
        catalogApi.listServiceItems(1, 100),
        catalogApi.listStaffs(),
      ]);
      const found = page.items.find((candidate) => candidate.id === this.serviceItemId);
      this.setData({
        loading: false,
        item: found ? toServiceItemVM(found) : null,
        staff: staffs.items.length > 0 ? toStaffVM(staffs.items[0]) : null,
        errorText: found ? '' : '这个款式可能已经下架了',
      });
    } catch (error) {
      this.setData({
        loading: false,
        errorText: isApiFailure(error) ? error.message : '网络连接失败',
      });
    }
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
    // 数据模型里没有「顾客↔款式」收藏表：保留设计稿入口，交互如实降级
    toast('收藏功能开发中');
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
    this.load();
  },
});
