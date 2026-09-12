import { couponApi, type CouponStatusFilter, type CustomerCoupon } from '../../api/index';
import { requireSession } from '../../store/session';
import { getThemeTokens } from '../../theme/theme';
import { buildIcons, type IconName } from '../../utils/icons';
import { basePageData } from '../../utils/page';
import { isApiFailure } from '../../utils/request';
import { syncTabBar } from '../../utils/tabbar';

const PAGE_ICONS: IconName[] = ['coupon'];

const TABS: { key: CouponStatusFilter; label: string }[] = [
  { key: 'usable', label: '可使用' },
  { key: 'used', label: '已使用' },
  { key: 'expired', label: '已过期' },
];

interface CouponRow extends CustomerCoupon {
  /** 券名（模板名）；为空时给一句兜底，避免卡片标题空白 */
  nameText: string;
  /** 面额（元，两位小数字符串） */
  amountText: string;
  /** 门槛文案 */
  thresholdText: string;
  /** 有效期文案 */
  expireText: string;
  /** 是否可用于下单（只有 usable 才给「去使用」） */
  actionable: boolean;
}

/** 分 → 元（保留两位；券面额都是整数元，这里不引入额外口径） */
function fenToYuanText(fen: number): string {
  return (fen / 100).toFixed(2);
}

/**
 * 我的优惠券（docs/manicure-ui-batch4 第 5 屏）。
 *
 * 与后端口径对齐的三点：
 * 1. **状态由后端现算**（`usable` 但已过期的券，后端返回的就是 `expired`）——
 *    页面**不再自己比较时间**，否则两处口径迟早不一致；
 * 2. **筛选走服务端**（`status` 查询参数），不是本地过滤 —— 否则分页会错；
 * 3. **未绑定先引导**：券是个人权益，未绑定时 `requireSession` 带去登录页并说明原因。
 */
Page({
  data: {
    ...basePageData(),
    icons: buildIcons(PAGE_ICONS, '#2D221E'),
    tabs: TABS,
    activeTab: 'usable' as CouponStatusFilter,
    loading: true,
    errorText: '',
    guest: false,
    coupons: [] as CouponRow[],
  },

  onLoad() {
    void this.load();
  },

  onShow() {
    this.setData({
      ...basePageData(),
      icons: buildIcons(PAGE_ICONS, getThemeTokens().text),
    });
    syncTabBar(this);
  },

  async load() {
    // 未绑定不发请求：后端必然 401，显示成「加载失败」会误导
    if (!this.data.bound) {
      this.setData({ loading: false, guest: true, errorText: '', coupons: [] });
      return;
    }
    this.setData({ loading: true, guest: false, errorText: '' });
    try {
      const page = await couponApi.listMine(this.data.activeTab, 1, 50);
      this.setData({
        loading: false,
        coupons: page.items.map((item) => ({
          ...item,
          nameText: item.templateName ?? '优惠券',
          amountText: fenToYuanText(item.discountAmount),
          thresholdText:
            item.thresholdAmount > 0
              ? '满 ' + fenToYuanText(item.thresholdAmount) + ' 元可用'
              : '无门槛',
          expireText: item.expireAt
            ? '有效期至 ' + item.expireAt.slice(0, 10).replace(/-/g, '.')
            : '长期有效',
          actionable: item.status === 'usable',
        })),
      });
    } catch (error) {
      this.setData({
        loading: false,
        coupons: [],
        errorText: isApiFailure(error) ? error.message : '网络连接失败',
      });
    }
  },

  onTab(event: WechatMiniprogram.TouchEvent) {
    const key = String(event.currentTarget.dataset.key) as CouponStatusFilter;
    if (key === this.data.activeTab) return;
    // 切页签重新拉：筛选在服务端做，保证分页正确
    this.setData({ activeTab: key }, () => {
      void this.load();
    });
  },

  async onGuestLogin() {
    await requireSession({
      needBind: true,
      reason: '绑定手机号后查看优惠券',
    });
  },

  onUse() {
    // 券的使用发生在下单时（确认预约页选择），这里引导过去
    wx.switchTab({ url: '/pages/index/index' });
  },

  onRetry() {
    void this.load();
  },
});