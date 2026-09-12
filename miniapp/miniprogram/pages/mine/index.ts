import { bookingApi, memberApi, staffApi } from '../../api/index';
import { ensureLogin, isBound, logout } from '../../store/auth';
import { getStaffStatus, isGranted, setMode } from '../../store/mode';
import { requireSession } from '../../store/session';
import { getThemeState, getThemeTokens } from '../../theme/theme';
import { buildIcons, type IconName } from '../../utils/icons';
import {
  goAddress,
  goBookings,
  goCoupons,
  goFavorites,
  goFeedback,
  goLogin,
  goMember,
  goStaffWorkbench,
  goTheme,
} from '../../utils/nav';
import { basePageData } from '../../utils/page';
import { isApiFailure } from '../../utils/request';
import { syncTabBar } from '../../utils/tabbar';
import { confirm, toast } from '../../utils/ui';

const PAGE_ICONS: IconName[] = [
  'settings',
  'card',
  'calendar',
  'check',
  'grid',
  'location',
  'headset',
  'chat',
  'person',
];

/** 订单状态入口（设计稿的四个小图标行） */
const ORDER_TABS = [
  { key: 'unpaid', label: '待支付', icon: 'card' as IconName },
  { key: 'confirmed', label: '已预约', icon: 'calendar' as IconName },
  { key: 'completed', label: '已完成', icon: 'check' as IconName },
  { key: '', label: '全部订单', icon: 'grid' as IconName },
];

Page({
  data: {
    ...basePageData(),
    statusBarHeight: 20,
    navRightGap: 28,
    icons: buildIcons(PAGE_ICONS, '#2D221E'),
    orderTabs: ORDER_TABS,
    /** 用户区 */
    nickname: '亲爱的顾客',
    levelName: '',
    slogan: '美丽，从指尖开始',
    /** 三列数据 */
    bookingCount: 0,
    favoriteCount: 0,
    couponCount: 0,
    /** 功能列表 */
    menu: [
      { key: 'address', label: '我的地址', icon: 'location' as IconName },
      { key: 'service', label: '联系客服', icon: 'headset' as IconName },
      { key: 'feedback', label: '意见反馈', icon: 'chat' as IconName },
      { key: 'about', label: '关于我们', icon: 'person' as IconName },
    ],
    bound: false,
    bindText: '',
    themeLine: '',
    logging: false,
    granted: false,
    applying: false,
    staffText: '',
  },

  onLoad() {
    try {
      const info = wx.getSystemInfoSync();
      const statusBarHeight = info.statusBarHeight ?? 20;
      const rect = wx.getMenuButtonBoundingClientRect();
      this.setData({
        statusBarHeight,
        navRightGap: rect && rect.height > 0 ? info.windowWidth - rect.left + 8 : 28,
      });
    } catch {
      /* 取不到就沿用默认值 */
    }
  },

  onShow() {
    this.setData({
      ...basePageData(),
      icons: buildIcons(PAGE_ICONS, getThemeTokens().text),
      ...this.snapshot(),
    });
    syncTabBar(this);
    this.loadSummary();
  },

  /** 本地状态快照：绑定态与主题名都可能在别处被改，onShow 时重新取一次最省心 */
  snapshot() {
    const theme = getThemeState();
    const bound = isBound();
    return {
      bound,
      bindText: bound ? '已绑定会员信息' : '未绑定手机号（仅浏览）',
      // 只显示主题名：令牌里的 emoji 与整套「不用 emoji」的视觉口径冲突
      themeLine: theme.name,
      granted: isGranted(),
      staffText: this.staffLine(),
    };
  },

  /**
   * 名字与等级来自会员接口；预约数用一次列表请求统计（列表接口没有 total）。
   *
   * **未绑定时不请求**：这两个接口对未绑定访客都返回 401（后端 §8.3 的既定行为），
   * 明知会 401 还打一次只会让 console 里堆满红色、并让「未登录」看起来像「加载失败」。
   */
  async loadSummary() {
    if (!isBound()) {
      this.setData({
        nickname: '未登录的访客',
        levelName: '',
        bookingCount: 0,
        favoriteCount: 0,
        couponCount: 0,
      });
      return;
    }
    try {
      const [me, bookings] = await Promise.all([
        memberApi.getMe().catch(() => null),
        bookingApi.list({ page: 1, pageSize: 50 }).catch(() => null),
      ]);
      this.setData({
        nickname: me?.name ?? '亲爱的顾客',
        levelName: me?.levelName ?? '',
        bookingCount: bookings ? bookings.items.length : 0,
        // 收藏与优惠券在数据模型里还不存在：显示 0，点击如实提示
        favoriteCount: 0,
        couponCount: 0,
      });
    } catch {
      /* 摘要失败不影响其它入口 */
    }
  },

  /** 需要身份的动作统一走这道门：不满足时会引导登录并返回 false */
  async guard(reason: string): Promise<boolean> {
    return requireSession({ needBind: true, reason });
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

  /** 订单状态入口：点进「我的预约」并带上对应筛选 */
  async onOrderTab(event: WechatMiniprogram.TouchEvent) {
    if (!(await this.guard('查看预约需要先绑定手机号'))) return;
    const key = String(event.currentTarget.dataset.key);
    goBookings();
    if (key) toast('已为你打开预约列表');
  },

  async onStatTap(event: WechatMiniprogram.TouchEvent) {
    const key = String(event.currentTarget.dataset.key);
    if (key === 'booking') {
      if (!(await this.guard('查看预约需要先绑定手机号'))) return;
      goBookings();
      return;
    }
    if (key === 'favorite') {
      if (!(await this.guard('收藏需要先绑定手机号'))) return;
      goFavorites();
      return;
    }
    if (!(await this.guard('优惠券需要先绑定手机号'))) return;
    goCoupons();
  },

  async onMenuTap(event: WechatMiniprogram.TouchEvent) {
    const key = String(event.currentTarget.dataset.key);
    if (key === 'service') {
      wx.showModal({
        title: '联系门店',
        content: '客服微信：nailshop001\n营业时间 10:00 - 20:00',
        showCancel: false,
        confirmText: '好',
      });
      return;
    }
    if (key === 'address') {
      if (!(await this.guard('管理地址需要先绑定手机号'))) return;
      goAddress();
      return;
    }
    if (key === 'feedback') {
      goFeedback();
      return;
    }
    if (key === 'about') {
      this.onAbout();
      return;
    }
    toast('该功能开发中');
  },

  onSettings() {
    goTheme();
  },

  /** 未登录 / 未绑定时的统一引导（两种说法不同：没登录 vs 登录了但没绑手机号） */
  onGuestAction() {
    goLogin({
      reason: isBound()
        ? '绑定手机号，解锁会员权益'
        : '登录后即可查看余额、积分与次卡',
    });
  },

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
    wx.showModal({
      title: '关于美甲小铺',
      content: `到店预约 · 会员储值 · 次卡 · 积分\n有问题可直接联系门店～`,
      showCancel: false,
      confirmText: '知道啦',
      confirmColor: '#B45F6B',
    });
  },
});
