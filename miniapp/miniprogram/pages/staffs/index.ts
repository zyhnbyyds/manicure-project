import { catalogApi } from '../../api/index';
import { getDraftItems, setDraftStaff } from '../../store/draft';
import { fenToYuan, formatDuration } from '../../utils/format';
import { runLoad } from '../../utils/load';
import { goServices, goSlots } from '../../utils/nav';
import { definePage } from '../../utils/page';
import { toStaffVM, type StaffVM } from '../../utils/present';

definePage({
  data: {
    loading: true,
    staffs: [] as StaffVM[],
    /** 没选项目就不该往后走：时长算不出来，可约时段也没有意义 */
    hasItems: false,
    itemNames: '',
    durationText: '',
    totalText: '0.00',
  },

  onLoad() {
    void this.load();
  },

  onShow() {
    // 从项目页返回时草稿可能已变，重新同步摘要
    this.syncDraft();
  },

  async load() {
    await runLoad(this, () => catalogApi.listStaffs(), {
      merge: (page) => ({ staffs: page.items.map(toStaffVM) }),
    });
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
    setDraftStaff({
      id: staff.id,
      nickname: staff.nickname,
      avatar: staff.avatar,
    });
    goSlots();
  },
});
