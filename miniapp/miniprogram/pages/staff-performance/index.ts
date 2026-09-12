/**
 * 美甲师业绩明细（S5 / D9：逐单提成全见）。
 *
 * 「逐单全见」是产品决策，不是实现偷懒：美甲师要对账，只给一个总数无法质疑，
 * 所以这里把每一单的**计提基数 / 提成金额 / 状态**原样列出来。
 *
 * 月份切换在**本地**推进：`period` 是 `yyyyMM`，不传时服务端按店内时区算当月；
 * 一旦用户翻月，就由前端明确传值，避免「我以为在看 9 月，服务端按 10 月算」。
 */
import { staffApi } from '../../api/index';
import { demoteToCustomer } from '../../store/mode';
import { fenToYuan } from '../../utils/format';
import { definePage } from '../../utils/page';
import {
  formatCommissionStatus,
  formatPeriod,
} from '../../utils/present';
import { isApiFailure } from '../../utils/request';
import { toast } from '../../utils/ui';

/** 当前本地月（不是服务端月）：翻月是纯展示动作，用设备日历最直观 */
function currentPeriod(): { year: number; month: number } {
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth() + 1 };
}

function toPeriod(year: number, month: number): string {
  return `${year}${String(month).padStart(2, '0')}`;
}

function shift(year: number, month: number, delta: number) {
  const total = year * 12 + (month - 1) + delta;
  return { year: Math.floor(total / 12), month: (total % 12) + 1 };
}

interface CommissionRow {
  id: number;
  bookingNo: string;
  serviceItemName: string;
  baseText: string;
  amountText: string;
  statusText: string;
  settledText: string;
  tone: string;
}

definePage({
  data: {
    loading: true,
    errorText: '',
    periodText: '',
    completedCount: 0,
    paidText: '0.00',
    accruedText: '0.00',
    settledText: '0.00',
    reversedText: '0.00',
    ratingText: '暂无评分',
    rows: [] as CommissionRow[],
    year: 0,
    month: 0,
    canNext: false,
  },

  onShow() {
    if (this.data.year === 0) {
      const now = currentPeriod();
      this.setData({ year: now.year, month: now.month });
    }
    void this.load();
  },

  /** 不允许翻到未来的月份：那里面什么都没有，翻过去只会看到一片空 */
  refreshCanNext() {
    const now = currentPeriod();
    this.setData({
      canNext:
        this.data.year * 12 + this.data.month < now.year * 12 + now.month,
    });
  },

  async load() {
    this.refreshCanNext();
    const period = toPeriod(this.data.year, this.data.month);
    this.setData({ loading: true, errorText: '' });
    try {
      const perf = await staffApi.getPerformance(period);
      this.setData({
        loading: false,
        periodText: formatPeriod(perf.period),
        completedCount: perf.completedCount,
        paidText: fenToYuan(perf.paidAmount),
        accruedText: fenToYuan(perf.commission.accrued),
        settledText: fenToYuan(perf.commission.settled),
        reversedText: fenToYuan(perf.commission.reversed),
        ratingText:
          perf.rating.average === null
            ? '暂无评分'
            : `${perf.rating.average} 分（${perf.rating.count} 条）`,
        rows: perf.items.map((item) => ({
          id: item.id,
          bookingNo: item.bookingNo ?? '—',
          serviceItemName: item.serviceItemName ?? '—',
          baseText: fenToYuan(item.baseAmount),
          amountText: fenToYuan(item.amount),
          statusText: formatCommissionStatus(item.status),
          settledText: item.settledAt ? item.settledAt.slice(0, 10) : '—',
          tone: item.status,
        })),
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

  onPrev() {
    const next = shift(this.data.year, this.data.month, -1);
    this.setData({ year: next.year, month: next.month });
    void this.load();
  },

  onNext() {
    if (!this.data.canNext) {
      toast('已经是本月啦');
      return;
    }
    const next = shift(this.data.year, this.data.month, 1);
    this.setData({ year: next.year, month: next.month });
    void this.load();
  },
});
