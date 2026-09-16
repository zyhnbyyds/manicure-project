<script setup lang="ts">
import { h, reactive, ref } from 'vue';
import { CheckCircle2, RotateCcw } from 'lucide-vue-next';
import dayjs from 'dayjs';
import {
  LewButton,
  LewMessage,
  LewModal,
  LewPagination,
  LewSelect,
  LewTable,
  LewTextarea,
} from 'lew-ui';
import type { LewTableColumn } from 'lew-ui';
import {
  fetchCommissionRecordSummary,
  reverseCommissionRecord,
  settleCommission,
} from '~/api/biz/commission-records';
import type { CommissionRecord } from '~/api/biz/commission-records';
import { listCommissionStaffOptions } from '~/api/biz/commission-rules';
import { useTable } from '~/composables/useTable';
import { formatDateTime } from '~/composables/useFormat';
import { confirmDanger } from '~/utils/confirm';
import IconButton from '~/components/IconButton.vue';

// ---------- 金额工具 ----------
function fen2yuan(value: number | null | undefined): string {
  if (value === null || value === undefined) return '-';
  return (value / 100).toFixed(2);
}

const STATUS_OPTIONS = [
  { label: '计提中', value: 'accrued' },
  { label: '已结算', value: 'settled' },
  { label: '已冲销', value: 'reversed' },
];

/** 最近 24 个月（value = YYYYMM，与后端 period 口径一致） */
const periodOptions = Array.from({ length: 24 }, (_, index) => {
  const month = dayjs().subtract(index, 'month');
  return { label: month.format('YYYY年MM月'), value: month.format('YYYYMM') };
});
const currentPeriod = dayjs().format('YYYYMM');

const staffOptions = reactive<{ label: string; value: string }[]>([]);
async function loadStaffs() {
  const data = await listCommissionStaffOptions();
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

// ---------- 列表 ----------
const query = ref<{ staffId?: string; period?: string; status?: string }>({});
const {
  items,
  loading,
  currentPage,
  pageSize,
  total,
  search,
  refresh,
  handleChange,
} = useTable<CommissionRecord>({
  url: '/biz/commission-records',
  query: () => query.value,
});

const columns: LewTableColumn[] = [
  { title: 'ID', field: 'id', width: 70 },
  {
    title: '关联预约',
    field: 'bookingId',
    width: 110,
    customRender: ({ row }) =>
      `#${(row as unknown as CommissionRecord).bookingId}`,
  },
  {
    title: '美甲师',
    field: 'staffName',
    width: 110,
    customRender: ({ row }) => {
      const record = row as unknown as CommissionRecord;
      return (
        record.staffName ??
        staffOptions.find((option) => option.value === String(record.staffId))
          ?.label ??
        `#${record.staffId}`
      );
    },
  },
  {
    title: '命中规则',
    field: 'ruleName',
    width: 150,
    customRender: ({ row }) => {
      const record = row as unknown as CommissionRecord;
      return (
        record.ruleName ??
        (record.ruleId ? `规则 #${record.ruleId}` : '未配置规则')
      );
    },
  },
  {
    title: '计提基数',
    field: 'baseAmount',
    width: 110,
    customRender: ({ row }) =>
      `¥${fen2yuan((row as unknown as CommissionRecord).baseAmount)}`,
  },
  {
    title: '计提金额',
    field: 'amount',
    width: 110,
    customRender: ({ row }) => {
      const record = row as unknown as CommissionRecord;
      const negative = record.amount < 0;
      return h(
        'span',
        {
          class: negative
            ? 'font-600 text-[var(--lew-color-error)]'
            : 'font-600 text-[var(--lew-color-primary)]',
        },
        `${negative ? '-' : ''}¥${fen2yuan(Math.abs(record.amount))}`,
      );
    },
  },
  { title: '期间', field: 'period', width: 100 },
  {
    title: '状态',
    field: 'status',
    width: 100,
    customRender: ({ row }) => {
      const status = (row as unknown as CommissionRecord).status;
      if (status === 'settled') {
        return h(
          'span',
          { class: 'text-[var(--lew-color-success)] font-600' },
          '已结算',
        );
      }
      if (status === 'reversed') {
        return h(
          'span',
          { class: 'text-[var(--app-text-muted)] line-through' },
          '已冲销',
        );
      }
      return h('span', { class: 'text-[var(--lew-color-warning)]' }, '计提中');
    },
  },
  {
    title: '结算批次',
    field: 'settleBatch',
    width: 150,
    customRender: ({ row }) =>
      (row as unknown as CommissionRecord).settleBatch ?? '-',
  },
  {
    title: '结算时间',
    field: 'settledAt',
    width: 165,
    customRender: ({ row }) =>
      formatDateTime((row as unknown as CommissionRecord).settledAt),
  },
  { title: '操作', field: 'operation', width: 80, fixed: 'right' },
];

void search();

// ---------- 期间汇总 ----------
const summaryPeriod = ref(currentPeriod);
const summaryLoading = ref(false);
const accruedStat = ref({ amount: 0, count: 0, staffCount: 0 });
const settledStat = ref({ amount: 0, count: 0 });

async function loadSummary() {
  summaryLoading.value = true;
  try {
    // 汇总一律由服务端聚合：前端拉列表求和会被单页上限截断而静默少算
    const summary = await fetchCommissionRecordSummary(summaryPeriod.value);
    accruedStat.value = {
      amount: summary.accrued.amount,
      count: summary.accrued.count,
      staffCount: summary.accrued.staffCount,
    };
    settledStat.value = {
      amount: summary.settled.amount,
      count: summary.settled.count,
    };
  } finally {
    summaryLoading.value = false;
  }
}
void loadSummary();

// ---------- 结算 ----------
const settling = ref(false);

async function openSettle() {
  /*
   * 防重（两个都必要）：
   * - `summaryLoading` 期间按钮已 loading，但 Vue 更新 DOM 是异步的，
   *   两次点击落在同一帧时第二次仍会进来 → 手工判断兜住这个窗口，
   *   否则会弹出两个确认框、发出两次结算。
   * - `settling` 覆盖「点确认 → 结算返回」的全过程。
   */
  if (settling.value || summaryLoading.value) return;
  const period = summaryPeriod.value;
  // 先取本期计提总额与人数，再二次确认
  await loadSummary();
  const stat = accruedStat.value;
  if (stat.count === 0) {
    LewMessage.info(`${period} 没有待结算的计提记录`);
    return;
  }
  confirmDanger({
    type: 'warning',
    title: `结算确认 · ${period}`,
    content: `本期计提总额 ¥${fen2yuan(stat.amount)}，涉及美甲师 ${stat.staffCount} 人、共 ${stat.count} 笔。\n结算后生成批次号并把记录置为「已结算」，之后不可修改，只能冲销。`,
    confirmText: '确认结算',
    confirmColor: 'warning',
    onConfirm: async () => {
      settling.value = true;
      try {
        const result = await settleCommission(period);
        LewMessage.success(
          `结算完成：批次 ${result.batch}，共 ${result.count} 笔，合计 ¥${fen2yuan(result.amount)}`,
        );
        await Promise.all([refresh(), loadSummary()]);
      } finally {
        settling.value = false;
      }
    },
  });
}

// ---------- 单笔冲销 ----------
const reverseVisible = ref(false);
const reverseTarget = ref<CommissionRecord | null>(null);
const reverseReason = ref('');

function openReverse(row: CommissionRecord) {
  reverseTarget.value = row;
  reverseReason.value = '';
  reverseVisible.value = true;
}

async function handleReverse() {
  const target = reverseTarget.value;
  if (!target) return;
  if (!reverseReason.value.trim()) {
    LewMessage.error('请填写冲销原因');
    return;
  }
  confirmDanger({
    type: 'warning',
    title: '冲销确认',
    content: `确定冲销该笔计提（¥${fen2yuan(target.amount)}）吗？记录不会被删除，状态置为「已冲销」；已结算期间发生的冲销进下一期为负数。`,
    confirmText: '冲销',
    onConfirm: async () => {
      await reverseCommissionRecord(target.id, reverseReason.value.trim());
      LewMessage.success('已冲销');
      reverseVisible.value = false;
      await Promise.all([refresh(), loadSummary()]);
    },
  });
}

function canReverse(row: CommissionRecord) {
  return row.status !== 'reversed';
}
</script>

<template>
  <div class="page-container">
    <!-- 页头 -->
    <div class="flex items-center justify-between">
      <div>
        <h2 class="page-title m-0">提成结算</h2>
        <p class="page-subtitle mt-1 mb-0">
          结算后不可修改，只能冲销；已结算期间的冲销进下一期为负数
        </p>
      </div>
      <LewButton
        v-permission="'biz:commission:settle'"
        type="fill"
        :loading="settling || summaryLoading"
        @click="openSettle"
      >
        <CheckCircle2 :size="15" style="margin-right: 4px" /> 结算本期
      </LewButton>
    </div>

    <!-- 期间汇总 -->
    <div class="app-card p-4">
      <div class="mb-3 flex flex-wrap items-center gap-3">
        <span class="text-14px font-600">期间汇总</span>
        <LewSelect
          v-model="summaryPeriod"
          width="170px"
          :options="periodOptions"
          @change="loadSummary"
        />
        <LewButton
          type="text"
          size="small"
          :loading="summaryLoading"
          @click="loadSummary"
          >刷新</LewButton
        >
        <span class="text-12px text-[var(--app-text-muted)]">
          金额单位：元 · 计提中涉及 {{ accruedStat.staffCount }} 人
        </span>
      </div>
      <div class="grid grid-cols-2 gap-3 md:grid-cols-4">
        <div class="rounded-8px border border-[var(--app-border)] p-3">
          <div class="text-12px text-[var(--app-text-muted)]">本期计提中</div>
          <div class="mt-1 text-18px font-700 text-[var(--lew-color-warning)]">
            ¥{{ fen2yuan(accruedStat.amount) }}
          </div>
          <div class="text-11.5px text-[var(--app-text-muted)]">
            {{ accruedStat.count }} 笔
          </div>
        </div>
        <div class="rounded-8px border border-[var(--app-border)] p-3">
          <div class="text-12px text-[var(--app-text-muted)]">本期已结算</div>
          <div class="mt-1 text-18px font-700 text-[var(--lew-color-success)]">
            ¥{{ fen2yuan(settledStat.amount) }}
          </div>
          <div class="text-11.5px text-[var(--app-text-muted)]">
            {{ settledStat.count }} 笔
          </div>
        </div>
        <div class="rounded-8px border border-[var(--app-border)] p-3">
          <div class="text-12px text-[var(--app-text-muted)]">涉及美甲师</div>
          <div class="mt-1 text-18px font-700">
            {{ accruedStat.staffCount }} 人
          </div>
          <div class="text-11.5px text-[var(--app-text-muted)]">
            仅统计计提中的记录
          </div>
        </div>
        <div class="rounded-8px border border-[var(--app-border)] p-3">
          <div class="text-12px text-[var(--app-text-muted)]">当前结算期间</div>
          <div class="mt-1 text-18px font-700">{{ summaryPeriod }}</div>
          <div class="text-11.5px text-[var(--app-text-muted)]">
            服务端实时聚合 · 不受分页影响
          </div>
        </div>
      </div>
    </div>

    <!-- 筛选 -->
    <div class="app-card flex flex-wrap items-center gap-3 p-4">
      <LewSelect
        v-model="query.staffId"
        width="170px"
        :options="staffOptions"
        placeholder="全部美甲师"
        clearable
      />
      <LewSelect
        v-model="query.period"
        width="170px"
        :options="periodOptions"
        placeholder="全部期间"
        clearable
      />
      <LewSelect
        v-model="query.status"
        width="140px"
        :options="STATUS_OPTIONS"
        placeholder="全部状态"
        clearable
      />
      <LewButton type="light" :loading="loading" @click="search()"
        >查询</LewButton
      >
    </div>

    <!-- 表格 -->
    <div class="app-card overflow-hidden">
      <LewTable
        :columns="columns"
        :data-source="items"
        :loading="loading"
        :focusable="false"
        size="small"
      >
        <template #operation="{ row }">
          <IconButton
            permission="biz:commission:settle"
            color="error"
            title="单笔冲销"
            :disabled="!canReverse(row as unknown as CommissionRecord)"
            @click="openReverse(row as unknown as CommissionRecord)"
          >
            <RotateCcw :size="14" />
          </IconButton>
        </template>
      </LewTable>

      <div class="flex justify-end p-3">
        <LewPagination
          v-model:current-page="currentPage"
          v-model:page-size="pageSize"
          :total="total"
          show-summary
          @change="handleChange"
        />
      </div>
    </div>

    <!-- 冲销弹窗 -->
    <LewModal v-model:visible="reverseVisible" title="单笔冲销" width="460px">
      <div class="flex flex-col gap-3 p-5">
        <div class="text-13.5px">
          计提记录
          <span class="font-600">#{{ reverseTarget?.id }}</span>
          ，金额
          <span class="font-600 text-[var(--lew-color-primary)]"
            >¥{{ fen2yuan(reverseTarget?.amount) }}</span
          >
          <span v-if="reverseTarget?.status === 'settled'">
            （已结算：冲销将进下一期为负数）
          </span>
        </div>
        <LewTextarea
          v-model="reverseReason"
          min-height="90px"
          placeholder="请填写冲销原因（必填）"
        />
        <div class="flex justify-end gap-2">
          <LewButton type="text" color="gray" @click="reverseVisible = false"
            >取消</LewButton
          >
          <LewButton
            v-permission="'biz:commission:settle'"
            type="fill"
            color="error"
            @click="handleReverse"
            >确认冲销</LewButton
          >
        </div>
      </div>
    </LewModal>
  </div>
</template>
