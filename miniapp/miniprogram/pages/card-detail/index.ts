import { memberApi } from '../../api/index';
import type { MemberCardDetail, MemberCardLog } from '../../api/types';
import { requireSession } from '../../store/session';
import type { IconName } from '../../utils/icons';
import { definePage } from '../../utils/page';
import { isApiFailure } from '../../utils/request';
import { toast } from '../../utils/ui';

const PAGE_ICONS: IconName[] = ['clock', 'card'];

/** 次卡状态 → 文案 */
const STATUS_TEXT: Record<string, string> = {
  active: '使用中',
  used_up: '已用完',
  expired: '已过期',
  refunded: '已退卡',
};

/** 每页拉多少条使用记录（与后端默认一致） */
const LOG_PAGE_SIZE = 20;

interface RecordVM {
  id: number;
  name: string;
  dateText: string;
  /** 美甲师名（撤销记录 / 档案已删时为空串，WXML 里据此不拼分隔符） */
  staffName: string;
  /** 核销 / 撤销 —— 撤销是「次数退回来了」，不能和核销混成同一种记录 */
  typeText: string;
  isRevert: boolean;
}

/**
 * 次卡详情（docs/manicure-ui-batch4 第 2 屏）。
 *
 * 入参 `?cardId=`，缺省时取第一张在用卡。
 *
 * ## 数据全部来自服务端
 *
 * - **剩余次数与可用性**用 `GET /app/member/cards/:id`（服务端算）：
 *   页面自己算 `totalTimes - usedTimes`，在「撤销过核销」的卡上会与门店对不上；
 *   不可用时还能拿到原因（过期 / 用完），顾客才知道下一步该做什么；
 * - **使用记录**用 `GET /app/member/cards/:id/logs`（倒序、可翻页），
 *   带项目名与美甲师名；撤销记录没有项目名 → 显示「—」，**不编一个名字**。
 *
 * ## 关于核销码（不伪造二维码）
 *
 * 设计稿画的是二维码 + 「每分钟自动刷新」。**这里没有画假二维码** ——
 * 假码扫出来是错的，比没有更糟。动态码必须由服务端签名（否则客户端可以离线造码），
 * 而门店当下的核销路径是「美甲师在工作台按卡号/会员找到次卡」，
 * 所以把**卡号**作为可核销凭据：大字展示 + 一键复制，并如实说明。
 * 要做真二维码，得后端先出带时效签名的短码接口 + 工作台扫码端（两件一起才有意义）。
 */
definePage({
  chromeIcons: PAGE_ICONS,

  data: {
    loading: true,
    errorText: '',
    // 未绑定手机号：不是错误，是「仅浏览」态
    guest: false,
    card: null as {
      id: number;
      cardNo: string;
      cardName: string;
      totalTimes: number;
      usedTimes: number;
      remainTimes: number;
      expireText: string;
      statusText: string;
      isActive: boolean;
      unusableReason: string;
      percent: number;
    } | null,
    records: [] as RecordVM[],
    /** 是否还有下一页记录 */
    hasMoreRecords: false,
    loadingMore: false,
  },

  cardId: 0,
  /** 已加载到第几页记录 */
  recordPage: 0,

  onLoad(query: Record<string, string | undefined>) {
    this.cardId = Number(query.cardId ?? 0);
    void this.load();
  },

  async load() {
    // 未绑定不发请求：次卡接口必然 401，把它显示成「加载失败」会让人以为系统坏了
    if (!this.data.bound) {
      this.setData({ loading: false, guest: true, errorText: '' });
      return;
    }
    this.setData({ loading: true, guest: false, errorText: '' });
    try {
      const target = await this.resolveCard();
      if (!target) {
        this.setData({ loading: false, errorText: '还没有次卡' });
        return;
      }
      const percent =
        target.totalTimes > 0
          ? Math.min(
              100,
              Math.round((target.usedTimes / target.totalTimes) * 100),
            )
          : 0;
      this.setData({
        loading: false,
        card: {
          id: target.id,
          cardNo: target.cardNo,
          cardName: target.cardName,
          totalTimes: target.totalTimes,
          usedTimes: target.usedTimes,
          remainTimes: target.remainingTimes,
          expireText: target.expireAt
            ? `有效期至 ${target.expireAt.slice(0, 10).replace(/-/g, '.')}`
            : '长期有效',
          statusText: STATUS_TEXT[target.status] ?? target.status,
          isActive: target.usable,
          unusableReason: target.unusableReason ?? '',
          percent,
        },
      });
      // 记录与卡面一起刷新：卡面说「已用 3 次」而记录少一条，顾客会以为记录丢了
      this.recordPage = 0;
      await this.loadRecords(true);
    } catch (error) {
      this.setData({
        loading: false,
        errorText: isApiFailure(error) ? error.message : '网络连接失败',
      });
    }
  },

  /**
   * 找到要展示的卡：带 `?cardId=` 直接用详情接口；没带就先拉列表挑一张（在用优先）。
   * 两条路径都由服务端出数，页面不做本地推算。
   */
  async resolveCard(): Promise<MemberCardDetail | null> {
    if (this.cardId) return memberApi.cardDetail(this.cardId);
    const page = await memberApi.listCards();
    const target =
      page.items.find((item) => item.status === 'active') ?? page.items[0];
    if (!target) return null;
    this.cardId = target.id;
    return memberApi.cardDetail(target.id);
  },

  async loadRecords(reset: boolean) {
    const card = this.data.card;
    if (!card) return;
    const page = reset ? 1 : this.recordPage + 1;
    if (!reset) this.setData({ loadingMore: true });
    try {
      const result = await memberApi.cardLogs(card.id, page, LOG_PAGE_SIZE);
      const mapped = result.items.map((item: MemberCardLog) =>
        toRecordVM(item),
      );
      this.recordPage = page;
      this.setData({
        records: reset ? mapped : [...this.data.records, ...mapped],
        // 返回条数少于页大小 = 没有下一页（列表接口没有 total，只能这么判断）
        hasMoreRecords: result.items.length === LOG_PAGE_SIZE,
        loadingMore: false,
      });
    } catch (error) {
      this.setData({ loadingMore: false });
      if (reset) toast(isApiFailure(error) ? error.message : '记录加载失败');
    }
  },

  onCodeTap() {
    const card = this.data.card;
    if (!card) return;
    if (!card.isActive) {
      toast(card.unusableReason || '这张卡当前不可核销');
      return;
    }
    // 复制卡号：美甲师在工作台按卡号核销，这是当下真实可用的路径
    wx.setClipboardData({
      data: card.cardNo,
      success: () => toast('卡号已复制，出示给美甲师即可'),
    });
  },

  async onMoreRecords() {
    if (this.data.loadingMore) return;
    await this.loadRecords(false);
  },

  async onGuestLogin() {
    await requireSession({ needBind: true, reason: '绑定手机号后查看次卡' });
  },

  onRetry() {
    void this.load();
  },
});

/** 记录 → 视图模型：项目/美甲师缺失显示「—」，不编名字 */
function toRecordVM(log: MemberCardLog): RecordVM {
  const isRevert = log.type === 'revert';
  return {
    id: log.id,
    name: log.serviceItemName ?? (isRevert ? '撤销核销' : '—'),
    dateText: formatDateTime(log.createdAt),
    staffName: log.staffName ?? '',
    typeText: isRevert ? '已撤销' : '已核销',
    isRevert,
  };
}

/** `2026-09-13T10:00:00.000Z` → `2026.09.13 18:00`（只做展示，时区口径在服务端） */
function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (value: number) => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}.${pad(date.getMonth() + 1)}.${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}
