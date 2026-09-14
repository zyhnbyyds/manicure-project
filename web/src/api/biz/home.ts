import { get } from '~/request';

/**
 * 首页经营概览（`GET /biz/reports/home`）。
 *
 * ## 两条前端必须尊重的约定
 *
 * 1. **金额字段可能整块不存在**：前台只有 `biz:report:home`（轻量版权限点），
 *    服务端**根本不下发**金额类字段（`meta.money = false`）。所以
 *    `summary.money` / `summary.member` / `stores[].net` 全是可选的 ——
 *    页面不能用 `v-if` 藏，而要按 `meta.money` 决定渲不渲染那些卡片
 *    （藏起来还会留下一排「¥0.00」，看着像数据坏了）。
 * 2. **门店对比恒为可见门店全量**：切到 A 店时 `summary` 是 A 店的，
 *    但 `stores[]` 仍是所有可见门店 —— 这是刻意的（否则没法回答「B 店今天怎么样」）。
 */

export type HomeRange = 'today' | '7d' | '30d' | 'month';

export const HOME_RANGE_OPTIONS: { label: string; value: HomeRange }[] = [
  { label: '今日', value: 'today' },
  { label: '近 7 日', value: '7d' },
  { label: '近 30 日', value: '30d' },
  { label: '本月', value: 'month' },
];

/** 页头统一口径提示（§10.5 硬性要求：营收口径必须写在页面上） */
export const HOME_REVENUE_CAVEAT =
  '净营收 = 实收（已扣退款），按「店内本地日」切分';

export interface HomeMoneySummary {
  gross: number;
  refund: number;
  net: number;
  prevNet: number | null;
  avgTicket: number | null;
  refundRatePermille: number | null;
  refundCountRatePermille: number | null;
  refundCount: number;
}

export interface HomeMemberSummary {
  rechargePrincipal: number;
  rechargeBonus: number;
  pointsIssued: number;
  pointsSpent: number;
  cardUsedTimes: number;
  /** 全店口径 */
  cardIssued: number;
  /** 全店口径 */
  balancePrincipalEnd: number;
  /** 全店口径 */
  balanceBonusEnd: number;
}

export interface HomeStoreRow {
  storeId: number;
  code: string;
  name: string;
  isDefault: boolean;
  created: number;
  completed: number;
  cancelled: number;
  noShow: number;
  pending: number;
  completedRatePermille: number | null;
  pendingPayments: number;
  pendingRefunds: number;
  net?: number | undefined;
  gross?: number | undefined;
  refund?: number | undefined;
  avgTicket?: number | null | undefined;
  refundRatePermille?: number | null | undefined;
}

export interface HomeOverview {
  meta: {
    range: HomeRange;
    dateFrom: string;
    dateTo: string;
    prevDateFrom: string;
    prevDateTo: string;
    prevSameLength: boolean;
    timeZone: string;
    storeScope: 'all' | 'stores';
    activeStoreId: number | null;
    activeStoreName: string | null;
    money: boolean;
    generatedAt: string;
  };
  summary: {
    money?: HomeMoneySummary | undefined;
    bookings: {
      created: number;
      total: number;
      completed: number;
      cancelled: number;
      noShow: number;
      pending: number;
      prevCompleted: number | null;
      completedRatePermille: number | null;
      arriveRatePermille: number | null;
      noShowRatePermille: number | null;
      cancelRatePermille: number | null;
    };
    customers: { newCustomers: number; returning: number; memberNew: number };
    member?: HomeMemberSummary | undefined;
  };
  trend: {
    date: string;
    created: number;
    completed: number;
    net?: number | undefined;
    gross?: number | undefined;
    refund?: number | undefined;
  }[];
  stores: HomeStoreRow[];
  todo: {
    pendingPayments: number;
    unpaidPayments: number;
    partialPayments: number;
    pendingRefunds: number;
    pendingBookings: number;
    todayBookings: number;
    upcoming: {
      id: number;
      bookingNo: string;
      startAt: string;
      customerName: string | null;
      staffName: string | null;
      status: string;
      payStatus: string;
    }[];
  };
}

export function getHomeOverview(range: HomeRange) {
  return get<HomeOverview>('/biz/reports/home', { range });
}
