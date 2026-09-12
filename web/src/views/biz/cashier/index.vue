<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import dayjs from 'dayjs';
import {
  CheckCircle2,
  ClipboardCopy,
  Plus,
  QrCode,
  RefreshCw,
  Trash2,
  Wallet,
} from 'lucide-vue-next';
import { LewButton, LewInput, LewMessage, LewModal, LewSelect } from 'lew-ui';
import {
  ONLINE_CHANNELS,
  closePayment,
  getCashierBooking,
  getPaymentStatus,
  listCashierBookings,
  listCreditAccountOptions,
  settleBooking,
  type CashierBooking,
  type CreditAccountOption,
  type PaymentChannel,
  type PaymentOutcome,
  type PaymentStatus,
  type SettleBookingBody,
  type SettleBookingResult,
} from '~/api/biz/payments';
import { getMember, type MemberDetail } from '~/api/biz/members';
import { listMemberCards, type MemberCard } from '~/api/biz/member-cards';
import { previewPoints, type PointsPreview } from '~/api/biz/points-goods';
import { formatDateTime } from '~/composables/useFormat';
import { confirmDanger } from '~/utils/confirm';
import IconButton from '~/components/IconButton.vue';

// ---------- 金额换算 ----------
function fen2yuan(fen: number | null | undefined): string {
  if (fen === null || fen === undefined) return '0.00';
  return (fen / 100).toFixed(2);
}

function yuan2fen(yuan: number | string | null | undefined): number {
  const value = Number(yuan ?? 0);
  return Number.isFinite(value) ? Math.round(value * 100) : 0;
}

// ---------- 左栏：待收款队列（未收 / 待收尾款 / 挂账） ----------
const unpaidItems = shallowRef<CashierBooking[]>([]);
const partialItems = shallowRef<CashierBooking[]>([]);
const creditItems = shallowRef<CashierBooking[]>([]);
const queueLoading = ref(false);
const queueKeyword = ref('');

const groups = computed(() => [
  {
    key: 'unpaid',
    title: '未收',
    items: unpaidItems.value,
    class: 'text-[var(--lew-color-error)]',
  },
  {
    key: 'partial',
    title: '待收尾款',
    items: partialItems.value,
    class: 'text-[var(--lew-color-warning)]',
  },
  {
    key: 'credit',
    title: '挂账',
    items: creditItems.value,
    class: 'text-[var(--lew-color-primary)]',
  },
]);

async function loadQueue() {
  queueLoading.value = true;
  try {
    const keyword = queueKeyword.value.trim() || undefined;
    const [unpaid, partial, credit] = await Promise.all([
      listCashierBookings(1, 50, { payStatus: 'unpaid', keyword }),
      listCashierBookings(1, 50, { payStatus: 'partial', keyword }),
      listCashierBookings(1, 50, { payStatus: 'credit', keyword }),
    ]);
    unpaidItems.value = unpaid.items;
    partialItems.value = partial.items;
    creditItems.value = credit.items;
  } finally {
    queueLoading.value = false;
  }
}
void loadQueue();

// ---------- 中栏：选中单据 ----------
const selectedId = ref<number | null>(null);
const selected = ref<CashierBooking | null>(null);
const detailLoading = ref(false);

const memberInfo = shallowRef<MemberDetail | null>(null);
const memberLoading = ref(false);

const customerCards = shallowRef<MemberCard[]>([]);

/** 可用储值余额（分）= 本金 + 赠送 */
const balanceAvailable = computed(
  () =>
    (memberInfo.value?.balancePrincipal ?? 0) +
    (memberInfo.value?.balanceBonus ?? 0),
);

const cardOptions = computed(() =>
  customerCards.value.map((card) => ({
    label: `${card.cardName}（${card.cardNo}，剩余 ${
      card.remainTimes ?? card.totalTimes - card.usedTimes
    } 次）`,
    value: String(card.id),
  })),
);

async function loadMember(customerId: number | null) {
  memberInfo.value = null;
  if (!customerId) return;
  memberLoading.value = true;
  try {
    memberInfo.value = await getMember(customerId);
  } catch {
    // 非会员 / 无 biz:member:list 权限：静默降级，不影响收银
  } finally {
    memberLoading.value = false;
  }
}

async function loadCustomerCards(customerId: number | null) {
  customerCards.value = [];
  if (!customerId) return;
  try {
    const data = await listMemberCards(1, 100, {
      customerId,
      status: 'active',
    });
    customerCards.value = data.items;
  } catch {
    // 次卡列表不可用时静默降级
  }
}

/** 应收 / 已收 / 尾款（分） */
const payableFen = computed(() => selected.value?.payableAmount ?? 0);
const paidFen = computed(() => selected.value?.paidAmount ?? 0);
const dueFen = computed(() => selected.value?.dueAmount ?? 0);

async function selectBooking(item: CashierBooking) {
  selectedId.value = item.id;
  selected.value = item;
  detailLoading.value = true;
  try {
    selected.value = await getCashierBooking(item.id);
  } catch {
    // 拦截器已提示；保留队列行的降级数据
  } finally {
    detailLoading.value = false;
  }
  const customerId = selected.value?.customerId ?? null;
  await Promise.all([loadMember(customerId), loadCustomerCards(customerId)]);
  resetPayments();
}

async function reloadSelected() {
  const id = selectedId.value;
  if (!id) return;
  detailLoading.value = true;
  try {
    selected.value = await getCashierBooking(id);
  } catch {
    // 拦截器已提示
  } finally {
    detailLoading.value = false;
  }
  await loadMember(selected.value?.customerId ?? null);
}

// ---------- 右栏：混合支付 ----------
interface PaymentRow {
  key: number;
  /** 渠道（LewSelect 的值为字符串，提交时断言成 PaymentChannel） */
  channel: string;
  /** 应收（元，LewInput 只接受字符串，提交时换算成分） */
  amount: string;
  /** 实收（元，现金找零用） */
  receivedAmount: string;
  memberCardId?: string;
}

let rowSeq = 0;
const paymentRows = ref<PaymentRow[]>([]);
const remark = ref('');
const pointsUsed = ref('');
const pointsPreview = ref<PointsPreview | null>(null);
const pointsPreviewLoading = ref(false);

const channelOptions = [
  { label: '现金', value: 'cash' },
  { label: '微信线下收款码', value: 'wechat_offline' },
  { label: '支付宝线下收款码', value: 'alipay_offline' },
  { label: '微信 Native 扫码', value: 'wxpay_native' },
  { label: '支付宝扫码', value: 'alipay_qr' },
  { label: '储值余额', value: 'balance' },
  { label: '次卡核销', value: 'card' },
  { label: '挂账', value: 'credit' },
];

function addRow(channel: PaymentChannel = 'cash', amount = 0) {
  rowSeq += 1;
  const text = String(amount);
  paymentRows.value.push({
    key: rowSeq,
    channel,
    amount: text,
    receivedAmount: text,
    memberCardId: undefined,
  });
}

function removeRow(key: number) {
  paymentRows.value = paymentRows.value.filter((row) => row.key !== key);
}

function resetPayments() {
  paymentRows.value = [];
  remark.value = '';
  pointsUsed.value = '';
  pointsPreview.value = null;
  creditAccountId.value = undefined;
  addRow('cash', Number(fen2yuan(dueFen.value)));
}

/** 本次收款合计（分，次卡核销不产生金额） */
const paymentsTotalFen = computed(() =>
  paymentRows.value
    .filter((row) => row.channel !== 'card')
    .reduce((sum, row) => sum + yuan2fen(row.amount), 0),
);

const hasCardRow = computed(() =>
  paymentRows.value.some((row) => row.channel === 'card'),
);
const hasCreditRow = computed(() =>
  paymentRows.value.some((row) => row.channel === 'credit'),
);
const hasOnlineRow = computed(() =>
  paymentRows.value.some((row) =>
    ONLINE_CHANNELS.includes(row.channel as PaymentChannel),
  ),
);

// 挂账主体（§18.1）；多笔 credit 共用同一次请求体里的 creditAccountId
const creditAccounts = shallowRef<CreditAccountOption[]>([]);
const creditAccountId = ref<string | undefined>(undefined);
const creditTypeText: Record<string, string> = {
  customer: '顾客',
  company: '公司',
  staff: '员工',
};
const creditAccountOptions = computed(() =>
  creditAccounts.value.map((account) => {
    const available =
      account.creditLimit === 0
        ? '额度不限'
        : `剩余额度 ¥${fen2yuan(Math.max(account.creditLimit - account.usedAmount, 0))}`;
    return {
      label: `${account.name}（${creditTypeText[account.type] ?? account.type}，${available}）`,
      value: String(account.id),
    };
  }),
);

watch(hasCreditRow, async (visible) => {
  if (!visible || creditAccounts.value.length) return;
  try {
    creditAccounts.value = await listCreditAccountOptions();
  } catch {
    // 挂账模块不可用时静默降级
  }
});

async function handlePointsPreview() {
  const booking = selected.value;
  if (!booking) return;
  const serviceItemIds = (booking.items ?? []).map(
    (item) => item.serviceItemId,
  );
  if (!serviceItemIds.length) {
    LewMessage.error('该单据没有项目明细，无法试算积分抵扣');
    return;
  }
  pointsPreviewLoading.value = true;
  try {
    const result = await previewPoints({
      customerId: booking.customerId,
      serviceItemIds,
    });
    pointsPreview.value = result;
    pointsUsed.value = String(result.maxPoints);
    LewMessage.success(
      `最多可用 ${result.maxPoints} 分，可抵 ¥${fen2yuan(result.maxDiscountAmount)}`,
    );
  } finally {
    pointsPreviewLoading.value = false;
  }
}

/** 最近一次提交的请求体（二维码「重新获取」时原样重放） */
const lastSubmitted = ref<SettleBookingBody | null>(null);
/** 结算提交中：挡住连点导致的重复建单（混合支付会逐笔落 biz_payment） */
const settling = ref(false);

function handleSettle() {
  if (settling.value) return;
  if (detailLoading.value) return;
  const booking = selected.value;
  if (!booking) {
    LewMessage.error('请先选择待收款的单据');
    return;
  }
  const rows = paymentRows.value.filter(
    (row) => row.channel === 'card' || Number(row.amount) > 0,
  );
  if (!rows.length) {
    LewMessage.error('请至少添加一笔收款');
    return;
  }
  const pointsUsedValue = Number(pointsUsed.value) || 0;
  if (pointsUsedValue < 0) {
    LewMessage.error('积分抵扣数不能为负');
    return;
  }
  for (const row of rows) {
    if (row.channel === 'card') {
      if (!row.memberCardId) {
        LewMessage.error('次卡核销必须选择一张可用次卡');
        return;
      }
      continue;
    }
    if (yuan2fen(row.amount) <= 0) {
      LewMessage.error('每笔收款金额必须大于 0');
      return;
    }
    if (row.channel === 'credit' && !creditAccountId.value) {
      LewMessage.error('挂账必须选择挂账主体');
      return;
    }
    if (
      row.channel === 'balance' &&
      yuan2fen(row.amount) > balanceAvailable.value
    ) {
      LewMessage.error(
        `储值余额不足：当前可用 ¥${fen2yuan(balanceAvailable.value)}，余额不足不会部分扣减`,
      );
      return;
    }
  }
  const totalFen = rows
    .filter((row) => row.channel !== 'card')
    .reduce((sum, row) => sum + yuan2fen(row.amount), 0);
  if (totalFen > dueFen.value) {
    LewMessage.error(
      `本次收款合计 ¥${fen2yuan(totalFen)} 超过应收尾款 ¥${fen2yuan(dueFen.value)}`,
    );
    return;
  }
  const body: SettleBookingBody = {
    payments: rows.map((row) => ({
      channel: row.channel as PaymentChannel,
      amount: yuan2fen(row.amount),
      receivedAmount:
        row.channel === 'cash' ? yuan2fen(row.receivedAmount) : undefined,
      memberCardId:
        row.channel === 'card' && row.memberCardId
          ? Number(row.memberCardId)
          : undefined,
    })),
    pointsUsed: pointsUsedValue > 0 ? pointsUsedValue : undefined,
    creditAccountId:
      hasCreditRow.value && creditAccountId.value
        ? Number(creditAccountId.value)
        : undefined,
    remark: remark.value.trim() || undefined,
  };
  confirmDanger({
    type: 'normal',
    title: '结算确认',
    content: `单据 ${booking.bookingNo}：本次收款 ¥${fen2yuan(totalFen)}（${rows.length} 笔${
      hasOnlineRow.value ? '，含在线扫码需顾客扫码支付' : ''
    }）${pointsUsedValue > 0 ? `，使用 ${pointsUsedValue} 积分抵扣` : ''}${
      hasCardRow.value ? '，含次卡核销' : ''
    }。确定提交吗？`,
    confirmText: '确认收款',
    confirmColor: 'primary',
    onConfirm: async () => {
      settling.value = true;
      try {
        lastSubmitted.value = body;
        await submitSettle(body);
      } finally {
        settling.value = false;
      }
    },
  });
}

async function submitSettle(body: SettleBookingBody) {
  const booking = selected.value;
  if (!booking) return;
  const result: SettleBookingResult = await settleBooking(booking.id, body);
  LewMessage.success('收款成功，单据金额已重算');
  await Promise.all([reloadSelected(), loadQueue()]);
  const online = pickOnlinePayment(result);
  if (online) openQrModal(online);
}

/** 从结算结果里挑出「在线支付且还需要顾客扫码」的那笔 */
function pickOnlinePayment(result: SettleBookingResult): PaymentOutcome | null {
  const outcomes = result.payments ?? [];
  return (
    outcomes.find(
      (item) =>
        item.status === 'pending' &&
        ONLINE_CHANNELS.includes(item.channel) &&
        !!item.codeUrl,
    ) ??
    outcomes.find((item) => item.status === 'pending') ??
    null
  );
}

// ---------- 扫码收款：二维码 + 3 秒轮询 + 5 分钟倒计时 ----------
const qrVisible = ref(false);
const qrPayment = ref<PaymentOutcome | null>(null);
const qrStatus = ref<PaymentStatus>('pending');
const qrRemaining = ref(0);
const qrFailures = ref(0);
let pollTimer: number | null = null;
let tickTimer: number | null = null;

const qrExpired = computed(() => qrRemaining.value <= 0);
const qrCountdownText = computed(() => {
  const total = Math.max(0, qrRemaining.value);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
});
/**
 * codeUrl 只有在**确实是图片地址**时才直接当图片渲染。
 * 微信 Native 给的是 `weixin://wxpay/bizpayurl?pr=...`、支付宝给的是
 * `https://qr.alipay.com/...`，两者都不是图片，必须按文本展示（需二维码渲染库才能画成码）。
 */
const qrIsImage = computed(() =>
  /^https?:\/\/.+\.(png|jpe?g|gif|webp|svg)(\?.*)?$/i.test(
    qrPayment.value?.codeUrl ?? '',
  ),
);

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
    ? dayjs(expireAt).valueOf()
    : dayjs().add(5, 'minute').valueOf();
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
      LewMessage.success('支付成功，单据金额已刷新');
      await Promise.all([reloadSelected(), loadQueue()]);
    } else if (data.status === 'closed' || data.status === 'failed') {
      stopPolling();
    }
  } catch {
    // 轮询失败静默重试；连续失败 5 次后停止，避免错误提示刷屏
    qrFailures.value += 1;
    if (qrFailures.value >= 5) stopPolling();
  }
}

function openQrModal(payment: PaymentOutcome) {
  qrPayment.value = payment;
  qrStatus.value = 'pending';
  qrVisible.value = true;
  startCountdown(payment.expireAt);
  startPolling(payment.paymentId);
}

function closeQrModal() {
  stopPolling();
  stopTick();
  qrVisible.value = false;
}

async function handleCopyCode() {
  const codeUrl = qrPayment.value?.codeUrl;
  if (!codeUrl) return;
  try {
    await navigator.clipboard.writeText(codeUrl);
    LewMessage.success('二维码内容已复制，可发给顾客');
  } catch {
    LewMessage.error('复制失败，请手动选择文本复制');
  }
}

/** 过期出口 1：关掉旧单、按同样的请求体重新获取二维码 */
function handleReacquire() {
  const payment = qrPayment.value;
  const body = lastSubmitted.value;
  if (!payment || !body) return;
  confirmDanger({
    type: 'normal',
    title: '重新获取二维码',
    content: `将关闭超时的支付单 ${payment.paymentNo} 并重新下单生成新二维码（同一预约重新收款必须新建支付单）。确定继续吗？`,
    confirmText: '重新获取',
    confirmColor: 'primary',
    onConfirm: async () => {
      await closePayment(payment.paymentId, { reason: '二维码超时，重新获取' });
      closeQrModal();
      await submitSettle(body);
    },
  });
}

/** 过期出口 2：关掉旧单，改成现金收款（由店员重新确认金额） */
function handleSwitchToCash() {
  const payment = qrPayment.value;
  if (!payment) return;
  confirmDanger({
    type: 'normal',
    title: '改现金收款',
    content: `将关闭在线支付单 ${payment.paymentNo}（¥${fen2yuan(payment.amount)}），并把本次收款改为现金。确定继续吗？`,
    confirmText: '改为现金',
    confirmColor: 'primary',
    onConfirm: async () => {
      await closePayment(payment.paymentId, {
        reason: '二维码超时，改现金收款',
      });
      closeQrModal();
      paymentRows.value = [];
      addRow('cash', Number(fen2yuan(payment.amount)));
      LewMessage.success('已改为现金收款，请核对金额后点击「去收款」');
    },
  });
}

onBeforeUnmount(() => {
  stopPolling();
  stopTick();
});

// ---------- 左栏渲染辅助 ----------
function renderPayStatus(status: string) {
  if (status === 'unpaid') return '未收';
  if (status === 'partial') return '待收尾款';
  if (status === 'paid') return '已结清';
  if (status === 'refunded') return '已退款';
  return '挂账';
}
</script>

<template>
  <div class="page-container">
    <!-- 页头 -->
    <div class="flex items-center justify-between">
      <div>
        <h2 class="page-title m-0">收银台</h2>
        <p class="page-subtitle mt-1 mb-0">
          待收款队列 → 单据金额明细 → 混合支付；金额一律以服务端重算为准
        </p>
      </div>
      <LewButton type="light" :loading="queueLoading" @click="loadQueue">
        <RefreshCw :size="14" style="margin-right: 4px" /> 刷新队列
      </LewButton>
    </div>

    <div class="grid grid-cols-[320px_minmax(0,1fr)_380px] gap-4">
      <!-- ============ 左栏：待收款队列 ============ -->
      <div class="app-card flex max-h-[calc(100vh-210px)] flex-col gap-2 p-3">
        <div class="flex items-center gap-2">
          <LewInput
            v-model="queueKeyword"
            placeholder="单号 / 姓名 / 手机号"
            clearable
            @ok="loadQueue"
          />
          <LewButton
            type="light"
            size="small"
            :loading="queueLoading"
            @click="loadQueue"
            >查询</LewButton
          >
        </div>
        <div class="flex-1 overflow-auto">
          <div v-for="group in groups" :key="group.key" class="mb-3">
            <div class="mb-1 flex items-center justify-between">
              <span class="font-600" :class="group.class">{{
                group.title
              }}</span>
              <span class="text-12px text-[var(--app-text-muted)]"
                >{{ group.items.length }} 单</span
              >
            </div>
            <p
              v-if="!group.items.length"
              class="table-empty m-0 py-2 text-12px"
            >
              暂无单据
            </p>
            <div
              v-for="item in group.items"
              :key="item.id"
              class="mb-2 cursor-pointer rounded-8px border border-[var(--app-border)] p-2 transition-colors hover:bg-[var(--app-bg-hover)]"
              :class="
                selectedId === item.id
                  ? 'bg-[var(--lew-color-primary-light)]'
                  : ''
              "
              @click="selectBooking(item)"
            >
              <div class="flex items-center justify-between">
                <span class="font-600">{{ item.bookingNo }}</span>
                <span class="text-12px text-[var(--app-text-muted)]">{{
                  renderPayStatus(item.payStatus)
                }}</span>
              </div>
              <div class="text-13px">{{ item.customerName }}</div>
              <div class="text-12px text-[var(--app-text-secondary)]">
                {{ formatDateTime(item.startAt, 'MM-DD HH:mm') }}
              </div>
              <div class="mt-1 flex items-center justify-between text-12px">
                <span>应付 ¥{{ fen2yuan(item.payableAmount) }}</span>
                <span
                  :class="
                    item.dueAmount > 0
                      ? 'text-[var(--lew-color-warning)]'
                      : 'text-[var(--lew-color-success)]'
                  "
                >
                  尾款 ¥{{ fen2yuan(item.dueAmount) }}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- ============ 中栏：单据金额明细 ============ -->
      <div
        class="app-card flex max-h-[calc(100vh-210px)] flex-col gap-3 overflow-auto p-4"
      >
        <p v-if="!selected" class="table-empty m-0">
          请在左侧选择一张待收款单据
        </p>
        <template v-else>
          <div class="flex items-center justify-between">
            <div>
              <div class="text-16px font-600">{{ selected.bookingNo }}</div>
              <div class="page-subtitle">
                {{ selected.customerName }}
                <span v-if="selected.customerPhone">
                  / {{ selected.customerPhone }}</span
                >
                / 美甲师 {{ selected.staffName ?? '#' + selected.staffId }}
              </div>
              <div class="page-subtitle">
                {{ formatDateTime(selected.startAt) }} ~
                {{ formatDateTime(selected.endAt) }}
              </div>
            </div>
            <span
              class="text-13px text-[var(--lew-color-primary)]"
              v-if="memberInfo"
            >
              会员 {{ memberInfo.level?.name ?? '未入会' }} / 可用余额 ¥{{
                fen2yuan(balanceAvailable)
              }}
              / 积分 {{ memberInfo.points }}
            </span>
            <span v-else class="text-12px text-[var(--app-text-muted)]">{{
              memberLoading ? '加载会员信息…' : '非会员 / 无会员查看权限'
            }}</span>
          </div>

          <!-- 金额明细（全部来自服务端快照，前端只展示） -->
          <div
            class="rounded-10px border border-[var(--app-border)] p-3 text-13.5px"
          >
            <div class="flex justify-between py-1">
              <span>项目原价</span>
              <span>¥{{ fen2yuan(selected.originalPrice) }}</span>
            </div>
            <div class="flex justify-between py-1">
              <span>
                等级优惠（{{
                  selected.levelDiscountPermille >= 1000
                    ? '不打折'
                    : `${(selected.levelDiscountPermille / 100).toFixed(1)} 折`
                }}）
              </span>
              <span class="text-[var(--lew-color-success)]"
                >- ¥{{ fen2yuan(selected.levelDiscountAmount) }}</span
              >
            </div>
            <div class="flex justify-between py-1">
              <span>积分抵扣</span>
              <span class="text-[var(--lew-color-success)]"
                >- ¥{{ fen2yuan(selected.pointsDiscountAmount) }}</span
              >
            </div>
            <div class="flex justify-between py-1">
              <span>
                手动改价<template v-if="selected.adjustReason">
                  （{{ selected.adjustReason }}）</template
                >
              </span>
              <span>¥{{ fen2yuan(selected.adjustAmount) }}</span>
            </div>
            <div
              class="mt-1 flex justify-between border-t border-[var(--app-border)] pt-2 font-600"
            >
              <span>应付金额</span>
              <span>¥{{ fen2yuan(payableFen) }}</span>
            </div>
            <div class="flex justify-between py-1">
              <span>已收金额</span>
              <span>¥{{ fen2yuan(paidFen) }}</span>
            </div>
            <div class="flex justify-between py-1">
              <span>已收渠道</span>
              <span>{{ selected.payChannelSummary ?? '-' }}</span>
            </div>
            <div class="flex justify-between py-1">
              <span>已退款</span>
              <span>¥{{ fen2yuan(selected.refundAmount) }}</span>
            </div>
            <div
              class="mt-1 flex justify-between border-t border-[var(--app-border)] pt-2 font-600 text-[var(--lew-color-warning)]"
            >
              <span>待收尾款</span>
              <span>¥{{ fen2yuan(dueFen) }}</span>
            </div>
          </div>

          <!-- 项目明细 -->
          <div>
            <div class="mb-1 font-600">项目明细</div>
            <table class="table-base">
              <thead>
                <tr>
                  <th class="table-th">项目</th>
                  <th class="table-th">时长(分钟)</th>
                  <th class="table-th">价格(元)</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="item in selected.items ?? []" :key="item.id">
                  <td class="table-td">{{ item.name }}</td>
                  <td class="table-td">{{ item.durationMinutes }}</td>
                  <td class="table-td">¥{{ fen2yuan(item.price) }}</td>
                </tr>
                <tr v-if="!(selected.items ?? []).length">
                  <td class="table-td" colspan="3">无项目明细</td>
                </tr>
              </tbody>
            </table>
          </div>

          <p
            v-if="selected.payStatus === 'credit'"
            class="page-subtitle m-0 rounded-8px border border-[var(--app-border)] p-2"
          >
            该单据为挂账（pay_status=credit）：正式销账在「应收台账」用 POST
            /biz/receivables/:id/settle 处理；此处仍可用混合支付补收（挂账可与
            balance 等渠道叠加）。
          </p>
        </template>
      </div>

      <!-- ============ 右栏：支付区 ============ -->
      <div
        class="app-card flex max-h-[calc(100vh-210px)] flex-col gap-3 overflow-auto p-4"
      >
        <div class="font-600">支付方式（可加多行混合支付）</div>
        <p v-if="!selected" class="page-subtitle m-0">请先选择单据</p>
        <template v-else>
          <div
            v-for="row in paymentRows"
            :key="row.key"
            class="rounded-8px border border-[var(--app-border)] p-2"
          >
            <div class="flex items-center gap-2">
              <LewSelect
                v-model="row.channel"
                width="150px"
                size="small"
                :options="channelOptions"
              />
              <LewInput
                v-model="row.amount"
                width="110px"
                size="small"
                placeholder="金额(元)"
                :disabled="row.channel === 'card'"
              />
              <IconButton
                color="error"
                title="删除该行"
                @click="removeRow(row.key)"
              >
                <Trash2 :size="14" />
              </IconButton>
            </div>

            <!-- 现金：实收（找零） -->
            <div
              v-if="row.channel === 'cash'"
              class="mt-2 flex items-center gap-2"
            >
              <span class="text-12px text-[var(--app-text-muted)]"
                >实收(元)</span
              >
              <LewInput
                v-model="row.receivedAmount"
                width="110px"
                size="small"
                placeholder="实收"
              />
            </div>

            <!-- 次卡核销：必须选卡 -->
            <div v-if="row.channel === 'card'" class="mt-2">
              <LewSelect
                v-model="row.memberCardId"
                width="100%"
                size="small"
                :options="cardOptions"
                placeholder="选择要核销的次卡"
              />
              <p class="page-subtitle m-0 mt-1">
                次卡核销不产生金额、不叠加等级折扣；仅可核销卡种适用项目内的项目。
              </p>
            </div>

            <!-- 储值余额 -->
            <p v-if="row.channel === 'balance'" class="page-subtitle m-0 mt-1">
              可用余额 ¥{{ fen2yuan(balanceAvailable) }}（本金 ¥{{
                fen2yuan(memberInfo?.balancePrincipal)
              }}
              / 赠送 ¥{{
                fen2yuan(memberInfo?.balanceBonus)
              }}）；余额不足会直接失败，不做部分扣减。
            </p>
          </div>

          <LewButton type="light" size="small" @click="addRow('cash', 0)">
            <Plus :size="13" style="margin-right: 4px" /> 添加一行
          </LewButton>

          <!-- 挂账主体（存在 credit 行时） -->
          <div v-if="hasCreditRow">
            <div class="mb-1 text-13px">挂账主体</div>
            <LewSelect
              v-model="creditAccountId"
              width="100%"
              size="small"
              :options="creditAccountOptions"
              placeholder="选择挂账主体（多笔挂账共用）"
            />
          </div>

          <!-- 积分抵扣 -->
          <div>
            <div class="mb-1 flex items-center gap-2">
              <span class="text-13px">积分抵扣</span>
              <LewButton
                type="light"
                size="small"
                :loading="pointsPreviewLoading"
                @click="handlePointsPreview"
                >试算上限</LewButton
              >
            </div>
            <LewInput
              v-model="pointsUsed"
              width="140px"
              size="small"
              placeholder="使用积分数"
            />
            <p v-if="pointsPreview" class="page-subtitle m-0 mt-1">
              最多可用 {{ pointsPreview.maxPoints }} 分（抵 ¥{{
                fen2yuan(pointsPreview.maxDiscountAmount)
              }}），100 分抵 1 元、单笔上限 30%，服务端复算为准。
            </p>
          </div>

          <!-- 备注 -->
          <div>
            <div class="mb-1 text-13px">备注</div>
            <LewInput
              v-model="remark"
              width="100%"
              size="small"
              placeholder="选填"
            />
          </div>

          <!-- 合计与差额 -->
          <div
            class="rounded-8px border border-[var(--app-border)] p-3 text-13px"
          >
            <div class="flex justify-between">
              <span>本单应收（尾款）</span>
              <span>¥{{ fen2yuan(dueFen) }}</span>
            </div>
            <div class="mt-1 flex justify-between">
              <span>本次收款合计</span>
              <span class="font-600">¥{{ fen2yuan(paymentsTotalFen) }}</span>
            </div>
            <div class="mt-1 flex justify-between">
              <span>差额</span>
              <span
                :class="
                  dueFen - paymentsTotalFen === 0
                    ? 'text-[var(--lew-color-success)]'
                    : 'text-[var(--lew-color-warning)]'
                "
              >
                ¥{{ fen2yuan(dueFen - paymentsTotalFen) }}
              </span>
            </div>
            <p v-if="hasOnlineRow" class="page-subtitle m-0 mt-2">
              含在线扫码渠道：提交后会返回二维码，需顾客在 5 分钟内扫码支付。
            </p>
          </div>

          <LewButton
            v-permission="'biz:payment:create'"
            type="fill"
            :loading="detailLoading || settling"
            @click="handleSettle"
          >
            <Wallet :size="14" style="margin-right: 4px" /> 去收款
          </LewButton>
        </template>
      </div>
    </div>

    <!-- ============ 扫码收款弹窗 ============ -->
    <LewModal
      v-model:visible="qrVisible"
      title="扫码收款"
      width="440px"
      :hide-footer="true"
    >
      <div class="flex flex-col items-center gap-3 p-5">
        <div class="text-13px text-[var(--app-text-secondary)]">
          {{
            qrPayment?.channel === 'alipay_qr'
              ? '支付宝扫码'
              : '微信 Native 扫码'
          }}：应收 ¥{{ fen2yuan(qrPayment?.amount) }}
        </div>

        <div
          class="flex h-200px w-200px items-center justify-center overflow-hidden rounded-8px border border-[var(--app-border)]"
        >
          <img
            v-if="qrIsImage"
            :src="qrPayment?.codeUrl ?? ''"
            alt="支付二维码"
            class="h-full w-full object-contain"
          />
          <div
            v-else
            class="max-h-full overflow-auto p-3 text-center text-12px break-all"
          >
            <QrCode :size="28" class="mx-auto mb-2" />
            {{ qrPayment?.codeUrl ?? '渠道未返回二维码内容' }}
          </div>
        </div>

        <div class="text-13px">
          <template v-if="qrStatus === 'success'">
            <span class="text-[var(--lew-color-success)]">
              <CheckCircle2 :size="14" style="display: inline" /> 支付成功
            </span>
          </template>
          <template v-else-if="qrExpired">
            <span class="text-[var(--lew-color-error)]">二维码已过期</span>
          </template>
          <template v-else>
            剩余有效时间
            <span class="font-600">{{ qrCountdownText }}</span>
            （每 3 秒自动查询渠道支付状态）
          </template>
        </div>

        <p class="page-subtitle m-0 text-center">
          当前未接入二维码渲染库（package.json 无 qrcode
          依赖），先把渠道返回的二维码内容原样展示，可复制后发给顾客；轮询、失效倒计时与过期出口均已实现。
        </p>

        <div class="flex flex-wrap items-center justify-center gap-2">
          <LewButton
            v-if="qrPayment?.codeUrl"
            type="light"
            size="small"
            @click="handleCopyCode"
          >
            <ClipboardCopy :size="13" style="margin-right: 4px" />
            复制二维码内容
          </LewButton>
          <template v-if="qrExpired">
            <LewButton
              v-permission="'biz:payment:create'"
              type="fill"
              size="small"
              @click="handleReacquire"
              >重新获取</LewButton
            >
            <LewButton
              v-permission="'biz:payment:close'"
              type="light"
              color="warning"
              size="small"
              @click="handleSwitchToCash"
              >改现金收款</LewButton
            >
          </template>
          <LewButton type="text" size="small" @click="closeQrModal"
            >关闭</LewButton
          >
        </div>
      </div>
    </LewModal>
  </div>
</template>
