import { SHOP } from '../../config';
import { bindPhone, ensureLogin, isBound } from '../../store/auth';
import { getThemeTokens } from '../../theme/theme';
import { buildIcons, type IconName } from '../../utils/icons';
import { goBack, goMember, goServices } from '../../utils/nav';
import { basePageData } from '../../utils/page';
import { isApiFailure } from '../../utils/request';
import { hideLoading, showLoading, toast } from '../../utils/ui';

const PAGE_ICONS: IconName[] = ['calendar', 'grid', 'card'];

interface PhoneNumberEventDetail {
  code?: string;
}
interface PhoneNumberEvent {
  detail: PhoneNumberEventDetail;
}

/**
 * 登录页（docs/manicure-ui-batch5 第 1 屏）。
 *
 * **这页是真功能，不是骨架**：
 * - 「微信一键登录」→ `ensureLogin()`（`wx.login` → `POST /app/auth/login` 换 app token）
 * - 「手机号登录」→ `<button open-type="getPhoneNumber">` → `POST /app/auth/phone`
 *   绑定/创建顾客档案（后端已是真实现）
 *
 * 两个动作都依赖后端凭据：未配置 `WX_MINIAPP_APPID/SECRET` 时登录接口按设计返回
 * 503「小程序端未启用」，这里如实把这句话展示给用户，而不是伪装成功。
 */
Page({
  data: {
    ...basePageData(),
    statusBarHeight: 20,
    icons: buildIcons(PAGE_ICONS, '#2D221E'),
    shop: SHOP,
    entries: [
      { key: 'booking', label: '预约美甲', icon: 'calendar' as IconName },
      { key: 'styles', label: '款式库', icon: 'grid' as IconName },
      { key: 'member', label: '会员卡', icon: 'card' as IconName },
    ],
    logging: false,
  },

  onLoad() {
    try {
      const info = wx.getSystemInfoSync();
      this.setData({ statusBarHeight: info.statusBarHeight ?? 20 });
    } catch {
      /* 取不到就沿用默认值 */
    }
  },

  onShow() {
    this.setData({
      ...basePageData(),
      icons: buildIcons(PAGE_ICONS, getThemeTokens().text),
    });
  },

  /** 微信一键登录：静默换 token，成功后返回上一页 */
  async onWechatLogin() {
    if (this.data.logging) return;
    this.setData({ logging: true });
    showLoading('登录中');
    try {
      await ensureLogin();
      hideLoading();
      toast('登录成功', 'success');
      setTimeout(() => goBack(), 600);
    } catch (error) {
      hideLoading();
      toast(isApiFailure(error) ? error.message : '登录失败，请稍后再试');
    } finally {
      this.setData({ logging: false });
    }
  },

  /** 手机号登录：授权手机号 → 绑定/创建顾客档案 */
  async onGetPhone(event: PhoneNumberEvent) {
    const code = event.detail.code;
    if (!code) {
      toast('需要你同意授权手机号哦');
      return;
    }
    if (this.data.logging) return;
    this.setData({ logging: true });
    showLoading('绑定中');
    try {
      // 绑定前必须先有 app token（后端 /app/auth/phone 要 app 身份）
      await ensureLogin();
      await bindPhone(code);
      hideLoading();
      toast('已绑定手机号', 'success');
      setTimeout(() => goBack(), 600);
    } catch (error) {
      hideLoading();
      toast(isApiFailure(error) ? error.message : '绑定失败，请稍后再试');
    } finally {
      this.setData({ logging: false });
    }
  },

  onEntry(event: WechatMiniprogram.TouchEvent) {
    const key = String(event.currentTarget.dataset.key);
    if (key === 'member') {
      goMember();
      return;
    }
    goServices();
  },

  /**
   * 用户协议 / 隐私政策。
   *
   * ⚠️ 这里用的是**占位文本**：正式的隐私政策需要门店主体信息与手机号用途声明，
   * 由店主确认后替换（提审前必须落地，否则会被驳回）。
   */
  onAgreement(event: WechatMiniprogram.TouchEvent) {
    const kind = String(event.currentTarget.dataset.kind);
    wx.showModal({
      title: kind === 'privacy' ? '隐私政策' : '用户协议',
      content:
        kind === 'privacy'
          ? '本小程序仅收集为你提供服务所必需的信息（微信标识、手机号），用于预约、会员与到店联系，不会用于其它用途。\n\n正式文本待门店主体确认后替换。'
          : '使用本小程序即表示你同意按门店规则进行预约与消费。\n\n正式文本待门店主体确认后替换。',
      showCancel: false,
      confirmText: '知道了',
      confirmColor: '#B45F6B',
    });
  },

  onSkip() {
    // 未登录也能浏览款式：直接回上一页
    if (isBound()) {
      goBack();
      return;
    }
    goServices();
  },
});
