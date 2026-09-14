<script setup lang="ts">
import { computed, h, nextTick, ref } from 'vue';
import { ClipboardCheck, Eye, Plus } from 'lucide-vue-next';
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
import type {
  LewFormOption,
  LewModalFooterButtonItem,
  LewTableColumn,
} from 'lew-ui';
import { withPassThroughRule } from '~/utils/form';
import {
  approveRefund,
  createRefund,
  previewRefund,
  rejectRefund,
} from '~/api/biz/refunds';
import type {
  Refund,
  RefundLiable,
  RefundMode,
  RefundPreview,
  RefundStatus,
} from '~/api/biz/refunds';
import { useTable } from '~/composables/useTable';
import { formatDateTime } from '~/composables/useFormat';
import { confirmDanger } from '~/utils/confirm';
import IconButton from '~/components/IconButton.vue';

// ---------- 展示口径（金额「分」→「元」/ 枚举本地映射） ----------
/** 分 → 元，保留两位 */
function fen2yuan(value: number | null | undefined): string {
  if (value === null || value === undefined) return '-';
  return (value / 100).toFixed(2);
}
/** 元 → 分，四舍五入取整 */
function yuan2fen(value: unknown): number {
  const num = Number(value ?? 0);
  return Number.isFinite(num) ? Math.round(num * 100) : 0;
}

/** 状态筛选（默认只看待审批，清空 = 全部） */
const STATUS_OPTIONS = [
  { label: '待审批', value: 'pending' },
  { label: '已通过', value: 'approved' },
  { label: '已驳回', value: 'rejected' },
  { label: '已退款成功', value: 'success' },
  { label: '退款失败', value: 'failed' },
];
/** 退款去向 */
const MODE_OPTIONS = [
  { label: '原路退回', value: 'original' },
  { label: '现金退', value: 'cash' },
  { label: '退入余额', value: 'balance' },
];
/** 责任归属 */
const LIABLE_OPTIONS = [
  { label: '店家', value: 'store' },
  { label: '顾客', value: 'customer' },
  { label: '不可抗力', value: 'force_majeure' },
];
const MODE_LABELS: Record<RefundMode, string> = {
  original: '原路退回',
  cash: '现金退',
  balance: '退入余额',
};
const LIABLE_LABELS: Record<RefundLiable, string> = {
  store: '店家',
  customer: '顾客',
  force_majeure: '不可抗力',
};

/** 状态带色展示：pending 橙 / approved 蓝 / success 绿 / rejected · failed 红 */
function renderRefundStatus(status: RefundStatus) {
  switch (status) {
    case 'pending':
      return h('span', { class: 'text-[var(--lew-color-warning)]' }, '待审批');
    case 'approved':
      return h('span', { class: 'text-[var(--lew-color-primary)]' }, '已通过');
    case 'success':
      return h('span', { class: 'text-[var(--lew-color-success)]' }, '已退款');
    case 'rejected':
      return h('span', { class: 'text-[var(--lew-color-error)]' }, '已驳回');
    default:
      return h('span', { class: 'text-[var(--lew-color-error)]' }, '退款失败');
  }
}

// ---------- 列表（默认只看待审批） ----------
const query = ref<{
  status?: string;
  mode?: string;
  liable?: string;
  dateFrom?: string;
  dateTo?: string;
}>({ status: 'pending' });

const {
  items,
  loading,
  currentPage,
  pageSize,
  total,
  search,
  refresh,
  handleChange,
} = useTable<Refund>({
  url: '/biz/refunds',
  query: () => query.value,
});

const columns: LewTableColumn[] = [
  { title: 'ID', field: 'id', width: 70 },
  { title: '退款单号', field: 'refundNo', width: 170 },
  {
    title: '预约号',
    field: 'bookingNo',
    width: 150,
    // 列表接口只返回 bookingId（无联查），有 bookingNo 时优先展示
    customRender: ({ row }) => {
      const refund = row as unknown as Refund;
      return (
        refund.bookingNo ?? (refund.bookingId ? `#${refund.bookingId}` : '-')
      );
    },
  },
  {
    title: '会员',
    field: 'customerName',
    width: 120,
    customRender: ({ row }) => {
      const refund = row as unknown as Refund;
      return refund.customerName ?? `#${refund.customerId}`;
    },
  },
  {
    title: '支付单号',
    field: 'paymentNo',
    width: 160,
    customRender: ({ row }) => {
      const refund = row as unknown as Refund;
      return (
        refund.paymentNo ?? (refund.paymentId ? `#${refund.paymentId}` : '-')
      );
    },
  },
  {
    title: '申请金额(元)',
    field: 'amount',
    width: 110,
    customRender: ({ row }) => fen2yuan((row as unknown as Refund).amount),
  },
  {
    title: '实退金额(元)',
    field: 'actualAmount',
    width: 110,
    customRender: ({ row }) =>
      fen2yuan((row as unknown as Refund).actualAmount),
  },
  {
    title: '判责扣减(元)',
    field: 'deductAmount',
    width: 110,
    customRender: ({ row }) =>
      fen2yuan((row as unknown as Refund).deductAmount),
  },
  {
    title: '去向',
    field: 'mode',
    width: 100,
    customRender: ({ row }) =>
      MODE_LABELS[(row as unknown as Refund).mode] ?? '-',
  },
  {
    title: '责任',
    field: 'liable',
    width: 100,
    customRender: ({ row }) => {
      const refund = row as unknown as Refund;
      const text = LIABLE_LABELS[refund.liable] ?? '-';
      // 顾客担责时用警示色提示扣减
      return refund.liable === 'customer'
        ? h('span', { class: 'text-[var(--lew-color-warning)]' }, text)
        : text;
    },
  },
  { title: '原因', field: 'reason' },
  {
    title: '状态',
    field: 'status',
    width: 100,
    customRender: ({ row }) =>
      renderRefundStatus((row as unknown as Refund).status),
  },
  {
    title: '申请人',
    field: 'applyByName',
    width: 100,
    customRender: ({ row }) => {
      const refund = row as unknown as Refund;
      return (
        refund.applyByName ?? (refund.applyBy ? `#${refund.applyBy}` : '-')
      );
    },
  },
  {
    title: '申请时间',
    field: 'applyAt',
    width: 170,
    customRender: ({ row }) =>
      formatDateTime((row as unknown as Refund).applyAt),
  },
  { title: '操作', field: 'operation', width: 110, fixed: 'right' },
];

void search();

// ---------- 审批 / 详情弹窗 ----------
const approvalVisible = ref(false);
/** 审批执行中：通过会**立即发起渠道退款**，连点会重复打款请求 */
const approving = ref(false);
const approvalRow = ref<Refund | null>(null);
const approvalIsPending = computed(
  () => approvalRow.value?.status === 'pending',
);

/** 只读区块字段（wide = 独占整行） */
const approvalRows = computed(() => {
  const row = approvalRow.value;
  if (!row) return [];
  return [
    { label: '退款单号', value: row.refundNo, wide: false },
    {
      label: '预约号',
      value: row.bookingNo ?? (row.bookingId ? `#${row.bookingId}` : '-'),
      wide: false,
    },
    {
      label: '会员',
      value: row.customerName ?? `#${row.customerId}`,
      wide: false,
    },
    { label: '申请金额(元)', value: fen2yuan(row.amount), wide: false },
    { label: '实退金额(元)', value: fen2yuan(row.actualAmount), wide: false },
    { label: '判责扣减(元)', value: fen2yuan(row.deductAmount), wide: false },
    { label: '去向', value: MODE_LABELS[row.mode] ?? '-', wide: false },
    { label: '责任', value: LIABLE_LABELS[row.liable] ?? '-', wide: false },
    {
      label: '申请人',
      value: row.applyByName ?? (row.applyBy ? `#${row.applyBy}` : '-'),
      wide: false,
    },
    { label: '申请时间', value: formatDateTime(row.applyAt), wide: false },
    {
      label: '命中规则',
      // 列表/详情接口未联查规则名，退回 policyId；都没有才是「未命中规则」
      value:
        row.policyName ??
        (row.policyId ? `规则 #${row.policyId}` : '未命中规则（全退）'),
      wide: false,
    },
    { label: '退款原因', value: row.reason || '-', wide: true },
  ];
});

function openApproval(row: Refund) {
  approvalRow.value = row;
  approvalVisible.value = true;
}

/** 待审批：驳回 / 通过；其它状态：只读详情，仅放「关闭」 */
const approvalFooterButtons = computed<LewModalFooterButtonItem[]>(() => {
  if (!approvalIsPending.value) {
    return [
      {
        props: {
          type: 'text',
          color: 'gray',
          size: 'small',
          text: '关闭',
          request: () => {
            approvalVisible.value = false;
          },
        },
      },
    ];
  }
  return [
    {
      props: {
        type: 'fill',
        color: 'error',
        size: 'small',
        text: '驳回',
        request: openReject,
      },
    },
    {
      props: {
        type: 'fill',
        color: 'primary',
        size: 'small',
        text: '通过',
        loading: approving.value,
        request: handleApprove,
      },
    },
  ];
});

/** 审批通过：立即执行退款且只能执行一次 → 二次确认 */
function handleApprove() {
  if (approving.value) return;
  const row = approvalRow.value;
  if (!row) return;
  confirmDanger({
    type: 'normal',
    title: '审批通过',
    content:
      '通过后将立即执行退款（原路退回调渠道 / 现金或退余额直接落地），且只能执行一次。确定通过吗？',
    confirmText: '确认通过',
    confirmColor: 'primary',
    onConfirm: async () => {
      approving.value = true;
      try {
        await approveRefund(row.id, {});
        LewMessage.success('已通过并执行退款');
        approvalVisible.value = false;
        void refresh();
      } finally {
        approving.value = false;
      }
    },
  });
}

// ---------- 驳回弹窗（独立 formKey） ----------
const rejectVisible = ref(false);
const rejectRow = ref<Refund | null>(null);
const rejectFormRef = ref();
const rejectForm = ref({ reason: '' });
const rejectFormKey = ref(0);

function openReject() {
  const row = approvalRow.value;
  if (!row) return;
  rejectRow.value = row;
  rejectFormKey.value += 1;
  rejectVisible.value = true;
  void nextTick(() => {
    rejectFormRef.value?.setForm?.({ reason: '' });
  });
}

async function handleRejectSubmit() {
  const valid = await rejectFormRef.value?.validate();
  if (!valid) return;
  const values = (rejectFormRef.value?.getForm?.() ??
    rejectForm.value) as typeof rejectForm.value;
  const reason = String(values.reason ?? '').trim();
  if (!reason) {
    LewMessage.error('驳回原因必填');
    return;
  }
  const row = rejectRow.value;
  if (!row) return;
  confirmDanger({
    title: '驳回确认',
    content: `确定驳回退款单「${row.refundNo}」吗？驳回后该单不再执行退款。`,
    confirmText: '确认驳回',
    onConfirm: async () => {
      await rejectRefund(row.id, { reason });
      LewMessage.success('已驳回');
      rejectVisible.value = false;
      approvalVisible.value = false;
      void refresh();
    },
  });
}

// ---------- 发起退款申请弹窗 ----------
const applyVisible = ref(false);
const applyFormRef = ref();
const applyForm = ref({
  bookingId: undefined as number | undefined,
  /** 取消时间（判责试算用，选填） */
  cancelAt: '',
  /** 元 */
  amount: undefined as number | undefined,
  mode: 'original' as RefundMode,
  liable: 'store' as RefundLiable,
  reason: '',
});
/** 表单 key：每次打开弹窗自增，强制重建 LewForm 以回填数据 */
const applyFormKey = ref(0);
const preview = ref<RefundPreview | null>(null);
const previewing = ref(false);
/** 去向提示（LewForm 不回写父级，靠 change 事件同步） */
const applyMode = ref<RefundMode>('original');

const applyModeHint = computed(() => {
  if (applyMode.value === 'original') return '在线支付强制原路退回。';
  if (applyMode.value === 'balance')
    return '退入储值余额需会员身份，将同事务回补余额并写会员流水。';
  return '';
});

/** 命中规则只给建议，最终金额由店员确认（改金额必填原因） */
const previewRows = computed(() => {
  const data = preview.value;
  if (!data) return [];
  // 后端字段名是 hoursToStart；兼容旧文档里的 hoursUntilStart
  const hoursToStart = data.hoursToStart ?? data.hoursUntilStart ?? null;
  return [
    {
      label: '命中规则',
      // 试算接口返回 policyName（policyId 兜底）
      value:
        data.policyName ??
        (data.policyId ? `规则 #${data.policyId}` : '未命中规则（全退）'),
    },
    {
      label: '规则阈值',
      value: data.hoursBefore != null ? `${data.hoursBefore} 小时前` : '-',
    },
    {
      label: '距开始',
      value: hoursToStart != null ? `${hoursToStart.toFixed(1)} 小时` : '-',
    },
    { label: '可退比例', value: `${(data.refundPermille / 10).toFixed(1)}%` },
    {
      label: '建议退款额',
      value: `${(data.suggestAmount / 100).toFixed(2)} 元`,
    },
    { label: '判责扣减', value: `${(data.deductAmount / 100).toFixed(2)} 元` },
    {
      label: '可退上限',
      value:
        data.refundableAmount != null
          ? `${(data.refundableAmount / 100).toFixed(2)} 元`
          : '-',
    },
  ];
});

const applyFormOptions: LewFormOption[] = [
  {
    field: 'bookingId',
    label: '预约 ID',
    as: 'input-number',
    rule: "Yup.number().required('不能为空')",
    props: { min: 1, placeholder: '用于定位支付单与判责规则' },
  },
  {
    field: 'cancelAt',
    label: '取消时间',
    as: 'date-picker',
    rule: 'Yup.string().nullable()',
    tips: '选填，默认按当前时间判责',
    props: {
      valueFormat: 'YYYY-MM-DD',
      clearable: true,
      placeholder: '选择取消时间',
    },
  },
  {
    field: 'amount',
    label: '退款金额(元)',
    as: 'input-number',
    rule: "Yup.number().required('不能为空')",
    tips: '默认取试算建议金额，可改；改动后必须在原因里写明',
    props: { min: 0, precision: 2 },
  },
  {
    field: 'mode',
    label: '去向',
    as: 'select',
    rule: "Yup.string().required('不能为空')",
    props: { options: MODE_OPTIONS },
  },
  {
    field: 'liable',
    label: '责任',
    as: 'select',
    rule: "Yup.string().required('不能为空')",
    props: { options: LIABLE_OPTIONS },
  },
  {
    field: 'reason',
    label: '退款原因',
    as: 'textarea',
    rule: "Yup.string().required('不能为空')",
    props: {
      placeholder: '改动建议金额时必须写清原因',
      rows: 3,
    },
  },
];

/** LewForm 不回写父级 v-model，靠 change 事件同步去向提示 */
function handleApplyFormChange(values: unknown) {
  const mode = (values as { mode?: unknown } | null | undefined)?.mode;
  applyMode.value =
    mode === 'original' || mode === 'cash' || mode === 'balance'
      ? mode
      : 'original';
}

function openApply() {
  preview.value = null;
  applyMode.value = 'original';
  applyFormKey.value += 1;
  applyVisible.value = true;
  void nextTick(() => {
    applyFormRef.value?.setForm?.({
      bookingId: undefined,
      cancelAt: '',
      amount: undefined,
      mode: 'original',
      liable: 'store',
      reason: '',
    });
  });
}

/** 判责试算：命中规则 + 建议金额，成功后回填 amount */
async function handlePreview() {
  const values = (applyFormRef.value?.getForm?.() ??
    applyForm.value) as typeof applyForm.value;
  const bookingId = Number(values.bookingId ?? 0);
  if (!bookingId) {
    LewMessage.error('请先填写预约 ID');
    return;
  }
  previewing.value = true;
  try {
    const result = await previewRefund({
      bookingId,
      cancelAt: values.cancelAt || undefined,
    });
    preview.value = result;
    applyFormRef.value?.setForm?.({
      ...values,
      amount: result.suggestAmount / 100,
    });
    LewMessage.success('试算完成，已回填建议退款金额');
  } finally {
    previewing.value = false;
  }
}

async function handleApplySubmit() {
  const valid = await applyFormRef.value?.validate();
  if (!valid) return;
  const values = (applyFormRef.value?.getForm?.() ??
    applyForm.value) as typeof applyForm.value;
  const data = preview.value;
  if (!data) {
    LewMessage.error('请先试算判责金额');
    return;
  }
  const reason = String(values.reason ?? '').trim();
  if (!reason) {
    LewMessage.error('退款原因必填');
    return;
  }
  const bookingId = Number(values.bookingId ?? 0);
  if (!bookingId) {
    LewMessage.error('请先填写预约 ID 并试算');
    return;
  }
  const amountYuan = Number(values.amount ?? 0);
  if (!Number.isFinite(amountYuan) || amountYuan <= 0) {
    LewMessage.error('退款金额必须大于 0');
    return;
  }
  const limitYuan =
    data.refundableAmount != null ? data.refundableAmount / 100 : null;
  if (limitYuan !== null && amountYuan > limitYuan) {
    LewMessage.error(`退款金额不能超过可退上限 ${limitYuan.toFixed(2)} 元`);
    return;
  }
  const mode = values.mode;
  confirmDanger({
    type: 'normal',
    title: '发起退款申请',
    content: `将按「${MODE_LABELS[mode] ?? '-'}」发起 ${amountYuan.toFixed(2)} 元退款申请，生成待审批退款单，需店长审批后才会执行。确定提交吗？`,
    confirmText: '确认提交',
    confirmColor: 'primary',
    onConfirm: async () => {
      await createRefund({
        bookingId,
        amount: yuan2fen(amountYuan),
        mode,
        reason,
        liable: values.liable,
      });
      LewMessage.success('已生成待审批退款单，需店长审批后执行');
      applyVisible.value = false;
      // 回到「待审批」列表，方便店长直接看到新单
      query.value.status = 'pending';
      void search();
    },
  });
}
</script>

<template>
  <div class="page-container">
    <!-- 页头 -->
    <div class="flex items-center justify-between">
      <div>
        <h2 class="page-title m-0">退款审批</h2>
        <p class="page-subtitle mt-1 mb-0">
          判责试算 + 申请 / 审批分离（审批默认只看待审批单）
        </p>
      </div>
      <LewButton
        v-permission="'biz:refund:apply'"
        type="fill"
        @click="openApply"
      >
        <Plus :size="15" style="margin-right: 4px" /> 发起退款申请
      </LewButton>
    </div>

    <!-- 搜索栏 -->
    <div class="app-card flex flex-wrap items-center gap-3 p-4">
      <LewSelect
        v-model="query.status"
        width="140px"
        :options="STATUS_OPTIONS"
        placeholder="全部状态"
        clearable
      />
      <LewSelect
        v-model="query.mode"
        width="140px"
        :options="MODE_OPTIONS"
        placeholder="全部去向"
        clearable
      />
      <LewSelect
        v-model="query.liable"
        width="140px"
        :options="LIABLE_OPTIONS"
        placeholder="全部责任"
        clearable
      />
      <LewDatePicker
        v-model="query.dateFrom"
        width="150px"
        value-format="YYYY-MM-DD"
        placeholder="开始日期"
        clearable
      />
      <LewDatePicker
        v-model="query.dateTo"
        width="150px"
        value-format="YYYY-MM-DD"
        placeholder="结束日期"
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
              v-if="(row as unknown as Refund).status === 'pending'"
              permission="biz:refund:approve"
              title="审批"
              @click="openApproval(row as unknown as Refund)"
            >
              <ClipboardCheck :size="14" />
            </IconButton>
            <IconButton
              v-else
              title="详情"
              @click="openApproval(row as unknown as Refund)"
            >
              <Eye :size="14" />
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

    <!-- 审批 / 详情弹窗：待审批给「驳回 + 通过」，其它状态只读 -->
    <LewModal
      v-model:visible="approvalVisible"
      :title="approvalIsPending ? '退款审批' : '退款单详情'"
      width="720px"
      :footer-buttons="approvalFooterButtons"
    >
      <div class="p-5">
        <div
          v-if="approvalRows.length"
          class="rounded-8px border border-[var(--app-border)] bg-[var(--app-bg-hover)] p-3"
        >
          <div class="grid grid-cols-2 gap-x-6 gap-y-1.5 text-13px">
            <div
              v-for="item in approvalRows"
              :key="item.label"
              class="flex items-start gap-2"
              :class="item.wide ? 'col-span-2' : ''"
            >
              <span class="shrink-0 text-[var(--app-text-muted)]">{{
                item.label
              }}</span>
              <span class="break-all">{{ item.value }}</span>
            </div>
          </div>
        </div>

        <p
          v-if="approvalIsPending"
          class="mt-3 mb-0 text-13px text-[var(--lew-color-warning)]"
        >
          通过后将立即执行退款（原路退回调渠道 /
          现金或退余额直接落地），且只能执行一次。
        </p>
      </div>
    </LewModal>

    <!-- 驳回弹窗（必填原因） -->
    <LewModal
      v-model:visible="rejectVisible"
      :title="`驳回退款单 - ${rejectRow?.refundNo ?? ''}`"
      width="480px"
      :footer-buttons="[
        {
          props: {
            type: 'text',
            color: 'gray',
            size: 'small',
            text: '取消',
            request: () => {
              rejectVisible = false;
            },
          },
        },
        {
          props: {
            type: 'fill',
            color: 'error',
            size: 'small',
            text: '确认驳回',
            request: handleRejectSubmit,
          },
        },
      ]"
    >
      <div class="p-5">
        <LewForm
          :key="rejectFormKey"
          ref="rejectFormRef"
          v-model="rejectForm"
          label-width="88px"
          :options="
            withPassThroughRule([
              {
                field: 'reason',
                label: '驳回原因',
                as: 'textarea',
                rule: `Yup.string().required('不能为空')`,
                props: { placeholder: '必填，将记录在退款单上', rows: 3 },
              },
            ])
          "
        />
      </div>
    </LewModal>

    <!-- 发起退款申请弹窗 -->
    <LewModal
      v-model:visible="applyVisible"
      title="发起退款申请"
      width="620px"
      :footer-buttons="[
        {
          props: {
            type: 'text',
            color: 'gray',
            size: 'small',
            text: '取消',
            request: () => {
              applyVisible = false;
            },
          },
        },
        {
          props: {
            type: 'fill',
            color: 'primary',
            size: 'small',
            text: '提交申请',
            request: handleApplySubmit,
          },
        },
      ]"
    >
      <div class="p-5">
        <LewForm
          :key="applyFormKey"
          ref="applyFormRef"
          v-model="applyForm"
          :options="applyFormOptions"
          label-width="96px"
          @change="handleApplyFormChange"
        />

        <div class="mt-3 flex items-center gap-3">
          <LewButton type="light" :loading="previewing" @click="handlePreview">
            试算判责
          </LewButton>
          <span class="text-13px text-[var(--app-text-muted)]">
            先填预约 ID 再试算，命中规则只给建议金额，可改但必须写明原因
          </span>
        </div>

        <div
          v-if="previewRows.length"
          class="mt-3 rounded-8px border border-[var(--app-border)] bg-[var(--app-bg-hover)] p-3"
        >
          <p class="m-0 mb-2 text-13px font-600">判责试算结果</p>
          <div class="grid grid-cols-2 gap-x-6 gap-y-1.5 text-13px">
            <div
              v-for="item in previewRows"
              :key="item.label"
              class="flex items-start gap-2"
            >
              <span class="shrink-0 text-[var(--app-text-muted)]">{{
                item.label
              }}</span>
              <span>{{ item.value }}</span>
            </div>
          </div>
        </div>

        <p
          v-if="applyModeHint"
          class="mt-3 mb-0 text-13px text-[var(--lew-color-warning)]"
        >
          {{ applyModeHint }}
        </p>
      </div>
    </LewModal>
  </div>
</template>
