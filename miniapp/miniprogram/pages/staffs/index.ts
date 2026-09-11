import { catalogApi } from '../../api';
import { getDraftItems, setDraftStaff } from '../../store/draft';
import { fenToYuan, formatDuration } from '../../utils/format';
import { goServices, goSlots } from '../../utils/nav';
import { basePageData } from '../../utils/page';
import { toStaffVM, type StaffVM } from '../../utils/present';
import { isApiFailure } from '../../utils/request';

Page({
  data: {
    ...basePageData(),
    loading: true,
    errorText: '',
    staffs: [] as StaffVM[],
    /** 没选项目就不该往后走：时长算不出来，可约时段也没有意义 */
    hasItems: false,
    itemNames: '',
    durationText: '',
    totalText: '0.00',
  },

  onLoad() {
    this.load();
  },

  onShow() {
    this.setData(basePageData());
    // 从项目页返回时草稿可能已变，重新同步摘要
    this.syncDraft();
  },

  async load() {
    this.setData({ loading: true, errorText: '' });
    try {
      const page = await catalogApi.listStaffs();
      this.setData({ loading: false, staffs: page.items.map(toStaffVM) });
    } catch (error) {
      this.setData({
        loading: false,
        errorText: isApiFailure(error) ? error.message : '加载失败，请稍后再试',
      });
    }
  },

  syncDraft() {
    const items = getDraftItems();
    this.setData({
      hasItems: items.length > 0,
      itemNames: items.map((item) => item.name).join(' · '),
      durationText: formatDuration(
        items.reduce((sum, item) => sum + item.durationMinutes, 0),
      ),
      totalText: fenToYuan(items.reduce((sum, item) => sum + item.price, 0)),
    });
  },

  changeItems() {
    wx.navigateBack();
  },

  onPick(event: WechatMiniprogram.TouchEvent) {
    if (!this.data.hasItems) {
      wx.showModal({
        title: '还没选款式',
        content: '先挑一个想做的款式，才能算出需要多久、有哪些时间可以约～',
        confirmText: '去挑款式',
        cancelText: '待会儿',
        confirmColor: '#FF8BA7',
        success: (res) => {
          if (res.confirm) goServices();
        },
      });
      return;
    }

    const id = Number(event.currentTarget.dataset.id);
    const staff = this.data.staffs.find((candidate) => candidate.id === id);
    if (!staff) return;
    // 换美甲师会清掉已选时段（排班与冲突都变了），见 store/draft.ts
    setDraftStaff({ id: staff.id, nickname: staff.nickname, avatar: staff.avatar });
    goSlots();
  },
});
