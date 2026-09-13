import { memberApi } from '../../api/index';
import type { Gender } from '../../api/types';
import { isBound } from '../../store/auth';
import { requireSession } from '../../store/session';
import type { IconName } from '../../utils/icons';
import { isApiFailure } from '../../utils/request';
import { definePage } from '../../utils/page';
import { hideLoading, showLoading, toast } from '../../utils/ui';

const PAGE_ICONS: IconName[] = ['person'];

/**
 * 性别单选项：**取值与后端 `biz_customer.gender` 逐字一致**（`unknown/male/female`），
 * 中文只作为标签 —— 前端不许自己造第三套枚举值。
 */
const GENDER_OPTIONS: { value: Gender; label: string }[] = [
  { value: 'female', label: '女' },
  { value: 'male', label: '男' },
  { value: 'unknown', label: '保密' },
];

/** 生日选择范围：从 1930 到今天（顾客几乎不可能更早生） */
const MIN_BIRTHDAY = '1930-01-01';

/**
 * 个人资料（`POST /app/member/profile`）。
 *
 * ## 为什么只有三项
 *
 * 可改的**只有姓名 / 性别 / 生日**，这是后端 schema 的白名单（`.strict()`，传别的一律 400）：
 * - **手机号**不在这里 —— 它是绑定锚点，换号等于换绑，必须走「授权 → 换手机号 → 同事务留痕」
 *   那条链路（`POST /app/auth/phone`）。页面上把手机号显示成只读一项，并说明去哪换；
 * - 等级 / 积分 / 余额 / 会员次卡只能由门店的账务链路改，这里连展示都不放。
 *
 * ## 提交后的状态
 *
 * 接口返回**更新后的整份会员信息**，所以提交成功直接拿它回填，不用再打一次 `getMe`
 * （少一次往返，也避免「保存后又显示旧值」的中间态）。
 */
definePage({
  chromeIcons: PAGE_ICONS,

  data: {
    // 首屏状态机：loading 渲染骨架、errorText 渲染错误态（与其它页一致）
    loading: true,
    loaded: false,
    errorText: '',
    needBind: false,

    name: '',
    gender: 'unknown' as Gender,
    birthday: '',
    phone: '',
    memberNo: '',
    genderOptions: GENDER_OPTIONS,
    minBirthday: MIN_BIRTHDAY,
    /** 生日上限 = 今天（`picker mode="date"` 的 end） */
    maxBirthday: '',
    saving: false,
    /** 当前是否已经改过（没改过就不让点「保存」，避免无意义请求） */
    dirty: false,
  },

  onLoad() {
    const now = new Date();
    this.setData({
      maxBirthday: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`,
    });
    if (!isBound()) {
      this.setData({ loading: false, needBind: true });
      return;
    }
    void this.load();
  },

  async load() {
    this.setData({ loading: true, errorText: '' });
    try {
      const me = await memberApi.getMe();
      this.setData({
        loading: false,
        loaded: true,
        needBind: false,
        name: me.name,
        gender: me.gender,
        birthday: me.birthday ?? '',
        phone: me.phone ?? '',
        memberNo: me.memberNo ?? '待入会',
        dirty: false,
      });
    } catch (error) {
      if (isApiFailure(error) && error.needBind) {
        this.setData({ loading: false, needBind: true, loaded: false });
        return;
      }
      this.setData({
        loading: false,
        errorText: isApiFailure(error) ? error.message : '网络连接失败',
      });
    }
  },

  onRetry() {
    void this.load();
  },

  /** 未绑定时点「去绑定」：统一走会话门面（会带原因跳登录页） */
  async onGuestLogin() {
    await requireSession({ needBind: true, reason: '修改资料需要先绑定手机号' });
    if (isBound()) void this.load();
  },

  onNameInput(event: WechatMiniprogram.Input) {
    this.setData({ name: event.detail.value, dirty: true });
  },

  onGender(event: WechatMiniprogram.TouchEvent) {
    const value = String(event.currentTarget.dataset.value) as Gender;
    if (value === this.data.gender) return;
    this.setData({ gender: value, dirty: true });
  },

  onBirthday(event: WechatMiniprogram.PickerChange) {
    this.setData({ birthday: String(event.detail.value), dirty: true });
  },

  /** 清空生日（后端允许传 null） */
  onBirthdayClear() {
    if (!this.data.birthday) return;
    this.setData({ birthday: '', dirty: true });
  },

  /**
   * 换手机号：走授权链路，不在本页直接改。
   *
   * 这里是**提示**而不是表单 —— 顾客换号必须重新过 `getPhoneNumber` 授权，
   * 后端还要按新号匹配/恢复顾客档案并写绑定留痕。
   */
  onChangePhone() {
    wx.showModal({
      title: '更换手机号',
      content:
        '手机号是账号的唯一凭据（预约、会员、券都跟着它走），需要重新授权一次。\n去「会员卡」页点「手机号登录 / 换绑」即可。',
      showCancel: false,
      confirmText: '知道了',
      confirmColor: '#B45F6B',
    });
  },

  async onSave() {
    if (this.data.saving) return;
    const name = this.data.name.trim();
    if (!name) {
      toast('姓名不能为空');
      return;
    }
    if (name.length > 30) {
      toast('姓名最多 30 个字');
      return;
    }
    if (!this.data.dirty) {
      toast('还没有改动哦');
      return;
    }
    this.setData({ saving: true });
    showLoading('保存中');
    try {
      // 只提交真正改过的字段：少传字段 = 少一次「误改」的机会
      const me = await memberApi.updateProfile({
        name,
        gender: this.data.gender,
        birthday: this.data.birthday ? this.data.birthday : null,
      });
      hideLoading();
      this.setData({
        saving: false,
        name: me.name,
        gender: me.gender,
        birthday: me.birthday ?? '',
        memberNo: me.memberNo ?? '待入会',
        dirty: false,
      });
      toast('资料已更新');
    } catch (error) {
      hideLoading();
      this.setData({ saving: false });
      toast(isApiFailure(error) ? error.message : '保存失败，请稍后再试');
    }
  },
});
