<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { Download } from 'lucide-vue-next';
import dayjs from 'dayjs';
import {
  LewButton,
  LewDatePicker,
  LewMessage,
  LewSelect,
  LewTable,
  LewTag,
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
import { useStoreScopeStore } from '~/store/store-scope';
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

/** 顶栏的门店切换器（多店才显示；单店期看不到，也不会多一次重拉） */
const storeScope = useStoreScopeStore();

/**
 * 切门店 → 整页重拉。
 *
 * 报表不走 `useTable`（一个页签一张表，另有汇总卡），所以这里单独接一次；
 * 不接就会出「切到 B 店，营收还是全公司的」—— 报表数字错了最难被发现。
 */
watch(
  () => storeScope.activeStoreId,
  () => {
    void load();
  },
);

/**
 * 页签切换 → 重新拉数据。
 *
 * **不要指望 `LewTabs` 的 `change` 事件**：lew-ui 2.8.2 的实现里先把本地值同步成新值、
 * 再比较「旧值 ≠ 新值」才 emit，结果那个条件恒不成立 —— 事件永远不会触发
 * （表现就是「页签高亮切了、内容没变」）。所以这里以 `v-model`（`tab`）的变化为准。
 */
watch(tab, () => {
  void load();
});

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

// ---------- 列描述（字段路径以后端 `ReportsService` 的类型为准，响应已展平成点号路径） ----------
interface ReportColumn {
  title: string;
  /** 后端字段路径，支持 `buckets.0-30` 这种点号路径（响应已展平） */
  keys: string[];
  kind?: 'text' | 'money' | 'number' | 'percent';
  width?: number;
  /** `true` = 全店口径：不随门店筛选变化（见 `OverviewMeta.globalScope`） */
  globalScope?: boolean;
}
interface OverviewMeta {
  label: string;
  keys: string[];
  kind: 'money' | 'number';
  /**
   * `true` = **全店口径**：不随门店筛选变化。
   *
   * 会员资产存量（余额结存）以及仍无门店归属的新增会员 / 次卡发售是全店口径。
   * 充值与积分等流水发生额已经能按发生门店统计；资产池本身仍全店通兑，不能伪造「A 店余额」。
   */
  globalScope?: boolean;
}
interface TabMeta {
  mode: 'summary' | 'table';
  columns?: ReportColumn[];
  overview?: OverviewMeta[];
  /** 整页签都是全店口径时的说明（会员报表：大部分指标无门店归属） */
  globalScopeNote?: string;
}

const OVERVIEW_META: OverviewMeta[] = [
  { label: '净营收', keys: ['revenue.net'], kind: 'money' },
  { label: '毛收入', keys: ['revenue.gross'], kind: 'money' },
  { label: '退款', keys: ['revenue.refund'], kind: 'money' },
  { label: '完成单量', keys: ['bookings.completed'], kind: 'number' },
  { label: '客单价', keys: ['revenue.avgTicket'], kind: 'money' },
  { label: '预约总数', keys: ['bookings.total'], kind: 'number' },
  { label: '取消单量', keys: ['bookings.cancelled'], kind: 'number' },
  { label: '爽约单量', keys: ['bookings.noShow'], kind: 'number' },
  { label: '未完成（待处理）', keys: ['bookings.pending'], kind: 'number' },
  { label: '新客数', keys: ['customers.newCustomers'], kind: 'number' },
  { label: '回头客数', keys: ['customers.returning'], kind: 'number' },
  // 新增会员无归属门店，仍是全店口径；充值/积分流水已按发生门店统计
  {
    label: '新增会员',
    keys: ['customers.memberNew'],
    kind: 'number',
    globalScope: true,
  },
  {
    label: '储值充值',
    keys: ['member.rechargePrincipal'],
    kind: 'money',
  },
  {
    label: '储值赠送',
    keys: ['member.rechargeBonus'],
    kind: 'money',
  },
  {
    label: '期末本金结存',
    keys: ['member.balancePrincipalEnd'],
    kind: 'money',
    globalScope: true,
  },
  {
    label: '期末赠送结存',
    keys: ['member.balanceBonusEnd'],
    kind: 'money',
    globalScope: true,
  },
  {
    label: '积分发放',
    keys: ['member.pointsIssued'],
    kind: 'number',
  },
  {
    label: '积分抵扣',
    keys: ['member.pointsSpent'],
    kind: 'number',
  },
  // 次卡核销能归属到门店（顺关联预约找），所以不是全店口径
  { label: '次卡核销', keys: ['member.cardUsedTimes'], kind: 'number' },
  {
    label: '次卡发售',
    keys: ['member.cardIssued'],
    kind: 'number',
    globalScope: true,
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
  members: {
    mode: 'table',
    globalScopeNote:
      '会员资产仍全店通兑：充值/积分/次卡核销按发生门店统计；期末结存、新增会员仍是全店口径',
    columns: [
      { title: '期间', keys: ['period'], kind: 'text', width: 140 },
      {
        title: '新增会员',
        keys: ['newMembers'],
        kind: 'number',
        width: 110,
        globalScope: true,
      },
      {
        title: '储值本金',
        keys: ['recharge'],
        kind: 'money',
        width: 120,
      },
      {
        title: '储值赠送',
        keys: ['bonus'],
        kind: 'money',
        width: 120,
      },
      {
        title: '期末结存',
        keys: ['balanceEnd'],
        kind: 'money',
        width: 130,
        globalScope: true,
      },
      {
        title: '积分发放',
        keys: ['pointsIssued'],
        kind: 'number',
        width: 110,
      },
      {
        title: '积分抵扣',
        keys: ['pointsSpent'],
        kind: 'number',
        width: 110,
      },
      { title: '次卡核销', keys: ['cardUsed'], kind: 'number', width: 110 },
    ],
  },
  revenue: {
    mode: 'table',
    columns: [
      { title: '期间', keys: ['period'], kind: 'text', width: 140 },
      { title: '毛收入', keys: ['gross'], kind: 'money', width: 120 },
      { title: '退款', keys: ['refund'], kind: 'money', width: 120 },
      { title: '净营收', keys: ['net'], kind: 'money', width: 130 },
      { title: '现金', keys: ['cash'], kind: 'money', width: 110 },
      { title: '微信', keys: ['wechat'], kind: 'money', width: 110 },
      { title: '支付宝', keys: ['alipay'], kind: 'money', width: 110 },
      { title: '储值余额', keys: ['balance'], kind: 'money', width: 120 },
      { title: '销账实收', keys: ['creditSettled'], kind: 'money', width: 120 },
      { title: '完成单量', keys: ['count'], kind: 'number', width: 100 },
    ],
  },
  services: {
    mode: 'table',
    columns: [
      { title: '项目', keys: ['name'], kind: 'text', width: 180 },
      { title: '次数', keys: ['times'], kind: 'number', width: 100 },
      { title: '金额', keys: ['amount'], kind: 'money', width: 130 },
      {
        title: '次卡核销次数',
        keys: ['cardTimes'],
        kind: 'number',
        width: 130,
      },
      {
        title: '次卡核销占比',
        keys: ['cardRatio'],
        kind: 'percent',
        width: 130,
      },
    ],
  },
  staffs: {
    mode: 'table',
    columns: [
      { title: '美甲师', keys: ['nickname'], kind: 'text', width: 140 },
      { title: '完成单量', keys: ['bookings'], kind: 'number', width: 110 },
      { title: '净营收分摊', keys: ['amount'], kind: 'money', width: 130 },
      { title: '提成', keys: ['commission'], kind: 'money', width: 120 },
      { title: '平均评分', keys: ['avgScore'], kind: 'number', width: 110 },
      { title: '评价数', keys: ['reviewCount'], kind: 'number', width: 100 },
    ],
  },
  receivables: {
    mode: 'table',
    columns: [
      { title: '挂账主体', keys: ['name'], kind: 'text', width: 160 },
      { title: '额度', keys: ['creditLimit'], kind: 'money', width: 120 },
      { title: '已挂未结', keys: ['outstanding'], kind: 'money', width: 130 },
      // 账龄是嵌套对象，取展平后的路径
      { title: '0-30 天', keys: ['buckets.0-30'], kind: 'money', width: 120 },
      { title: '31-60 天', keys: ['buckets.31-60'], kind: 'money', width: 120 },
      { title: '60 天以上', keys: ['buckets.60+'], kind: 'money', width: 120 },
      { title: '逾期金额', keys: ['overdueAmount'], kind: 'money', width: 120 },
    ],
  },
};

// 兜底：万一拿到非法页签名，也不要把整页渲染成空白（用概览的列描述顶着）
const currentMeta = computed(() => TAB_META[tab.value] ?? TAB_META.overview);

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
      /** 会员资产类指标：全店口径，必须在卡片上标出来（见 OverviewMeta.globalScope） */
      globalScope: meta.globalScope === true,
    }));
});

/** 概览 / 会员：未被口径覆盖的剩余标量字段（原样展示，避免漏字段） */
const leftoverScalars = computed(() => {
  const scalars = reportScalars(payload.value);
  if (!scalars) return [];
  const known = new Set(
    [
      ...OVERVIEW_META.flatMap((meta) => meta.keys),
      // 营收口径的完成单量与「完成单量」卡片同义（只是锚点不同：支付日 vs 服务开始日），
      // 不再重复列一行 —— 它含 "revenue"，落到这里会被当成金额显示成 ¥0.00
      'revenue.count',
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
            v-if="storeScope.hasSwitcher"
            class="mr-2 rounded-6px bg-[var(--lew-color-primary-light)] px-2 py-0.5 font-600 text-[var(--lew-color-primary)]"
            title="报表按顶栏选中的门店统计（店长固定只看自己门店）；带「全店」标记的指标不随门店筛选变化"
            >统计口径：{{ storeScope.activeLabel }}</span
          >
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
        <LewTabs v-model="tab" :options="tabOptions" type="block" round />
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
              class="relative rounded-8px border border-[var(--app-border)] p-3"
            >
              <div class="text-12px text-[var(--app-text-muted)]">
                {{ card.label }}
              </div>
              <div class="mt-1 text-18px font-700">{{ card.value }}</div>
              <LewTag
                v-if="card.globalScope"
                class="absolute right-2 top-2"
                type="light"
                size="small"
                title="会员资产全店通兑：这项是全店口径，不随门店筛选变化"
                >全店</LewTag
              >
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
        <div
          v-if="currentMeta.globalScopeNote"
          class="mx-4 mt-3 rounded-6px bg-[var(--lew-color-warning-light)] px-3 py-2 text-12px text-[var(--lew-color-warning)]"
        >
          {{ currentMeta.globalScopeNote }}
        </div>
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
