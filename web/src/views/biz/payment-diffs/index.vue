<script setup lang="ts">
import { computed, h, nextTick, ref } from 'vue';
import { RefreshCw, Wrench } from 'lucide-vue-next';
import {
  LewButton,
  LewDatePicker,
  LewForm,
  LewMessage,
  LewModal,
  LewPagination,
  LewSelect,
  LewTable,
} from 'lew-ui';
import type { LewFormOption, LewTableColumn } from 'lew-ui';
import { handlePaymentDiff, reconcilePayments } from '~/api/biz/payment-diffs';
import type {
  PaymentDiff,
  PaymentDiffChannel,
  PaymentDiffStatus,
  PaymentDiffType,
} from '~/api/biz/payment-diffs';
import { formatDateTime } from '~/composables/useFormat';
import { useTable } from '~/composables/useTable';
import { confirmDanger } from '~/utils/confirm';
import IconButton from '~/components/IconButton.vue';

// ---------- 枚举映射 ----------
const DIFF_CHANNEL_OPTIONS = [
  { label: '微信 Native', value: 'wxpay_native' },
  { label: '支付宝扫码', value: 'alipay_qr' },
];

const DIFF_CHANNEL_LABELS: Record<PaymentDiffChannel, string> = {
  wxpay_native: '微信 Native',
  alipay_qr: '支付宝扫码',
};

const DIFF_STATUS_OPTIONS = [
  { label: '待处理', value: 'pending' },
  { label: '已处理', value: 'resolved' },
  { label: '已忽略', value: 'ignored' },
];

const DIFF_TYPE_MAP: Record<PaymentDiffType, { text: string; class: string }> =
  {
    amount_mismatch: {
      text: '金额不一致',
      class: 'text-[var(--lew-color-error)]',
    },
    missing_in_system: {
      text: '系统缺单',
      class: 'text-[var(--lew-color-warning)]',
    },
    missing_in_channel: {
      text: '渠道缺单',
      class: 'text-[var(--lew-color-primary)]',
    },
    status_mismatch: {
      text: '状态不一致',
      class: 'text-[var(--app-text-muted)]',
    },
  };

const DIFF_STATUS_MAP: Record<
  PaymentDiffStatus,
  { text: string; class: string }
> = {
  pending: { text: '待处理', class: 'text-[var(--lew-color-warning)]' },
  resolved: { text: '已处理', class: 'text-[var(--lew-color-success)]' },
  ignored: { text: '已忽略', class: 'text-[var(--app-text-muted)]' },
};

/** 差异类型标签（按类型分色） */
function renderDiffType(diffType: PaymentDiffType) {
  const item = DIFF_TYPE_MAP[diffType];
  return h('span', { class: item.class }, item.text);
}

/** 差异处理状态标签 */
function renderDiffStatus(status: PaymentDiffStatus) {
  const item = DIFF_STATUS_MAP[status];
  return h('span', { class: item.class }, item.text);
}

// ---------- 金额工具 ----------
/** 分 → 元，保留两位 */
function fen2yuan(value: number): string {
  return (value / 100).toFixed(2);
}

// ---------- 列表 ----------
const query = ref<{
  billDate?: string;
  channel?: string;
  status?: string;
}>({});
const {
  items,
  loading,
  currentPage,
  pageSize,
  total,
  search,
  refresh,
  handleChange,
} = useTable<PaymentDiff>({
  url: '/biz/payment-diffs',
  query: () => query.value,
});

const columns: LewTableColumn[] = [
  { title: 'ID', field: 'id', width: 70 },
  { title: '对账日', field: 'billDate', width: 110 },
  {
    title: '渠道',
    field: 'channel',
    width: 110,
    customRender: ({ row }) =>
      DIFF_CHANNEL_LABELS[(row as unknown as PaymentDiff).channel] ?? '-',
  },
  {
    title: '系统单号',
    field: 'outTradeNo',
    width: 170,
    customRender: ({ row }) =>
      (row as unknown as PaymentDiff).outTradeNo ?? '-',
  },
  {
    title: '渠道单号',
    field: 'transactionId',
    width: 170,
    customRender: ({ row }) =>
      (row as unknown as PaymentDiff).transactionId ?? '-',
  },
  {
    title: '系统金额(元)',
    field: 'systemAmount',
    width: 110,
    customRender: ({ row }) =>
      fen2yuan((row as unknown as PaymentDiff).systemAmount),
  },
  {
    title: '渠道金额(元)',
    field: 'channelAmount',
    width: 110,
    customRender: ({ row }) =>
      fen2yuan((row as unknown as PaymentDiff).channelAmount),
  },
  {
    title: '差异类型',
    field: 'diffType',
    width: 130,
    customRender: ({ row }) =>
      renderDiffType((row as unknown as PaymentDiff).diffType),
  },
  {
    title: '状态',
    field: 'status',
    width: 90,
    customRender: ({ row }) =>
      renderDiffStatus((row as unknown as PaymentDiff).status),
  },
  {
    title: '处理人',
    field: 'handleByName',
    width: 100,
    customRender: ({ row }) => {
      const diff = row as unknown as PaymentDiff;
      return (
        diff.handleByName ??
        (diff.handleBy === null ? '-' : `#${diff.handleBy}`)
      );
    },
  },
  {
    title: '处理时间',
    field: 'handledAt',
    width: 170,
    customRender: ({ row }) => {
      const handledAt = (row as unknown as PaymentDiff).handledAt;
      return handledAt ? formatDateTime(handledAt) : '-';
    },
  },
  {
    title: '备注',
    field: 'remark',
    customRender: ({ row }) => (row as unknown as PaymentDiff).remark ?? '-',
  },
  { title: '操作', field: 'operation', width: 100, fixed: 'right' },
];

void search();

// ---------- 触发对账 ----------
const reconcileVisible = ref(false);
const reconcileFormRef = ref();
const reconcileForm = ref<{ billDate: string; channel?: string }>({
  billDate: '',
});
/** 表单 key：每次打开弹窗自增，强制重建 LewForm 以回填数据 */
const reconcileFormKey = ref(0);

const reconcileFormOptions: LewFormOption[] = [
  {
    field: 'billDate',
    label: '对账日',
    as: 'date-picker',
    rule: "Yup.string().required('不能为空')",
    props: { valueFormat: 'YYYY-MM-DD', placeholder: '请选择对账日' },
  },
  {
    field: 'channel',
    label: '渠道',
    as: 'select',
    props: {
      options: DIFF_CHANNEL_OPTIONS,
      placeholder: '全部渠道',
      clearable: true,
    },
  },
];

function openReconcile() {
  reconcileFormKey.value += 1;
  reconcileVisible.value = true;
  void nextTick(() => {
    reconcileFormRef.value?.setForm?.({ billDate: '', channel: undefined });
  });
}

async function handleReconcileSubmit() {
  const valid = await reconcileFormRef.value?.validate();
  if (!valid) return;
  const values = (reconcileFormRef.value?.getForm?.() ??
    reconcileForm.value) as typeof reconcileForm.value;
  if (!values.billDate) {
    LewMessage.error('请选择对账日');
    return;
  }
  const channel: PaymentDiffChannel | undefined = values.channel
    ? (values.channel as PaymentDiffChannel)
    : undefined;
  const billDate = values.billDate;
  confirmDanger({
    type: 'normal',
    title: '触发对账',
    content:
      '将对指定日期重新拉取渠道账单并比对，已存在的差异不会重复生成。确定继续吗？',
    confirmText: '开始对账',
    confirmColor: 'primary',
    onConfirm: async () => {
      const result = await reconcilePayments({ billDate, channel });
      LewMessage.success(`对账完成，发现 ${result.diffs} 条差异`);
      reconcileVisible.value = false;
      void refresh();
    },
  });
}

// ---------- 标记处理 ----------
const diffVisible = ref(false);
/** 处理差异的提交态：挡住连点（这是唯一一处**不走 confirmDanger** 的表单提交） */
const formSubmitting = ref(false);
const diffTarget = ref<PaymentDiff | null>(null);
const diffFormRef = ref();
const diffForm = ref<{ status: 'resolved' | 'ignored'; remark: string }>({
  status: 'resolved',
  remark: '',
});
const diffFormKey = ref(0);

const DIFF_HANDLE_OPTIONS = [
  { label: '已处理', value: 'resolved' },
  { label: '忽略', value: 'ignored' },
];

const diffFormOptions: LewFormOption[] = [
  {
    field: 'status',
    label: '处理结果',
    as: 'radio-group',
    rule: "Yup.string().required('不能为空')",
    props: { options: DIFF_HANDLE_OPTIONS },
  },
  {
    field: 'remark',
    label: '处理备注',
    as: 'textarea',
    rule: "Yup.string().required('处理备注必填，不允许静默忽略')",
    props: {
      placeholder: '请写清处理方式（补单 / 手工登记 / 联系渠道）',
      rows: 3,
    },
  },
];

/** 只读展示的差异关键信息 */
const diffInfoFields = computed<{ label: string; value: string }[]>(() => {
  const item = diffTarget.value;
  if (!item) return [];
  return [
    { label: '对账日', value: item.billDate },
    { label: '渠道', value: DIFF_CHANNEL_LABELS[item.channel] },
    { label: '系统单号', value: item.outTradeNo ?? '-' },
    { label: '渠道单号', value: item.transactionId ?? '-' },
    { label: '系统金额(元)', value: fen2yuan(item.systemAmount) },
    { label: '渠道金额(元)', value: fen2yuan(item.channelAmount) },
    { label: '差异类型', value: DIFF_TYPE_MAP[item.diffType].text },
  ];
});

function openHandleDiff(row: PaymentDiff) {
  diffTarget.value = row;
  diffFormKey.value += 1;
  diffVisible.value = true;
  void nextTick(() => {
    diffFormRef.value?.setForm?.({ status: 'resolved', remark: '' });
  });
}

async function handleDiffSubmit() {
  // 唯一一处**没走 confirmDanger** 的表单提交：中心化的防重入盖不到它，单独挡一层
  if (formSubmitting.value) return;
  const valid = await diffFormRef.value?.validate();
  if (!valid) return;
  const values = (diffFormRef.value?.getForm?.() ??
    diffForm.value) as typeof diffForm.value;
  const target = diffTarget.value;
  if (!target) return;
  if (!values.remark?.trim()) {
    LewMessage.error('处理备注必填，不允许静默忽略');
    return;
  }
  const status: 'resolved' | 'ignored' =
    values.status === 'ignored' ? 'ignored' : 'resolved';
  formSubmitting.value = true;
  try {
    await handlePaymentDiff(target.id, {
      status,
      remark: values.remark.trim(),
    });
    LewMessage.success(status === 'ignored' ? '已忽略该差异' : '已标记处理');
    diffVisible.value = false;
    void refresh();
  } finally {
    formSubmitting.value = false;
  }
}
</script>

<template>
  <div class="page-container">
    <!-- 页头 -->
    <div class="flex items-center justify-between">
      <div>
        <h2 class="page-title m-0">支付对账</h2>
        <p class="page-subtitle mt-1 mb-0">渠道账单差异与人工处理</p>
      </div>
      <LewButton
        v-permission="'biz:payment:reconcile'"
        type="fill"
        @click="openReconcile"
      >
        <RefreshCw :size="15" style="margin-right: 4px" /> 触发对账
      </LewButton>
    </div>

    <!-- 搜索栏 -->
    <div class="app-card flex items-center gap-3 p-4">
      <LewDatePicker
        v-model="query.billDate"
        width="160px"
        value-format="YYYY-MM-DD"
        placeholder="对账日"
        :clearable="true"
      />
      <LewSelect
        v-model="query.channel"
        width="150px"
        :options="DIFF_CHANNEL_OPTIONS"
        placeholder="全部渠道"
        clearable
      />
      <LewSelect
        v-model="query.status"
        width="140px"
        :options="DIFF_STATUS_OPTIONS"
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
          <div class="flex items-center gap-1">
            <IconButton
              v-if="(row as unknown as PaymentDiff).status === 'pending'"
              permission="biz:payment:reconcile"
              title="标记处理"
              @click="openHandleDiff(row as unknown as PaymentDiff)"
            >
              <Wrench :size="14" />
            </IconButton>
          </div>
        </template>
      </LewTable>

      <div class="flex justify-end p-3">
        <LewPagination
          v-model:current-page="currentPage"
          v-model:page-size="pageSize"
          :total="total"
          @change="handleChange"
        />
      </div>
    </div>

    <!-- 触发对账弹窗 -->
    <LewModal
      v-model:visible="reconcileVisible"
      title="触发对账"
      width="480px"
      :footer-buttons="[
        {
          props: {
            type: 'text',
            color: 'gray',
            size: 'small',
            text: '取消',
            request: () => {
              reconcileVisible = false;
            },
          },
        },
        {
          props: {
            type: 'fill',
            color: 'primary',
            size: 'small',
            text: '开始对账',
            request: handleReconcileSubmit,
          },
        },
      ]"
    >
      <div class="p-5">
        <LewForm
          :key="reconcileFormKey"
          ref="reconcileFormRef"
          v-model="reconcileForm"
          :options="reconcileFormOptions"
          label-width="80px"
        />
      </div>
    </LewModal>

    <!-- 标记处理弹窗 -->
    <LewModal
      v-model:visible="diffVisible"
      title="标记差异处理"
      width="520px"
      :footer-buttons="[
        {
          props: {
            type: 'text',
            color: 'gray',
            size: 'small',
            text: '取消',
            request: () => {
              diffVisible = false;
            },
          },
        },
        {
          props: {
            type: 'fill',
            color: 'primary',
            size: 'small',
            text: '保存',
            loading: formSubmitting,
            request: handleDiffSubmit,
          },
        },
      ]"
    >
      <div class="p-5">
        <!-- 只读：该差异的关键信息 -->
        <div
          class="mb-4 p-3 rounded-8px bg-[var(--app-bg-page)] text-13px flex flex-col gap-y-1.5"
        >
          <div
            v-for="field in diffInfoFields"
            :key="field.label"
            class="flex items-start gap-1"
          >
            <span class="shrink-0 text-[var(--app-text-muted)]"
              >{{ field.label }}：</span
            >
            <span class="break-all">{{ field.value }}</span>
          </div>
        </div>

        <LewForm
          :key="diffFormKey"
          ref="diffFormRef"
          v-model="diffForm"
          :options="diffFormOptions"
          label-width="80px"
        />
      </div>
    </LewModal>
  </div>
</template>
