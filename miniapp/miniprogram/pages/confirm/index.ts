import { bookingApi } from '../../api/index';
import { ensureLogin, bindPhone, isBound } from '../../store/auth';
import {
  clearDraft,
  getDraftSnapshot,
  getDraftTotals,
  getDraftRemark,
  setDraftRemark,
} from '../../store/draft';
import {
  fenToYuan,
  formatDateTimeLabel,
  formatDuration,
  formatTimeRange,
} from '../../utils/format';
import { goBookings } from '../../utils/nav';
import { basePageData } from '../../utils/page';
import { staffEmoji } from '../../utils/present';
import { isApiFailure } from '../../utils/request';
import { hideLoading, showLoading, toast } from '../../utils/ui';

interface ConfirmItem {
  id: number;
  name: string;
  emoji: string;
  durationText: string;
  priceText: string;
}

/**
 * `bindgetphonenumber` 的事件体。
 *
 * 这里**不能**用 `WechatMiniprogram.ButtonGetPhoneNumber`：模板自带的 typings 把它标成了
 * `GeneralCallbackResult & Partial<GetWeRunDataSuccessCallbackResult>`（旧的 getWeRunData 形态），
 * 上面没有 `code`。而当前 `getPhoneNumber` 能力回调里带的是 `code`（服务端再换手机号），
 * 所以按真实契约自己声明一个窄类型。
 */
interface PhoneNumberEventDetail {
  code?: string;
  errMsg?: string;
}

interface PhoneNumberEvent {
  detail: PhoneNumberEventDetail;
}

/**
 * 确认预约。
 *
 * 价格口径（重要）：这里只展示**项目原价合计**。
 * 会员等级折扣、积分抵扣、改价都属于服务端算价（spec §5.7），
 * app 域也没有「算价预览」接口，所以客户端**不猜最终金额**，只如实说明结算方式。
 */
Page({
  data: {
    ...basePageData(),
    ready: false,
    items: [] as ConfirmItem[],
    staffName: '',
    staffEmoji: '',
    dateText: '',
    timeText: '',
    durationText: '',
    totalText: '0.00',
    remark: '',
    submitting: false,
    needBind: false,
  },

  onLoad() {
    const snapshot = getDraftSnapshot();
    if (!snapshot.staff || !snapshot.slot || snapshot.items.length === 0) {
      toast('预约信息不完整，请重新选择');
      setTimeout(() => wx.navigateBack(), 900);
      return;
    }
    const totals = getDraftTotals();
    this.setData({
      ready: true,
      items: snapshot.items.map((item) => ({
        id: item.id,
        name: item.name,
        emoji: '💅',
        durationText: formatDuration(item.durationMinutes),
        priceText: fenToYuan(item.price),
      })),
      staffName: snapshot.staff.nickname,
      staffEmoji: staffEmoji(snapshot.staff.id),
      dateText: formatDateTimeLabel(snapshot.slot.startAt).replace(/\s\d{2}:\d{2}$/, ''),
      timeText: formatTimeRange(snapshot.slot.startAt, snapshot.slot.endAt),
      durationText: formatDuration(totals.durationMinutes),
      totalText: fenToYuan(totals.originalPrice),
      remark: getDraftRemark(),
      needBind: !isBound(),
    });
  },

  onShow() {
    // 授权手机号后返回本页要立刻更新按钮状态
    this.setData({ ...basePageData(), needBind: !isBound() });
  },

  onRemarkInput(event: WechatMiniprogram.Input) {
    const value = event.detail.value;
    setDraftRemark(value);
    this.setData({ remark: value });
  },

  /** `<button open-type="getPhoneNumber">` 的回调 */
  async onGetPhone(event: PhoneNumberEvent) {
    const code = event.detail.code;
    if (!code) {
      toast('需要你同意授权手机号哦');
      return;
    }
    showLoading('绑定中');
    try {
      await bindPhone(code);
      hideLoading();
      this.setData({ needBind: false });
      toast('绑定成功', 'success');
    } catch (error) {
      hideLoading();
      toast(isApiFailure(error) ? error.message : '绑定失败，请稍后再试');
    }
  },

  async onSubmit() {
    if (this.data.submitting) return;
    if (!isBound()) {
      toast('请先授权手机号');
      return;
    }
    const snapshot = getDraftSnapshot();
    if (!snapshot.staff || !snapshot.slot) return;

    this.setData({ submitting: true });
    showLoading('提交中');
    try {
      await ensureLogin();
      const booking = await bookingApi.create({
        staffId: snapshot.staff.id,
        startAt: snapshot.slot.startAt,
        serviceItemIds: snapshot.items.map((item) => item.id),
        remark: snapshot.remark ? snapshot.remark : null,
      });
      hideLoading();
      clearDraft();
      wx.showModal({
        title: '预约提交成功 🎉',
        content: `单号 ${booking.bookingNo}\n我们会尽快与美甲师确认，请留意通知`,
        showCancel: false,
        confirmText: '看我的预约',
        confirmColor: '#FF8BA7',
        complete: () => goBookings(),
      });
    } catch (error) {
      hideLoading();
      if (isApiFailure(error) && error.needBind) {
        this.setData({ needBind: true });
        toast('请先授权手机号');
      } else {
        toast(isApiFailure(error) ? error.message : '提交失败，请稍后再试');
      }
    } finally {
      this.setData({ submitting: false });
    }
  },
});
