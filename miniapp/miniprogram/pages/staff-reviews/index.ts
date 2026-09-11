/**
 * 我的评价（S5）。
 *
 * 只展示后端给的**已公开**评价 —— 被隐藏的评价（§20.1）后端就不返回，
 * 前端这里也不做任何「猜一下再补一条」的事。
 *
 * 评分没有时显示「暂无评分」而不是 0 分：0 分会让美甲师以为自己被打了 0 分，
 * 而事实只是「还没有人评价」，这两件事的含义完全不同（后端为此特意返回 `null`）。
 */
import { staffApi } from '../../api/index';
import { demoteToCustomer } from '../../store/mode';
import { getThemeTokens } from '../../theme/theme';
import { buildIcons, type IconName } from '../../utils/icons';
import { basePageData } from '../../utils/page';
import { isApiFailure } from '../../utils/request';
import { toast } from '../../utils/ui';

const PAGE_ICONS: IconName[] = ['star'];

interface ReviewRow {
  id: number;
  bookingNo: string;
  score: number;
  content: string;
  reply: string | null;
  dateText: string;
}

function toRow(item: {
  id: number;
  bookingNo: string | null;
  score: number;
  content: string | null;
  reply: string | null;
  createdAt: string;
}): ReviewRow {
  const score = Math.max(1, Math.min(5, Math.round(item.score)));
  return {
    id: item.id,
    bookingNo: item.bookingNo ?? '—',
    score,
    content: item.content ?? '（这位顾客只打了分，没写评价）',
    reply: item.reply,
    dateText: item.createdAt.slice(0, 10),
  };
}

Page({
  data: {
    ...basePageData(),
    /** 星级用图标画：原来的 ★☆ 是文本字符，属要清掉的残留（同 ♡ 那类） */
    iconsStarOn: buildIcons(PAGE_ICONS, getThemeTokens().primary, 24, true),
    iconsStarOff: buildIcons(PAGE_ICONS, getThemeTokens().border),
    starSlots: [1, 2, 3, 4, 5],
    loading: true,
    errorText: '',
    rows: [] as ReviewRow[],
    countText: '',
  },

  onShow() {
    this.setData({ ...basePageData() });
    void this.load();
  },

  async load() {
    this.setData({ loading: true, errorText: '' });
    try {
      const list = await staffApi.listReviews(1, 50);
      this.setData({
        loading: false,
        rows: list.items.map(toRow),
        countText: `共 ${list.items.length} 条`,
      });
    } catch (error) {
      if (isApiFailure(error) && error.statusCode === 403) {
        demoteToCustomer();
        this.setData({ loading: false });
        wx.switchTab({ url: '/pages/index/index' });
        return;
      }
      this.setData({
        loading: false,
        errorText: isApiFailure(error) ? error.message : '加载失败，请重试',
      });
    }
  },

  onShareTip() {
    toast('把你的作品页分享给顾客，评价会越来越多～');
  },
});
