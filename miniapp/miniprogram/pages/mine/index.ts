import { isMockEnabled } from '../../config';
import { staffApi } from '../../api/index';
import { ensureLogin, isBound, logout } from '../../store/auth';
import { getStaffStatus, isGranted, setMode } from '../../store/mode';
import { getThemeState } from '../../theme/theme';
import { goBookings, goMember, goStaffWorkbench, goTheme } from '../../utils/nav';
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
    granted: false,
    applying: false,
    staffText: '',
  },

  onShow() {
    this.setData({ ...basePageData(), ...this.snapshot() });
    syncTabBar(this);
  },

  /** 本地状态快照：绑定态与主题名都可能在别处被改，onShow 时重新取一次最省心 */
  snapshot() {
    const theme = getThemeState();
    const bound = isBound();
    return {
      bound,
      bindText: bound ? '已绑定会员信息' : '未绑定手机号（仅浏览）',
      themeLine: `${theme.name} ${theme.emoji}`,
      granted: isGranted(),
      staffText: this.staffLine(),
    };
  },

  /**
   * 工作台入口的说明文案。
   *
   * 返回空串 = **不显示这一块**：对绝大多数顾客来说「美甲师工作台」是无关信息，
   * 摆在那儿只会让人困惑。只有已经申请过（pending / active / rejected）的人才看得到。
   */
  staffLine(): string {
    const status = getStaffStatus();
    if (status === 'active') return '已开通，可切换到工作台模式';
    if (status === 'pending') return '已提交申请，等店长确认后就能用啦';
    if (status === 'rejected') return '申请被驳回了，可以重新提交一次';
    return '';
  },

  goBookings,
  goMember,
  goTheme,
  goStaffWorkbench,

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

  /** 切到工作台模式：TabBar 会整套换成「工作台 / 我的预约 / 我的」 */
  onEnterWorkbench() {
    setMode('staff');
    goStaffWorkbench();
  },

  /**
   * 申请开通工作台。
   *
   * 服务端只认「当前 app 身份 + 已绑定的手机号」，请求体里不带任何身份字段 ——
   * 手机号命中在职美甲师档案也只是置 `pending`，**不会自动开通**（必须店长后台确认，
   * 否则等于凭手机号提权）。所以这里成功之后 UI 仍然停在「等确认」。
   */
  async onApplyStaff() {
    if (this.data.applying) return;
    this.setData({ applying: true });
    try {
      await staffApi.apply();
      this.setData({ ...this.snapshot(), applying: false });
      toast('申请已提交，等店长确认～', 'success');
    } catch (error) {
      this.setData({ applying: false });
      toast(isApiFailure(error) ? error.message : '申请失败，请稍后再试');
    }
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
