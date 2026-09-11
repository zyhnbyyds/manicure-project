import { getThemeTokens } from '../../theme/theme';
import { buildIcons, type IconName } from '../../utils/icons';
import { basePageData } from '../../utils/page';
import { toast } from '../../utils/ui';

const PAGE_ICONS: IconName[] = ['coupon'];

/** 状态页签（设计稿三档） */
const TABS = [
  { key: 'usable', label: '可使用' },
  { key: 'used', label: '已使用' },
  { key: 'expired', label: '已过期' },
];

/**
 * 我的优惠券（docs/manicure-ui-batch4 第 5 屏）。
 *
 * **整个功能在数据模型里不存在**：`biz_*` 里没有任何 coupon / voucher 表，
 * 后端也没有发放、领取、核销、与订单绑定的任何逻辑。
 *
 * 所以这页只还原设计稿的**骨架**（三个状态页签、空态、底部使用规则），
 * **不塞假券** —— 假券会让顾客以为有优惠可用，到了收银台却核销不了，比空着糟得多。
 *
 * 补这个功能需要（都在后端，且要注意与算价的关系）：
 * 1. 表：`biz_coupon_template`（模板：门槛/面额/有效期/适用范围）+ `biz_customer_coupon`
 *    （持有：customer_id + template_id + status + used_booking_id + 唯一约束防重复核销）；
 * 2. 接口：发放（活动/后台）、`GET /app/coupons`、核销（必须与下单**同事务**并把
 *    `used_booking_id` 条件更新，否则会出现「一券多用」）；
 * 3. 算价：券的抵扣要进 §5.7 的算价链路，且**与积分/次卡/等级折扣的叠加规则要先定死**。
 * 目前本页与「确认预约」里的券入口都按「不可用」如实呈现。
 */
Page({
  data: {
    ...basePageData(),
    icons: buildIcons(PAGE_ICONS, '#2D221E'),
    tabs: TABS,
    activeTab: 'usable',
    /** 券列表：模型不存在，恒为空 */
    coupons: [] as unknown[],
  },

  onShow() {
    this.setData({
      ...basePageData(),
      icons: buildIcons(PAGE_ICONS, getThemeTokens().text),
    });
  },

  onTab(event: WechatMiniprogram.TouchEvent) {
    const key = String(event.currentTarget.dataset.key);
    if (key === this.data.activeTab) return;
    this.setData({ activeTab: key });
    if (this.data.coupons.length === 0) return;
    toast('券列表待接口接入后可用');
  },

  onUse() {
    toast('优惠券功能开发中');
  },
});
