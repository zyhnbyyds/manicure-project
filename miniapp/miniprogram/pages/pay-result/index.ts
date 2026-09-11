import { getThemeTokens } from '../../theme/theme';
import { fenToYuan } from '../../utils/format';
import { buildIcons, type IconName } from '../../utils/icons';
import { goBookings, goHome } from '../../utils/nav';
import { basePageData } from '../../utils/page';

const WHITE_ICONS: IconName[] = ['check', 'clock'];
const TEXT_ICONS: IconName[] = ['check'];

/**
 * 支付结果（docs/manicure-ui-batch2 第 1 屏）。
 *
 * 入参走 query（`status` / `bookingId` / `amount`）而不是内存草稿：
 * 支付结果是「已经发生的事实」，用参数表达更准确，也让该页可以直接自检。
 * `status` 取 `success | pending`（失败态跳回收银台重试，不单独留一页）。
 */
Page({
  data: {
    ...basePageData(),
    iconsWhite: buildIcons(WHITE_ICONS, '#FFFFFF'),
    iconsText: buildIcons(TEXT_ICONS, '#B45F6B'),
    status: 'success' as 'success' | 'pending',
    title: '支付成功',
    subtitle: '定金已支付，预约已确认',
    amountText: '',
    /** 两张提示卡（设计稿里是「订单提示」「温馨提示」） */
    orderTip: '',
    warmTip: '到店前如需改期，请提前 2 小时联系门店，避免产生扣费。',
  },

  onLoad(query: Record<string, string | undefined>) {
    const status = query.status === 'pending' ? 'pending' : 'success';
    const amount = Number(query.amount ?? 0);
    const bookingNo = query.bookingNo ?? '';

    this.setData({
      status,
      title: status === 'success' ? '支付成功' : '等待支付结果',
      subtitle:
        status === 'success' ? '定金已支付，预约已确认' : '支付结果确认中，请稍后查看订单',
      amountText: amount > 0 ? fenToYuan(amount) : '',
      orderTip:
        status === 'success'
          ? `${bookingNo ? `订单号 ${bookingNo}\n` : ''}已支付 ${fenToYuan(amount)} 元，剩余尾款到店结算。`
          : '若已付款但状态未更新，稍后下拉刷新「我的预约」即可。',
    });
  },

  onShow() {
    const tokens = getThemeTokens();
    this.setData({
      ...basePageData(),
      iconsText: buildIcons(TEXT_ICONS, tokens.primary),
    });
  },

  goOrders() {
    goBookings();
  },

  onDone() {
    // 「完成」回首页：从结果页返回收银台没有意义（钱已经付了）
    goHome();
  },
});
