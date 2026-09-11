import { memberApi } from '../../api/index';
import { bindPhone, isBound } from '../../store/auth';
import { basePageData } from '../../utils/page';
import { toMemberMeVM, type MemberMeVM } from '../../utils/present';
import { isApiFailure } from '../../utils/request';
import { hideLoading, showLoading, toast } from '../../utils/ui';

interface PhoneNumberEventDetail {
  code?: string;
}

interface PhoneNumberEvent {
  detail: PhoneNumberEventDetail;
}

/**
 * 会员中心。
 *
 * 口径要点（都来自后端契约，不自行加工）：
 * - 余额**本金与赠送分开显示**（赠送不可退，必须让顾客看得见差别）；
 * - 折扣率是千分比整数（`950` → `9.5折`），无等级时后端回 `1000` → 显示「无折扣」；
 * - 未绑定手机号时后端返回 401 + `needBind`，这里引导到手机号授权，
 *   **不把「未绑定」显示成「加载失败」**——它是正常的仅浏览状态。
 */
Page({
  data: {
    ...basePageData(),
    loading: true,
    errorText: '',
    needBind: false,
    me: null as MemberMeVM | null,
  },

  onShow() {
    const bound = isBound();
    this.setData({ ...basePageData(), needBind: !bound });
    if (bound) {
      this.load();
    } else {
      this.setData({ loading: false, me: null });
    }
  },

  async load() {
    this.setData({ loading: true, errorText: '' });
    try {
      const response = await memberApi.getMe();
      this.setData({ loading: false, me: toMemberMeVM(response), needBind: false });
    } catch (error) {
      if (isApiFailure(error) && error.needBind) {
        this.setData({ loading: false, needBind: true, me: null });
        return;
      }
      this.setData({
        loading: false,
        errorText: isApiFailure(error) ? error.message : '加载失败，请稍后再试',
      });
    }
  },

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
      this.load();
    } catch (error) {
      hideLoading();
      toast(isApiFailure(error) ? error.message : '绑定失败，请稍后再试');
    }
  },
});
