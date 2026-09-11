import { catalogApi } from '../../api/index';
import { getDraftItems, getDraftStaff, setDraftSlot } from '../../store/draft';
import { buildDateChips, fenToYuan, formatDuration, formatSlotReason, type DateChip } from '../../utils/format';
import { goConfirm } from '../../utils/nav';
import { basePageData } from '../../utils/page';
import { toSlotVM, type SlotVM } from '../../utils/present';
import { isApiFailure } from '../../utils/request';
import { toast } from '../../utils/ui';

/**
 * 选日期与时段。
 *
 * 时段**完全来自后端** `GET /app/available-slots`（与后台同一套 SlotPort 实现），
 * 客户端不做任何补算或放宽——「至少提前 60 分钟」这条规则在服务端，
 * 前端只负责把 reason 翻译成人话（`formatSlotReason`）。
 */
Page({
  data: {
    ...basePageData(),
    dateChips: [] as DateChip[],
    activeDate: '',
    slots: [] as SlotVM[],
    reasonText: '',
    durationText: '',
    loading: false,
    errorText: '',
    selectedStart: '',
    /** 已选时段的展示钟点（WXML 不能调函数，必须在这里算好） */
    selectedTimeText: '',
    staffName: '',
    itemNames: '',
    totalText: '0.00',
  },

  onLoad() {
    const staff = getDraftStaff();
    const items = getDraftItems();
    if (!staff || items.length === 0) {
      toast('请先选好款式和美甲师');
      setTimeout(() => wx.navigateBack(), 800);
      return;
    }

    const dateChips = buildDateChips(14);
    this.setData(
      {
        dateChips,
        activeDate: dateChips[0].value,
        staffName: staff.nickname,
        itemNames: items.map((item) => item.name).join(' · '),
        durationText: formatDuration(
          items.reduce((sum, item) => sum + item.durationMinutes, 0),
        ),
        totalText: fenToYuan(items.reduce((sum, item) => sum + item.price, 0)),
      },
      () => {
        this.loadSlots();
      },
    );
  },

  onShow() {
    this.setData(basePageData());
  },

  async loadSlots() {
    const staff = getDraftStaff();
    const items = getDraftItems();
    if (!staff || items.length === 0) return;

    // 切日期时清掉已选时段：旧日期选的时段在新日期下没有任何意义
    this.setData({ loading: true, errorText: '', selectedStart: '', selectedTimeText: '' });
    try {
      const result = await catalogApi.getAvailableSlots({
        staffId: staff.id,
        date: this.data.activeDate,
        serviceItemIds: items.map((item) => item.id),
      });
      this.setData({
        loading: false,
        slots: result.slots.map(toSlotVM),
        reasonText: result.slots.length > 0 ? '' : formatSlotReason(result.reason),
      });
    } catch (error) {
      this.setData({
        loading: false,
        slots: [],
        errorText: isApiFailure(error) ? error.message : '加载失败，请稍后再试',
      });
    }
  },

  onDate(event: WechatMiniprogram.TouchEvent) {
    const date = String(event.currentTarget.dataset.date);
    if (date === this.data.activeDate) return;
    this.setData({ activeDate: date }, () => {
      this.loadSlots();
    });
  },

  onSlot(event: WechatMiniprogram.TouchEvent) {
    const startAt = String(event.currentTarget.dataset.start);
    const slot = this.data.slots.find((candidate) => candidate.startAt === startAt);
    this.setData({
      selectedStart: startAt,
      selectedTimeText: slot ? slot.timeText : '',
    });
  },

  goNext() {
    const { selectedStart, slots, activeDate } = this.data;
    if (!selectedStart) {
      toast('先选一个时间吧～');
      return;
    }
    const slot = slots.find((candidate) => candidate.startAt === selectedStart);
    if (!slot) return;
    setDraftSlot({ date: activeDate, startAt: slot.startAt, endAt: slot.endAt });
    goConfirm();
  },
});
