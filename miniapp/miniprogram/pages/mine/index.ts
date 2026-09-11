import { isMockEnabled } from '../../config';
import { ensureLogin, isBound, logout } from '../../store/auth';
import { getThemeState } from '../../theme/theme';
import { goBookings, goMember, goTheme } from '../../utils/nav';
import { basePageData } from '../../utils/page';
import { isApiFailure } from '../../utils/request';
import { syncTabBar } from '../../utils/tabbar';
import { confirm, toast } from '../../utils/ui';

Page({
  data: {
    ...basePageData(),
    bound: false,
    bindText: '',
    themeLine: '',
    logging: false,
  },

  onShow() {
    this.setData({ ...basePageData(), ...this.snapshot() });
    syncTabBar(this, 2);
  },

  /** 本地状态快照：绑定态与主题名都可能在别处被改，onShow 时重新取一次最省心 */
  snapshot() {
    const theme = getThemeState();
    const bound = isBound();
    return {
      bound,
      bindText: bound ? '已绑定会员信息' : '未绑定手机号（仅浏览）',
      themeLine: `${theme.name} ${theme.emoji}`,
    };
  },

  goBookings,
  goMember,
  goTheme,

  async onLogin() {
    if (this.data.logging) return;
    this.setData({ logging: true });
    try {
      await ensureLogin();
      this.setData(this.snapshot());
      toast('已登录', 'success');
    } catch (error) {
      toast(isApiFailure(error) ? error.message : '登录失败，请稍后再试');
    } finally {
      this.setData({ logging: false });
    }
  },

  async onLogout() {
    const agreed = await confirm({
      title: '退出登录',
      content: '退出后需要重新进入小程序才会静默登录，确定吗？',
      confirmText: '退出',
    });
    if (!agreed) return;
    logout();
    this.setData(this.snapshot());
    toast('已退出');
  },

  onAbout() {
    const mockLine = isMockEnabled()
      ? '\n\n当前展示的是演示数据：后端尚未配置小程序凭据，登录接口按设计返回「小程序端未启用」。'
      : '';
    wx.showModal({
      title: '关于美甲小铺',
      content: `到店预约 · 会员储值 · 次卡 · 积分\n有问题可直接联系门店～${mockLine}`,
      showCancel: false,
      confirmText: '知道啦',
      confirmColor: '#FF8BA7',
    });
  },
});
