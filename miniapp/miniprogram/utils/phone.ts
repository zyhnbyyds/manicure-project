/**
 * 顾客手机号：脱敏展示 + 拨号。
 *
 * 口径（D11）：**列表里只有脱敏值**（`138****0000`），真号在真的要拨号时才
 * `GET /app/staff/bookings/:id/phone` 取一次。所以这里拨的不是列表里那串星号，
 * 而是临时取回的真号 —— 直接把 `138****0000` 喂给 `wx.makePhoneCall` 是拨不通的。
 *
 * 为什么要绕这一下：截图、日志、抓包都拿不到批量号码；只有真要打电话的那一瞬间
 * 才产生一次「本人单 → 真号」的请求，服务端也只在那一刻才有据可查。
 */
import { staffApi } from '../api/index';
import { toast } from './ui';

export interface DialTarget {
  bookingId: number;
  /** 列表里的脱敏值，用于失败时告诉用户是哪一单 */
  masked: string | null;
}

/**
 * 拨号：先按预约取真号，再拉起微信的原生拨号确认框。
 *
 * 取号失败（403 / 404 / 网络）一律**只提示、不弹原生框**——
 * 没拿到真号就弹拨号框，用户会看到一个空号码或上一次的残留，比不弹更糟。
 */
export async function dialCustomer(target: DialTarget): Promise<void> {
  if (!target.masked) {
    toast('这位顾客没有留电话');
    return;
  }
  try {
    const result = await staffApi.getBookingPhone(target.bookingId);
    if (!result.phone) {
      toast('这位顾客没有留电话');
      return;
    }
    wx.makePhoneCall({
      phoneNumber: result.phone,
      fail: () => {
        // 用户自己取消也会走 fail，不打扰
      },
    });
  } catch {
    toast('暂时取不到联系方式，请稍后再试');
  }
}
