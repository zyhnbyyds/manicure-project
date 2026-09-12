import { bookingApi } from '../../api/index';
import { fenToYuan } from '../../utils/format';
import type { IconName } from '../../utils/icons';
import { goBookings, goHome } from '../../utils/nav';
import { definePage } from '../../utils/page';

const WHITE_ICONS: IconName[] = ['check', 'clock'];
const TEXT_ICONS: IconName[] = ['check'];

/**
 * 支付结果（docs/manicure-ui-batch2 第 1 屏）。
 *
 * ## query 只用于**首屏渲染**，事实以服务端为准
 *
 * 入参走 query（`status` / `bookingId` / `amount`），但 **query 是可以被改的**：
 * 改一下 URL 就能凭空得到一个「支付成功、金额任意」的页面。所以进入本页后
 * **立刻用 `bookingId` 向服务端复核**（`GET /app/bookings/:id`），
 * 用返回的 `payStatus` / `paidAmount` 覆盖 query 的展示。
 *
 * 复核失败（网络问题）时**保留 query 的展示**，不把结果页变成错误页 ——
 * 服务端已经是事实来源，前端这一层只是「别把假话显示给用户」。
 *
 * `status` 取 `success | pending`（失败态跳回收银台重试，不单独留一页）。
 */
definePage({
  chromeIcons: TEXT_ICONS,
  whiteIcons: WHITE_ICONS,

  data: {
    status: 'success' as 'success' | 'pending',
    title: '支付成功',
    subtitle: '定金已支付，预约已确认',
    amountText: '',
    /** 两张提示卡（设计稿里是「订单提示」「温馨提示」） */
    orderTip: '',
    warmTip: '到店前如需改期，请提前 2 小时联系门店，避免产生扣费。',
  },

  async onLoad(query: Record<string, string | undefined>) {
    const bookingId = Number(query.bookingId ?? 0);
    // 先用 query 渲染，避免白屏
    this.render(
      query.status === 'pending' ? 'pending' : 'success',
      Number(query.amount ?? 0),
      query.bookingNo ?? '',
    );

    // 再用**服务端事实**纠正：payStatus 才是「钱到没到」的唯一依据
    if (!bookingId) return;
    try {
      const booking = await bookingApi.detail(bookingId);
      const paid = booking.payStatus === 'paid';
      this.render(
        paid ? 'success' : 'pending',
        paid ? booking.paidAmount : booking.dueAmount,
        booking.bookingNo,
      );
    } catch {
      /* 复核失败就保留首屏展示（不把结果页变成错误页） */
    }
  },

  /** 统一的渲染入口：状态与金额只从这里进 data，便于被服务端事实覆盖 */
  render(status: 'success' | 'pending', amount: number, bookingNo: string) {
    this.setData({
      status,
      title: status === 'success' ? '支付成功' : '等待支付结果',
      subtitle:
        status === 'success'
          ? '款项已到账，预约已确认'
          : '支付结果确认中，请稍后查看订单',
      amountText: amount > 0 ? fenToYuan(amount) : '',
      orderTip:
        status === 'success'
          ? `${bookingNo ? `订单号 ${bookingNo}\n` : ''}已支付 ${fenToYuan(amount)} 元，剩余尾款到店结算。`
          : '若已付款但状态未更新，稍后下拉刷新「我的预约」即可。',
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
