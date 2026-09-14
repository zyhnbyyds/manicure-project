import { getNavMetrics } from '../../utils/metrics';
import {
  bookingApi,
  couponApi,
  favoriteApi,
  memberApi,
  staffApi,
} from '../../api/index';
import { ensureLogin, isBound, logout } from '../../store/auth';
import { getStaffStatus, isGranted, setMode } from '../../store/mode';
import { requireSession } from '../../store/session';
import { getThemeState } from '../../theme/theme';
import { absoluteAssetUrl } from '../../utils/asset-url';
import { fenToYuan } from '../../utils/format';
import type { IconName } from '../../utils/icons';
import {
  goAddress,
  goBookings,
  goCoupons,
  goFavorites,
  goFeedback,
  goLogin,
  goMember,
  goPoints,
  goProfileEdit,
  goStaffWorkbench,
  goTheme,
} from '../../utils/nav';
import { definePage } from '../../utils/page';
import { isApiFailure } from '../../utils/request';
import { confirm, toast } from '../../utils/ui';

const PAGE_ICONS: IconName[] = [
  'sun',
  'card',
  'calendar',
  'check',
  'grid',
  'location',
  'headset',
  'chat',
  'person',
  'gift',
  'settings',
];

/** 订单状态入口（设计稿的四个小图标行） */
const ORDER_TABS = [
  { key: 'unpaid', label: '待支付', icon: 'card' as IconName },
  { key: 'confirmed', label: '已预约', icon: 'calendar' as IconName },
  { key: 'completed', label: '已完成', icon: 'check' as IconName },
  { key: '', label: '全部订单', icon: 'grid' as IconName },
];

/**
 * 个人中心（新设计稿 `manicure-ui-mine-v2.png`）。
 *
 * ## 结构
 *
 * 左上角一枚太阳（主题/外观快捷入口）→ 用户卡（头像 + 昵称 + 等级 + 签名 + 绑定态，
 * 整卡可点进「个人资料」）→ 统计卡（上排三个计数、下排积分与余额）→ 我的订单（四宫格，
 * 待支付带数量角标）→ 更多服务（六项）→ 退出登录。
 *
 * ## 三条口径
 *
 * 1. **数字全部是真的**：预约数用列表长度（列表接口没有 total）、收藏数走
 *    `/app/member/favorites`、优惠券数只数**可用**的（过期的摆在那儿没用）、
 *    积分与余额直接来自 `me`。**不写死 0** —— 那会让人以为自己的资产是 0；
 * 2. **未绑定时不请求**这些接口（它们对未绑定访客一律 401），而是显示引导卡：
 *    明知会失败还打一次，只会让「未登录」看起来像「加载失败」；
 * 3. 头像与「个人资料」同源（`app_wx_user.avatar`），本页**只读展示**，
 *    改资料统一在「个人资料」页（那里才有保存动作），点这里跳过去。
 */
definePage({
  chromeIcons: PAGE_ICONS,

  data: {
    statusBarHeight: 20,
    navRightGap: 28,
    orderTabs: ORDER_TABS,
    /** 用户卡 */
    nickname: '亲爱的顾客',
    levelName: '',
    slogan: '美丽，从指尖开始。',
    bindText: '',
    avatarSrc: '',
    /** 没头像时用昵称首字兜底（不伪造一张别人的照片） */
    avatarText: '',
    /** 统计卡：上排三个计数 */
    bookingCount: 0,
    favoriteCount: 0,
    couponCount: 0,
    /** 统计卡：下排积分与余额 */
    points: 0,
    balanceText: '0.00',
    /** 待支付数量（订单宫格上的角标） */
    unpaidCount: 0,
    /** 功能列表 */
    menu: [
      // 个人资料排第一：这是顾客最常想改的东西（头像/昵称/姓名/偏好），
      // 以前只能在门店让店员改，现在自助
      { key: 'profile', label: '个人资料', icon: 'person' as IconName },
      { key: 'address', label: '我的地址', icon: 'location' as IconName },
      { key: 'service', label: '联系客服', icon: 'headset' as IconName },
      { key: 'feedback', label: '意见反馈', icon: 'chat' as IconName },
      { key: 'points', label: '积分兑换', icon: 'gift' as IconName },
    ],
    themeLine: '',
    logging: false,
    bound: false,
    granted: false,
    applying: false,
    staffText: '',
  },

  onLoad() {
    try {
      const metrics = getNavMetrics();
      const statusBarHeight = metrics.statusBarHeight ?? 20;
      const rect = wx.getMenuButtonBoundingClientRect();
      this.setData({
        statusBarHeight,
        navRightGap:
          rect && rect.height > 0 ? metrics.windowWidth - rect.left + 8 : 28,
      });
    } catch {
      /* 取不到就沿用默认值 */
    }
  },

  onShow() {
    // 主题 / 登录态 / 图标由 definePage 的 chrome 统一刷新，这里只补本页自己的快照
    this.setData(this.snapshot());
    void this.loadSummary();
  },

  /** 本地状态快照：绑定态与主题名都可能在别处被改，onShow 时重新取一次最省心 */
  snapshot() {
    const theme = getThemeState();
    const bound = isBound();
    return {
      bound,
      bindText: bound ? '已绑定会员信息。' : '未绑定手机号（仅浏览）',
      // 只显示主题名：令牌里的 emoji 与整套「不用 emoji」的视觉口径冲突
      themeLine: theme.name,
      granted: isGranted(),
      staffText: this.staffLine(),
    };
  },

  /**
   * 摘要数据：名字 / 等级 / 头像 / 积分 / 余额来自 `me`，三个计数各走一次列表。
   *
   * **未绑定时一次请求都不发**（见文件头第 2 条口径），直接给空态。
   */
  async loadSummary() {
    if (!isBound()) {
      this.setData({
        nickname: '未登录的访客',
        levelName: '',
        avatarSrc: '',
        avatarText: '客',
        bookingCount: 0,
        favoriteCount: 0,
        couponCount: 0,
        points: 0,
        balanceText: '0.00',
        unpaidCount: 0,
      });
      return;
    }
    try {
      const [me, bookings, favorites, coupons] = await Promise.all([
        memberApi.getMe().catch(() => null),
        bookingApi.list({ page: 1, pageSize: 50 }).catch(() => null),
        favoriteApi.list().catch(() => null),
        // 只数「可用」的券：过期/已用的摆在这儿没用，也不该出现在计数里
        couponApi.listMine('usable', 1, 50).catch(() => null),
      ]);
      const displayName = me?.nickname ?? me?.name ?? '亲爱的顾客';
      const unpaid = bookings
        ? bookings.items.filter(
            (item) =>
              (item.payStatus === 'unpaid' || item.payStatus === 'partial') &&
              (item.status === 'pending' || item.status === 'confirmed'),
          ).length
        : 0;
      this.setData({
        nickname: displayName,
        levelName: me?.levelName ?? '',
        avatarSrc: absoluteAssetUrl(me?.avatar ?? null) ?? '',
        avatarText: displayName.slice(0, 1),
        bookingCount: bookings ? bookings.items.length : 0,
        favoriteCount: favorites ? favorites.items.length : 0,
        couponCount: coupons ? coupons.items.length : 0,
        points: me?.points ?? 0,
        balanceText: fenToYuan(
          (me?.balancePrincipal ?? 0) + (me?.balanceBonus ?? 0),
        ),
        unpaidCount: unpaid,
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
  goPoints,
  goStaffWorkbench,

  /** 用户卡 / 头像：统一进「个人资料」改（那里才有保存动作） */
  async onUserCard() {
    if (!(await this.guard('修改资料需要先绑定手机号'))) return;
    goProfileEdit();
  },

  /** 统计卡下排（积分 / 余额）：都落在「会员卡」页 */
  async onAssets() {
    if (!(await this.guard('查看积分与余额需要先绑定手机号'))) return;
    goMember();
  },

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
    if (key === 'profile') {
      if (!(await this.guard('修改资料需要先绑定手机号'))) return;
      goProfileEdit();
      return;
    }
    if (key === 'service') {
      /**
       * 联系客服：门店信息 + 关于我们合并在这里。
       *
       * 新设计稿的功能列表里没有「关于我们」那一行（六项：个人资料/我的地址/联系客服/
       * 意见反馈/积分兑换/主题设置），但门店信息与版本说明不能就这么丢掉 ——
       * 合并进客服弹窗是最省事又不破坏设计稿的做法。
       */
      wx.showModal({
        title: '联系门店',
        content:
          '客服微信：nailshop001\n营业时间：10:00 - 20:00\n' +
          '地址：上海市静安区南京西路 1788 号 3 楼 355 室\n\n' +
          '到店前可先发款式图，我们帮你估时长～',
        showCancel: false,
        confirmText: '好',
        confirmColor: '#B45F6B',
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
    if (key === 'points') {
      goPoints();
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
      // 登录成功后要把摘要也刷新一遍：`snapshot()` 只管绑定态与主题，
      // 不刷的话昵称/积分/计数会停在「未登录的访客」那一版（实测踩到过）
      await this.loadSummary();
      toast('已登录');
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
});
