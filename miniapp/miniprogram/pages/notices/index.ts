import { noticeApi } from '../../api/index';
import type { Notice } from '../../api/types';
import { isBound } from '../../store/auth';
import { requireSession } from '../../store/session';
import type { IconName } from '../../utils/icons';
import { goBookingDetail } from '../../utils/nav';
import { isApiFailure } from '../../utils/request';
import { definePage } from '../../utils/page';
import { toast } from '../../utils/ui';

const PAGE_ICONS: IconName[] = ['calendar', 'gift', 'star', 'chat', 'check'];

/**
 * 分类 → 图标。分类名来自**数据**（模板的 `category`），所以这里是一张
 * 「认识哪个用哪个、不认识给默认图标」的映射表，而不是一份必须与门店一致的清单。
 */
const CATEGORY_ICONS: Record<string, IconName> = {
  预约提醒: 'calendar',
  账户通知: 'gift',
  活动优惠: 'star',
  系统通知: 'chat',
};

type NoticeVM = Notice & {
  timeText: string;
  icon: IconName;
  unread: boolean;
};

/**
 * 消息中心（docs/manicure-ui-batch5 第 2 屏）。
 *
 * ## 页签来自数据，不硬编码
 *
 * 设计稿画了五个固定页签（全部/系统通知/预约提醒/活动优惠/客服消息），但分类是
 * **门店自己在通知模板上填的**（`sys_notice_template.category`）。前端硬编码五个名字
 * 的话，门店把「活动优惠」改成「会员日」就点不出任何东西。所以页签 = 「全部」+
 * 接口返回的 `categories`（该顾客收件箱里真实出现过的分类）。
 *
 * ## 已读的两种时机
 *
 * - **点开某条** → 立刻标已读（返回剩余未读数，本地同步更新红点）；
 * - **「全部已读」** → 只清**当前页签**下的未读 —— 带着筛选点「全部已读」，
 *   顺手把别的分类也清掉是意料之外的行为。
 */
definePage({
  chromeIcons: PAGE_ICONS,

  data: {
    loading: true,
    errorText: '',
    needBind: false,
    /** 「全部」+ 数据里真实出现过的分类 */
    tabs: ['全部'] as string[],
    activeTab: '全部',
    notices: [] as NoticeVM[],
    unread: 0,
  },

  onLoad() {
    if (!isBound()) {
      this.setData({ loading: false, needBind: true });
      return;
    }
    void this.load();
  },

  /** 从订单详情回来要看到已读状态 */
  onShow() {
    if (this.data.needBind) return;
    if (!isBound()) {
      this.setData({ needBind: true, loading: false });
      return;
    }
    if (!this.data.loading) void this.load();
  },

  async load() {
    this.setData({ errorText: '' });
    try {
      const result = await noticeApi.list({
        category: this.data.activeTab === '全部' ? undefined : this.data.activeTab,
        page: 1,
        pageSize: 50,
      });
      const tabs = ['全部', ...result.categories];
      this.setData({
        loading: false,
        needBind: false,
        // 选中的分类若已消失（那条消息被删），回落「全部」
        activeTab: tabs.includes(this.data.activeTab) ? this.data.activeTab : '全部',
        tabs,
        unread: result.unread,
        notices: result.items.map(toNoticeVM),
      });
    } catch (error) {
      if (isApiFailure(error) && error.needBind) {
        this.setData({ loading: false, needBind: true });
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
    await requireSession({ needBind: true, reason: '查看消息需要先绑定手机号' });
    if (isBound()) void this.load();
  },

  onTab(event: WechatMiniprogram.TouchEvent) {
    const name = String(event.currentTarget.dataset.name);
    if (name === this.data.activeTab) return;
    // 分类筛选下推服务端（分页才正确），并回骨架屏
    this.setData({ activeTab: name, loading: true, notices: [] });
    void this.load();
  },

  /**
   * 点开一条消息：标已读 + 有预约就跳订单详情。
   *
   * 已读是**乐观更新**（本地先改，请求失败再回滚并提示）—— 消息列表点一下要立刻有反馈，
   * 等服务端回来才变色会让人以为没点到。
   */
  async onOpen(event: WechatMiniprogram.TouchEvent) {
    const id = Number(event.currentTarget.dataset.id);
    const target = this.data.notices.find((item) => item.id === id);
    if (!target) return;

    if (target.unread) {
      this.setData({
        notices: this.data.notices.map((item) =>
          item.id === id ? { ...item, unread: false } : item,
        ),
        unread: Math.max(0, this.data.unread - 1),
      });
      try {
        const result = await noticeApi.markRead(id);
        this.setData({ unread: result.unread });
      } catch {
        // 回滚：宁可显示成未读，也不要「看起来已读其实没标上」
        this.setData({
          notices: this.data.notices.map((item) =>
            item.id === id ? { ...item, unread: true } : item,
          ),
          unread: this.data.unread + 1,
        });
        toast('标记已读失败，请稍后再试');
      }
    }

    if (target.bookingId) goBookingDetail(target.bookingId);
  },

  async onReadAll() {
    if (this.data.unread === 0) {
      toast('暂时没有未读消息');
      return;
    }
    try {
      const result = await noticeApi.markAllRead(
        this.data.activeTab === '全部' ? undefined : this.data.activeTab,
      );
      this.setData({
        notices: this.data.notices.map((item) => ({ ...item, unread: false })),
        unread: result.unread,
      });
      toast(`已读 ${result.updated} 条`);
    } catch (error) {
      toast(isApiFailure(error) ? error.message : '操作失败，请稍后再试');
    }
  },
});

function toNoticeVM(notice: Notice): NoticeVM {
  return {
    ...notice,
    timeText: formatTime(notice.createdAt),
    icon: CATEGORY_ICONS[notice.category ?? ''] ?? 'chat',
    unread: notice.readAt === null,
  };
}

/** `2026-09-13T10:00:00.000Z` → `09-13 18:00`（今天的信息更友好） */
function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (value: number) => String(value).padStart(2, '0');
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return sameDay ? `今天 ${time}` : `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}`;
}
