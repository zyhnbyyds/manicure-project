import { memberApi } from '../../api/index';
import { getThemeTokens } from '../../theme/theme';
import { buildIcons, type IconName } from '../../utils/icons';
import { basePageData } from '../../utils/page';
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

/**
 * 次卡详情（docs/manicure-ui-batch4 第 2 屏）。
 *
 * 入参 `?cardId=`，缺省时取第一张在用卡。
 *
 * **核销码的处理（重要）**：设计稿画的是二维码 + 「每分钟自动刷新」。
 * 我没有伪造一个假二维码 —— 假码扫出来是错的，比没有更糟。
 * 这里用虚线框展示**卡号**作为可核销凭据，并注明核销码应由服务端生成。
 * 正式方案二选一：
 * 1. 后端加 `GET /app/member/cards/:id/qrcode`，返回带时效签名的短码（推荐：
 *    动态码必须服务端签，否则客户端可离线造码）；
 * 2. 后端返回一次性 `ticket`，小程序端用 canvas 画码。
 */
Page({
  data: {
    ...basePageData(),
    icons: buildIcons(PAGE_ICONS, '#2D221E'),
    loading: true,
    errorText: '',
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
      percent: number;
    } | null,
    /** 使用记录：app 域没有该接口，先给空态 */
    records: [] as { id: number; dateText: string; name: string }[],
  },

  cardId: 0,

  onLoad(query: Record<string, string | undefined>) {
    this.cardId = Number(query.cardId ?? 0);
    this.load();
  },

  onShow() {
    this.setData({
      ...basePageData(),
      icons: buildIcons(PAGE_ICONS, getThemeTokens().text),
    });
  },

  async load() {
    this.setData({ loading: true, errorText: '' });
    try {
      const page = await memberApi.listCards();
      const target =
        page.items.find((item) => item.id === this.cardId) ??
        page.items.find((item) => item.status === 'active') ??
        page.items[0];
      if (!target) {
        this.setData({ loading: false, errorText: '还没有次卡' });
        return;
      }
      const remain = Math.max(0, target.totalTimes - target.usedTimes);
      const percent =
        target.totalTimes > 0
          ? Math.min(100, Math.round((target.usedTimes / target.totalTimes) * 100))
          : 0;
      this.setData({
        loading: false,
        card: {
          id: target.id,
          cardNo: target.cardNo,
          cardName: target.cardName,
          totalTimes: target.totalTimes,
          usedTimes: target.usedTimes,
          remainTimes: remain,
          expireText: target.expireAt
            ? `有效期至 ${target.expireAt.slice(0, 10).replace(/-/g, '.')}`
            : '长期有效',
          statusText: STATUS_TEXT[target.status] ?? target.status,
          isActive: target.status === 'active',
          percent,
        },
      });
    } catch (error) {
      this.setData({
        loading: false,
        errorText: isApiFailure(error) ? error.message : '网络连接失败',
      });
    }
  },

  onCodeTap() {
    const card = this.data.card;
    if (!card) return;
    if (!card.isActive) {
      toast('这张卡当前不可核销');
      return;
    }
    // 复制卡号：美甲师在后台可以按卡号核销，这是当下真实可用的路径
    wx.setClipboardData({
      data: card.cardNo,
      success: () => toast('卡号已复制，出示给美甲师即可', 'success'),
    });
  },

  onMoreRecords() {
    toast('使用记录接口正在接入');
  },

  onRetry() {
    this.load();
  },
});
