<!-- 幸福从来都不是什么轰轰烈烈的大事 -->
<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useEventListener } from '@vueuse/core';
import { useRouter } from 'vue-router';
import {
  AlertTriangle,
  CalendarClock,
  RefreshCw,
  Wallet,
} from 'lucide-vue-next';
import { LewButton, LewTable, LewTabs, LewTag } from 'lew-ui';
import type { LewTableColumn, LewTabsOption } from 'lew-ui';
import * as echarts from 'echarts/core';
import { BarChart, LineChart } from 'echarts/charts';
import {
  GridComponent,
  LegendComponent,
  TooltipComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import {
  HOME_RANGE_OPTIONS,
  HOME_REVENUE_CAVEAT,
  getHomeOverview,
} from '~/api/biz/home';
import type { HomeOverview, HomeRange, HomeStoreRow } from '~/api/biz/home';
import { useSettingsStore } from '~/store/settings';
import { useUserStore } from '~/store/user';
import { useStoreScopeStore } from '~/store/store-scope';
import { formatDateTime } from '~/composables/useFormat';
import AppLoading from '~/components/AppLoading.vue';

/**
 * 首页 = **经营概览**（按店）。
 *
 * ## 与旧版首页的关系
 *
 * 旧版是「系统运行概览」（用户/部门/角色/菜单/缓存/登录趋势）——那是**超管视角**，
 * 店长登进来看到的全是跟自己无关的数字。现在整页换成经营概览；
 * 系统运行那部分**已从首页移除**（要看系统状态去「系统监控」那几页）。
 *
 * ## 三条必须守住的口径（每条都有单测钉在 `home-overview.spec.ts`）
 *
 * 1. **净营收 = 实收 − 退款**，营业日按 `shopDayRange` 的店内本地日切（不是 UTC 截断）；
 * 2. **成单率 = 完成 ÷ (完成+取消+爽约)**，待确认/进行中的单不进分母 ——
 *    这就是产品口径里的「下单率」；
 * 3. **门店对比表恒看可见门店全量**（不受顶栏切换器影响），汇总卡与待办才跟随切换器。
 *
 * ## 前台看到的是「轻量版」
 *
 * 前台只有 `biz:report:home`：**服务端不下发任何金额字段**（`meta.money = false`）。
 * 所以金额卡片是「按 `money` 决定渲不渲染」，而不是 `v-if` 藏起来 ——
 * 藏起来会留下一排 `¥0.00`（看着像数据坏了），而且数字其实已经发出去了。
 */

echarts.use([
  CanvasRenderer,
  BarChart,
  LineChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
]);

const router = useRouter();
const userStore = useUserStore();
const settings = useSettingsStore();
const storeScope = useStoreScopeStore();

/** 全量版（含金额）或轻量版（单量 + 待办）都能打开这个页面 */
const canSeeHome = computed(() =>
  userStore.hasPermission(['biz:report:view', 'biz:report:home']),
);

const range = ref<HomeRange>('today');
const rangeOptions: LewTabsOption[] = HOME_RANGE_OPTIONS.map((item) => ({
  label: item.label,
  value: item.value,
}));

const loading = ref(true);
const data = ref<HomeOverview | null>(null);
const errorMessage = ref('');

const money = computed(() => data.value?.meta.money === true);

// ---------- 展示口径 ----------

/** 分 → 元（两位小数，不带符号） */
function fen2yuan(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return (value / 100).toFixed(2);
}

function yuan(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return `¥${(value / 100).toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function count(value: number | null | undefined): string {
  return (value ?? 0).toLocaleString('en-US');
}

/** 千分比整数 → 百分比文本；`null` = 分母为 0（显示「—」，不显示 0.0%） */
function percent(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return `${(value / 10).toFixed(1)}%`;
}

const PAY_STATUS_TEXT: Record<string, string> = {
  unpaid: '未收款',
  partial: '部分收款',
  paid: '已收清',
  refunded: '已退款',
  credit: '挂账',
};

/** 净营收环比文案（分 → 有符号元） */
const netDelta = computed(() => {
  const summary = data.value?.summary.money;
  if (!summary || summary.prevNet === null) return null;
  const diff = summary.net - summary.prevNet;
  if (diff === 0) return '与上期持平';
  return `${diff > 0 ? '+' : '-'}${fen2yuan(Math.abs(diff))}`;
});

const netDeltaTone = computed<'up' | 'down' | 'flat'>(() => {
  const summary = data.value?.summary.money;
  if (!summary || summary.prevNet === null) return 'flat';
  if (summary.net > summary.prevNet) return 'up';
  if (summary.net < summary.prevNet) return 'down';
  return 'flat';
});

const prevRangeLabel = computed(() => {
  const meta = data.value?.meta;
  if (!meta) return '上期';
  if (meta.range === 'today') return '较昨日';
  if (meta.range === 'month')
    return meta.prevSameLength ? '较上月同期' : '较上月（区间不等长）';
  return '较上一周期';
});

// ---------- 指标卡 ----------

interface StatCard {
  label: string;
  value: string;
  sub?: string;
  delta?: string | null;
  deltaTone?: 'up' | 'down' | 'flat';
  to?: string;
}

const statCards = computed<StatCard[]>(() => {
  const current = data.value;
  if (!current) {
    /*
     * 首屏骨架：卡片文案来自权限而不是数据，所以加载中先摆一排同名的占位卡 ——
     * 否则「一进来是空白、一秒后突然冒出 7 张卡」，看起来像页面坏了。
     */
    if (!loading.value) return [];
    return (
      userStore.hasPermission('biz:report:view')
        ? [
            '净营收',
            '完成单量',
            '成单率（下单率）',
            '预约单量',
            '客单价',
            '退款率',
          ]
        : [
            '完成单量',
            '成单率（下单率）',
            '预约单量',
            '爽约率',
            '新客 / 回头客',
            '今日预约',
          ]
    ).map((label) => ({ label, value: '—' }));
  }
  const { summary } = current;
  const cards: StatCard[] = [];

  if (summary.money) {
    cards.push({
      label: '净营收',
      value: yuan(summary.money.net),
      sub: `实收 ${yuan(summary.money.gross)} − 退款 ${yuan(summary.money.refund)}`,
      delta: netDelta.value,
      deltaTone: netDeltaTone.value,
    });
  }

  cards.push({
    label: '完成单量',
    value: `${count(summary.bookings.completed)} 单`,
    sub: `${prevRangeLabel.value} ${count(summary.bookings.prevCompleted)} 单 · 取消 ${count(summary.bookings.cancelled)} · 爽约 ${count(summary.bookings.noShow)}`,
  });

  cards.push({
    label: '成单率（下单率）',
    value: percent(summary.bookings.completedRatePermille),
    sub: `完成 ÷ (完成+取消+爽约) · 到店率 ${percent(summary.bookings.arriveRatePermille)}`,
  });

  cards.push({
    label: '预约单量',
    value: `${count(summary.bookings.created)} 单`,
    sub: `区间内新下的预约（含待确认 ${count(summary.bookings.pending)} 单）`,
  });

  if (summary.money) {
    cards.push({
      label: '客单价',
      value: yuan(summary.money.avgTicket),
      sub: '净营收 ÷ 完成单量',
    });
    cards.push({
      label: '退款率',
      value: percent(summary.money.refundRatePermille),
      sub: `退款 ${yuan(summary.money.refund)} ÷ 实收 ${yuan(summary.money.gross)} · 涉及 ${count(summary.money.refundCount)} 单`,
    });
    cards.push({
      label: '储值充值',
      value: yuan(summary.member?.rechargePrincipal),
      sub: `赠送 ${yuan(summary.member?.rechargeBonus)} · 按店（流水发生门店）`,
    });
  } else {
    cards.push({
      label: '爽约率',
      value: percent(summary.bookings.noShowRatePermille),
      sub: `取消率 ${percent(summary.bookings.cancelRatePermille)}`,
    });
    cards.push({
      label: '新客 / 回头客',
      value: `${count(summary.customers.newCustomers)} / ${count(summary.customers.returning)}`,
      sub: '首次完成落在区间内 = 新客',
    });
    cards.push({
      label: '今日预约',
      value: `${count(current.todo.todayBookings)} 单`,
      sub: `待确认 ${count(current.todo.pendingBookings)} 单 · 去预约列表`,
      to: '/biz/bookings',
    });
  }

  return cards;
});

// ---------- 待办 ----------

interface TodoCard {
  label: string;
  value: number;
  hint: string;
  to: string;
}

const todoCards = computed<TodoCard[]>(() => {
  const todo = data.value?.todo;
  if (!todo) return [];
  return [
    {
      label: '未付款',
      value: todo.unpaidPayments,
      hint: '一分没收的活单 → 预约列表（按未付款筛）',
      to: '/biz/bookings?payStatus=unpaid',
    },
    {
      label: '尾款未清',
      value: todo.partialPayments,
      hint: '收过定金/部分款 → 预约列表（按部分收款筛）',
      to: '/biz/bookings?payStatus=partial',
    },
    {
      label: '待审批退款',
      value: todo.pendingRefunds,
      hint: '申请与审批分离 → 退款审批（默认只看待审批）',
      to: '/biz/refunds',
    },
    {
      label: '待确认预约',
      value: todo.pendingBookings,
      hint: '小程序自助下单（今天及以后）→ 预约列表',
      to: '/biz/bookings?status=pending',
    },
  ];
});

const upcomingColumns: LewTableColumn[] = [
  { title: '时间', field: 'startAt', width: 82 },
  { title: '顾客', field: 'customerName', width: 108 },
  { title: '美甲师', field: 'staffName', width: 108 },
  { title: '单号', field: 'bookingNo' },
  { title: '收款', field: 'payStatus', width: 90 },
];

const upcoming = computed(() =>
  (data.value?.todo.upcoming ?? []).map((row) => ({
    ...row,
    startAt: formatDateTime(row.startAt, 'HH:mm'),
    payStatus: PAY_STATUS_TEXT[row.payStatus] ?? row.payStatus,
  })),
);

// ---------- 门店对比 ----------

const storeColumns = computed<LewTableColumn[]>(() => {
  const columns: LewTableColumn[] = [
    {
      title: '门店',
      field: 'name',
      width: 170,
      customRender: ({ row }) => {
        const store = row as unknown as HomeStoreRow;
        return store.isDefault ? `${store.name}（默认）` : store.name;
      },
    },
    { title: '预约', field: 'created', width: 78 },
    { title: '完成', field: 'completed', width: 78 },
    {
      title: '成单率',
      field: 'completedRatePermille',
      width: 90,
      customRender: ({ row }) =>
        percent((row as unknown as HomeStoreRow).completedRatePermille),
    },
  ];
  if (money.value) {
    columns.push(
      {
        title: '净营收',
        field: 'net',
        width: 128,
        customRender: ({ row }) => yuan((row as unknown as HomeStoreRow).net),
      },
      {
        title: '退款率',
        field: 'refundRatePermille',
        width: 96,
        customRender: ({ row }) =>
          percent((row as unknown as HomeStoreRow).refundRatePermille),
      },
    );
  }
  columns.push(
    { title: '待收款', field: 'pendingPayments', width: 88 },
    { title: '待审批退款', field: 'pendingRefunds', width: 106 },
    { title: '操作', field: 'operation', width: 96, fixed: 'right' },
  );
  return columns;
});

type StoreRowItem = HomeStoreRow & { total?: boolean };

/**
 * 门店对比表的行。
 *
 * 超管看全部门店时在最上面补一行「合计」：它的数字直接取汇总（而不是把各店加起来），
 * 这样「合计行 = 下方各店之和」这条对账等式能被肉眼验出来 —— 对不上就是分组漏了门店。
 */
const storeRows = computed<StoreRowItem[]>(() => {
  const current = data.value;
  if (!current) return [];
  const rows: StoreRowItem[] = [...current.stores];
  if (current.meta.storeScope === 'all' && current.stores.length > 1) {
    const sum = (pick: (row: HomeStoreRow) => number): number =>
      current.stores.reduce((total, row) => total + pick(row), 0);
    rows.unshift({
      storeId: 0,
      code: '',
      name: '全部门店（合计）',
      isDefault: false,
      created: sum((row) => row.created),
      completed: sum((row) => row.completed),
      cancelled: sum((row) => row.cancelled),
      noShow: sum((row) => row.noShow),
      pending: sum((row) => row.pending),
      completedRatePermille: current.summary.bookings.completedRatePermille,
      pendingPayments: sum((row) => row.pendingPayments),
      pendingRefunds: sum((row) => row.pendingRefunds),
      ...(money.value
        ? {
            net: current.summary.money?.net ?? 0,
            gross: current.summary.money?.gross ?? 0,
            refund: current.summary.money?.refund ?? 0,
            refundRatePermille:
              current.summary.money?.refundRatePermille ?? null,
          }
        : {}),
      total: true,
    });
  }
  return rows;
});

function switchStore(row: StoreRowItem) {
  storeScope.setActive(row.total ? null : row.storeId);
}

function isCurrentStore(row: StoreRowItem): boolean {
  const activeId = data.value?.meta.activeStoreId ?? null;
  return row.total ? activeId === null : activeId === row.storeId;
}

// ---------- 会员与次卡（存量类必须标「全店」） ----------

interface StockItem {
  label: string;
  value: string;
  /** `store` = 按店（流水发生门店）；`all` = 全店（存量与主体） */
  scope: 'store' | 'all';
}

const stockItems = computed<StockItem[]>(() => {
  const member = data.value?.summary.member;
  if (!member) return [];
  return [
    {
      label: '期末本金结存',
      value: yuan(member.balancePrincipalEnd),
      scope: 'all',
    },
    {
      label: '期末赠送结存',
      value: yuan(member.balanceBonusEnd),
      scope: 'all',
    },
    {
      label: '新增会员',
      value: `${count(data.value?.summary.customers.memberNew)} 人`,
      scope: 'all',
    },
    {
      label: '次卡发售',
      value: `${count(member.cardIssued)} 张`,
      scope: 'all',
    },
    {
      label: '储值充值',
      value: yuan(member.rechargePrincipal),
      scope: 'store',
    },
    { label: '储值赠送', value: yuan(member.rechargeBonus), scope: 'store' },
    { label: '积分发放', value: count(member.pointsIssued), scope: 'store' },
    { label: '积分抵扣', value: count(member.pointsSpent), scope: 'store' },
    {
      label: '次卡核销',
      value: `${count(member.cardUsedTimes)} 次`,
      scope: 'store',
    },
  ];
});

// ---------- 趋势图 ----------

const trendRef = ref<HTMLElement>();
let trendChart: ReturnType<typeof echarts.init> | null = null;

function chartVar(name: string, fallback: string): string {
  return (
    getComputedStyle(document.documentElement).getPropertyValue(name).trim() ||
    fallback
  );
}

function chartTheme() {
  const isDark = settings.isDark;
  return {
    text: chartVar('--app-text-secondary', isDark ? '#acacb8' : '#3c3c46'),
    axisLine: chartVar('--app-border', isDark ? '#32323a' : '#e4e4ef'),
    splitLine: chartVar('--app-bg-hover', isDark ? '#26262c' : '#f0f0f4'),
    primary: chartVar('--lew-color-primary', isDark ? '#78a8ff' : '#1a73e8'),
    success: chartVar('--lew-color-success', '#62c68c'),
    tooltipBg: chartVar('--app-bg-card', isDark ? '#1a1a1e' : '#ffffff'),
    tooltipBorder: chartVar('--app-border', isDark ? '#34343b' : '#e4e4e9'),
    tooltipText: chartVar('--app-text-primary', isDark ? '#f5f5f8' : '#101014'),
  };
}

/** 净营收（柱，仅金额版）+ 完成单量（线）；两个量纲所以双轴 */
function renderChart() {
  if (!trendChart) return;
  const current = data.value;
  const trend = current?.trend ?? [];
  const t = chartTheme();
  const withMoney = current?.meta.money === true;

  trendChart.setOption(
    {
      backgroundColor: 'transparent',
      textStyle: { color: t.text },
      grid: { left: 60, right: 52, top: 36, bottom: 28 },
      legend: { top: 0, textStyle: { color: t.text } },
      tooltip: {
        trigger: 'axis',
        backgroundColor: t.tooltipBg,
        borderColor: t.tooltipBorder,
        borderWidth: 1,
        textStyle: { color: t.tooltipText },
        extraCssText:
          'box-shadow: 0 2px 8px rgb(0 0 0 / 15%); border-radius: 8px;',
      },
      xAxis: {
        type: 'category',
        data: trend.map((item) => item.date.slice(5)),
        axisLine: { lineStyle: { color: t.axisLine } },
        axisLabel: { color: t.text },
      },
      yAxis: [
        {
          type: 'value',
          name: withMoney ? '净营收(元)' : '单量',
          nameTextStyle: { color: t.text },
          axisLabel: { color: t.text },
          splitLine: { lineStyle: { color: t.splitLine } },
        },
        ...(withMoney
          ? [
              {
                type: 'value',
                name: '完成单量',
                nameTextStyle: { color: t.text },
                axisLabel: { color: t.text },
                splitLine: { show: false },
              },
            ]
          : []),
      ],
      series: [
        ...(withMoney
          ? [
              {
                name: '净营收(元)',
                type: 'bar',
                yAxisIndex: 0,
                barMaxWidth: 18,
                data: trend.map((item) => (item.net ?? 0) / 100),
                itemStyle: { color: t.primary, borderRadius: [4, 4, 0, 0] },
              },
            ]
          : []),
        {
          name: '完成单量',
          type: 'line',
          smooth: true,
          yAxisIndex: withMoney ? 1 : 0,
          data: trend.map((item) => item.completed),
          lineStyle: { width: 2.5, color: t.success },
          itemStyle: { color: t.success },
        },
      ],
    },
    true,
  );
}

function handleResize() {
  trendChart?.resize();
}

watch(() => settings.isDark, renderChart);
watch(() => settings.primaryColor, renderChart);
useEventListener(window, 'resize', handleResize);

// 侧边栏折叠会改主区宽度但不触发 window resize，等过渡(200ms)结束后再自适应
let resizeTimer: number | undefined;
watch(
  () => settings.collapsed,
  () => {
    if (resizeTimer) window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(handleResize, 220);
  },
);

onUnmounted(() => {
  if (resizeTimer) window.clearTimeout(resizeTimer);
  trendChart?.dispose();
  trendChart = null;
});

// ---------- 加载 ----------

/**
 * `silent = true` 用于刷新 / 切门店 / 切区间：不回到骨架屏，只盖遮罩。
 *
 * 图表容器用 `v-show` 而不是 `v-if` —— `display:none` 的容器上 init/resize 会得到
 * 0×0 画布（首页的老坑），所以内容始终挂载，只在 `loading` 结束后重画。
 */
async function load(silent = false) {
  if (!canSeeHome.value) {
    loading.value = false;
    return;
  }
  if (!silent) loading.value = true;
  errorMessage.value = '';
  try {
    data.value = await getHomeOverview(range.value);
  } catch (error) {
    errorMessage.value =
      error instanceof Error ? error.message : '经营概览加载失败';
    data.value = null;
  } finally {
    loading.value = false;
    // 先关 loading（骨架屏退场、容器有了真实宽高）再画图
    await nextTick();
    if (trendRef.value) {
      if (!trendChart) trendChart = echarts.init(trendRef.value);
      renderChart();
    }
  }
}

onMounted(() => {
  void load();
});

/** 区间切换：`LewTabs` 的 `@change` 在 lew-ui 2.8.2 恒不触发，只能盯 `v-model` */
watch(range, () => {
  void load(true);
});

/**
 * 顶栏门店切换器 → 整页重拉。
 *
 * 首页不是列表页（没有 `useTable` 帮忙自动重载），必须自己接一次；
 * 不接就是「切到 B 店，营收还是全公司的」—— 数字错了最难被发现。
 */
watch(
  () => storeScope.activeStoreId,
  () => {
    void load(true);
  },
);

const rangeLabel = computed(() => {
  const meta = data.value?.meta;
  if (!meta) return '';
  return meta.dateFrom === meta.dateTo
    ? meta.dateFrom
    : `${meta.dateFrom} ~ ${meta.dateTo}`;
});
</script>

<template>
  <div class="flex flex-col gap-4">
    <!-- 页头 -->
    <div class="flex flex-wrap items-end justify-between gap-3">
      <div>
        <p class="page-subtitle mt-1 mb-0">
          <template v-if="canSeeHome">
            经营概览 ·
            <span class="font-600">{{
              data?.meta.activeStoreName ?? '全部门店'
            }}</span>
            · {{ rangeLabel }} · {{ HOME_REVENUE_CAVEAT }}
          </template>
          <template v-else>欢迎回来</template>
        </p>
      </div>
      <div v-if="canSeeHome" class="flex items-center gap-2">
        <LewTabs v-model="range" :options="rangeOptions" type="block" round />
        <LewButton type="light" :loading="loading" @click="load(true)">
          <RefreshCw :size="14" style="margin-right: 4px" />刷新
        </LewButton>
      </div>
    </div>

    <!-- 无权限：不是错误，只是这个角色不该看经营数据 -->
    <div v-if="!canSeeHome" class="app-card p-8 text-center">
      <div class="text-15px font-600">当前角色没有经营概览权限</div>
      <p class="mt-2 mb-0 text-13px text-[var(--app-text-muted)]">
        经营概览需要「首页-经营概览（轻量）」或「报表中心-查看」权限。
        美甲师的日常在小程序工作台（我的预约 / 排班 / 评价 /
        提成），后台只用于只读查询。
      </p>
    </div>

    <template v-else>
      <!-- 加载失败（最常见原因：账号还没分配门店 → 403） -->
      <div v-if="errorMessage" class="app-card p-6">
        <div class="flex items-center gap-2 text-[var(--lew-color-danger)]">
          <AlertTriangle :size="16" />
          <span class="font-600">经营概览加载失败</span>
        </div>
        <p class="mt-2 mb-3 text-13px text-[var(--app-text-muted)]">
          {{ errorMessage }}
        </p>
        <LewButton type="light" size="small" @click="load()">重试</LewButton>
      </div>

      <template v-else>
        <!-- 指标卡 -->
        <div class="grid grid-cols-2 gap-4 lg:grid-cols-3 xl:grid-cols-6">
          <div
            v-for="card in statCards"
            :key="card.label"
            class="app-card flex flex-col gap-2 p-5"
            :class="card.to ? 'cursor-pointer' : ''"
            @click="card.to ? router.push(card.to) : undefined"
          >
            <AppLoading
              class="flex flex-col gap-2"
              variant="skeleton"
              :rows="2"
              min-height="72px"
              :loading="loading"
            >
              <span class="text-13px text-[var(--app-text-muted)]">{{
                card.label
              }}</span>
              <span class="text-22px font-700 tracking--2%">{{
                card.value
              }}</span>
              <span
                v-if="card.delta"
                class="text-12px font-600"
                :class="
                  card.deltaTone === 'up'
                    ? 'tag-success'
                    : card.deltaTone === 'down'
                      ? 'tag-failure'
                      : 'text-[var(--app-text-muted)]'
                "
                >{{ card.delta }}</span
              >
              <span
                v-if="card.sub"
                class="text-11.5px leading-4 text-[var(--app-text-muted)]"
                >{{ card.sub }}</span
              >
            </AppLoading>
          </div>
        </div>

        <!-- 趋势 + 待办 -->
        <div class="grid grid-cols-1 gap-4 xl:grid-cols-3">
          <AppLoading
            class="app-card p-5 xl:col-span-2"
            variant="overlay"
            text="加载趋势…"
            :loading="loading"
          >
            <h3 class="mt-0 mb-3 text-15px font-600">
              近 14 日趋势（店内本地日）
            </h3>
            <div ref="trendRef" class="h-260px" />
          </AppLoading>

          <div class="app-card flex flex-col gap-3 p-5">
            <h3 class="mt-0 mb-0 text-15px font-600">
              待办
              <span class="text-12px font-400 text-[var(--app-text-muted)]"
                >（当前状态，不随区间变化）</span
              >
            </h3>
            <AppLoading
              class="flex flex-col gap-3"
              variant="skeleton"
              :rows="4"
              min-height="188px"
              :loading="loading"
            >
              <button
                v-for="item in todoCards"
                :key="item.label"
                type="button"
                class="flex cursor-pointer items-center justify-between rounded-8px border border-[var(--app-border)] px-3 py-2 text-left transition-colors hover:bg-[var(--app-bg-hover)]"
                @click="router.push(item.to)"
              >
                <span class="flex flex-col">
                  <span class="text-13px font-600">{{ item.label }}</span>
                  <span class="text-11.5px text-[var(--app-text-muted)]">{{
                    item.hint
                  }}</span>
                </span>
                <span
                  class="text-20px font-700"
                  :class="item.value > 0 ? '' : 'text-[var(--app-text-muted)]'"
                  >{{ count(item.value) }}</span
                >
              </button>
            </AppLoading>

            <div class="mt-1 border-t border-[var(--app-border)] pt-3">
              <div class="mb-2 flex items-center gap-1 text-13px font-600">
                <CalendarClock :size="14" />
                今天接下来
                <span class="text-11.5px font-400 text-[var(--app-text-muted)]"
                  >今日共 {{ count(data?.todo.todayBookings) }} 单</span
                >
              </div>
              <LewTable
                :columns="upcomingColumns"
                :data-source="upcoming"
                :loading="loading"
                size="small"
                :focusable="false"
              >
                <!-- lew-ui 的「空态」是**插槽**：`empty-text` 属性不存在，写了也不生效 -->
                <template #empty>今天没有待服务的预约</template>
              </LewTable>
            </div>
          </div>
        </div>

        <!-- 门店对比 -->
        <div v-if="storeRows.length > 1" class="app-card p-5 pb-3">
          <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h3 class="m-0 text-15px font-600">
              门店对比
              <span class="text-12px font-400 text-[var(--app-text-muted)]"
                >（恒为可见门店全量，不受顶栏切换影响）</span
              >
            </h3>
            <span class="text-11.5px text-[var(--app-text-muted)]">
              <Wallet
                :size="12"
                style="display: inline; vertical-align: -2px"
              />
              点「查看」把整个首页切到那家店
            </span>
          </div>
          <LewTable
            :columns="storeColumns"
            :data-source="storeRows"
            :loading="loading"
            :focusable="false"
            size="small"
          >
            <template #operation="{ row }">
              <LewButton
                v-if="!isCurrentStore(row as unknown as StoreRowItem)"
                type="text"
                size="small"
                @click="switchStore(row as unknown as StoreRowItem)"
              >
                查看
              </LewButton>
              <LewTag v-else type="light" size="small" color="primary"
                >当前</LewTag
              >
            </template>
          </LewTable>
        </div>

        <!-- 会员与次卡：存量类必须标「全店」，否则店长会以为切店后这些数字也是本店的 -->
        <div v-if="money && stockItems.length" class="app-card p-5">
          <div class="mb-3 flex flex-wrap items-center gap-2">
            <h3 class="m-0 text-15px font-600">会员与次卡</h3>
            <span class="text-11.5px text-[var(--app-text-muted)]">
              储值余额是全店通兑的一个池子：结存、新增会员、次卡发售是全店口径；
              充值 / 积分 / 核销按流水发生门店
            </span>
          </div>
          <div class="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
            <div
              v-for="item in stockItems"
              :key="item.label"
              class="relative rounded-8px border border-[var(--app-border)] p-3"
            >
              <div class="text-12px text-[var(--app-text-muted)]">
                {{ item.label }}
              </div>
              <div class="mt-1 text-17px font-700">{{ item.value }}</div>
              <LewTag
                class="absolute top-2 right-2"
                type="light"
                size="small"
                :color="item.scope === 'all' ? 'primary' : 'success'"
                :title="
                  item.scope === 'all'
                    ? '全店口径：不随门店筛选变化（资产池全店通兑 / 无门店归属）'
                    : '按店口径：只统计发生在当前门店的部分'
                "
                >{{ item.scope === 'all' ? '全店' : '按店' }}</LewTag
              >
            </div>
          </div>
        </div>

        <p class="mb-0 text-11.5px text-[var(--app-text-muted)]">
          数据生成于 {{ formatDateTime(data?.meta.generatedAt) }} · 营业日按
          {{ data?.meta.timeZone ?? 'Asia/Shanghai' }} 切分 · 成单率 = 完成 ÷
          (完成 + 取消 + 爽约)
        </p>
      </template>
    </template>
  </div>
</template>
