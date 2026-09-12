<script setup lang="ts">
import { computed, h, onBeforeUnmount, reactive, ref } from 'vue';
import { Ban, CheckCircle2, FileText, Plus, Trash2 } from 'lucide-vue-next';
import {
  LewButton,
  LewDatePicker,
  LewInput,
  LewInputNumber,
  LewMessage,
  LewModal,
  LewPagination,
  LewSelect,
  LewTable,
  LewTextarea,
} from 'lew-ui';
import type { LewTableColumn } from 'lew-ui';
import {
  ONLINE_PAY_CHANNELS,
  cancelReceivable,
  getReceivable,
  getReceivableSummary,
  settleReceivable,
} from '~/api/biz/receivables';
import type {
  Receivable,
  ReceivableDetail,
  ReceivablePayChannel,
  ReceivableStatus,
  ReceivableSummaryRow,
  SettlePaymentInput,
} from '~/api/biz/receivables';
import { closePayment, getPaymentStatus } from '~/api/biz/payments';
import type { PaymentStatus } from '~/api/biz/payments';
import { listCreditAccountOptions } from '~/api/biz/credit-accounts';
import type { CreditAccount } from '~/api/biz/credit-accounts';
import { useTable } from '~/composables/useTable';
import { formatDateTime } from '~/composables/useFormat';
import { confirmDanger } from '~/utils/confirm';
import IconButton from '~/components/IconButton.vue';
import { openImagePreview } from '~/composables/useImagePreview';

// ---------- 金额工具 ----------
function fen2yuan(value: number | null | undefined): string {
  if (value === null || value === undefined) return '-';
  return (value / 100).toFixed(2);
}
function yuan2fen(value: unknown): number {
  const num = Number(value ?? 0);
  return Number.isFinite(num) ? Math.round(num * 100) : 0;
}

const STATUS_OPTIONS = [
  { label: '未结', value: 'open' },
  { label: '部分销账', value: 'partial' },
  { label: '已结清', value: 'settled' },
  { label: '已逾期', value: 'overdue' },
  { label: '已作废', value: 'cancelled' },
];
const STATUS_LABELS: Record<ReceivableStatus, string> = {
  open: '未结',
  partial: '部分销账',
  settled: '已结清',
  overdue: '已逾期',
  cancelled: '已作废',
};
const STATUS_CLASS: Record<ReceivableStatus, string> = {
  open: 'text-[var(--app-text-secondary)]',
  partial: 'text-[var(--lew-color-warning)] font-600',
  settled: 'text-[var(--lew-color-success)]',
  overdue: 'text-[var(--lew-color-error)] font-600',
  cancelled: 'text-[var(--app-text-muted)] line-through',
};

const CHANNEL_OPTIONS = [
  { label: '现金', value: 'cash' },
  { label: '微信线下', value: 'wechat_offline' },
  { label: '支付宝线下', value: 'alipay_offline' },
  { label: '储值余额', value: 'balance' },
  { label: '微信扫码(在线)', value: 'wxpay_native' },
  { label: '支付宝扫码(在线)', value: 'alipay_qr' },
];
const CHANNEL_LABELS: Record<ReceivablePayChannel, string> = {
  cash: '现金',
  wechat_offline: '微信线下',
  alipay_offline: '支付宝线下',
  balance: '储值余额',
  wxpay_native: '微信扫码',
  alipay_qr: '支付宝扫码',
};

// ---------- 账龄色阶 ----------
/** 按「本列最大值」做比例着色，数值越大颜色越深（色阶） */
function scaleStyle(value: number, max: number, hue: number) {
  if (!value) {
    return { color: 'var(--app-text-muted)' } as Record<string, string>;
  }
  const ratio = max > 0 ? Math.min(1, value / max) : 0;
  const lightness = 96 - ratio * 38;
  return {
    backgroundColor: `hsl(${hue} 85% ${lightness}%)`,
    color: lightness < 72 ? '#fff' : 'var(--app-text-primary)',
    padding: '2px 6px',
    borderRadius: '4px',
    display: 'inline-block',
    fontWeight: '600',
  } as Record<string, string>;
}

// ---------- 账龄汇总 ----------
const summaryRows = ref<ReceivableSummaryRow[]>([]);
const summaryLoading = ref(false);
const summaryMax = computed(() => {
  let max = 0;
  for (const row of summaryRows.value) {
    max = Math.max(
      max,
      row.age0to30 ?? 0,
      row.age31to60 ?? 0,
      row.age60plus ?? 0,
      row.overdueAmount ?? 0,
    );
  }
  return max;
});

async function loadSummary() {
  summaryLoading.value = true;
  try {
    summaryRows.value = (await getReceivableSummary()) ?? [];
  } finally {
    summaryLoading.value = false;
  }
}

// ---------- 挂账主体（筛选下拉 + 额度展示） ----------
const accountOptions = reactive<{ label: string; value: string }[]>([]);
const accountMap = ref<Record<number, CreditAccount>>({});
async function loadAccounts() {
  const data = await listCreditAccountOptions();
  const map: Record<number, CreditAccount> = {};
  for (const account of data.items) map[account.id] = account;
  accountMap.value = map;
  accountOptions.splice(
    0,
    accountOptions.length,
    ...data.items.map((account) => ({
      label: account.name,
      value: String(account.id),
    })),
  );
}

// ---------- 列表 ----------
const query = ref<{
  creditAccountId?: string;
  status?: string;
  dueDateFrom?: string;
  dueDateTo?: string;
  overdue?: string;
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
} = useTable<Receivable>({
  url: '/biz/receivables',
  query: () => query.value,
});

const columns: LewTableColumn[] = [
  { title: '应收单号', field: 'receivableNo', width: 160 },
  {
    title: '挂账主体',
    field: 'creditAccountName',
    width: 140,
    customRender: ({ row }) =>
      (row as unknown as Receivable).creditAccountName ?? '-',
  },
  {
    title: '预约单号',
    field: 'bookingNo',
    width: 160,
    customRender: ({ row }) => (row as unknown as Receivable).bookingNo ?? '-',
  },
  {
    title: '应收金额',
    field: 'amount',
    width: 110,
    customRender: ({ row }) =>
      `¥${fen2yuan((row as unknown as Receivable).amount)}`,
  },
  {
    title: '已销账',
    field: 'settledAmount',
    width: 110,
    customRender: ({ row }) =>
      `¥${fen2yuan((row as unknown as Receivable).settledAmount)}`,
  },
  {
    title: '未结余额',
    field: 'remain',
    width: 110,
    customRender: ({ row }) => {
      const item = row as unknown as Receivable;
      const remain = Math.max(0, item.amount - item.settledAmount);
      return h(
        'span',
        { class: remain > 0 ? 'font-600' : 'text-[var(--app-text-muted)]' },
        `¥${fen2yuan(remain)}`,
      );
    },
  },
  {
    title: '到期日',
    field: 'dueDate',
    width: 115,
    customRender: ({ row }) => {
      const item = row as unknown as Receivable;
      if (!item.dueDate) return '不定期';
      return item.status === 'overdue'
        ? h('span', { class: 'text-[var(--lew-color-error)]' }, item.dueDate)
        : item.dueDate;
    },
  },
  {
    title: '状态',
    field: 'status',
    width: 95,
    customRender: ({ row }) => {
      const status = (row as unknown as Receivable).status;
      return h('span', { class: STATUS_CLASS[status] }, STATUS_LABELS[status]);
    },
  },
  {
    title: '创建时间',
    field: 'createdAt',
    width: 165,
    customRender: ({ row }) =>
      formatDateTime((row as unknown as Receivable).createdAt),
  },
  { title: '操作', field: 'operation', width: 120, fixed: 'right' },
];

void loadSummary();
void loadAccounts();
void search();

/** 点账龄汇总的某一行 → 只看该主体的应收 */
function filterByAccount(row: ReceivableSummaryRow) {
  query.value.creditAccountId = String(row.creditAccountId);
  void search();
}

/** 是否可销账 / 作废 */
function canSettle(row: Receivable) {
  return row.status !== 'settled' && row.status !== 'cancelled';
}
function canCancel(row: Receivable) {
  return row.settledAmount === 0 && canSettle(row);
}

// ---------- 销账 ----------
interface SettleRow {
  channel: ReceivablePayChannel;
  /** 元 */
  amount: number;
  remark: string;
}
const settleVisible = ref(false);
/** 销账提交中：销账是资金动作，连点会超额销账 */
const settling = ref(false);
const settleTarget = ref<Receivable | null>(null);
const settleRows = ref<SettleRow[]>([]);
const settleDetail = ref<ReceivableDetail | null>(null);
const settleDetailLoading = ref(false);

const settleTotalFen = computed(() =>
  settleRows.value.reduce((sum, row) => sum + yuan2fen(row.amount), 0),
);
const settleRemainFen = computed(() => {
  const target = settleTarget.value;
  if (!target) return 0;
  return Math.max(
    0,
    target.amount - target.settledAmount - settleTotalFen.value,
  );
});
const settleAccount = computed(() => {
  const target = settleTarget.value;
  if (!target) return null;
  return accountMap.value[target.creditAccountId] ?? null;
});
/** 销账后主体的已挂未结 */
const settleUsedAfterFen = computed(() => {
  const account = settleAccount.value;
  if (!account) return 0;
  return account.usedAmount - settleTotalFen.value;
});
/** 销账后剩余额度；额度 0 = 不限 → null */
const settleLimitRemainFen = computed(() => {
  const account = settleAccount.value;
  if (!account || account.creditLimit === 0) return null;
  return account.creditLimit - settleUsedAfterFen.value;
});

function addSettleRow() {
  settleRows.value.push({ channel: 'cash', amount: 0, remark: '' });
}
function removeSettleRow(index: number) {
  settleRows.value.splice(index, 1);
}
/** 快速填入剩余应收 */
function fillRemain(index: number) {
  const row = settleRows.value[index];
  if (!row) return;
  const others = settleRows.value.reduce(
    (sum, item, i) => (i === index ? sum : sum + yuan2fen(item.amount)),
    0,
  );
  const target = settleTarget.value;
  if (!target) return;
  const remain = Math.max(0, target.amount - target.settledAmount - others);
  row.amount = remain / 100;
}

function openSettle(row: Receivable) {
  settleTarget.value = row;
  settleRows.value = [{ channel: 'cash', amount: 0, remark: '' }];
  settleDetail.value = null;
  settleVisible.value = true;
  void loadSettleDetail(row.id);
}

/** 预填「剩余应收」金额，减少手输 */
function onSettleOpened(row: Receivable) {
  const remain = Math.max(0, row.amount - row.settledAmount);
  const first = settleRows.value[0];
  if (first) first.amount = remain / 100;
}

async function loadSettleDetail(id: number) {
  settleDetailLoading.value = true;
  try {
    const detail = await getReceivable(id);
    settleDetail.value = detail;
    if (settleTarget.value && settleTarget.value.id === id) {
      onSettleOpened(settleTarget.value);
    }
  } finally {
    settleDetailLoading.value = false;
  }
}

// ---------- 在线渠道二维码 ----------
const qrVisible = ref(false);
const qrCodeUrl = ref('');
const qrExpireAt = ref<string | null>(null);
/**
 * 在线收款码的**支付状态轮询**。
 *
 * 原来这里只弹二维码、**不查支付状态**，却写着「支付成功后自动回到本单」——
 * 顾客扫完码页面不会有任何变化，员工只能手动刷新或干等后端定时任务（最长 2 分钟），
 * 期间很可能**再收一次现金**。现在与收银台用同一套：
 * 3 秒轮询 + 连续失败 5 次停（避免刷屏）+ 卸载时清理定时器 + 过期两条出口。
 */
const qrPaymentId = ref<number | null>(null);
// 直接用接口导出的类型：手抄枚举必然漏项（refunded / partial_refunded 都真实存在）
const qrStatus = ref<PaymentStatus>('pending');
const qrFailures = ref(0);
/** 二维码剩余秒数（0 = 已过期，给出「重新获取 / 改现金」出口） */
const qrRemaining = ref(0);
/** 状态文案：让员工一眼看出「还在等 / 成了 / 需要处理」 */
const qrStatusText = computed(() => {
  switch (qrStatus.value) {
    case 'pending':
      return '等待顾客支付，支付成功后本页会自动刷新';
    case 'success':
      return '顾客已支付';
    case 'closed':
      return '该支付单已关闭，请重新获取二维码或改现金收款';
    case 'failed':
      return '该支付单支付失败，请重新获取二维码或改现金收款';
    default:
      return '该支付单已退款，请核对台账';
  }
});
let pollTimer: number | null = null;
let tickTimer: number | null = null;
/** 最近一次提交的销账参数：过期后「重新获取」要按同样参数重下 */
let lastSettle: { target: Receivable; payments: SettlePaymentInput[] } | null =
  null;

function stopPolling() {
  if (pollTimer !== null) {
    window.clearInterval(pollTimer);
    pollTimer = null;
  }
}

function stopTick() {
  if (tickTimer !== null) {
    window.clearInterval(tickTimer);
    tickTimer = null;
  }
}

function startCountdown(expireAt: string | null | undefined) {
  stopTick();
  const expireMs = expireAt
    ? new Date(expireAt).getTime()
    : Date.now() + 5 * 60_000;
  const update = () => {
    qrRemaining.value = Math.max(0, Math.round((expireMs - Date.now()) / 1000));
    if (qrRemaining.value <= 0) stopTick();
  };
  update();
  tickTimer = window.setInterval(update, 1000);
}

function startPolling(paymentId: number) {
  stopPolling();
  qrFailures.value = 0;
  pollTimer = window.setInterval(() => {
    void pollStatus(paymentId);
  }, 3000);
}

async function pollStatus(paymentId: number) {
  if (qrStatus.value !== 'pending') return;
  try {
    const data = await getPaymentStatus(paymentId);
    qrFailures.value = 0;
    qrStatus.value = data.status;
    if (data.status === 'success') {
      stopPolling();
      stopTick();
      qrVisible.value = false;
      LewMessage.success('顾客已支付，正在刷新应收台账');
      await refreshAll();
      await loadAccounts();
    } else if (data.status === 'closed' || data.status === 'failed') {
      // 通道侧已定局：停轮询并**明确告知**，同时刷新台账（别让员工猜）
      stopPolling();
      LewMessage.warning(
        data.status === 'closed'
          ? '该在线支付单已关闭，请重新获取二维码或改现金收款'
          : '该在线支付单支付失败，请重新获取二维码或改现金收款',
      );
      await refreshAll();
    }
  } catch {
    // 轮询失败静默重试；连续失败 5 次后停止，避免提示刷屏
    qrFailures.value += 1;
    if (qrFailures.value >= 5) stopPolling();
  }
}

async function closeQrModal() {
  stopPolling();
  stopTick();
  qrVisible.value = false;
  // 关闭前**主动查一次**通道：员工关掉弹窗时这笔到底成没成，不能只靠后端定时任务
  const paymentId = qrPaymentId.value;
  if (paymentId && qrStatus.value === 'pending') {
    try {
      await pollStatus(paymentId);
    } catch {
      /* 查不到就算了，台账刷新仍会反映本地状态 */
    }
  }
}

/** 过期出口 1：关掉超时的支付单，按同样的参数重新获取二维码 */
function handleReacquire() {
  const paymentId = qrPaymentId.value;
  const last = lastSettle;
  if (!paymentId || !last) return;
  confirmDanger({
    type: 'normal',
    title: '重新获取二维码',
    content: '将关闭已超时的支付单并重新下单生成新二维码。确定继续吗？',
    confirmText: '重新获取',
    confirmColor: 'primary',
    onConfirm: async () => {
      await closePayment(paymentId, { reason: '二维码超时，重新获取' });
      await closeQrModal();
      await submitSettle(last.target, last.payments);
    },
  });
}

/**
 * 过期出口 2：关掉超时的支付单，改为现金收款。
 *
 * 这里**刻意不自动重提**销账：金额构成可能已经被员工改过，自动按旧参数重下
 * 有「替他做决定」的风险。只负责把在线单关干净，并明确告诉员工下一步做什么。
 */
function handleSwitchToCash() {
  const paymentId = qrPaymentId.value;
  if (!paymentId) return;
  confirmDanger({
    type: 'normal',
    title: '改现金收款',
    content:
      '将关闭这张超时的在线支付单，然后请按现金方式重新销账。确定继续吗？',
    confirmText: '改为现金',
    confirmColor: 'primary',
    onConfirm: async () => {
      await closePayment(paymentId, { reason: '二维码超时，改现金收款' });
      await closeQrModal();
      LewMessage.success('已关闭在线支付单，请按现金方式重新销账');
      await refreshAll();
    },
  });
}

onBeforeUnmount(() => {
  stopPolling();
  stopTick();
});
const qrIsImage = computed(() =>
  /^(data:image\/|https?:\/\/.+\/(wxpay|alipay)|https?:\/\/.+\.(png|jpe?g|gif|svg))/i.test(
    qrCodeUrl.value,
  ),
);
async function copyQrUrl() {
  try {
    await navigator.clipboard.writeText(qrCodeUrl.value);
    LewMessage.success('已复制支付链接');
  } catch {
    LewMessage.error('复制失败，请手动选中下方链接复制');
  }
}

function hasOnlineChannel() {
  return settleRows.value.some((row) =>
    ONLINE_PAY_CHANNELS.includes(row.channel),
  );
}

async function handleSettle() {
  const target = settleTarget.value;
  if (!target) return;
  if (!settleRows.value.length) {
    LewMessage.error('请至少添加一笔销账');
    return;
  }
  const payments: SettlePaymentInput[] = [];
  for (const [index, row] of settleRows.value.entries()) {
    const amount = yuan2fen(row.amount);
    if (amount <= 0) {
      LewMessage.error(`第 ${index + 1} 笔销账金额必须大于 0`);
      return;
    }
    payments.push({
      channel: row.channel,
      amount,
      remark: row.remark || null,
    });
  }
  const remain = Math.max(0, target.amount - target.settledAmount);
  if (settleTotalFen.value > remain) {
    LewMessage.error(
      `销账合计 ¥${fen2yuan(settleTotalFen.value)} 超过剩余应收 ¥${fen2yuan(remain)}`,
    );
    return;
  }
  // 销账是资金动作：确认前展示合计、销账后剩余应收与剩余额度
  const channelText = settleRows.value
    .map(
      (row) =>
        `${CHANNEL_LABELS[row.channel] ?? row.channel} ¥${fen2yuan(yuan2fen(row.amount))}`,
    )
    .join(' + ');
  confirmDanger({
    type: 'warning',
    title: '销账确认',
    content: `应收单 ${target.receivableNo}\n本次销账：${channelText}\n合计 ¥${fen2yuan(settleTotalFen.value)}，销账后剩余应收 ¥${fen2yuan(settleRemainFen.value)}。\n销账不得超额，确认执行吗？`,
    confirmText: '确认销账',
    confirmColor: 'warning',
    onConfirm: async () => {
      settling.value = true;
      try {
        await submitSettle(target, payments);
      } finally {
        settling.value = false;
      }
    },
  });
}

async function submitSettle(
  target: Receivable,
  payments: SettlePaymentInput[],
) {
  // 双保险：confirmDanger 已挡一层，这里挡「已提交但弹窗还没关」的窗口
  if (settling.value) return;
  const result = await settleReceivable(target.id, { payments });
  await refreshAll();
  await loadAccounts();
  const beRemain = Math.max(
    0,
    target.amount - (result.settledAmount ?? target.settledAmount),
  );
  if (result.codeUrl) {
    qrCodeUrl.value = result.codeUrl;
    qrExpireAt.value = result.expireAt ?? null;
    qrPaymentId.value = result.paymentId ?? null;
    qrStatus.value = 'pending';
    // 记住本次参数：过期后「重新获取」按同样参数重下
    lastSettle = { target, payments };
    settleVisible.value = false;
    qrVisible.value = true;
    startCountdown(result.expireAt);
    if (qrPaymentId.value !== null) startPolling(qrPaymentId.value);
    LewMessage.success('已生成在线收款码，请顾客扫码支付');
    return;
  }
  LewMessage.success(
    beRemain > 0
      ? `销账成功，剩余应收 ¥${fen2yuan(beRemain)}`
      : '销账成功，该应收已结清',
  );
  if (beRemain === 0) settleVisible.value = false;
  else if (settleTarget.value) await loadSettleDetail(settleTarget.value.id);
}

// ---------- 作废 ----------
const cancelVisible = ref(false);
const cancelTarget = ref<Receivable | null>(null);
const cancelReason = ref('');

function openCancel(row: Receivable) {
  cancelTarget.value = row;
  cancelReason.value = '';
  cancelVisible.value = true;
}

async function handleCancel() {
  const target = cancelTarget.value;
  if (!target) return;
  if (!cancelReason.value.trim()) {
    LewMessage.error('请填写作废原因');
    return;
  }
  confirmDanger({
    type: 'warning',
    title: '作废确认',
    content: `确定作废应收单「${target.receivableNo}」（¥${fen2yuan(target.amount)}）吗？作废后不可恢复，同时回减主体已挂金额。`,
    confirmText: '作废',
    onConfirm: async () => {
      await cancelReceivable(target.id, cancelReason.value.trim());
      LewMessage.success('已作废');
      cancelVisible.value = false;
      await refreshAll();
      await loadAccounts();
    },
  });
}

// ---------- 销账记录（独立于销账弹窗，避免互相覆盖） ----------
const historyVisible = ref(false);
const historyTarget = ref<Receivable | null>(null);
const historyDetail = ref<ReceivableDetail | null>(null);
const historyLoading = ref(false);

async function openHistory(row: Receivable) {
  historyTarget.value = row;
  historyVisible.value = true;
  historyDetail.value = null;
  historyLoading.value = true;
  try {
    historyDetail.value = await getReceivable(row.id);
  } finally {
    historyLoading.value = false;
  }
}

/** 汇总 + 列表一起刷新 */
async function refreshAll() {
  await Promise.all([loadSummary(), refresh()]);
}
</script>

<template>
  <div class="page-container">
    <!-- 页头 -->
    <div class="flex items-center justify-between">
      <div>
        <h2 class="page-title m-0">应收台账</h2>
        <p class="page-subtitle mt-1 mb-0">
          挂账不计营收，销账才计入；销账不得超额
        </p>
      </div>
      <LewButton
        type="light"
        :loading="summaryLoading || loading"
        @click="refreshAll"
      >
        刷新
      </LewButton>
    </div>

    <!-- 账龄汇总（按主体聚合，色阶） -->
    <div class="app-card p-4">
      <div class="mb-3 flex items-center justify-between">
        <span class="text-14px font-600">按主体聚合的账龄汇总</span>
        <span class="text-12px text-[var(--app-text-muted)]">
          点击行可只看该主体 · 金额单位：元
        </span>
      </div>
      <div class="overflow-x-auto">
        <table class="table-base">
          <thead>
            <tr>
              <th class="table-th">主体</th>
              <th class="table-th">类型</th>
              <th class="table-th">额度</th>
              <th class="table-th">已挂未结</th>
              <th class="table-th">应收余额</th>
              <th class="table-th">0-30 天</th>
              <th class="table-th">31-60 天</th>
              <th class="table-th">60 天以上</th>
              <th class="table-th">逾期金额</th>
              <th class="table-th">未结单数</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="row in summaryRows"
              :key="row.creditAccountId"
              class="cursor-pointer hover:bg-[var(--app-bg-hover)]"
              @click="filterByAccount(row)"
            >
              <td class="table-td font-600">{{ row.creditAccountName }}</td>
              <td class="table-td">
                {{
                  row.type === 'customer'
                    ? '顾客'
                    : row.type === 'company'
                      ? '公司'
                      : '员工'
                }}
              </td>
              <td class="table-td">
                {{
                  row.creditLimit === 0
                    ? '不限'
                    : `¥${fen2yuan(row.creditLimit)}`
                }}
              </td>
              <td class="table-td">¥{{ fen2yuan(row.usedAmount) }}</td>
              <td class="table-td font-600">
                ¥{{ fen2yuan(row.unsettledAmount) }}
              </td>
              <td class="table-td">
                <span :style="scaleStyle(row.age0to30, summaryMax, 142)">
                  {{ fen2yuan(row.age0to30) }}
                </span>
              </td>
              <td class="table-td">
                <span :style="scaleStyle(row.age31to60, summaryMax, 38)">
                  {{ fen2yuan(row.age31to60) }}
                </span>
              </td>
              <td class="table-td">
                <span :style="scaleStyle(row.age60plus, summaryMax, 0)">
                  {{ fen2yuan(row.age60plus) }}
                </span>
              </td>
              <td class="table-td">
                <span :style="scaleStyle(row.overdueAmount, summaryMax, 0)">
                  {{ fen2yuan(row.overdueAmount) }}
                </span>
              </td>
              <td class="table-td">{{ row.count }}</td>
            </tr>
            <tr v-if="!summaryLoading && !summaryRows.length">
              <td class="table-empty" colspan="10">暂无挂账数据</td>
            </tr>
            <tr v-else-if="summaryLoading">
              <td class="table-empty" colspan="10">加载中…</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- 筛选 -->
    <div class="app-card flex flex-wrap items-center gap-3 p-4">
      <LewSelect
        v-model="query.creditAccountId"
        width="200px"
        :options="accountOptions"
        placeholder="全部挂账主体"
        clearable
      />
      <LewSelect
        v-model="query.status"
        width="140px"
        :options="STATUS_OPTIONS"
        placeholder="全部状态"
        clearable
      />
      <LewDatePicker
        v-model="query.dueDateFrom"
        width="150px"
        value-format="YYYY-MM-DD"
        placeholder="到期日从"
        clearable
      />
      <span class="text-[var(--app-text-muted)]">~</span>
      <LewDatePicker
        v-model="query.dueDateTo"
        width="150px"
        value-format="YYYY-MM-DD"
        placeholder="到期日至"
        clearable
      />
      <LewSelect
        v-model="query.overdue"
        width="130px"
        :options="[
          { label: '仅看逾期', value: 'true' },
          { label: '非逾期', value: 'false' },
        ]"
        placeholder="逾期筛选"
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
              permission="biz:receivable:settle"
              title="销账"
              :disabled="!canSettle(row as unknown as Receivable) || settling"
              @click="openSettle(row as unknown as Receivable)"
            >
              <CheckCircle2 :size="14" />
            </IconButton>
            <IconButton
              permission="biz:receivable:cancel"
              color="error"
              title="作废"
              :disabled="!canCancel(row as unknown as Receivable)"
              @click="openCancel(row as unknown as Receivable)"
            >
              <Ban :size="14" />
            </IconButton>
            <IconButton
              title="销账记录"
              @click="openHistory(row as unknown as Receivable)"
            >
              <FileText :size="14" />
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

    <!-- 销账弹窗 -->
    <LewModal
      v-model:visible="settleVisible"
      :title="`销账 - ${settleTarget?.receivableNo ?? ''}`"
      width="720px"
      :footer-buttons="[
        {
          props: {
            type: 'text',
            color: 'gray',
            size: 'small',
            text: '取消',
            request: () => {
              settleVisible = false;
            },
          },
        },
        {
          props: {
            type: 'fill',
            color: 'primary',
            size: 'small',
            text: '确认销账',
            request: handleSettle,
          },
        },
      ]"
    >
      <div class="flex flex-col gap-4 p-5">
        <!-- 金额与额度实时显示 -->
        <div
          class="grid grid-cols-3 gap-x-4 gap-y-2 rounded-8px bg-[var(--app-bg-hover)] p-3 text-13px"
        >
          <div>
            <span class="text-[var(--app-text-muted)]">应收金额：</span>
            <span class="font-600">¥{{ fen2yuan(settleTarget?.amount) }}</span>
          </div>
          <div>
            <span class="text-[var(--app-text-muted)]">已销账：</span>
            <span>¥{{ fen2yuan(settleTarget?.settledAmount) }}</span>
          </div>
          <div>
            <span class="text-[var(--app-text-muted)]">本次销账合计：</span>
            <span class="font-600 text-[var(--lew-color-primary)]"
              >¥{{ fen2yuan(settleTotalFen) }}</span
            >
          </div>
          <div>
            <span class="text-[var(--app-text-muted)]">剩余应收：</span>
            <span
              class="font-600"
              :class="
                settleRemainFen > 0 ? 'text-[var(--lew-color-warning)]' : ''
              "
              >¥{{ fen2yuan(settleRemainFen) }}</span
            >
          </div>
          <div>
            <span class="text-[var(--app-text-muted)]">主体额度：</span>
            <span>{{
              !settleAccount || settleAccount.creditLimit === 0
                ? '不限'
                : `¥${fen2yuan(settleAccount.creditLimit)}`
            }}</span>
          </div>
          <div>
            <span class="text-[var(--app-text-muted)]">销账后已挂未结：</span>
            <span
              class="font-600"
              :class="
                settleUsedAfterFen < 0 ? 'text-[var(--lew-color-error)]' : ''
              "
              >¥{{ fen2yuan(settleUsedAfterFen) }}</span
            >
          </div>
          <div>
            <span class="text-[var(--app-text-muted)]">销账后剩余额度：</span>
            <span
              class="font-600"
              :class="
                settleLimitRemainFen !== null && settleLimitRemainFen < 0
                  ? 'text-[var(--lew-color-error)]'
                  : ''
              "
              >{{
                settleLimitRemainFen === null
                  ? '不限'
                  : `¥${fen2yuan(settleLimitRemainFen)}`
              }}</span
            >
          </div>
          <div>
            <span class="text-[var(--app-text-muted)]">到期日：</span>
            <span>{{ settleTarget?.dueDate ?? '不定期' }}</span>
          </div>
          <div>
            <span class="text-[var(--app-text-muted)]">状态：</span>
            <span>{{
              settleTarget ? STATUS_LABELS[settleTarget.status] : '-'
            }}</span>
          </div>
        </div>

        <!-- 多笔混合销账 -->
        <div>
          <div class="mb-2 flex items-center justify-between">
            <span class="text-13.5px font-600">销账明细（支持多笔混合）</span>
            <LewButton size="small" type="light" @click="addSettleRow">
              <Plus :size="14" style="margin-right: 4px" /> 添加一笔
            </LewButton>
          </div>
          <div class="flex flex-col gap-2">
            <div
              v-for="(row, index) in settleRows"
              :key="index"
              class="flex items-center gap-2"
            >
              <LewSelect
                v-model="row.channel"
                width="150px"
                :options="CHANNEL_OPTIONS"
              />
              <LewInputNumber
                v-model="row.amount"
                width="140px"
                :min="0"
                :step="0.01"
                placeholder="金额(元)"
              />
              <LewButton size="small" type="text" @click="fillRemain(index)"
                >填剩余</LewButton
              >
              <LewInput
                v-model="row.remark"
                width="160px"
                placeholder="备注(选填)"
              />
              <IconButton
                color="error"
                title="删除该笔"
                @click="removeSettleRow(index)"
              >
                <Trash2 :size="14" />
              </IconButton>
            </div>
            <div
              v-if="!settleRows.length"
              class="table-empty rounded-8px border border-dashed border-[var(--app-border)]"
            >
              还没有销账明细，点「添加一笔」
            </div>
          </div>
          <p
            v-if="hasOnlineChannel()"
            class="mt-2 mb-0 text-12px text-[var(--lew-color-warning)]"
          >
            含在线扫码渠道：提交后会生成收款二维码，顾客扫码支付成功后，
            在线支付单由回调 / 主动查单落地（线上部分不会立即销账）。
          </p>
        </div>

        <!-- 销账记录 -->
        <div>
          <span class="text-13.5px font-600">历史销账记录</span>
          <div class="mt-2">
            <table class="table-base">
              <thead>
                <tr>
                  <th class="table-th">渠道</th>
                  <th class="table-th">金额</th>
                  <th class="table-th">支付时间</th>
                  <th class="table-th">备注</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="payment in settleDetail?.payments ?? []"
                  :key="payment.id"
                >
                  <td class="table-td">
                    {{
                      CHANNEL_LABELS[payment.payChannel] ?? payment.payChannel
                    }}
                  </td>
                  <td class="table-td">¥{{ fen2yuan(payment.amount) }}</td>
                  <td class="table-td">{{ formatDateTime(payment.paidAt) }}</td>
                  <td class="table-td">{{ payment.remark ?? '-' }}</td>
                </tr>
                <tr
                  v-if="
                    !settleDetailLoading &&
                    !(settleDetail?.payments ?? []).length
                  "
                >
                  <td class="table-empty" colspan="4">暂无销账记录</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </LewModal>

    <!-- 在线收款二维码 -->
    <LewModal v-model:visible="qrVisible" title="在线收款码" width="420px">
      <div class="flex flex-col items-center gap-3 p-5">
        <img
          v-if="qrIsImage"
          :src="qrCodeUrl"
          alt="收款二维码"
          title="点击放大（方便顾客远距离扫码）"
          class="h-200px w-200px cursor-zoom-in object-contain"
          @click="openImagePreview([qrCodeUrl], 0, '在线收款码')"
        />
        <!--
          TODO(QR): 项目未内置二维码渲染库（web/package.json 不可改），
          渠道返回的是支付链接（weixin:// / https://qr.alipay.com/...），
          无法直接当图片展示。这里降级为「链接 + 复制」，接入 qrcode 库后替换为 <canvas>/<img> 渲染。
        -->
        <div
          v-else
          class="flex h-160px w-full items-center justify-center rounded-8px border border-dashed border-[var(--app-border)] p-3 text-center text-12.5px text-[var(--app-text-muted)]"
        >
          二维码组件待接入：请让顾客在收银台扫码，<br />
          或复制下方支付链接后用收银设备打开
        </div>
        <code
          class="max-h-80px w-full overflow-y-auto rounded-6px bg-[var(--app-bg-hover)] p-2 text-12px break-all"
          >{{ qrCodeUrl }}</code
        >
        <div class="text-12px text-[var(--app-text-muted)]">
          <span v-if="qrRemaining > 0">剩余 {{ qrRemaining }} 秒 · </span>
          <span v-else>已超时 · </span>
          <span>{{ qrStatusText }}</span>
        </div>
        <div
          v-if="qrRemaining <= 0 && qrStatus !== 'success'"
          class="flex gap-2"
        >
          <LewButton type="fill" @click="handleReacquire"
            >重新获取二维码</LewButton
          >
          <LewButton type="light" @click="handleSwitchToCash"
            >改现金收款</LewButton
          >
        </div>
        <div class="flex gap-2">
          <LewButton type="light" @click="copyQrUrl">复制支付链接</LewButton>
          <LewButton type="fill" @click="closeQrModal">关闭</LewButton>
        </div>
      </div>
    </LewModal>

    <!-- 作废弹窗 -->
    <LewModal v-model:visible="cancelVisible" title="作废应收单" width="460px">
      <div class="flex flex-col gap-3 p-5">
        <div class="text-13.5px">
          应收单
          <span class="font-600">{{ cancelTarget?.receivableNo }}</span>
          ，金额
          <span class="font-600">¥{{ fen2yuan(cancelTarget?.amount) }}</span>
        </div>
        <p class="m-0 text-12.5px text-[var(--app-text-muted)]">
          作废后不可恢复，同时回减该主体的已挂未结金额。
        </p>
        <LewTextarea
          v-model="cancelReason"
          min-height="90px"
          placeholder="请填写作废原因（必填）"
        />
        <div class="flex justify-end gap-2">
          <LewButton type="text" color="gray" @click="cancelVisible = false"
            >取消</LewButton
          >
          <LewButton
            v-permission="'biz:receivable:cancel'"
            type="fill"
            color="error"
            @click="handleCancel"
            >确认作废</LewButton
          >
        </div>
      </div>
    </LewModal>

    <!-- 销账记录抽屉（只读） -->
    <LewModal
      v-model:visible="historyVisible"
      :title="`销账记录 - ${historyTarget?.receivableNo ?? ''}`"
      width="640px"
      :hide-footer="true"
    >
      <div class="p-5">
        <table class="table-base">
          <thead>
            <tr>
              <th class="table-th">渠道</th>
              <th class="table-th">金额</th>
              <th class="table-th">支付时间</th>
              <th class="table-th">备注</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="payment in historyDetail?.payments ?? []"
              :key="payment.id"
            >
              <td class="table-td">
                {{ CHANNEL_LABELS[payment.payChannel] ?? payment.payChannel }}
              </td>
              <td class="table-td">¥{{ fen2yuan(payment.amount) }}</td>
              <td class="table-td">{{ formatDateTime(payment.paidAt) }}</td>
              <td class="table-td">{{ payment.remark ?? '-' }}</td>
            </tr>
            <tr
              v-if="!historyLoading && !(historyDetail?.payments ?? []).length"
            >
              <td class="table-empty" colspan="4">暂无销账记录</td>
            </tr>
          </tbody>
        </table>
      </div>
    </LewModal>
  </div>
</template>
