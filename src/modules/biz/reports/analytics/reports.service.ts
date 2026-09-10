/**
 * 报表中心（§20.2，6 张表 + CSV 导出）。
 *
 * 口径铁律（每个数字都要能手工复核）：
 * - **净营收 = Σ 成功支付单 `received_amount` − Σ 成功退款单 `actual_amount`**（§15.7 不变量 4）；
 *   毛收入不扣退款，净营收扣。挂账下单时不写支付单 → 天然不计营收；销账时落支付单 → 此时才计入（§18.4）。
 * - 营业日一律按**店内本地日**切分：筛选走 `localDateRange()`（由 `shopDayRange()` 换算成 UTC 绝对区间），
 *   分组用 `shopDateOf()` 把每一行映射到它真正落在的本地日；**禁止** `DATE(created_at)` 这类 UTC 截断。
 * - 次卡核销单独计数（`channel='card'` 的支付单实收为 0），不进实收营收，但计次数。
 * - `total_spent`（会员累计消费）只服务等级，与本报表的营收口径分开显示（§15.7 不变量 6）。
 * - 报表**只读**：本服务不写任何表，金额一律整数「分」。
 */
import { BadRequestException, Injectable } from '@nestjs/common';
import {
  and,
  count,
  eq,
  inArray,
  isNull,
  lt,
  min,
  or,
  type SQL,
  sum,
} from 'drizzle-orm';
import type { MySqlColumn } from 'drizzle-orm/mysql-core';
import { DatabaseService } from '../../../../database/database.service';
import {
  bizBookingItems,
  bizBookings,
  bizCommissionRecords,
  bizCreditAccounts,
  bizCustomers,
  bizMemberCardLogs,
  bizMemberCards,
  bizMemberTransactions,
  bizPayments,
  bizReceivables,
  bizRefunds,
  bizReviews,
  bizServiceItems,
  bizStaffs,
} from '../../../../database/schema/index.js';
import { BizConfigService } from '../../common/biz-config.service.js';
import { andConditions, localDateRange } from '../../common/query.js';
import {
  addLocalDays,
  daysBetween,
  listLocalDates,
  shopDateOf,
  shopDayRange,
  shopToday,
} from '../../common/shop-time.js';

/* ------------------------------------------------------------------ *
 * 类型
 * ------------------------------------------------------------------ */

export type ReportGranularity = 'day' | 'week' | 'month';

export type ReportType =
  | 'overview'
  | 'revenue'
  | 'services'
  | 'staffs'
  | 'members'
  | 'receivables';

export type PaymentPurpose =
  | 'deposit'
  | 'final'
  | 'recharge'
  | 'card_buy'
  | 'credit_settle';

/**
 * `channel` 维度 = **支付渠道**。
 *
 * 既接受 `biz_payment.channel` 的库内枚举值，也接受聚合标签
 * `wechat`（= `wxpay_native` + `wechat_offline`）与 `alipay`（= `alipay_qr` + `alipay_offline`），
 * 这样后台前端的「微信 / 支付宝」两个筛选项可以直接命中，不用拆成四个。
 */
/** `biz_payment.channel` 的库内枚举值 */
export const PAYMENT_CHANNEL_VALUES = [
  'cash',
  'wechat_offline',
  'wxpay_native',
  'alipay_offline',
  'alipay_qr',
  'balance',
  'card',
  'credit',
] as const;

export type PaymentChannelValue = (typeof PAYMENT_CHANNEL_VALUES)[number];

export type ReportChannel = PaymentChannelValue | 'wechat' | 'alipay';

/** 渠道筛选 → 支付单上的实际渠道集合 */
export function channelsOf(channel: ReportChannel): PaymentChannelValue[] {
  if (channel === 'wechat') return ['wxpay_native', 'wechat_offline'];
  if (channel === 'alipay') return ['alipay_qr', 'alipay_offline'];
  return [channel];
}

export type ReportQuery = {
  dateFrom?: string | undefined;
  dateTo?: string | undefined;
  staffId?: number | undefined;
  channel?: ReportChannel | undefined;
  /** 扩展维度：按支付用途筛选（默认不过滤，与 §20.2 口径一致） */
  purpose?: PaymentPurpose | undefined;
  granularity?: ReportGranularity | undefined;
};

export type OverviewReport = {
  revenue: {
    gross: number;
    refund: number;
    net: number;
    count: number;
    avgTicket: number;
  };
  bookings: {
    total: number;
    completed: number;
    cancelled: number;
    noShow: number;
    pending: number;
  };
  customers: {
    newCustomers: number;
    returning: number;
    memberNew: number;
  };
  member: {
    rechargePrincipal: number;
    rechargeBonus: number;
    balancePrincipalEnd: number;
    balanceBonusEnd: number;
    pointsIssued: number;
    pointsSpent: number;
    cardUsedTimes: number;
    cardIssued: number;
  };
};

export type RevenueReportRow = {
  period: string;
  gross: number;
  refund: number;
  net: number;
  cash: number;
  wechat: number;
  alipay: number;
  balance: number;
  creditSettled: number;
  count: number;
};

export type ServiceReportRow = {
  serviceItemId: number;
  name: string;
  times: number;
  amount: number;
  cardTimes: number;
  /** 次卡核销占比，千分比整数（`floor(cardTimes * 1000 / times)`） */
  cardRatio: number;
};

export type StaffReportRow = {
  staffId: number;
  nickname: string;
  bookings: number;
  amount: number;
  commission: number;
  avgScore: number;
  reviewCount: number;
};

export type MemberReportRow = {
  period: string;
  /** 仅 `granularity=day` 时给出（等于 `period`） */
  date?: string | undefined;
  newMembers: number;
  recharge: number;
  bonus: number;
  balanceEnd: number;
  pointsIssued: number;
  pointsSpent: number;
  cardUsed: number;
};

export type ReceivableBucket = '0-30' | '31-60' | '60+';

export type ReceivableBucketRow = {
  bucket: ReceivableBucket;
  count: number;
  amount: number;
  settledAmount: number;
  outstanding: number;
};

export type ReceivableAccountRow = {
  creditAccountId: number;
  name: string;
  type: 'customer' | 'company' | 'staff';
  creditLimit: number;
  usedAmount: number;
  count: number;
  amount: number;
  settledAmount: number;
  outstanding: number;
  overdueAmount: number;
  buckets: Record<ReceivableBucket, number>;
};

/** 主体维度的账龄累加器（主体识别信息单独从 `biz_credit_account` 取） */
type ReceivableAccountNumbers = Omit<
  ReceivableAccountRow,
  'creditAccountId' | 'name' | 'type' | 'creditLimit' | 'usedAmount'
>;

export type ReceivablesReport = {
  /** 账龄基准日（店内本地日） */
  asOf: string;
  buckets: ReceivableBucketRow[];
  overdue: { count: number; amount: number };
  total: {
    count: number;
    amount: number;
    settledAmount: number;
    outstanding: number;
  };
  accounts: ReceivableAccountRow[];
};

/* ------------------------------------------------------------------ *
 * 常量与纯函数
 * ------------------------------------------------------------------ */

/** 计入「实收」的支付单状态（§15.7 不变量 4：毛收入不扣退款） */
const PAID_PAYMENT_STATUSES = [
  'success',
  'partial_refunded',
  'refunded',
] as const;

const PENDING_BOOKING_STATUSES = ['pending', 'confirmed', 'arrived'] as const;

const BUCKETS: ReceivableBucket[] = ['0-30', '31-60', '60+'];

/** 默认区间：最近 30 个店内本地日（含当天） */
export const DEFAULT_REPORT_RANGE_DAYS = 30;

/** 导出同步返回的行数上限，超出提示走异步任务（本期 TODO） */
export const MAX_EXPORT_ROWS = 10_000;

const LOCAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function must(condition: SQL | undefined): SQL {
  if (!condition) throw new BadRequestException('查询条件无效');
  return condition;
}

function toInt(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}

/** 按占比向下取整分摊（少算不多算，差额留在单头，可手工复核） */
function apportion(total: number, part: number, whole: number): number {
  if (total <= 0 || whole <= 0) return 0;
  return Math.min(Math.floor((total * part) / whole), total);
}

/** ISO 8601 周（周一为一周首日） */
function isoWeek(date: string): string {
  const [year, month, day] = date.split('-').map(Number) as [
    number,
    number,
    number,
  ];
  const time = Date.UTC(year, month - 1, day);
  const weekday = (new Date(time).getUTCDay() + 6) % 7; // 0 = 周一
  const thursday = time + (3 - weekday) * 86_400_000;
  const isoYear = new Date(thursday).getUTCFullYear();
  const jan1 = Date.UTC(isoYear, 0, 1);
  const week = Math.floor((thursday - jan1) / 86_400_000 / 7) + 1;
  return `${isoYear}-W${String(week).padStart(2, '0')}`;
}

/** 本地日 → 分桶标签（day / ISO 周 / 月） */
function periodOf(date: string, granularity: ReportGranularity): string {
  if (granularity === 'week') return isoWeek(date);
  if (granularity === 'month') return date.slice(0, 7);
  return date;
}

/** 区间内全部分桶（零填充，保证图表与手工核对都有稳定的行序） */
function buildPeriods(
  dateFrom: string,
  dateTo: string,
  granularity: ReportGranularity,
): string[] {
  const periods: string[] = [];
  const seen = new Set<string>();
  for (const date of listLocalDates(dateFrom, dateTo)) {
    const label = periodOf(date, granularity);
    if (seen.has(label)) continue;
    seen.add(label);
    periods.push(label);
  }
  return periods;
}

/* ------------------------------------------------------------------ *
 * 服务
 * ------------------------------------------------------------------ */

type ResolvedQuery = {
  timeZone: string;
  granularity: ReportGranularity;
  dateFrom: string;
  dateTo: string;
  staffId?: number | undefined;
  channel?: ReportChannel | undefined;
  purpose?: PaymentPurpose | undefined;
};

type ResolvedPartialQuery = {
  timeZone: string;
  dateFrom?: string | undefined;
  dateTo?: string | undefined;
  staffId?: number | undefined;
};

@Injectable()
export class ReportsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly config: BizConfigService,
  ) {}

  /* ---------------- 公开接口 ---------------- */

  async overview(input: ReportQuery): Promise<OverviewReport> {
    return this.overviewOf(await this.resolve(input));
  }

  async revenue(input: ReportQuery): Promise<RevenueReportRow[]> {
    return this.revenueOf(await this.resolve(input));
  }

  async services(input: ReportQuery): Promise<ServiceReportRow[]> {
    return this.servicesOf(await this.resolve(input));
  }

  async staffs(input: ReportQuery): Promise<StaffReportRow[]> {
    return this.staffsOf(await this.resolve(input));
  }

  async members(input: ReportQuery): Promise<MemberReportRow[]> {
    return this.membersOf(await this.resolve(input));
  }

  async receivables(input: ReportQuery): Promise<ReceivablesReport> {
    return this.receivablesOf(await this.resolvePartial(input));
  }

  /** 导出 CSV 文本（含 UTF-8 BOM，Excel 直接可开） */
  async exportCsv(
    type: ReportType,
    input: ReportQuery,
  ): Promise<{ filename: string; content: string }> {
    let header: string[];
    let rows: (string | number)[][];
    let label: string;
    let range: string;

    if (type === 'receivables') {
      const query = await this.resolvePartial(input);
      const report = await this.receivablesOf(query);
      header = [
        '主体ID',
        '主体名称',
        '类型',
        '授信额度(分)',
        '未结金额(分)',
        '0-30天(分)',
        '31-60天(分)',
        '60+天(分)',
        '逾期金额(分)',
      ];
      rows = report.accounts.map((row) => [
        row.creditAccountId,
        row.name,
        row.type,
        row.creditLimit,
        row.outstanding,
        row.buckets['0-30'],
        row.buckets['31-60'],
        row.buckets['60+'],
        row.overdueAmount,
      ]);
      rows.push([
        '合计',
        '',
        '',
        '',
        report.total.outstanding,
        ...BUCKETS.map(
          (bucket) =>
            report.buckets.find((item) => item.bucket === bucket)
              ?.outstanding ?? 0,
        ),
        report.overdue.amount,
      ]);
      label = '应收账龄';
      range = report.asOf;
    } else {
      const query = await this.resolve(input);
      label = type;
      range = `${query.dateFrom}_${query.dateTo}`;
      if (type === 'overview') {
        const report = await this.overviewOf(query);
        header = ['指标', '数值', '单位'];
        rows = [
          ['毛收入(实收)', report.revenue.gross, '分'],
          ['退款', report.revenue.refund, '分'],
          ['净营收', report.revenue.net, '分'],
          ['完成单量', report.revenue.count, '单'],
          ['客单价', report.revenue.avgTicket, '分'],
          ['预约总数', report.bookings.total, '单'],
          ['已完成', report.bookings.completed, '单'],
          ['已取消', report.bookings.cancelled, '单'],
          ['爽约', report.bookings.noShow, '单'],
          ['未完成(待处理)', report.bookings.pending, '单'],
          ['新客', report.customers.newCustomers, '人'],
          ['回头客', report.customers.returning, '人'],
          ['新增会员', report.customers.memberNew, '人'],
          ['储值本金', report.member.rechargePrincipal, '分'],
          ['储值赠送', report.member.rechargeBonus, '分'],
          ['期末本金结存', report.member.balancePrincipalEnd, '分'],
          ['期末赠送结存', report.member.balanceBonusEnd, '分'],
          ['积分发放', report.member.pointsIssued, '积分'],
          ['积分抵扣', report.member.pointsSpent, '积分'],
          ['次卡核销次数', report.member.cardUsedTimes, '次'],
          ['次卡发售', report.member.cardIssued, '张'],
        ];
      } else if (type === 'revenue') {
        rows = (await this.revenueOf(query)).map((row) => [
          row.period,
          row.gross,
          row.refund,
          row.net,
          row.cash,
          row.wechat,
          row.alipay,
          row.balance,
          row.creditSettled,
          row.count,
        ]);
        header = [
          '期间',
          '毛收入(分)',
          '退款(分)',
          '净营收(分)',
          '现金(分)',
          '微信(分)',
          '支付宝(分)',
          '储值(分)',
          '销账实收(分)',
          '完成单量',
        ];
      } else if (type === 'services') {
        rows = (await this.servicesOf(query)).map((row) => [
          row.serviceItemId,
          row.name,
          row.times,
          row.amount,
          row.cardTimes,
          row.cardRatio,
        ]);
        header = [
          '项目ID',
          '项目名称',
          '次数',
          '金额(分)',
          '次卡核销次数',
          '次卡占比(‰)',
        ];
      } else if (type === 'staffs') {
        rows = (await this.staffsOf(query)).map((row) => [
          row.staffId,
          row.nickname,
          row.bookings,
          row.amount,
          row.commission,
          row.avgScore,
          row.reviewCount,
        ]);
        header = [
          '美甲师ID',
          '昵称',
          '完成单量',
          '净营收分摊(分)',
          '提成(分)',
          '平均评分',
          '评价数',
        ];
      } else {
        rows = (await this.membersOf(query)).map((row) => [
          row.period,
          row.newMembers,
          row.recharge,
          row.bonus,
          row.balanceEnd,
          row.pointsIssued,
          row.pointsSpent,
          row.cardUsed,
        ]);
        header = [
          '期间',
          '新增会员',
          '储值本金(分)',
          '储值赠送(分)',
          '期末结存(分)',
          '积分发放',
          '积分抵扣',
          '次卡核销次数',
        ];
      }
    }

    if (rows.length > MAX_EXPORT_ROWS)
      throw new BadRequestException(
        `导出行数 ${rows.length} 超过 ${MAX_EXPORT_ROWS} 行，请缩小时间范围；` +
          '大文件异步导出任务本期未实现（TODO：复用 jobs + 文件模块，完成后通知中心提示下载）',
      );

    const content = buildCsv(header, rows);
    return { filename: `${label}-${range}.csv`, content };
  }

  /* ---------------- overview ---------------- */

  private async overviewOf(q: ResolvedQuery): Promise<OverviewReport> {
    const [payments, refunds, bookings, memberTxns, cardLogs, cardIssued] =
      await Promise.all([
        this.paymentRows(q),
        this.refundRows(q),
        this.bookingRows(q, {}),
        this.memberTransactionRows(q),
        this.cardLogRows(q),
        this.cardIssuedCount(q),
      ]);

    const gross = payments.reduce(
      (total, row) => total + row.receivedAmount,
      0,
    );
    const refund = refunds.reduce((total, row) => total + row.actualAmount, 0);
    const completed = bookings.filter((row) => row.status === 'completed');
    const count = completed.length;
    const net = gross - refund;

    const member = await this.memberTotalsOf(q, memberTxns, cardLogs);

    return {
      revenue: {
        gross,
        refund,
        net,
        count,
        avgTicket: count > 0 ? Math.floor(net / count) : 0,
      },
      bookings: {
        total: bookings.length,
        completed: count,
        cancelled: bookings.filter((row) => row.status === 'cancelled').length,
        noShow: bookings.filter((row) => row.status === 'no_show').length,
        pending: bookings.filter((row) =>
          (PENDING_BOOKING_STATUSES as readonly string[]).includes(row.status),
        ).length,
      },
      customers: await this.customerTotalsOf(q, completed),
      member: { ...member, cardIssued },
    };
  }

  /** 会员维度：充值 / 积分 / 结存 / 次卡核销（金额与积分都取流水口径） */
  private async memberTotalsOf(
    q: ResolvedQuery,
    transactions: {
      type: string;
      balanceDeltaPrincipal: number;
      balanceDeltaBonus: number;
      pointsDelta: number;
    }[],
    cardLogs: { type: string; times: number }[],
  ) {
    let rechargePrincipal = 0;
    let rechargeBonus = 0;
    let pointsIssued = 0;
    let pointsSpent = 0;
    for (const row of transactions) {
      if (row.type === 'recharge') {
        rechargePrincipal += row.balanceDeltaPrincipal;
        rechargeBonus += row.balanceDeltaBonus;
      }
      if (row.type === 'points_earn' && row.pointsDelta > 0)
        pointsIssued += row.pointsDelta;
      if (
        (row.type === 'points_spend' || row.type === 'points_redeem') &&
        row.pointsDelta < 0
      )
        pointsSpent += -row.pointsDelta;
    }

    // 期末结存 = 截至区间结束（不含）的全部流水增量和（§15.7 不变量 2 对账等式）
    const [balance] = await this.database.db
      .select({
        principal: sum(bizMemberTransactions.balanceDeltaPrincipal),
        bonus: sum(bizMemberTransactions.balanceDeltaBonus),
      })
      .from(bizMemberTransactions)
      .where(lt(bizMemberTransactions.createdAt, this.rangeEnd(q)));

    return {
      rechargePrincipal,
      rechargeBonus,
      balancePrincipalEnd: toInt(balance?.principal),
      balanceBonusEnd: toInt(balance?.bonus),
      pointsIssued,
      pointsSpent,
      cardUsedTimes: netCardTimes(cardLogs),
    };
  }

  /** 新客 / 回头客（§20.2：首次完成时间落在区间内 = 新客） */
  private async customerTotalsOf(
    q: ResolvedQuery,
    completed: { customerId: number }[],
  ): Promise<OverviewReport['customers']> {
    const customerIds = [...new Set(completed.map((row) => row.customerId))];
    const start = this.rangeStart(q);
    const end = this.rangeEnd(q);

    let newCustomers = 0;
    let returning = 0;
    if (customerIds.length) {
      const firsts = await this.database.db
        .select({
          customerId: bizBookings.customerId,
          firstAt: min(bizBookings.startAt),
        })
        .from(bizBookings)
        .where(
          andConditions([
            eq(bizBookings.status, 'completed'),
            isNull(bizBookings.deletedAt),
            inArray(bizBookings.customerId, customerIds),
            q.staffId ? eq(bizBookings.staffId, q.staffId) : undefined,
            q.channel ? this.bookingChannelCondition(q.channel) : undefined,
          ]),
        )
        .groupBy(bizBookings.customerId);
      const firstMap = new Map(
        firsts.map((row) => [row.customerId, row.firstAt?.getTime() ?? 0]),
      );
      for (const customerId of customerIds) {
        const firstAt = firstMap.get(customerId) ?? 0;
        if (firstAt >= start.getTime() && firstAt < end.getTime())
          newCustomers++;
        else returning++;
      }
    }

    const [memberNewRow] = await this.database.db
      .select({ value: count() })
      .from(bizCustomers)
      .where(
        andConditions([
          isNull(bizCustomers.deletedAt),
          this.dayRange(bizCustomers.memberSince, q),
        ]),
      );

    return {
      newCustomers,
      returning,
      memberNew: toInt(memberNewRow?.value),
    };
  }

  /* ---------------- revenue ---------------- */

  private async revenueOf(q: ResolvedQuery): Promise<RevenueReportRow[]> {
    const [payments, refunds, bookings] = await Promise.all([
      this.paymentRows(q),
      this.refundRows(q),
      this.bookingRows(q, { completedOnly: true }),
    ]);

    const rows = new Map<string, RevenueReportRow>();
    for (const period of buildPeriods(q.dateFrom, q.dateTo, q.granularity))
      rows.set(period, {
        period,
        gross: 0,
        refund: 0,
        net: 0,
        cash: 0,
        wechat: 0,
        alipay: 0,
        balance: 0,
        creditSettled: 0,
        count: 0,
      });

    for (const payment of payments) {
      const row = rows.get(
        periodOf(
          this.localDay(payment.paidAt ?? payment.createdAt, q.timeZone),
          q.granularity,
        ),
      );
      if (!row) continue;
      row.gross += payment.receivedAmount;
      if (payment.purpose === 'credit_settle')
        row.creditSettled += payment.receivedAmount;
      if (payment.channel === 'cash') row.cash += payment.receivedAmount;
      else if (
        payment.channel === 'wxpay_native' ||
        payment.channel === 'wechat_offline'
      )
        row.wechat += payment.receivedAmount;
      else if (
        payment.channel === 'alipay_qr' ||
        payment.channel === 'alipay_offline'
      )
        row.alipay += payment.receivedAmount;
      else if (payment.channel === 'balance')
        row.balance += payment.receivedAmount;
    }

    for (const refund of refunds) {
      const row = rows.get(
        periodOf(
          this.localDay(refund.refundedAt ?? refund.createdAt, q.timeZone),
          q.granularity,
        ),
      );
      if (row) row.refund += refund.actualAmount;
    }

    for (const booking of bookings) {
      const row = rows.get(
        periodOf(this.localDay(booking.startAt, q.timeZone), q.granularity),
      );
      if (row) row.count += 1;
    }

    return [...rows.values()].map((row) => ({
      ...row,
      net: row.gross - row.refund,
    }));
  }

  /* ---------------- services ---------------- */

  private async servicesOf(q: ResolvedQuery): Promise<ServiceReportRow[]> {
    const [items, cardLogs, names] = await Promise.all([
      this.bookingItemRows(q),
      this.cardLogRows(q),
      this.database.db
        .select({ id: bizServiceItems.id, name: bizServiceItems.name })
        .from(bizServiceItems),
    ]);
    const nameMap = new Map(names.map((row) => [row.id, row.name]));

    const rows = new Map<number, ServiceReportRow>();
    const ensure = (serviceItemId: number): ServiceReportRow => {
      const found = rows.get(serviceItemId);
      if (found) return found;
      const created: ServiceReportRow = {
        serviceItemId,
        name: nameMap.get(serviceItemId) ?? '',
        times: 0,
        amount: 0,
        cardTimes: 0,
        cardRatio: 0,
      };
      rows.set(serviceItemId, created);
      return created;
    };

    for (const item of items) {
      const row = ensure(item.serviceItemId);
      if (!row.name) row.name = item.name;
      row.times += 1;
      // 净营收按项目原价占比分摊到明细（向下取整，差额留在单头）
      row.amount += apportion(
        item.paidAmount - item.refundAmount,
        item.price,
        item.originalPrice,
      );
    }

    for (const log of cardLogs) {
      const row = ensure(log.serviceItemId);
      row.cardTimes += log.type === 'use' ? log.times : -log.times;
    }

    return [...rows.values()]
      .map((row) => {
        const cardTimes = Math.max(row.cardTimes, 0);
        return {
          ...row,
          cardTimes,
          cardRatio:
            row.times > 0 ? Math.floor((cardTimes * 1000) / row.times) : 0,
        };
      })
      .sort(
        (a, b) =>
          b.amount - a.amount ||
          b.times - a.times ||
          a.serviceItemId - b.serviceItemId,
      );
  }

  /* ---------------- staffs ---------------- */

  private async staffsOf(q: ResolvedQuery): Promise<StaffReportRow[]> {
    const [bookings, commissions, reviews] = await Promise.all([
      this.bookingRows(q, { completedOnly: true }),
      this.database.db
        .select({
          staffId: bizCommissionRecords.staffId,
          amount: sum(bizCommissionRecords.amount),
        })
        .from(bizCommissionRecords)
        .where(
          andConditions([
            inArray(bizCommissionRecords.status, ['accrued', 'settled']),
            this.dayRange(bizCommissionRecords.createdAt, q),
            q.staffId ? eq(bizCommissionRecords.staffId, q.staffId) : undefined,
          ]),
        )
        .groupBy(bizCommissionRecords.staffId),
      this.database.db
        .select({ staffId: bizReviews.staffId, score: bizReviews.score })
        .from(bizReviews)
        .where(
          andConditions([
            eq(bizReviews.status, 'published'),
            isNull(bizReviews.deletedAt),
            this.dayRange(bizReviews.createdAt, q),
            q.staffId ? eq(bizReviews.staffId, q.staffId) : undefined,
          ]),
        ),
    ]);

    const rows = new Map<number, StaffReportRow>();
    const ensure = (staffId: number): StaffReportRow => {
      const found = rows.get(staffId);
      if (found) return found;
      const created: StaffReportRow = {
        staffId,
        nickname: '',
        bookings: 0,
        amount: 0,
        commission: 0,
        avgScore: 0,
        reviewCount: 0,
      };
      rows.set(staffId, created);
      return created;
    };

    for (const booking of bookings) {
      const row = ensure(booking.staffId);
      row.bookings += 1;
      row.amount += booking.paidAmount - booking.refundAmount;
    }
    for (const record of commissions)
      ensure(record.staffId).commission += toInt(record.amount);

    const scores = new Map<number, { total: number; count: number }>();
    for (const review of reviews) {
      const current = scores.get(review.staffId) ?? { total: 0, count: 0 };
      current.total += review.score;
      current.count += 1;
      scores.set(review.staffId, current);
      ensure(review.staffId);
    }
    for (const [staffId, score] of scores) {
      const row = ensure(staffId);
      row.reviewCount = score.count;
      row.avgScore = score.count
        ? Math.round((score.total / score.count) * 100) / 100
        : 0;
    }

    // `staffId` 过滤时即使零业绩也要给出该美甲师一行，方便前端渲染
    if (q.staffId) ensure(q.staffId);

    const nicknames = await this.database.db
      .select({ id: bizStaffs.id, nickname: bizStaffs.nickname })
      .from(bizStaffs)
      .where(inArray(bizStaffs.id, [...rows.keys()]));
    const nicknameMap = new Map(nicknames.map((row) => [row.id, row.nickname]));
    for (const row of rows.values())
      row.nickname = nicknameMap.get(row.staffId) ?? '';

    return [...rows.values()].sort(
      (a, b) =>
        b.amount - a.amount || b.bookings - a.bookings || a.staffId - b.staffId,
    );
  }

  /* ---------------- members ---------------- */

  private async membersOf(q: ResolvedQuery): Promise<MemberReportRow[]> {
    const [transactions, cardLogs, memberNews, opening, deltas] =
      await Promise.all([
        this.memberTransactionRows(q),
        this.cardLogRows(q),
        this.database.db
          .select({ memberSince: bizCustomers.memberSince })
          .from(bizCustomers)
          .where(
            andConditions([
              isNull(bizCustomers.deletedAt),
              this.dayRange(bizCustomers.memberSince, q),
            ]),
          ),
        this.openingBalanceRows(q),
        this.balanceDeltaRows(q),
      ]);

    const dayDeltas = new Map<string, number>();
    for (const txn of deltas) {
      const day = this.localDay(txn.createdAt, q.timeZone);
      dayDeltas.set(
        day,
        (dayDeltas.get(day) ?? 0) +
          txn.balanceDeltaPrincipal +
          txn.balanceDeltaBonus,
      );
    }

    const periods = buildPeriods(q.dateFrom, q.dateTo, q.granularity);
    const rows = new Map<string, MemberReportRow>(
      periods.map((period) => [
        period,
        {
          period,
          date: q.granularity === 'day' ? period : undefined,
          newMembers: 0,
          recharge: 0,
          bonus: 0,
          balanceEnd: 0,
          pointsIssued: 0,
          pointsSpent: 0,
          cardUsed: 0,
        },
      ]),
    );

    for (const customer of memberNews) {
      if (!customer.memberSince) continue;
      const row = rows.get(
        periodOf(
          this.localDay(customer.memberSince, q.timeZone),
          q.granularity,
        ),
      );
      if (row) row.newMembers += 1;
    }
    for (const txn of transactions) {
      const row = rows.get(
        periodOf(this.localDay(txn.createdAt, q.timeZone), q.granularity),
      );
      if (!row) continue;
      if (txn.type === 'recharge') {
        row.recharge += txn.balanceDeltaPrincipal;
        row.bonus += txn.balanceDeltaBonus;
      }
      if (txn.type === 'points_earn' && txn.pointsDelta > 0)
        row.pointsIssued += txn.pointsDelta;
      if (
        (txn.type === 'points_spend' || txn.type === 'points_redeem') &&
        txn.pointsDelta < 0
      )
        row.pointsSpent += -txn.pointsDelta;
    }
    for (const log of cardLogs) {
      const row = rows.get(
        periodOf(this.localDay(log.createdAt, q.timeZone), q.granularity),
      );
      if (!row) continue;
      row.cardUsed += log.type === 'use' ? log.times : -log.times;
    }

    // 期末结存：从区间期初余额起，按本地日累计（桶内取最后一天的值）
    let running = opening;
    for (const date of listLocalDates(q.dateFrom, q.dateTo)) {
      running += dayDeltas.get(date) ?? 0;
      const row = rows.get(periodOf(date, q.granularity));
      if (row) row.balanceEnd = running;
    }

    return [...rows.values()].map((row) => ({
      ...row,
      balanceEnd: Math.max(row.balanceEnd, 0),
    }));
  }

  /* ---------------- receivables ---------------- */

  private async receivablesOf(
    q: ResolvedPartialQuery,
  ): Promise<ReceivablesReport> {
    const asOf = shopToday(q.timeZone);
    const [receivableRows, accounts] = await Promise.all([
      this.database.db
        .select({
          id: bizReceivables.id,
          creditAccountId: bizReceivables.creditAccountId,
          amount: bizReceivables.amount,
          settledAmount: bizReceivables.settledAmount,
          dueDate: bizReceivables.dueDate,
          status: bizReceivables.status,
          createdAt: bizReceivables.createdAt,
        })
        .from(bizReceivables)
        .where(
          andConditions([
            isNull(bizReceivables.deletedAt),
            inArray(bizReceivables.status, ['open', 'partial', 'overdue']),
            q.dateFrom || q.dateTo
              ? must(
                  localDateRange(
                    bizReceivables.createdAt,
                    q.dateFrom,
                    q.dateTo,
                    q.timeZone,
                  ),
                )
              : undefined,
          ]),
        ),
      this.database.db
        .select({
          id: bizCreditAccounts.id,
          name: bizCreditAccounts.name,
          type: bizCreditAccounts.type,
          creditLimit: bizCreditAccounts.creditLimit,
          usedAmount: bizCreditAccounts.usedAmount,
        })
        .from(bizCreditAccounts)
        .where(isNull(bizCreditAccounts.deletedAt)),
    ]);
    const byAccount = new Map<number, ReceivableAccountNumbers>();
    const buckets = new Map<ReceivableBucket, ReceivableBucketRow>(
      BUCKETS.map((bucket) => [
        bucket,
        { bucket, count: 0, amount: 0, settledAmount: 0, outstanding: 0 },
      ]),
    );
    const total = { count: 0, amount: 0, settledAmount: 0, outstanding: 0 };
    const overdue = { count: 0, amount: 0 };

    for (const row of receivableRows) {
      const outstanding = Math.max(row.amount - row.settledAmount, 0);
      if (outstanding <= 0) continue;
      const createdDay = this.localDay(row.createdAt, q.timeZone);
      const agingDays = row.dueDate
        ? Math.max(daysBetween(row.dueDate, asOf), 0)
        : Math.max(daysBetween(createdDay, asOf), 0);
      const bucket: ReceivableBucket =
        agingDays <= 30 ? '0-30' : agingDays <= 60 ? '31-60' : '60+';
      const isOverdue =
        row.dueDate !== null && row.dueDate !== undefined && row.dueDate < asOf;

      const bucketRow = buckets.get(bucket);
      if (bucketRow) {
        bucketRow.count += 1;
        bucketRow.amount += row.amount;
        bucketRow.settledAmount += row.settledAmount;
        bucketRow.outstanding += outstanding;
      }

      const existing = byAccount.get(row.creditAccountId) ?? {
        count: 0,
        amount: 0,
        settledAmount: 0,
        outstanding: 0,
        overdueAmount: 0,
        buckets: { '0-30': 0, '31-60': 0, '60+': 0 },
      };
      existing.count += 1;
      existing.amount += row.amount;
      existing.settledAmount += row.settledAmount;
      existing.outstanding += outstanding;
      existing.buckets[bucket] += outstanding;
      if (isOverdue) existing.overdueAmount += outstanding;
      byAccount.set(row.creditAccountId, existing);

      total.count += 1;
      total.amount += row.amount;
      total.settledAmount += row.settledAmount;
      total.outstanding += outstanding;
      if (isOverdue) {
        overdue.count += 1;
        overdue.amount += outstanding;
      }
    }

    return {
      asOf,
      buckets: BUCKETS.map(
        (bucket) =>
          buckets.get(bucket) ?? {
            bucket,
            count: 0,
            amount: 0,
            settledAmount: 0,
            outstanding: 0,
          },
      ),
      overdue,
      total,
      // 与 `/biz/receivables/summary` 保持同一主体集合（含零余额主体），便于交叉核对。
      // 主体识别信息一律取 `biz_credit_account`（账龄金额才来自明细累加）。
      accounts: accounts
        .map((account) => {
          const numbers = byAccount.get(account.id);
          return {
            creditAccountId: account.id,
            name: account.name,
            type: account.type,
            creditLimit: account.creditLimit,
            usedAmount: account.usedAmount,
            count: numbers?.count ?? 0,
            amount: numbers?.amount ?? 0,
            settledAmount: numbers?.settledAmount ?? 0,
            outstanding: numbers?.outstanding ?? 0,
            overdueAmount: numbers?.overdueAmount ?? 0,
            buckets: numbers?.buckets ?? { '0-30': 0, '31-60': 0, '60+': 0 },
          };
        })
        .sort(
          (a, b) =>
            b.outstanding - a.outstanding ||
            a.creditAccountId - b.creditAccountId,
        ),
    };
  }

  /* ---------------- 查询条件 ---------------- */

  private async resolve(input: ReportQuery): Promise<ResolvedQuery> {
    const timeZone = await this.timeZone();
    const granularity = input.granularity ?? 'day';
    const today = shopToday(timeZone);
    const dateTo = input.dateTo ?? today;
    const dateFrom =
      input.dateFrom ?? addLocalDays(dateTo, -(DEFAULT_REPORT_RANGE_DAYS - 1));
    this.assertRange(dateFrom, dateTo);
    return {
      timeZone,
      granularity,
      dateFrom,
      dateTo,
      staffId: input.staffId,
      channel: input.channel,
      purpose: input.purpose,
    };
  }

  private async resolvePartial(
    input: ReportQuery,
  ): Promise<ResolvedPartialQuery> {
    const timeZone = await this.timeZone();
    if (input.dateFrom || input.dateTo)
      this.assertRange(
        input.dateFrom ?? '1970-01-01',
        input.dateTo ?? shopToday(timeZone),
      );
    return {
      timeZone,
      dateFrom: input.dateFrom,
      dateTo: input.dateTo,
      staffId: input.staffId,
    };
  }

  private assertRange(dateFrom: string, dateTo: string): void {
    if (!LOCAL_DATE_PATTERN.test(dateFrom))
      throw new BadRequestException('dateFrom 必须是 YYYY-MM-DD（店内本地日）');
    if (!LOCAL_DATE_PATTERN.test(dateTo))
      throw new BadRequestException('dateTo 必须是 YYYY-MM-DD（店内本地日）');
    if (dateFrom > dateTo)
      throw new BadRequestException('dateFrom 不能晚于 dateTo');
  }

  private async timeZone(): Promise<string> {
    const { timezone } = await this.config.booking();
    return timezone;
  }

  /** 店内本地日区间（含两端）→ 绝对时刻条件 */
  private dayRange(column: MySqlColumn, q: ResolvedQuery): SQL {
    return must(localDateRange(column, q.dateFrom, q.dateTo, q.timeZone));
  }

  private rangeStart(q: ResolvedQuery): Date {
    return shopDayRange(q.dateFrom, q.timeZone).start;
  }

  private rangeEnd(q: ResolvedQuery): Date {
    return shopDayRange(addLocalDays(q.dateTo, 1), q.timeZone).start;
  }

  /** 一次查询内的本地日换算（含 DST 的正确做法，禁用 UTC 截断） */
  private localDay(value: Date, timeZone: string): string {
    return shopDateOf(value, timeZone);
  }

  private paymentRows(q: ResolvedQuery) {
    return this.database.db
      .select({
        id: bizPayments.id,
        bookingId: bizPayments.bookingId,
        purpose: bizPayments.purpose,
        channel: bizPayments.channel,
        receivedAmount: bizPayments.receivedAmount,
        paidAt: bizPayments.paidAt,
        createdAt: bizPayments.createdAt,
      })
      .from(bizPayments)
      .where(
        andConditions([
          inArray(bizPayments.status, PAID_PAYMENT_STATUSES),
          isNull(bizPayments.deletedAt),
          must(
            or(
              this.dayRange(bizPayments.paidAt, q),
              and(
                isNull(bizPayments.paidAt),
                this.dayRange(bizPayments.createdAt, q),
              ),
            ),
          ),
          q.channel
            ? inArray(bizPayments.channel, channelsOf(q.channel))
            : undefined,
          q.purpose ? eq(bizPayments.purpose, q.purpose) : undefined,
          q.staffId
            ? inArray(
                bizPayments.bookingId,
                this.database.db
                  .select({ id: bizBookings.id })
                  .from(bizBookings)
                  .where(eq(bizBookings.staffId, q.staffId)),
              )
            : undefined,
        ]),
      );
  }

  private refundRows(q: ResolvedQuery) {
    return this.database.db
      .select({
        id: bizRefunds.id,
        bookingId: bizRefunds.bookingId,
        actualAmount: bizRefunds.actualAmount,
        refundedAt: bizRefunds.refundedAt,
        createdAt: bizRefunds.createdAt,
      })
      .from(bizRefunds)
      .where(
        andConditions([
          eq(bizRefunds.status, 'success'),
          isNull(bizRefunds.deletedAt),
          must(
            or(
              this.dayRange(bizRefunds.refundedAt, q),
              and(
                isNull(bizRefunds.refundedAt),
                this.dayRange(bizRefunds.createdAt, q),
              ),
            ),
          ),
          q.channel
            ? inArray(
                bizRefunds.paymentId,
                this.database.db
                  .select({ id: bizPayments.id })
                  .from(bizPayments)
                  .where(inArray(bizPayments.channel, channelsOf(q.channel))),
              )
            : undefined,
          q.staffId
            ? inArray(
                bizRefunds.bookingId,
                this.database.db
                  .select({ id: bizBookings.id })
                  .from(bizBookings)
                  .where(eq(bizBookings.staffId, q.staffId)),
              )
            : undefined,
        ]),
      );
  }

  /** 预约单：营业日锚点 = `start_at`（服务开始的那一天） */
  private bookingRows(q: ResolvedQuery, options: { completedOnly?: boolean }) {
    return this.database.db
      .select({
        id: bizBookings.id,
        status: bizBookings.status,
        customerId: bizBookings.customerId,
        staffId: bizBookings.staffId,
        startAt: bizBookings.startAt,
        paidAmount: bizBookings.paidAmount,
        refundAmount: bizBookings.refundAmount,
      })
      .from(bizBookings)
      .where(
        andConditions([
          isNull(bizBookings.deletedAt),
          this.dayRange(bizBookings.startAt, q),
          options.completedOnly
            ? eq(bizBookings.status, 'completed')
            : undefined,
          q.staffId ? eq(bizBookings.staffId, q.staffId) : undefined,
          q.channel ? this.bookingChannelCondition(q.channel) : undefined,
        ]),
      );
  }

  /** 预约明细（已完成单）：金额来自单头派生的 paid/refund，按原价占比分摊 */
  private bookingItemRows(q: ResolvedQuery) {
    return this.database.db
      .select({
        bookingId: bizBookingItems.bookingId,
        serviceItemId: bizBookingItems.serviceItemId,
        name: bizBookingItems.name,
        price: bizBookingItems.price,
        originalPrice: bizBookings.originalPrice,
        paidAmount: bizBookings.paidAmount,
        refundAmount: bizBookings.refundAmount,
      })
      .from(bizBookingItems)
      .innerJoin(bizBookings, eq(bizBookingItems.bookingId, bizBookings.id))
      .where(
        andConditions([
          eq(bizBookings.status, 'completed'),
          isNull(bizBookings.deletedAt),
          this.dayRange(bizBookings.startAt, q),
          q.staffId ? eq(bizBookings.staffId, q.staffId) : undefined,
          q.channel ? this.bookingChannelCondition(q.channel) : undefined,
        ]),
      );
  }

  /** 该渠道有成功支付单的预约（`channel` 维度统一指支付渠道） */
  private bookingChannelCondition(channel: ReportChannel): SQL {
    return inArray(
      bizBookings.id,
      this.database.db
        .select({ id: bizPayments.bookingId })
        .from(bizPayments)
        .where(
          and(
            inArray(bizPayments.status, PAID_PAYMENT_STATUSES),
            inArray(bizPayments.channel, channelsOf(channel)),
            isNull(bizPayments.deletedAt),
          ),
        ),
    );
  }

  /** 会员流水（区间内）：充值 / 积分 / 结存增量的唯一事实来源 */
  private memberTransactionRows(q: ResolvedQuery) {
    return this.database.db
      .select({
        type: bizMemberTransactions.type,
        balanceDeltaPrincipal: bizMemberTransactions.balanceDeltaPrincipal,
        balanceDeltaBonus: bizMemberTransactions.balanceDeltaBonus,
        pointsDelta: bizMemberTransactions.pointsDelta,
        createdAt: bizMemberTransactions.createdAt,
      })
      .from(bizMemberTransactions)
      .where(this.dayRange(bizMemberTransactions.createdAt, q));
  }

  /** 区间期初余额（本金 + 赠送） */
  private async openingBalanceRows(q: ResolvedQuery): Promise<number> {
    const [row] = await this.database.db
      .select({
        principal: sum(bizMemberTransactions.balanceDeltaPrincipal),
        bonus: sum(bizMemberTransactions.balanceDeltaBonus),
      })
      .from(bizMemberTransactions)
      .where(lt(bizMemberTransactions.createdAt, this.rangeStart(q)));
    return toInt(row?.principal) + toInt(row?.bonus);
  }

  /** 余额增量流水（用于按日累计期末结存） */
  private balanceDeltaRows(q: ResolvedQuery) {
    return this.database.db
      .select({
        balanceDeltaPrincipal: bizMemberTransactions.balanceDeltaPrincipal,
        balanceDeltaBonus: bizMemberTransactions.balanceDeltaBonus,
        createdAt: bizMemberTransactions.createdAt,
      })
      .from(bizMemberTransactions)
      .where(this.dayRange(bizMemberTransactions.createdAt, q));
  }

  /**
   * 次卡核销记录（只追加）。
   *
   * 优先按「关联预约的营业日」判定区间（与项目排行同一锚点），
   * 没有关联预约的核销（散客核销）回落到核销发生时间。
   */
  private cardLogRows(q: ResolvedQuery) {
    return this.database.db
      .select({
        serviceItemId: bizMemberCardLogs.serviceItemId,
        type: bizMemberCardLogs.type,
        times: bizMemberCardLogs.times,
        createdAt: bizMemberCardLogs.createdAt,
      })
      .from(bizMemberCardLogs)
      .leftJoin(bizBookings, eq(bizMemberCardLogs.bookingId, bizBookings.id))
      .where(
        must(
          or(
            and(
              isNull(bizMemberCardLogs.bookingId),
              this.dayRange(bizMemberCardLogs.createdAt, q),
            ),
            and(
              eq(bizBookings.status, 'completed'),
              isNull(bizBookings.deletedAt),
              this.dayRange(bizBookings.startAt, q),
              q.staffId ? eq(bizBookings.staffId, q.staffId) : undefined,
              q.channel ? this.bookingChannelCondition(q.channel) : undefined,
            ),
          ),
        ),
      );
  }

  private async cardIssuedCount(q: ResolvedQuery): Promise<number> {
    const [row] = await this.database.db
      .select({ value: count() })
      .from(bizMemberCards)
      .where(
        andConditions([
          isNull(bizMemberCards.deletedAt),
          this.dayRange(bizMemberCards.purchasedAt, q),
        ]),
      );
    return toInt(row?.value);
  }
}

/* ------------------------------------------------------------------ *
 * CSV
 * ------------------------------------------------------------------ */

function netCardTimes(logs: { type: string; times: number }[]): number {
  return logs.reduce(
    (total, log) => total + (log.type === 'use' ? log.times : -log.times),
    0,
  );
}

function csvCell(value: string | number | null | undefined): string {
  const text = value === null || value === undefined ? '' : String(value);
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

/** 生成带 UTF-8 BOM 的 CSV（Excel 直接打开不乱码） */
export function buildCsv(
  header: string[],
  rows: (string | number)[][],
): string {
  const lines = [header, ...rows].map((row) => row.map(csvCell).join(','));
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}
