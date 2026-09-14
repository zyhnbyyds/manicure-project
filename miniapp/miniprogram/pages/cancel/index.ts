import { bookingApi } from '../../api/index';
import type { Booking } from '../../api/types';
import {
  fenToYuan,
  formatDateTimeLabel,
  formatTimeRange,
} from '../../utils/format';
import type { IconName } from '../../utils/icons';
import { goBack, goBookings } from '../../utils/nav';
import { definePage } from '../../utils/page';
import { isApiFailure } from '../../utils/request';
import { hideLoading, showLoading, toast } from '../../utils/ui';

const PAGE_ICONS: IconName[] = ['clock', 'check', 'headset'];

/**
 * 取消规则（原则性表述）。
 *
 * 命中门店政策时，上面还会显示 `GET /app/bookings/:id/refund-preview` 给的**真实金额**
 * （服务端按 `RefundPort.preview` 的同一套判责规则算）——
 * 页面自己写「扣 30%」这类数字只会给出错误的金额预期，比不写更糟。
 * 只有拿不到预览（没有支付、接口失败）时才退回这几条原则性说明。
 */
const RULES = [
  {
    icon: 'clock' as IconName,
    title: '提前取消',
    text: '越早取消，越不影响门店安排，通常可全额退还定金',
  },
  {
    icon: 'check' as IconName,
    title: '临近取消',
    text: '临近开始时间取消，门店可能按规则扣除部分定金',
  },
  {
    icon: 'headset' as IconName,
    title: '特殊情况',
    text: '临时有事请联系门店，我们会尽力帮你协调改期',
  },
];

definePage({
  chromeIcons: PAGE_ICONS,

  data: {
    rules: RULES,
    loading: true,
    errorText: '',
    booking: null as Booking | null,
    itemNames: '',
    whenText: '',
    paidText: '0.00',
    dueText: '0.00',
    submitting: false,
    /** 费用预览（服务端按门店判责规则算）；拿不到时 previewOk = false，退回原则性说明 */
    previewOk: false,
    preview: {
      policyName: '',
      paidText: '0.00',
      suggestText: '0.00',
      deductText: '0.00',
      deductAmount: 0,
    },
  },

  bookingId: 0,

  onLoad(query: Record<string, string | undefined>) {
    this.bookingId = Number(query.bookingId ?? 0);
    this.load();
    void this.loadPreview();
  },

  /**
   * 拉费用预览。
   *
   * 失败**不报错、不挡流程**：没有支付（纯到店付）时预览就是 0，接口也可能不可用；
   * 这时退回「取消说明」里的原则性表述，顾客照样能取消。
   */
  async loadPreview() {
    if (!this.bookingId) return;
    try {
      const preview = await bookingApi.refundPreview(this.bookingId);
      this.setData({
        previewOk: true,
        preview: {
          policyName: preview.policyName ?? '',
          paidText: fenToYuan(preview.paidAmount),
          suggestText: fenToYuan(preview.suggestAmount),
          deductText: fenToYuan(preview.deductAmount),
          deductAmount: preview.deductAmount,
        },
      });
    } catch {
      this.setData({ previewOk: false });
    }
  },

  async load() {
    if (!this.bookingId) {
      this.setData({ loading: false, errorText: '没找到这笔订单' });
      return;
    }
    this.setData({ loading: true, errorText: '' });
    try {
      const page = await bookingApi.list({ page: 1, pageSize: 50 });
      const found = page.items.find((item) => item.id === this.bookingId);
      if (!found) {
        this.setData({ loading: false, errorText: '没找到这笔订单' });
        return;
      }
      this.setData({
        loading: false,
        booking: found,
        itemNames: found.items.map((item) => item.name).join(' · '),
        whenText: `${formatDateTimeLabel(found.startAt).replace(/\s\d{2}:\d{2}$/, '')} ${formatTimeRange(found.startAt, found.endAt)}`,
        paidText: fenToYuan(found.paidAmount),
        dueText: fenToYuan(found.dueAmount),
      });
    } catch (error) {
      this.setData({
        loading: false,
        errorText: isApiFailure(error) ? error.message : '网络连接失败',
      });
    }
  },

  /** 「我再想想」：直接返回，不做任何变更 */
  onThinkAgain() {
    goBack();
  },

  async onConfirm() {
    if (this.data.submitting) return;
    if (!this.data.booking) return;
    this.setData({ submitting: true });
    showLoading('正在取消');
    try {
      await bookingApi.cancel(this.bookingId, '顾客在小程序内取消');
      hideLoading();
      wx.showModal({
        title: '已取消预约',
        content: '退款金额由门店按判责规则处理，可在「我的预约」查看进度。',
        showCancel: false,
        confirmText: '好',
        confirmColor: '#B45F6B',
        complete: () => goBookings(),
      });
    } catch (error) {
      hideLoading();
      toast(isApiFailure(error) ? error.message : '取消失败，请稍后再试');
    } finally {
      this.setData({ submitting: false });
    }
  },
});
