<script setup lang="ts">
import { computed, h, ref } from 'vue';
import { FileText, RefreshCw, XCircle } from 'lucide-vue-next';
import {
  LewButton,
  LewDatePicker,
  LewDrawer,
  LewInput,
  LewMessage,
  LewPagination,
  LewSelect,
  LewTable,
} from 'lew-ui';
import type { LewTableColumn } from 'lew-ui';
import { closePayment, getPayment, queryPayment } from '~/api/biz/payments';
import type {
  Payment,
  PaymentChannel,
  PaymentDetail,
  PaymentLog,
  PaymentPurpose,
  PaymentStatus,
} from '~/api/biz/payments';
import { formatDateTime } from '~/composables/useFormat';
import { useCustomerOptions } from '~/composables/useCustomerOptions';
import { useTable } from '~/composables/useTable';
import { confirmDanger } from '~/utils/confirm';
import { trimCell } from '~/utils/table-text';
import IconButton from '~/components/IconButton.vue';

// ---------- 枚举映射 ----------
const CHANNEL_OPTIONS = [
  { label: '现金', value: 'cash' },
  { label: '微信线下', value: 'wechat_offline' },
  { label: '支付宝线下', value: 'alipay_offline' },
  { label: '微信 Native', value: 'wxpay_native' },
  { label: '支付宝扫码', value: 'alipay_qr' },
  { label: '储值', value: 'balance' },
  { label: '次卡', value: 'card' },
  { label: '挂账', value: 'credit' },
];

const CHANNEL_LABELS: Record<PaymentChannel, string> = {
  cash: '现金',
  wechat_offline: '微信线下',
  alipay_offline: '支付宝线下',
  wxpay_native: '微信 Native',
  alipay_qr: '支付宝扫码',
  balance: '储值',
  card: '次卡',
  credit: '挂账',
};

const PURPOSE_OPTIONS = [
  { label: '定金', value: 'deposit' },
  { label: '尾款', value: 'final' },
  { label: '充值', value: 'recharge' },
  { label: '购卡', value: 'card_buy' },
  { label: '销账', value: 'credit_settle' },
];

const PURPOSE_LABELS: Record<PaymentPurpose, string> = {
  deposit: '定金',
  final: '尾款',
  recharge: '充值',
  card_buy: '购卡',
  credit_settle: '销账',
};

const PAY_STATUS_OPTIONS = [
  { label: '待支付', value: 'pending' },
  { label: '成功', value: 'success' },
  { label: '失败', value: 'failed' },
  { label: '已关闭', value: 'closed' },
  { label: '已全额退款', value: 'refunded' },
  { label: '部分退款', value: 'partial_refunded' },
];

const PAY_STATUS_MAP: Record<PaymentStatus, { text: string; class: string }> = {
  pending: { text: '待支付', class: 'text-[var(--lew-color-warning)]' },
  success: { text: '成功', class: 'text-[var(--lew-color-success)]' },
  failed: { text: '失败', class: 'text-[var(--lew-color-error)]' },
  closed: { text: '已关闭', class: 'text-[var(--app-text-muted)]' },
  refunded: { text: '已全额退款', class: 'text-[var(--lew-color-error)]' },
  partial_refunded: {
    text: '部分退款',
    class: 'text-[var(--lew-color-warning)]',
  },
};

const PAY_EVENT_LABELS: Record<PaymentLog['event'], string> = {
  create: '创建支付单',
  callback: '渠道回调',
  query: '主动查单',
  close: '关单',
  refund: '退款',
  callback_invalid: '回调验签失败',
};

/** 通道中文 */
function renderChannel(channel: PaymentChannel) {
  return h('span', null, CHANNEL_LABELS[channel] ?? '-');
}

/** 用途中文 */
function renderPurpose(purpose: PaymentPurpose) {
  return h('span', null, PURPOSE_LABELS[purpose] ?? '-');
}

/** 支付状态标签（带颜色） */
function renderPayStatus(status: PaymentStatus) {
  const item = PAY_STATUS_MAP[status];
  return h('span', { class: item.class }, item.text);
}

// ---------- 金额工具 ----------
/** 分 → 元，保留两位 */
function fen2yuan(value: number): string {
  return (value / 100).toFixed(2);
}

/** 会员展示：姓名（缺失时用 #ID） */
function memberText(name: string | null | undefined, customerId: number) {
  return name ?? `#${customerId}`;
}

// ---------- 列表 ----------
// 顾客筛选此前是「手填顾客 ID」—— 内部主键不是给店长看的，改成顾客下拉（可本地搜索）。
const { options: customerOptions, search: searchCustomers } =
  useCustomerOptions();
void searchCustomers('', 200);

const query = ref<{
  channel?: string;
  status?: string;
  purpose?: string;
  dateFrom?: string;
  dateTo?: string;
  bookingNo?: string;
  customerId?: string;
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
} = useTable<Payment>({
  url: '/biz/payments',
  query: () => query.value,
});

const columns: LewTableColumn[] = [
  { title: 'ID', field: 'id', width: 70 },
  { title: '支付单号', field: 'paymentNo', width: 170 },
  {
    title: '预约号',
    field: 'bookingNo',
    width: 150,
    // 列表接口只返回 bookingId（无联查），有 bookingNo 时优先展示
    customRender: ({ row }) => {
      const payment = row as unknown as Payment;
      return (
        payment.bookingNo ?? (payment.bookingId ? `#${payment.bookingId}` : '-')
      );
    },
  },
  {
    title: '会员',
    field: 'customerName',
    width: 120,
    customRender: ({ row }) => {
      const payment = row as unknown as Payment;
      return memberText(payment.customerName, payment.customerId);
    },
  },
  {
    title: '用途',
    field: 'purpose',
    width: 90,
    customRender: ({ row }) =>
      renderPurpose((row as unknown as Payment).purpose),
  },
  {
    title: '通道',
    field: 'channel',
    width: 110,
    customRender: ({ row }) =>
      renderChannel((row as unknown as Payment).channel),
  },
  {
    title: '应收(元)',
    field: 'amount',
    width: 100,
    customRender: ({ row }) => fen2yuan((row as unknown as Payment).amount),
  },
  {
    title: '实收(元)',
    field: 'receivedAmount',
    width: 100,
    customRender: ({ row }) =>
      fen2yuan((row as unknown as Payment).receivedAmount),
  },
  {
    title: '已退(元)',
    field: 'refundedAmount',
    width: 100,
    customRender: ({ row }) =>
      fen2yuan((row as unknown as Payment).refundedAmount),
  },
  {
    title: '状态',
    field: 'status',
    width: 110,
    customRender: ({ row }) =>
      renderPayStatus((row as unknown as Payment).status),
  },
  {
    title: '创建时间',
    field: 'createdAt',
    width: 170,
    customRender: ({ row }) =>
      formatDateTime((row as unknown as Payment).createdAt),
  },
  { title: '操作', field: 'operation', width: 110, fixed: 'right' },
];

void search();

// ---------- 详情（抽屉 + 渠道轨迹） ----------
const detailVisible = ref(false);
const detailLoading = ref(false);
const detail = ref<PaymentDetail | null>(null);

const detailFields = computed<{ label: string; value: string }[]>(() => {
  const item = detail.value;
  if (!item) return [];
  return [
    { label: '支付单号', value: item.paymentNo },
    { label: '商户订单号', value: item.outTradeNo },
    {
      label: '预约号',
      value: item.bookingNo ?? (item.bookingId ? `#${item.bookingId}` : '-'),
    },
    {
      label: '会员',
      value: memberText(item.customerName, item.customerId),
    },
    { label: '用途', value: PURPOSE_LABELS[item.purpose] },
    { label: '通道', value: CHANNEL_LABELS[item.channel] },
    { label: '应收(元)', value: fen2yuan(item.amount) },
    { label: '实收(元)', value: fen2yuan(item.receivedAmount) },
    { label: '已退(元)', value: fen2yuan(item.refundedAmount) },
    { label: '状态', value: PAY_STATUS_MAP[item.status].text },
    { label: '渠道交易号', value: item.transactionId ?? '-' },
    { label: '创建时间', value: formatDateTime(item.createdAt) },
    { label: '支付时间', value: formatDateTime(item.paidAt) },
    { label: '失效时间', value: formatDateTime(item.expireAt) },
    { label: '回调时间', value: formatDateTime(item.callbackAt) },
    { label: '备注', value: item.remark ?? '-' },
    { label: '二维码链接', value: item.codeUrl ?? '-' },
  ];
});

const detailLogs = computed<PaymentLog[]>(() => detail.value?.logs ?? []);

const logColumns: LewTableColumn[] = [
  {
    title: '事件',
    field: 'event',
    width: 120,
    customRender: ({ row }) =>
      PAY_EVENT_LABELS[(row as unknown as PaymentLog).event] ?? '-',
  },
  {
    title: 'HTTP 状态',
    field: 'httpStatus',
    width: 100,
    customRender: ({ row }) => {
      const status = (row as unknown as PaymentLog).httpStatus;
      return status === null ? '-' : String(status);
    },
  },
  {
    title: '原始报文',
    field: 'raw',
    customRender: ({ row }) => {
      const raw = (row as unknown as PaymentLog).raw;
      if (raw === null || raw === undefined) {
        return h('span', { class: 'text-[var(--app-text-muted)]' }, '-');
      }
      const text = JSON.stringify(raw).slice(0, 200);
      return trimCell(text, { class: 'max-w-320px' });
    },
  },
  {
    title: '时间',
    field: 'createdAt',
    width: 170,
    customRender: ({ row }) =>
      formatDateTime((row as unknown as PaymentLog).createdAt),
  },
];

async function openDetail(row: Payment) {
  detail.value = null;
  detailVisible.value = true;
  detailLoading.value = true;
  try {
    detail.value = await getPayment(row.id);
  } finally {
    detailLoading.value = false;
  }
}

// ---------- 主动查单 ----------
function handleQuery(row: Payment) {
  confirmDanger({
    type: 'normal',
    title: '主动查单',
    content: '将向渠道查询该笔支付的真实状态，确定继续吗？',
    confirmText: '查单',
    confirmColor: 'primary',
    onConfirm: async () => {
      const result = await queryPayment(row.id);
      LewMessage.success(
        `查单完成，当前状态：${PAY_STATUS_MAP[result.status].text}`,
      );
      void refresh();
    },
  });
}

// ---------- 关单 ----------
function handleClose(row: Payment) {
  confirmDanger({
    type: 'warning',
    title: '关单确认',
    content: `确定关闭支付单「${row.paymentNo}」吗？关闭后该笔订单不可再支付。`,
    confirmText: '关单',
    confirmColor: 'error',
    onConfirm: async () => {
      await closePayment(row.id, {});
      LewMessage.success('已关单');
      void refresh();
    },
  });
}
</script>

<template>
  <div class="page-container">
    <!-- 页头 -->
    <div class="flex items-center justify-between">
      <div>
        <h2 class="page-title m-0">支付流水</h2>
        <p class="page-subtitle mt-1 mb-0">
          支付单查询、渠道轨迹、主动查单与关单
        </p>
      </div>
    </div>

    <!-- 搜索栏 -->
    <div class="app-card flex flex-wrap items-center gap-3 p-4">
      <LewSelect
        v-model="query.channel"
        width="150px"
        :options="CHANNEL_OPTIONS"
        placeholder="全部通道"
        clearable
      />
      <LewSelect
        v-model="query.status"
        width="150px"
        :options="PAY_STATUS_OPTIONS"
        placeholder="全部状态"
        clearable
      />
      <LewSelect
        v-model="query.purpose"
        width="130px"
        :options="PURPOSE_OPTIONS"
        placeholder="全部用途"
        clearable
      />
      <LewDatePicker
        v-model="query.dateFrom"
        width="150px"
        value-format="YYYY-MM-DD"
        placeholder="开始日期"
        :clearable="true"
      />
      <LewDatePicker
        v-model="query.dateTo"
        width="150px"
        value-format="YYYY-MM-DD"
        placeholder="结束日期"
        :clearable="true"
      />
      <LewInput
        v-model="query.bookingNo"
        width="160px"
        placeholder="预约号"
        clearable
        @enter="search()"
      />
      <LewSelect
        v-model="query.customerId"
        width="220px"
        :options="customerOptions"
        placeholder="全部顾客"
        clearable
        searchable
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
              title="详情"
              @click="openDetail(row as unknown as Payment)"
            >
              <FileText :size="14" />
            </IconButton>
            <IconButton
              v-if="(row as unknown as Payment).status === 'pending'"
              permission="biz:payment:create"
              title="查单"
              @click="handleQuery(row as unknown as Payment)"
            >
              <RefreshCw :size="14" />
            </IconButton>
            <IconButton
              v-if="(row as unknown as Payment).status === 'pending'"
              permission="biz:payment:close"
              color="error"
              title="关单"
              @click="handleClose(row as unknown as Payment)"
            >
              <XCircle :size="14" />
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

    <!-- 支付单详情抽屉 -->
    <LewDrawer
      v-model:visible="detailVisible"
      title="支付单详情"
      width="720px"
      :hide-footer="true"
      close-on-click-overlay
      close-by-esc
    >
      <div class="p-5">
        <div
          v-if="detailLoading"
          class="py-6 text-center text-[var(--app-text-muted)]"
        >
          加载中…
        </div>
        <template v-else-if="detail">
          <!-- 支付单字段 -->
          <div class="grid grid-cols-2 gap-x-4 gap-y-2">
            <div
              v-for="field in detailFields"
              :key="field.label"
              class="flex items-start gap-1 text-13px"
            >
              <span class="shrink-0 text-[var(--app-text-muted)]"
                >{{ field.label }}：</span
              >
              <span class="break-all">{{ field.value }}</span>
            </div>
          </div>

          <!-- 渠道轨迹 -->
          <h4
            class="m-0 mt-5 mb-3 text-13px font-600 text-[var(--app-text-secondary)]"
          >
            渠道轨迹
          </h4>
          <LewTable
            :columns="logColumns"
            :data-source="detailLogs"
            :focusable="false"
            size="small"
          />
        </template>
      </div>
    </LewDrawer>
  </div>
</template>
