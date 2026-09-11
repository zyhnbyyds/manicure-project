/**
 * 美甲师的「我的预约」（S5）。
 *
 * 与顾客端「我的预约」是**两个页面**而不是一个：
 * 顾客看到的是「几点、哪个美甲师」，美甲师看到的是「几点、哪位顾客（可拨号）、
 * 能不能点到达店/完成」。字段集合与可操作项都不同，硬塞进一个页面只会两边都别扭。
 */
import { staffApi } from '../../api/index';
import type { BookingStatus } from '../../api/types';
import { demoteToCustomer } from '../../store/mode';
import { addDays, toLocalDateString } from '../../utils/format';
import { basePageData } from '../../utils/page';
import { dialCustomer } from '../../utils/phone';
import { toStaffBookingRow, type StaffBookingRow } from '../../utils/present';
import { isApiFailure } from '../../utils/request';
import { syncTabBar } from '../../utils/tabbar';
import { confirm, toast } from '../../utils/ui';

interface FilterItem {
  key: string;
  label: string;
}

const FILTERS: FilterItem[] = [
  { key: '', label: '全部' },
  { key: 'confirmed', label: '待到店' },
  { key: 'arrived', label: '进行中' },
  { key: 'completed', label: '已完成' },
];

/** 日期条：从今天起 7 天，够覆盖「今天 + 本周」的查看需求 */
const DATE_COUNT = 7;

Page({
  data: {
    ...basePageData(),
    loading: true,
    errorText: '',
    filters: FILTERS,
    activeFilter: '',
    dates: [] as { value: string; label: string; isToday: boolean }[],
    activeDate: '',
    bookings: [] as StaffBookingRow[],
  },

  onShow() {
    this.setData({ ...basePageData() });
    syncTabBar(this);
    void this.load();
  },

  buildDates() {
    const today = new Date();
    const dates = [];
    for (let index = 0; index < DATE_COUNT; index += 1) {
      const date = addDays(today, index);
      dates.push({
        value: toLocalDateString(date),
        label:
          index === 0
            ? '今天'
            : index === 1
              ? '明天'
              : `${date.getMonth() + 1}-${date.getDate()}`,
        isToday: index === 0,
      });
    }
    return dates;
  },

  async load() {
    const dates = this.buildDates();
    const activeDate = this.data.activeDate || dates[0]?.value || '';
    this.setData({ loading: true, errorText: '', dates, activeDate });
    try {
      const list = await staffApi.listBookings({
        date: activeDate,
        status: (this.data.activeFilter || undefined) as BookingStatus | undefined,
        pageSize: 50,
      });
      this.setData({ loading: false, bookings: list.items.map(toStaffBookingRow) });
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

  onFilter(event: WechatMiniprogram.TouchEvent) {
    const key = String(event.currentTarget.dataset.key ?? '');
    if (key === this.data.activeFilter) return;
    this.setData({ activeFilter: key });
    void this.load();
  },

  onDate(event: WechatMiniprogram.TouchEvent) {
    const value = String(event.currentTarget.dataset.value ?? '');
    if (!value || value === this.data.activeDate) return;
    this.setData({ activeDate: value });
    void this.load();
  },

  async onCall(event: WechatMiniprogram.TouchEvent) {
    const id = Number(event.currentTarget.dataset.id);
    const row = this.data.bookings.find((item) => item.id === id);
    if (!row) return;
    await dialCustomer({ bookingId: id, masked: row.customerPhoneMasked });
  },

  async onArrive(event: WechatMiniprogram.TouchEvent) {
    const id = Number(event.currentTarget.dataset.id);
    try {
      const result = await staffApi.markArrived(id);
      toast(result.changed ? '已标记到店' : '这单已经记过到店啦', 'success');
      await this.load();
    } catch (error) {
      toast(isApiFailure(error) ? error.message : '操作失败，请稍后再试');
    }
  },

  async onComplete(event: WechatMiniprogram.TouchEvent) {
    const id = Number(event.currentTarget.dataset.id);
    const agreed = await confirm({
      title: '标记服务完成',
      content: '完成后会立即计提这一单的提成，确定吗？',
      confirmText: '完成服务',
    });
    if (!agreed) return;
    try {
      const result = await staffApi.markCompleted(id);
      if (result.warning) toast(result.warning);
      else toast(result.changed ? '已标记完成' : '这单已经完成过啦', 'success');
      await this.load();
    } catch (error) {
      toast(isApiFailure(error) ? error.message : '操作失败，请稍后再试');
    }
  },
});
