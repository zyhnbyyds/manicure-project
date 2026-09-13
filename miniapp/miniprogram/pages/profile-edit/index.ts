import { catalogApi, memberApi } from '../../api/index';
import type { Gender } from '../../api/types';
import { isBound } from '../../store/auth';
import { requireSession } from '../../store/session';
import { absoluteAssetUrl } from '../../utils/asset-url';
import { fenToYuan } from '../../utils/format';
import type { IconName } from '../../utils/icons';
import { isApiFailure } from '../../utils/request';
import { definePage } from '../../utils/page';
import { hideLoading, showLoading, toast } from '../../utils/ui';
import { chooseAndUploadImage } from '../../utils/upload';

const PAGE_ICONS: IconName[] = ['person', 'card', 'calendar'];

/**
 * 性别单选项：**取值与后端 `biz_customer.gender` 逐字一致**（`unknown/male/female`），
 * 中文只作标签 —— 前端不许自己造第三套枚举值。
 */
const GENDER_OPTIONS: { value: Gender; label: string }[] = [
  { value: 'female', label: '女' },
  { value: 'male', label: '男' },
  { value: 'unknown', label: '保密' },
];

/** 生日选择范围：1930 到今天，以及出生年份的上限（今天） */
const MIN_BIRTHDAY = '1930-01-01';

/** 等级序位超出预设档位时停在最高档（与 `app.wxss` 的 `.tier-3` 对齐） */
const TIER_CLASSES = ['tier-0', 'tier-1', 'tier-2', 'tier-3'];

/**
 * 个人资料（新设计稿）。
 *
 * ## 三类字段，三条写路径（别混）
 *
 * | 界面上的样子 | 落库位置 | 说明 |
 * | --- | --- | --- |
 * | 昵称 / 头像 | `app_wx_user` | 「APP 里怎么称呼我」，改它**不该动门店档案的姓名** |
 * | 姓名 / 性别 / 生日 / 美甲偏好 | `biz_customer` | 门店档案，写入口与后台共用 `CustomerPort` |
 * | 手机号 | 不在这里 | 改号等于换绑，必须走 `/app/auth/phone` 的授权 + 留痕链路 |
 *
 * 后端 `POST /app/member/profile` 一次收齐并返回**更新后的整份会员信息**，
 * 所以保存后直接 `setData` 即可，不用再打一次 `me()`。
 *
 * ## 两处与设计稿不同，都是刻意的
 *
 * 1. **没有「微信号」那一行**：我们持有的是 `openid`/`unionid`，那不是微信号；
 *    微信也不提供接口读取用户微信号。凭 openid 编一个 `wxid_xxx` 展示 = 伪造身份信息，
 *    抄设计稿不能抄到这一步。真实且有用的标识（会员号）已经在会员卡条上；
 * 2. **美甲偏好的选项来自门店真实款式分类**（`biz_service_item.category` 去重），
 *    而不是设计稿里那个写死的「选择喜欢的风格」下拉值 —— 门店改分类，选项跟着变。
 *
 * ## 升级进度
 *
 * 「距 X 还差 ¥N」的差额**由服务端算**（`me.nextLevel.remaining`）：
 * 升级规则是门店侧口径，前端自己减就等于把规则复制了一份。
 */
definePage({
  chromeIcons: PAGE_ICONS,

  data: {
    // 首屏状态机：loading 渲染骨架、errorText 渲染错误态（与其它页一致）
    loading: true,
    loaded: false,
    errorText: '',
    needBind: false,

    /** 头像 */
    avatarSrc: '',
    /** 没有头像时用昵称首字兜底（不伪造一张别人的照片） */
    avatarText: '',
    /** 昵称（大字 + 铅笔） */
    nickname: '',
    /** 会员卡条 */
    levelName: '普通会员',
    tierClass: 'tier-0',
    memberNo: '',
    totalSpentText: '0.00',
    /** 升级进度：0~100；没有下一级时 hasNext = false（不显示进度条） */
    hasNext: false,
    progressPercent: 0,
    nextText: '',

    /** 基本信息 */
    name: '',
    gender: 'unknown' as Gender,
    birthday: '',
    preference: '',
    preferenceOptions: [] as string[],
    genderOptions: GENDER_OPTIONS,
    minBirthday: MIN_BIRTHDAY,
    maxBirthday: '',
    /** 生日 picker 的 index（选项就是「未选择」+ 已选日期） */
    birthdayText: '请选择生日',

    /** 账号与安全 */
    phoneMasked: '',
    bound: false,

    saving: false,
    uploadingAvatar: false,
    /** 改过才让存（避免无意义请求） */
    dirty: false,
  },

  /** 记住原始值（判断「真的改了没有」）+ 待提交的头像地址 */
  original: {
    nickname: '',
    name: '',
    gender: 'unknown' as Gender,
    birthday: '',
    preference: '',
    avatar: '',
  },
  /** 刚上传、还没随表单提交的头像地址（保存在实例上，不进 data） */
  pendingAvatar: '',

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
      const [me, items] = await Promise.all([
        memberApi.getMe(),
        // 偏好选项来自门店真实款式分类（去重）；取不到就只留「已选值」一项
        catalogApi
          .listServiceItems(1, 100)
          .catch(() => ({ items: [], page: 1, pageSize: 100 })),
      ]);
      const categories = [
        ...new Set(
          items.items
            .map((item) => item.category ?? '')
            .filter((name) => name !== ''),
        ),
      ];
      const avatarSrc = absoluteAssetUrl(me.avatar) ?? '';
      const nickname = me.nickname ?? '';
      this.original = {
        nickname,
        name: me.name,
        gender: me.gender,
        birthday: me.birthday ?? '',
        preference: me.preference ?? '',
        avatar: me.avatar ?? '',
      };
      this.setData({
        loading: false,
        loaded: true,
        needBind: false,
        avatarSrc,
        avatarText: (nickname || me.name).slice(0, 1),
        nickname,
        levelName: me.levelName ?? '普通会员',
        tierClass:
          TIER_CLASSES[Math.min(me.levelRank, TIER_CLASSES.length - 1)] ??
          'tier-0',
        memberNo: me.memberNo ? `NO. ${me.memberNo}` : '待入会后生成',
        totalSpentText: fenToYuan(me.totalSpent),
        hasNext: me.nextLevel !== null,
        progressPercent: me.nextLevel
          ? Math.min(
              100,
              me.nextLevel.upgradeAmount > 0
                ? Math.round(
                    (me.totalSpent / me.nextLevel.upgradeAmount) * 100,
                  )
                : 100,
            )
          : 100,
        nextText: me.nextLevel
          ? `距${me.nextLevel.name}还差${fenToYuan(me.nextLevel.remaining)}元`
          : '已是最高等级',
        name: me.name,
        gender: me.gender,
        birthday: me.birthday ?? '',
        birthdayText: me.birthday ? me.birthday : '请选择生日',
        preference: me.preference ?? '',
        preferenceOptions: [
          ...new Set([...(me.preference ? [me.preference] : []), ...categories]),
        ],
        phoneMasked: maskPhone(me.phone),
        bound: Boolean(me.phone),
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

  async onGuestLogin() {
    await requireSession({ needBind: true, reason: '修改资料需要先绑定手机号' });
    if (isBound()) void this.load();
  },

  /* ------------------------------ 头像与昵称 ------------------------------ */

  /** 换头像：选图即刻上传，保存时把地址一并提交（与反馈/评价同一套上传组件） */
  async onAvatar() {
    if (this.data.uploadingAvatar) return;
    this.setData({ uploadingAvatar: true });
    const uploaded = await chooseAndUploadImage(1);
    if (uploaded) {
      // 地址先记在实例上，等点「保存」再随表单提交（避免只传了图却没保存资料）
      this.pendingAvatar = uploaded.path;
      this.setData({ avatarSrc: uploaded.src, dirty: true });
      toast('头像已上传，记得点保存');
    }
    this.setData({ uploadingAvatar: false });
  },

  onNicknameInput(event: WechatMiniprogram.Input) {
    this.setData({ nickname: event.detail.value, dirty: true });
  },

  /** 昵称旁的铅笔：把焦点交给昵称输入框（设计稿画的就是这个动作） */
  onEditNickname() {
    toast('在下面「基本信息 → 昵称」里改就行');
  },

  /* ------------------------------ 基本信息 ------------------------------ */

  onNameInput(event: WechatMiniprogram.Input) {
    this.setData({ name: event.detail.value, dirty: true });
  },

  onGender(event: WechatMiniprogram.TouchEvent) {
    const value = String(event.currentTarget.dataset.value) as Gender;
    if (value === this.data.gender) return;
    this.setData({ gender: value, dirty: true });
  },

  onBirthday(event: WechatMiniprogram.PickerChange) {
    const value = String(event.detail.value);
    this.setData({ birthday: value, birthdayText: value, dirty: true });
  },

  /** 偏好：选项就是门店真实款式分类（清空走旁边的「清空」） */
  onPreference(event: WechatMiniprogram.PickerChange) {
    const index = Number(event.detail.value);
    const value = this.data.preferenceOptions[index] ?? '';
    if (!value) return;
    this.setData({ preference: value, dirty: true });
  },

  onBirthdayClear() {
    if (!this.data.birthday) return;
    this.setData({ birthday: '', birthdayText: '请选择生日', dirty: true });
  },

  /** 清空偏好（提交时传 null，不是空串） */
  onPreferenceClear() {
    if (!this.data.preference) return;
    this.setData({ preference: '', dirty: true });
  },

  /* ------------------------------ 账号与安全 ------------------------------ */

  /**
   * 换手机号：走授权链路，不在本页直接改。
   *
   * 手机号是绑定锚点，后端还要按新号匹配/恢复顾客档案并写绑定留痕 ——
   * 所以这里只解释去哪换，不给一个改不动的输入框。
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

  /* ------------------------------ 保存 ------------------------------ */

  async onSave() {
    if (this.data.saving) return;
    const name = this.data.name.trim();
    const nickname = this.data.nickname.trim();
    if (!name) {
      toast('姓名不能为空');
      return;
    }
    if (name.length > 30) {
      toast('姓名最多 30 个字');
      return;
    }
    if (nickname.length > 50) {
      toast('昵称最多 50 个字');
      return;
    }
    if (!this.data.dirty) {
      toast('还没有改动哦');
      return;
    }

    const pending = this.pendingAvatar;
    const birthday = this.data.birthday === '' ? null : this.data.birthday;
    const preference = this.data.preference === '' ? null : this.data.preference;

    this.setData({ saving: true });
    showLoading('保存中');
    try {
      const me = await memberApi.updateProfile({
        name,
        nickname: nickname === '' ? null : nickname,
        ...(pending ? { avatar: pending } : {}),
        gender: this.data.gender,
        birthday,
        preference,
      });
      hideLoading();
      const avatarSrc = absoluteAssetUrl(me.avatar) ?? '';
      this.pendingAvatar = '';
      this.original = {
        nickname: me.nickname ?? '',
        name: me.name,
        gender: me.gender,
        birthday: me.birthday ?? '',
        preference: me.preference ?? '',
        avatar: me.avatar ?? '',
      };
      this.setData({
        saving: false,
        dirty: false,
        nickname: me.nickname ?? '',
        name: me.name,
        gender: me.gender,
        birthday: me.birthday ?? '',
        birthdayText: me.birthday ?? '请选择生日',
        preference: me.preference ?? '',
        avatarSrc,
        avatarText: ((me.nickname ?? '') || me.name).slice(0, 1),
      });
      toast('资料已更新');
    } catch (error) {
      hideLoading();
      this.setData({ saving: false });
      toast(isApiFailure(error) ? error.message : '保存失败，请稍后再试');
    }
  },
});

/** `13800000001` → `138****0001`（详情页只用于展示，不是脱敏存储） */
function maskPhone(phone: string | null): string {
  if (!phone || phone.length < 7) return phone ?? '';
  return `${phone.slice(0, 3)}****${phone.slice(-4)}`;
}
