<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import { Download } from 'lucide-vue-next';
import dayjs from 'dayjs';
import {
  LewButton,
  LewDatePicker,
  LewMessage,
  LewSelect,
  LewTable,
  LewTabs,
} from 'lew-ui';
import type { LewTableColumn, LewTabsOption } from 'lew-ui';
import {
  REPORT_TABS,
  REVENUE_CAVEAT,
  exportReport,
  getReport,
  reportNumber,
  reportRows,
  reportScalars,
  reportText,
} from '~/api/biz/reports';
import type {
  ReportGranularity,
  ReportPayload,
  ReportTabKey,
} from '~/api/biz/reports';
import { listStaffOptions } from '~/api/biz/reviews';
import { formatDateTime } from '~/composables/useFormat';

// ---------- 金额工具 ----------
function fen2yuan(value: number | null | undefined): string {
  if (value === null || value === undefined) return '-';
  return (value / 100).toFixed(2);
}

/** 百分比口径兼容：<=1 视为小数比例、<=100 视为百分数、>100 视为千分比 */
function formatPercent(value: number): string {
  if (!value) return '0.0';
  const percent = value <= 1 ? value * 100 : value <= 100 ? value : value / 10;
  return percent.toFixed(1);
}

// ---------- 查询条件 ----------
const tab = ref<ReportTabKey>('overview');
const dateFrom = ref(dayjs().startOf('month').format('YYYY-MM-DD'));
const dateTo = ref(dayjs().format('YYYY-MM-DD'));
const granularity = ref<ReportGranularity>('day');
const staffId = ref<string | undefined>(undefined);
const channel = ref<string | undefined>(undefined);

const tabOptions: LewTabsOption[] = REPORT_TABS.map((item) => ({
  label: item.label,
  value: item.key,
}));
const GRANULARITY_OPTIONS = [
  { label: '按日', value: 'day' },
  { label: '按周', value: 'week' },
  { label: '按月', value: 'month' },
];
/** 营收拆渠道：支付渠道枚举（§9.8） */
const CHANNEL_OPTIONS = [
  { label: '现金', value: 'cash' },
  { label: '微信', value: 'wechat' },
  { label: '支付宝', value: 'alipay' },
  { label: '储值余额', value: 'balance' },
  { label: '次卡', value: 'card' },
  { label: '挂账', value: 'credit' },
];
const staffOptions = reactive<{ label: string; value: string }[]>([]);

async function loadStaffs() {
  const data = await listStaffOptions();
  staffOptions.splice(
    0,
    staffOptions.length,
    ...data.items.map((staff) => ({
      label: staff.nickname,
      value: String(staff.id),
    })),
  );
}
void loadStaffs();

function setQuickRange(kind: 'today' | 'month' | 'lastMonth' | 'last7') {
  if (kind === 'today') {
    dateFrom.value = dayjs().format('YYYY-MM-DD');
    dateTo.value = dayjs().format('YYYY-MM-DD');
  } else if (kind === 'month') {
    dateFrom.value = dayjs().startOf('month').format('YYYY-MM-DD');
    dateTo.value = dayjs().format('YYYY-MM-DD');
  } else if (kind === 'lastMonth') {
    const last = dayjs().subtract(1, 'month');
    dateFrom.value = last.startOf('month').format('YYYY-MM-DD');
    dateTo.value = last.endOf('month').format('YYYY-MM-DD');
  } else {
    dateFrom.value = dayjs().subtract(6, 'day').format('YYYY-MM-DD');
    dateTo.value = dayjs().format('YYYY-MM-DD');
  }
  void load();
}

// ---------- 数据加载 ----------
const payload = ref<ReportPayload | null>(null);
const loading = ref(false);
const exporting = ref(false);

async function load() {
  if (!dateFrom.value || !dateTo.value) {
    LewMessage.error('请选择日期区间');
    return;
  }
  loading.value = true;
  try {
    payload.value = await getReport(tab.value, {
      dateFrom: dateFrom.value,
      dateTo: dateTo.value,
      staffId: staffId.value || undefined,
      channel: channel.value || undefined,
      granularity: tab.value === 'revenue' ? granularity.value : undefined,
    });
  } finally {
    loading.value = false;
  }
}
void load();

function switchTab(value: unknown) {
  tab.value = value as ReportTabKey;
  void load();
}

// ---------- 导出 ----------
async function handleExport() {
  exporting.value = true;
  try {
    const filename = await exportReport({
      type: tab.value,
      dateFrom: dateFrom.value,
      dateTo: dateTo.value,
      format: 'csv',
      staffId: staffId.value || undefined,
      channel: channel.value || undefined,
      granularity: tab.value === 'revenue' ? granularity.value : undefined,
    });
    LewMessage.success(`已导出 ${filename}`);
  } finally {
    exporting.value = false;
  }
}

// ---------- 列描述（字段名兼容 camelCase / snake_case） ----------
interface ReportColumn {
  title: string;
  keys: string[];
  kind?: 'text' | 'money' | 'number' | 'percent';
  width?: number;
}
interface OverviewMeta {
  label: string;
  keys: string[];
  kind: 'money' | 'number';
}
interface TabMeta {
  mode: 'summary' | 'table';
  columns?: ReportColumn[];
  overview?: OverviewMeta[];
}

const OVERVIEW_META: OverviewMeta[] = [
  {
    label: '净营收',
    keys: ['netRevenue', 'net_revenue', 'revenue'],
    kind: 'money',
  },
  {
    label: '完成单量',
    keys: ['completedCount', 'completed_count', 'orderCount', 'order_count'],
    kind: 'number',
  },
  {
    label: '客单价',
    keys: ['avgOrderAmount', 'avg_order_amount', 'avgAmount'],
    kind: 'money',
  },
  {
    label: '新客数',
    keys: ['newCustomerCount', 'new_customer_count', 'newCustomers'],
    kind: 'number',
  },
  {
    label: '回头客数',
    keys: [
      'returningCustomerCount',
      'returning_customer_count',
      'returningCustomers',
    ],
    kind: 'number',
  },
  {
    label: '取消单量',
    keys: ['cancelledCount', 'cancelled_count'],
    kind: 'number',
  },
  { label: '爽约单量', keys: ['noShowCount', 'no_show_count'], kind: 'number' },
  {
    label: '新增会员',
    keys: ['newMemberCount', 'new_member_count', 'memberNewCount'],
    kind: 'number',
  },
  {
    label: '储值充值',
    keys: ['rechargeAmount', 'recharge_amount', 'balanceRecharge'],
    kind: 'money',
  },
  {
    label: '储值退款',
    keys: ['rechargeRefundAmount', 'recharge_refund_amount', 'balanceRefund'],
    kind: 'money',
  },
  {
    label: '余额结存',
    keys: ['balanceAmount', 'balance_amount', 'balanceBalance', 'balance'],
    kind: 'money',
  },
  {
    label: '次卡发售',
    keys: ['cardSoldCount', 'card_sold_count', 'cardIssuedCount'],
    kind: 'number',
  },
  {
    label: '次卡核销',
    keys: ['cardUsedCount', 'card_used_count', 'cardUseCount'],
    kind: 'number',
  },
  {
    label: '积分发放',
    keys: ['pointsIssued', 'points_issued'],
    kind: 'number',
  },
  {
    label: '积分抵扣',
    keys: ['pointsDeducted', 'points_deducted', 'pointsSpent'],
    kind: 'number',
  },
  {
    label: '积分兑换',
    keys: ['pointsRedeemed', 'points_redeemed'],
    kind: 'number',
  },
  {
    label: '积分结存',
    keys: ['pointsBalance', 'points_balance'],
    kind: 'number',
  },
];

const MEMBER_LABEL_MAP: Record<string, string> = {
  newMemberCount: '新增会员',
  new_member_count: '新增会员',
  rechargeAmount: '储值充值',
  recharge_amount: '储值充值',
  rechargeRefundAmount: '储值退款',
  recharge_refund_amount: '储值退款',
  balanceAmount: '余额结存',
  balance_amount: '余额结存',
  balancePrincipal: '本金结存',
  balance_principal: '本金结存',
  balanceBonus: '赠送结存',
  balance_bonus: '赠送结存',
  cardSoldCount: '次卡发售',
  card_sold_count: '次卡发售',
  cardUsedCount: '次卡核销',
  card_used_count: '次卡核销',
  cardRefundCount: '次卡退卡',
  card_refund_count: '次卡退卡',
  pointsIssued: '积分发放',
  points_issued: '积分发放',
  pointsSpent: '积分抵扣',
  points_spent: '积分抵扣',
  pointsRedeemed: '积分兑换',
  points_redeemed: '积分兑换',
  pointsBalance: '积分结存',
  points_balance: '积分结存',
};

const MONEY_HINT = /amount|revenue|price|balance|money|fee/i;

const TAB_META: Record<ReportTabKey, TabMeta> = {
  overview: { mode: 'summary', overview: OVERVIEW_META },
  members: { mode: 'summary' },
  revenue: {
    mode: 'table',
    columns: [
      {
        title: '期间',
        keys: ['period', 'date', 'bucket', 'label', 'day'],
        kind: 'text',
        width: 140,
      },
      { title: '渠道', keys: ['channel'], kind: 'text', width: 110 },
      {
        title: '实收',
        keys: ['paidAmount', 'paid_amount', 'receivedAmount', 'paymentAmount'],
        kind: 'money',
        width: 120,
      },
      {
        title: '退款',
        keys: ['refundAmount', 'refund_amount', 'refund'],
        kind: 'money',
        width: 120,
      },
      {
        title: '净营收',
        keys: ['netRevenue', 'net_revenue', 'netAmount', 'revenue', 'amount'],
        kind: 'money',
        width: 130,
      },
      {
        title: '完成单量',
        keys: ['orderCount', 'order_count', 'count', 'bookingCount'],
        kind: 'number',
        width: 100,
      },
    ],
  },
  services: {
    mode: 'table',
    columns: [
      {
        title: '项目',
        keys: ['name', 'serviceItemName', 'service_item_name'],
        kind: 'text',
        width: 180,
      },
      {
        title: '次数',
        keys: ['count', 'times', 'quantity', 'useCount'],
        kind: 'number',
        width: 100,
      },
      {
        title: '金额',
        keys: ['amount', 'totalAmount', 'netRevenue', 'revenue'],
        kind: 'money',
        width: 130,
      },
      {
        title: '次卡核销次数',
        keys: [
          'cardTimes',
          'card_times',
          'cardUseCount',
          'card_use_count',
          'cardUsedCount',
        ],
        kind: 'number',
        width: 130,
      },
      {
        title: '次卡核销占比',
        keys: [
          'cardRatio',
          'card_ratio',
          'cardPercent',
          'card_percent',
          'cardRatioPermille',
        ],
        kind: 'percent',
        width: 130,
      },
    ],
  },
  staffs: {
    mode: 'table',
    columns: [
      {
        title: '美甲师',
        keys: ['staffName', 'staff_name', 'nickname', 'name'],
        kind: 'text',
        width: 140,
      },
      {
        title: '完成单量',
        keys: ['orderCount', 'order_count', 'completedCount', 'count'],
        kind: 'number',
        width: 110,
      },
      {
        title: '净营收',
        keys: ['netRevenue', 'net_revenue', 'amount', 'revenue'],
        kind: 'money',
        width: 130,
      },
      {
        title: '提成',
        keys: ['commissionAmount', 'commission_amount', 'commission'],
        kind: 'money',
        width: 120,
      },
      {
        title: '平均评分',
        keys: ['avgScore', 'avg_score', 'averageScore', 'score'],
        kind: 'number',
        width: 110,
      },
    ],
  },
  receivables: {
    mode: 'table',
    columns: [
      {
        title: '挂账主体',
        keys: [
          'creditAccountName',
          'credit_account_name',
          'accountName',
          'name',
        ],
        kind: 'text',
        width: 160,
      },
      {
        title: '额度',
        keys: ['creditLimit', 'credit_limit', 'limit'],
        kind: 'money',
        width: 120,
      },
      {
        title: '已挂未结',
        keys: [
          'usedAmount',
          'used_amount',
          'unsettledAmount',
          'unsettled_amount',
        ],
        kind: 'money',
        width: 130,
      },
      {
        title: '0-30 天',
        keys: ['age0to30', 'age_0_30', 'due0to30', 'bucket0to30'],
        kind: 'money',
        width: 120,
      },
      {
        title: '31-60 天',
        keys: ['age31to60', 'age_31_60', 'due31to60', 'bucket31to60'],
        kind: 'money',
        width: 120,
      },
      {
        title: '60 天以上',
        keys: ['age60plus', 'age_60_plus', 'due60plus', 'bucket60plus'],
        kind: 'money',
        width: 120,
      },
      {
        title: '逾期金额',
        keys: ['overdueAmount', 'overdue_amount', 'overdue'],
        kind: 'money',
        width: 120,
      },
    ],
  },
};

const currentMeta = computed(() => TAB_META[tab.value]);

function hasAny(row: Record<string, unknown>, keys: string[]) {
  return keys.some(
    (key) => row[key] !== undefined && row[key] !== null && row[key] !== '',
  );
}

/** 概览页签：命中口径的指标卡（仅概览页签配置了 overview） */
const overviewCards = computed(() => {
  const scalars = reportScalars(payload.value);
  const metaList = currentMeta.value.overview ?? [];
  if (!scalars) return [];
  return metaList
    .filter((meta) => hasAny(scalars, meta.keys))
    .map((meta) => ({
      label: meta.label,
      value:
        meta.kind === 'money'
          ? `¥${fen2yuan(reportNumber(scalars, ...meta.keys))}`
          : String(reportNumber(scalars, ...meta.keys)),
    }));
});

/** 概览 / 会员：未被口径覆盖的剩余标量字段（原样展示，避免漏字段） */
const leftoverScalars = computed(() => {
  const scalars = reportScalars(payload.value);
  if (!scalars) return [];
  const known = new Set(
    [
      ...OVERVIEW_META.flatMap((meta) => meta.keys),
      ...Object.keys(MEMBER_LABEL_MAP),
    ].map((key) => key),
  );
  return Object.entries(scalars)
    .filter(([key]) => !known.has(key))
    .map(([key, value]) => ({
      label: MEMBER_LABEL_MAP[key] ?? key,
      value:
        typeof value === 'number' && MONEY_HINT.test(key)
          ? `¥${fen2yuan(value)}`
          : String(value),
    }));
});

const tableRows = computed(() => reportRows(payload.value));

function cellValue(row: Record<string, unknown>, column: ReportColumn) {
  if (column.kind === 'text') return reportText(row, ...column.keys);
  const value = reportNumber(row, ...column.keys);
  if (column.kind === 'money') return `¥${fen2yuan(value)}`;
  if (column.kind === 'percent') return `${formatPercent(value)}%`;
  return String(value);
}

const tableColumns = computed<LewTableColumn[]>(() =>
  (currentMeta.value.columns ?? []).map((column) => ({
    title: column.title,
    field: column.keys[0] ?? column.title,
    width: column.width,
    customRender: ({ row }) =>
      cellValue(row as Record<string, unknown>, column),
  })),
);

/** 空态提示：把后端原始键名暴露出来，便于核对口径 */
const rawKeys = computed(() => {
  const scalars = reportScalars(payload.value);
  if (scalars) return Object.keys(scalars);
  const first = tableRows.value[0];
  return first ? Object.keys(first) : [];
});
</script>

<template>
  <div class="page-container">
    <!-- 页头（必须标注营收口径） -->
    <div class="flex items-start justify-between">
      <div>
        <h2 class="page-title m-0">报表中心</h2>
        <p class="page-subtitle mt-1 mb-0">
          <span
            class="mr-2 rounded-6px bg-[var(--lew-color-warning-light)] px-2 py-0.5 font-600 text-[var(--lew-color-warning)]"
            >{{ REVENUE_CAVEAT }}</span
          >
          挂账下单不计营收，销账时才计入；次卡核销金额为 0 但计次数
        </p>
      </div>
      <LewButton
        v-permission="'biz:report:export'"
        type="fill"
        :loading="exporting"
        @click="handleExport"
      >
        <Download :size="15" style="margin-right: 4px" /> 导出 CSV
      </LewButton>
    </div>

    <!-- 统一日期区间 + 维度 -->
    <div class="app-card flex flex-wrap items-center gap-3 p-4">
      <LewDatePicker
        v-model="dateFrom"
        width="150px"
        value-format="YYYY-MM-DD"
        placeholder="开始日期"
        clearable
      />
      <span class="text-[var(--app-text-muted)]">~</span>
      <LewDatePicker
        v-model="dateTo"
        width="150px"
        value-format="YYYY-MM-DD"
        placeholder="结束日期"
        clearable
      />
      <LewButton type="text" size="small" @click="setQuickRange('today')"
        >今日</LewButton
      >
      <LewButton type="text" size="small" @click="setQuickRange('last7')"
        >近 7 天</LewButton
      >
      <LewButton type="text" size="small" @click="setQuickRange('month')"
        >本月</LewButton
      >
      <LewButton type="text" size="small" @click="setQuickRange('lastMonth')"
        >上月</LewButton
      >
      <span class="mx-1 h-20px w-1px bg-[var(--app-border)]" />
      <LewSelect
        v-model="staffId"
        width="160px"
        :options="staffOptions"
        placeholder="全部美甲师"
        clearable
      />
      <LewSelect
        v-model="channel"
        width="140px"
        :options="CHANNEL_OPTIONS"
        placeholder="全部渠道"
        clearable
      />
      <LewSelect
        v-if="tab === 'revenue'"
        v-model="granularity"
        width="120px"
        :options="GRANULARITY_OPTIONS"
        placeholder="粒度"
      />
      <LewButton type="light" :loading="loading" @click="load">查询</LewButton>
    </div>

    <!-- 分页签 -->
    <div class="app-card overflow-hidden">
      <div class="border-b border-[var(--app-border)] px-4 pt-3">
        <LewTabs
          :model-value="tab"
          :options="tabOptions"
          type="block"
          round
          @change="switchTab"
        />
      </div>

      <div v-if="loading" class="table-empty">加载中…</div>

      <!-- 概览 / 会员：指标卡 + 键值表 -->
      <template v-else-if="currentMeta.mode === 'summary'">
        <div class="p-4">
          <div
            v-if="overviewCards.length"
            class="grid grid-cols-2 gap-3 md:grid-cols-4"
          >
            <div
              v-for="card in overviewCards"
              :key="card.label"
              class="rounded-8px border border-[var(--app-border)] p-3"
            >
              <div class="text-12px text-[var(--app-text-muted)]">
                {{ card.label }}
              </div>
              <div class="mt-1 text-18px font-700">{{ card.value }}</div>
            </div>
          </div>

          <table class="table-base mt-4">
            <thead>
              <tr>
                <th class="table-th">指标</th>
                <th class="table-th">数值</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="item in leftoverScalars" :key="item.label">
                <td class="table-td">{{ item.label }}</td>
                <td class="table-td font-600">{{ item.value }}</td>
              </tr>
              <tr v-if="!leftoverScalars.length && !overviewCards.length">
                <td class="table-empty" colspan="2">该区间没有数据</td>
              </tr>
            </tbody>
          </table>

          <p
            v-if="rawKeys.length"
            class="mt-3 mb-0 text-11.5px text-[var(--app-text-muted)]"
          >
            后端返回字段：{{ rawKeys.join('、') }}
          </p>
        </div>
      </template>

      <!-- 明细页签 -->
      <template v-else>
        <LewTable
          :columns="tableColumns"
          :data-source="tableRows"
          :loading="loading"
          :focusable="false"
          size="small"
        />
        <div
          v-if="!tableRows.length"
          class="table-empty border-t border-[var(--app-border)]"
        >
          该区间没有数据
        </div>
        <p
          v-if="rawKeys.length"
          class="m-0 px-4 py-2 text-11.5px text-[var(--app-text-muted)]"
        >
          后端返回字段：{{ rawKeys.join('、') }}
        </p>
      </template>
    </div>

    <!-- 口径说明 -->
    <div class="app-card p-4 text-12.5px text-[var(--app-text-secondary)]">
      <div class="mb-1 font-600 text-[var(--app-text-primary)]">口径说明</div>
      <ul class="m-0 pl-5 leading-6">
        <li>
          营收 = Σ 成功支付实收金额 − Σ 成功退款金额（挂账在销账时才计入）。
        </li>
        <li>单量 = 状态为「已完成」的预约数；取消 / 爽约单量单列。</li>
        <li>客单价 = 净营收 ÷ 完成单量；新客 = 首次完成落在区间内。</li>
        <li>项目排行的次卡核销单独计数（金额为 0），占比列为核销次数占比。</li>
        <li>「营业日」按门店时区（默认自然日）切分，导出为 CSV。</li>
      </ul>
      <div class="mt-2 text-11.5px text-[var(--app-text-muted)]">
        数据时间：{{ formatDateTime(new Date()) }} · 当前页签：{{
          REPORT_TABS.find((item) => item.key === tab)?.label ?? tab
        }}
      </div>
    </div>
  </div>
</template>
