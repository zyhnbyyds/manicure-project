<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import dayjs from 'dayjs';
import {
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  CircleDollarSign,
  ClipboardCopy,
  PanelRightClose,
  Plus,
  QrCode,
  RefreshCw,
  Search,
  Trash2,
  Wallet,
} from 'lucide-vue-next';
import {
  LewButton,
  LewInput,
  LewMessage,
  LewModal,
  LewSelect,
  LewTextarea,
} from 'lew-ui';
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
import { ApiError } from '~/request';
import { confirmDanger } from '~/utils/confirm';
import AppLoading from '~/components/AppLoading.vue';
import IconButton from '~/components/IconButton.vue';
import { openImagePreview } from '~/composables/useImagePreview';

// ---------- 金额换算 ----------
function fen2yuan(fen: number | null | undefined): string {
  if (fen === null || fen === undefined) return '0.00';
  return (fen / 100).toFixed(2);
}

function yuan2fen(yuan: number | string | null | undefined): number {
  const value = Number(yuan ?? 0);
  return Number.isFinite(value) ? Math.round(value * 100) : 0;
}

/** 千分比折扣率 → 「8.5 折」（1000‰ = 不打折） */
function formatDiscount(permille: number | null | undefined): string {
  const value = permille ?? 1000;
  return value >= 1000 ? '不打折' : `${(value / 100).toFixed(1)} 折`;
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

// ---------- 左栏：分组页签（全部 / 未收 / 待收尾款 / 挂账） ----------
const QUEUE_TABS = [
  { key: 'all', title: '全部' },
  { key: 'unpaid', title: '未收' },
  { key: 'partial', title: '待收尾款' },
  { key: 'credit', title: '挂账' },
] as const;

type QueueTabKey = (typeof QUEUE_TABS)[number]['key'];

const activeQueueTab = ref<QueueTabKey>('all');

/** 全部队列的尾款合计（分）—— 收起左栏时的摘要 */
const allQueueDueFen = computed(() =>
  groups.value.reduce(
    (total, group) =>
      total + group.items.reduce((sum, item) => sum + item.dueAmount, 0),
    0,
  ),
);

const queueTabs = computed(() =>
  QUEUE_TABS.map((tab) => ({
    key: tab.key,
    title: tab.title,
    count:
      tab.key === 'all'
        ? groups.value.reduce((sum, group) => sum + group.items.length, 0)
        : (groups.value.find((group) => group.key === tab.key)?.items.length ??
          0),
  })),
);

/** 当前页签下要展示的分组（「全部」= 三个分组依次展示） */
const visibleGroups = computed(() =>
  activeQueueTab.value === 'all'
    ? groups.value
    : groups.value.filter((group) => group.key === activeQueueTab.value),
);

const visibleDueFen = computed(() =>
  visibleGroups.value.reduce(
    (total, group) =>
      total + group.items.reduce((sum, item) => sum + item.dueAmount, 0),
    0,
  ),
);

/** 左栏折叠态：收起后只留一行摘要 */
const queueCollapsed = ref(false);
/** 右栏（支付区）折叠态：收起后只留本次收款合计 */
const payCollapsed = ref(false);
/**
 * 队列是否已完成**首次**加载。
 *
 * 首次要出骨架屏（此时列表真的是空的）；之后的刷新/搜索只在按钮上转圈 ——
 * 每点一次「刷新队列」都把列表抽成骨架会闪得很难受。
 */
const queueFirstLoaded = ref(false);

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
    queueFirstLoaded.value = true;
  } finally {
    queueLoading.value = false;
  }
}
void loadQueue();

/** 队列卡片右上角的折扣角标（未打折 / 列表未返回折扣率时不显示） */
function discountTag(item: CashierBooking): string | null {
  const permille = item.levelDiscountPermille;
  if (!permille || permille >= 1000) return null;
  return formatDiscount(permille);
}

/** 支付状态文案 + 配色（枚举以后端为准，前端只做中文映射） */
const PAY_STATUS_META: Record<string, { text: string; style: string }> = {
  unpaid: {
    text: '未收',
    style:
      'color: var(--lew-color-error); background: var(--lew-color-error-light);',
  },
  partial: {
    text: '待收尾款',
    style:
      'color: var(--lew-color-warning); background: var(--lew-color-warning-light);',
  },
  paid: {
    text: '已结清',
    style:
      'color: var(--lew-color-success); background: var(--lew-color-success-light);',
  },
  refunded: {
    text: '已退款',
    style: 'color: var(--app-text-secondary); background: var(--app-bg-hover);',
  },
  credit: {
    text: '挂账',
    style:
      'color: var(--lew-color-primary); background: var(--lew-color-primary-light);',
  },
};

function payStatusText(status: string): string {
  return PAY_STATUS_META[status]?.text ?? status;
}

function payStatusStyle(status: string): string {
  return (
    PAY_STATUS_META[status]?.style ??
    'color: var(--app-text-secondary); background: var(--app-bg-hover);'
  );
}

// ---------- 中栏：选中单据 ----------
const selectedId = ref<number | null>(null);
const selected = ref<CashierBooking | null>(null);
const detailLoading = ref(false);

/**
 * 是否展开右侧两块（单据金额明细 + 支付区）。
 *
 * 未选中单据时**不展开**：待收款队列独占整页宽度（卡片按屏宽铺成多列），
 * 选中一张后队列收成 300px 窄栏、右侧两块从右侧推展开来。
 */
const showDetail = computed(() => !!selected.value);

/** 队列卡片排布：整页宽时多列铺开，收成窄栏时回到单列 */
const queueGridClass = computed(() =>
  showDetail.value ? 'grid-cols-1' : 'sm:grid-cols-2 2xl:grid-cols-3',
);

/**
 * 详情面板的「迟到滑入」内联样式。
 *
 * 外层容器已经把宽度和整体淡入做完了，这里只让面板自己晚一点滑到位，做出层次感。
 * 用内联样式而不是 class：面板同时挂着 `app-card`（自带 `transition-shadow`），
 * 与 class 版 `transition-[...]` 同权重，最终谁生效取决于产物 CSS 的顺序 —— 内联最稳。
 */
function panelSlideStyle(delayMs: number) {
  return {
    transition: `translate 320ms cubic-bezier(0.22, 1, 0.36, 1) ${
      showDetail.value ? delayMs : 0
    }ms`,
    translate: showDetail.value ? '0px' : '14px',
  };
}

const memberInfo = shallowRef<MemberDetail | null>(null);
const memberLoading = ref(false);
/**
 * 会员信息读失败是因为**没权限**（403），而不是「这位顾客不是会员」。
 *
 * 两者都会让 `memberInfo` 为空、可用余额算成 0，但处置方式完全相反：
 * 前者要找店长开 `biz:member:list`，后者跟权限无关。
 * 原先一律静默降级，于是「店员没权限」被伪装成「顾客没充钱」——
 * 余额支付永远失败，报错却是「储值余额不足」，排障方向完全错。
 */
const memberForbidden = ref(false);

const customerCards = shallowRef<MemberCard[]>([]);

/** 可用储值余额（分）= 本金 + 赠送 */
const balanceAvailable = computed(
  () =>
    (memberInfo.value?.balancePrincipal ?? 0) +
    (memberInfo.value?.balanceBonus ?? 0),
);

/** 中栏顾客卡片左侧的圆形头像占位（无头像字段，用姓名首字） */
const customerInitial = computed(
  () => selected.value?.customerName?.trim().slice(0, 1) || '客',
);

/** 会员信息区页签：会员等级 / 可用余额积分 */
const memberTab = ref<'level' | 'account'>('level');

const memberLevelText = computed(
  () =>
    memberInfo.value?.level?.name ?? memberInfo.value?.levelName ?? '未入会',
);

const memberDiscountText = computed(() =>
  formatDiscount(
    memberInfo.value?.level?.discountPermille ??
      memberInfo.value?.levelDiscountPermille,
  ),
);

/** 选中单据的等级折扣文案（快照值，前端只展示不计算） */
const bookingDiscountText = computed(() =>
  formatDiscount(selected.value?.levelDiscountPermille),
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
  memberForbidden.value = false;
  if (!customerId) return;
  memberLoading.value = true;
  try {
    memberInfo.value = await getMember(customerId);
  } catch (error) {
    // 403 = 当前账号没有 `biz:member:list`：**不能**静默降级成「余额 0」，
    // 否则余额支付只会报「储值余额不足」，把权限问题指成顾客没充钱
    if (error instanceof ApiError && error.status === 403) {
      memberForbidden.value = true;
    }
    // 其余（404 非会员等）仍静默降级：不影响现金 / 扫码收款
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

/** 渠道文案（唯一来源；下拉与「本次分配」两处共用，避免两套映射漂移） */
const CHANNEL_LABELS: Record<string, string> = {
  cash: '现金',
  wechat_offline: '微信线下收款码',
  alipay_offline: '支付宝线下收款码',
  wxpay_native: '微信 Native 扫码',
  alipay_qr: '支付宝扫码',
  balance: '储值余额',
  card: '次卡核销',
  credit: '挂账',
};

const channelOptions = Object.entries(CHANNEL_LABELS).map(([value, label]) => ({
  label,
  value,
}));

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
  // 待收尾款的单**默认预填全额**：这很容易被当成「就该收这么多」而误收全额
  // （现金立刻入账，事后要退款走审批）。所以明确说一句，让员工知道自己可以改小。
  if (selected.value?.payStatus === 'partial') {
    LewMessage.info('默认已填入全部待收尾款，如只收一部分请直接改小金额');
  }
}

/**
 * 收起右侧详情：队列重新铺满整页。
 *
 * 与「点队列卡片」不同，这个入口是**显式**的（标题栏的收起按钮），
 * 避免店员连点同一张卡片时把详情误收起。
 */
function clearSelection() {
  selectedId.value = null;
  selected.value = null;
  memberInfo.value = null;
  memberForbidden.value = false;
  customerCards.value = [];
  paymentRows.value = [];
  remark.value = '';
  pointsUsed.value = '';
  pointsPreview.value = null;
  creditAccountId.value = undefined;
}

/** 本次收款合计（分，次卡核销不产生金额） */
const paymentsTotalFen = computed(() =>
  paymentRows.value
    .filter((row) => row.channel !== 'card')
    .reduce((sum, row) => sum + yuan2fen(row.amount), 0),
);

/** 差额（分）= 待收尾款 − 本次收款合计；0 才算收齐 */
const diffFen = computed(() => dueFen.value - paymentsTotalFen.value);

/** 本次各渠道分配（右栏摘要区逐笔展示，让店员核对混合支付构成） */
const paymentAllocations = computed(() =>
  paymentRows.value
    .filter((row) => row.channel === 'card' || yuan2fen(row.amount) > 0)
    .map((row) => ({
      key: row.key,
      label: CHANNEL_LABELS[row.channel] ?? row.channel,
      amount: row.channel === 'card' ? 0 : yuan2fen(row.amount),
      isCard: row.channel === 'card',
    })),
);

const hasCardRow = computed(() =>
  paymentRows.value.some((row) => row.channel === 'card'),
);
/**
 * 次卡行选中的卡片 id —— 结算时必须随请求带上。
 *
 * 服务端靠它把 `biz_booking.member_card_id` 落下来并**重算 `payable`**（次卡 → 0）。
 * 只加一行 `channel='card'` 的支付行而漏传它，结果是「扣了顾客一次卡、价格却没减」，
 * 而且次卡支付单的金额恒为 0，账面也看不出问题。
 */
const cardRowCardId = computed<number | null>(() => {
  const row = paymentRows.value.find((item) => item.channel === 'card');
  return row?.memberCardId ? Number(row.memberCardId) : null;
});
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
      // 分清两种原因：没权限读余额 ≠ 顾客余额不够
      LewMessage.error(
        memberForbidden.value
          ? '当前账号没有查看会员余额的权限（biz:member:list），无法用储值余额收款 —— 请让店长在「角色管理」里为这个角色勾上该权限'
          : `储值余额不足：当前可用 ¥${fen2yuan(balanceAvailable.value)}，余额不足不会部分扣减`,
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
    // 次卡核销必须带上卡片 id：服务端靠它落 member_card_id 并**重算 payable**（次卡 → 0）。
    // 只加一行 channel='card' 的支付行而漏传这个字段，会「扣了顾客一次卡、价格却没减」。
    memberCardId: cardRowCardId.value ?? undefined,
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
      // 通道侧已定局：停轮询 + **明确告知** + 刷新单据
      // （原来只 stopPolling，界面停在「剩余 00:00」，店员不知道这笔到底成没成）
      stopPolling();
      LewMessage.warning(
        data.status === 'closed'
          ? '该支付单已关闭，请重新获取二维码或改现金收款'
          : '该支付单支付失败，请重新获取二维码或改现金收款',
      );
      await Promise.all([reloadSelected(), loadQueue()]);
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

async function closeQrModal() {
  stopPolling();
  stopTick();
  qrVisible.value = false;
  // 关掉弹窗**不等于**这笔没付：顾客可能刚扫完码。关闭前主动查一次通道，
  // 否则这笔只能等后端定时查单（最长 2 分钟），期间店员很可能再收一次钱。
  const paymentId = qrPayment.value?.paymentId;
  if (paymentId && qrStatus.value === 'pending') {
    try {
      await pollStatus(paymentId);
    } catch {
      /* 查不到就算了，队列刷新仍会反映本地状态 */
    }
  }
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
      <div class="flex items-center gap-3">
        <span class="text-12.5px text-[var(--app-text-muted)]">
          队列待收尾款
          <span class="text-15px font-700 text-[var(--lew-color-warning)]"
            >¥{{ fen2yuan(allQueueDueFen) }}</span
          >
        </span>
        <LewButton type="light" :loading="queueLoading" @click="loadQueue">
          <RefreshCw :size="14" style="margin-right: 4px" /> 刷新队列
        </LewButton>
      </div>
    </div>

    <!-- 未选中单据：队列独占整页宽；选中后队列收成 300px，右侧两块推展开 -->
    <div class="flex items-start">
      <!-- ============ 左栏：待收款队列 ============ -->
      <aside
        class="app-card flex max-h-[calc(100vh-210px)] shrink-0 flex-col overflow-hidden p-3 transition-[width] duration-300 ease-out"
        :class="showDetail ? 'w-300px' : 'w-full'"
      >
        <div class="mb-2 flex shrink-0 items-center justify-between">
          <span class="text-14px font-600">待收款队列</span>
          <IconButton
            :title="queueCollapsed ? '展开队列' : '收起队列'"
            @click="queueCollapsed = !queueCollapsed"
          >
            <component
              :is="queueCollapsed ? ChevronDown : ChevronUp"
              :size="14"
            />
          </IconButton>
        </div>

        <!-- 收起态：只留一行摘要 -->
        <div
          v-if="queueCollapsed"
          class="rounded-8px bg-[var(--app-bg-hover)] px-2.5 py-2 text-12px text-[var(--app-text-secondary)]"
        >
          共 {{ queueTabs[0]?.count ?? 0 }} 单 · 尾款
          <span class="font-600 text-[var(--lew-color-warning)]"
            >¥{{ fen2yuan(allQueueDueFen) }}</span
          >
        </div>

        <template v-else>
          <!-- 搜索（整页宽时不跟着拉满，最多 360px） -->
          <div class="flex shrink-0 items-center gap-2">
            <div class="w-full max-w-360px">
              <LewInput
                v-model="queueKeyword"
                width="100%"
                size="small"
                placeholder="单号 / 姓名 / 手机号"
                clearable
                @ok="loadQueue"
              />
            </div>
            <LewButton
              type="fill"
              size="small"
              :loading="queueLoading"
              @click="loadQueue"
            >
              <Search :size="13" style="margin-right: 3px" /> 查询
            </LewButton>
          </div>

          <!-- 分组页签 -->
          <div
            class="mt-2 flex w-full max-w-420px shrink-0 items-center gap-1 rounded-8px bg-[var(--app-bg-hover)] p-1"
          >
            <button
              v-for="tab in queueTabs"
              :key="tab.key"
              type="button"
              class="flex-1 cursor-pointer whitespace-nowrap rounded-6px border-none bg-transparent px-0.5 py-1.5 text-12px transition-colors"
              :class="
                activeQueueTab === tab.key
                  ? 'bg-[var(--app-bg-card)] font-600 text-[var(--lew-color-primary)] shadow-[var(--app-shadow)]'
                  : 'text-[var(--app-text-secondary)] hover:text-[var(--app-text-primary)]'
              "
              @click="activeQueueTab = tab.key"
            >
              {{ tab.title
              }}<span class="ml-0.5 text-10px opacity-60">{{ tab.count }}</span>
            </button>
          </div>

          <!-- 队列列表 -->
          <div class="mt-2 min-h-0 flex-1 overflow-auto pr-1">
            <AppLoading
              variant="skeleton"
              shape="card"
              :rows="4"
              min-height="220px"
              :loading="queueLoading && !queueFirstLoaded"
            >
              <p
                v-if="!visibleGroups.some((group) => group.items.length)"
                class="table-empty m-0 py-6 text-12px"
              >
                暂无单据
              </p>
              <div
                v-for="group in visibleGroups"
                v-show="group.items.length"
                :key="`${activeQueueTab}-${group.key}`"
                class="mb-2.5 grid gap-2"
                :class="queueGridClass"
              >
                <div
                  class="col-span-full flex items-center justify-between px-1"
                >
                  <span class="text-12px font-600" :class="group.class">{{
                    group.title
                  }}</span>
                  <span class="text-11px text-[var(--app-text-muted)]"
                    >{{ group.items.length }} 单</span
                  >
                </div>
                <div
                  v-for="(item, index) in group.items"
                  :key="item.id"
                  class="app-rise-in cursor-pointer rounded-10px border p-2.5 transition-all"
                  :style="{ '--app-stagger': `${Math.min(index, 12) * 26}ms` }"
                  :class="
                    selectedId === item.id
                      ? 'border-[var(--lew-color-primary)] bg-[var(--lew-color-primary-light)]'
                      : 'border-[var(--app-border)] hover:bg-[var(--app-bg-hover)]'
                  "
                  @click="selectBooking(item)"
                >
                  <div class="flex items-start gap-2">
                    <span
                      class="mt-1px flex h-18px w-18px shrink-0 items-center justify-center rounded-full text-11px font-700"
                      :class="
                        selectedId === item.id
                          ? 'bg-[var(--lew-color-primary)] text-white'
                          : 'bg-[var(--app-bg-hover)] text-[var(--app-text-secondary)]'
                      "
                      >{{ index + 1 }}</span
                    >
                    <div class="min-w-0 flex-1">
                      <div class="flex items-center justify-between gap-2">
                        <span class="truncate text-13px font-600">{{
                          item.customerName
                        }}</span>
                        <span
                          class="shrink-0 text-15px font-700"
                          :class="
                            item.dueAmount > 0
                              ? group.class
                              : 'text-[var(--lew-color-success)]'
                          "
                          >¥{{ fen2yuan(item.payableAmount) }}</span
                        >
                      </div>
                      <div class="mt-0.5 flex items-center gap-1.5">
                        <span
                          class="truncate text-12px text-[var(--app-text-secondary)]"
                          >编号 {{ item.bookingNo }}</span
                        >
                        <span
                          v-if="discountTag(item)"
                          class="shrink-0 rounded-4px bg-[var(--lew-color-warning-light)] px-1 text-11px text-[var(--lew-color-warning)]"
                          >{{ discountTag(item) }}</span
                        >
                        <span
                          v-if="item.payStatus === 'credit'"
                          class="shrink-0 rounded-4px bg-[var(--lew-color-primary-light)] px-1 text-11px text-[var(--lew-color-primary)]"
                          >挂账</span
                        >
                      </div>
                      <div
                        class="mt-0.5 flex items-center justify-between text-11.5px text-[var(--app-text-muted)]"
                      >
                        <span
                          >{{ formatDateTime(item.startAt, 'MM-DD HH:mm') }} ~
                          {{ formatDateTime(item.endAt, 'HH:mm') }}</span
                        >
                        <span
                          >尾款 ¥{{ fen2yuan(item.dueAmount) }} ·
                          {{ payStatusText(item.payStatus) }}</span
                        >
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </AppLoading>
          </div>

          <!-- 未选中单据时的引导（队列为空时没必要说「点一张单据」） -->
          <p
            v-if="!showDetail && (queueTabs[0]?.count ?? 0) > 0"
            class="page-subtitle m-0 shrink-0 text-center"
          >
            点一张单据，右侧会展开「金额明细 + 混合支付」
          </p>

          <!-- 页脚：当前页签的尾款合计 -->
          <div
            class="mt-2 flex shrink-0 items-center justify-between border-t border-[var(--app-border)] pt-2.5"
          >
            <span
              class="flex items-center gap-1.5 text-13px text-[var(--app-text-secondary)]"
            >
              <CircleDollarSign
                :size="14"
                class="text-[var(--lew-color-warning)]"
              />
              尾款金额
            </span>
            <span class="text-17px font-700 text-[var(--lew-color-warning)]"
              >¥{{ fen2yuan(visibleDueFen) }}</span
            >
          </div>
        </template>
      </aside>

      <!--
        右侧两块整体推展开：宽度用 calc 精确对齐（300 队列 + 16 间距），可被浏览器插值动画。
        两层动画分工：外层容器负责「宽度 + 淡入」（它是普通 div，transition 不被别的类抢）；
        两块面板自己只负责「迟一点滑到位」，用内联样式写 —— app-card 自带 transition-shadow，
        和 class 版的 transition-[...] 同权重、谁生效看产物 CSS 顺序，不能赌（踩过：淡入直接跳变）。
      -->
      <div
        class="flex min-w-0 items-start overflow-hidden transition-[width,margin,opacity] duration-350 ease-[cubic-bezier(0.22,1,0.36,1)]"
        :class="
          showDetail
            ? 'ml-4 w-[calc(100%_-_316px)] opacity-100'
            : 'pointer-events-none ml-0 w-0 opacity-0'
        "
      >
        <!-- ============ 中栏：订单信息 ============ -->
        <AppLoading
          class="app-card flex max-h-[calc(100vh-210px)] min-w-0 flex-1 flex-col overflow-hidden"
          :style="panelSlideStyle(60)"
          variant="overlay"
          size="small"
          text="加载单据明细…"
          :loading="detailLoading"
        >
          <div class="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-4">
            <p v-if="!selected" class="table-empty m-0">
              请在左侧选择一张待收款单据
            </p>
            <template v-else>
              <!-- 标题 + 会员信息页签 -->
              <div class="flex items-start justify-between gap-3">
                <div class="flex items-center gap-2">
                  <h3 class="m-0 text-18px font-700">订单信息</h3>
                  <span
                    class="rounded-4px px-1.5 py-0.5 text-11.5px font-600"
                    :style="payStatusStyle(selected.payStatus)"
                    >{{ payStatusText(selected.payStatus) }}</span
                  >
                </div>
                <div class="flex shrink-0 items-center gap-2">
                  <div
                    v-if="memberInfo"
                    class="flex items-center gap-1 rounded-8px bg-[var(--app-bg-hover)] p-1"
                  >
                    <button
                      type="button"
                      class="cursor-pointer rounded-6px border-none px-2.5 py-1 text-12.5px transition-colors"
                      :class="
                        memberTab === 'level'
                          ? 'bg-[var(--app-bg-card)] font-600 text-[var(--lew-color-primary)] shadow-[var(--app-shadow)]'
                          : 'bg-transparent text-[var(--app-text-secondary)]'
                      "
                      @click="memberTab = 'level'"
                    >
                      会员等级
                    </button>
                    <button
                      type="button"
                      class="cursor-pointer rounded-6px border-none px-2.5 py-1 text-12.5px transition-colors"
                      :class="
                        memberTab === 'account'
                          ? 'bg-[var(--app-bg-card)] font-600 text-[var(--lew-color-primary)] shadow-[var(--app-shadow)]'
                          : 'bg-transparent text-[var(--app-text-secondary)]'
                      "
                      @click="memberTab = 'account'"
                    >
                      可用余额积分
                    </button>
                  </div>
                  <IconButton
                    title="收起详情（队列重新铺满整页）"
                    @click="clearSelection"
                  >
                    <PanelRightClose :size="15" />
                  </IconButton>
                </div>
              </div>

              <!-- 顾客 + 会员信息 -->
              <div class="rounded-10px border border-[var(--app-border)] p-3">
                <div class="flex items-center gap-3">
                  <div
                    class="flex h-38px w-38px shrink-0 items-center justify-center rounded-full bg-[var(--lew-color-primary-light)] text-15px font-700 text-[var(--lew-color-primary)]"
                  >
                    {{ customerInitial }}
                  </div>
                  <div class="min-w-0 flex-1">
                    <div class="flex flex-wrap items-center gap-x-3 gap-y-0.5">
                      <span class="text-14px font-600">{{
                        selected.customerName
                      }}</span>
                      <span
                        class="text-12.5px text-[var(--app-text-secondary)]"
                        >{{ selected.customerPhone ?? '无手机号' }}</span
                      >
                      <span class="text-12.5px text-[var(--app-text-secondary)]"
                        >美甲师
                        {{ selected.staffName ?? '#' + selected.staffId }}</span
                      >
                      <span class="text-12px text-[var(--app-text-muted)]">
                        {{ formatDateTime(selected.startAt, 'MM-DD HH:mm') }} ~
                        {{ formatDateTime(selected.endAt, 'HH:mm') }}（{{
                          selected.durationMinutes
                        }}
                        分钟）
                      </span>
                      <span class="text-12px text-[var(--app-text-muted)]"
                        >单号 {{ selected.bookingNo }}</span
                      >
                    </div>

                    <!-- 会员资料：与右上页签联动 -->
                    <AppLoading
                      class="mt-1.5 text-12.5px"
                      variant="spinner"
                      size="small"
                      align="start"
                      min-height="20px"
                      text="加载会员信息…"
                      :loading="memberLoading"
                    >
                      <span
                        v-if="memberForbidden"
                        class="text-[var(--lew-color-error)]"
                        title="当前账号缺少 biz:member:list，读不到会员余额"
                      >
                        无查看会员余额的权限（biz:member:list）——
                        请让店长在「角色管理」里为你的角色勾上
                      </span>
                      <span
                        v-else-if="!memberInfo"
                        class="text-[var(--app-text-muted)]"
                        >非会员（散客）</span
                      >
                      <div
                        v-else
                        class="flex flex-wrap items-center gap-x-4 gap-y-1"
                      >
                        <template v-if="memberTab === 'level'">
                          <span class="text-[var(--app-text-muted)]"
                            >会员卡号
                            <span
                              class="font-600 text-[var(--app-text-primary)]"
                              >{{ memberInfo.memberNo ?? '未生成' }}</span
                            ></span
                          >
                          <span class="text-[var(--app-text-muted)]"
                            >等级
                            <span
                              class="font-600 text-[var(--app-text-primary)]"
                              >{{ memberLevelText }}</span
                            ></span
                          >
                          <span class="text-[var(--app-text-muted)]"
                            >折扣
                            <span
                              class="font-600 text-[var(--app-text-primary)]"
                              >{{ memberDiscountText }}</span
                            ></span
                          >
                          <span class="text-[var(--app-text-muted)]"
                            >累计消费
                            <span
                              class="font-600 text-[var(--app-text-primary)]"
                              >¥{{ fen2yuan(memberInfo.totalSpent) }}</span
                            ></span
                          >
                        </template>
                        <template v-else>
                          <span class="text-[var(--app-text-muted)]"
                            >可用余额
                            <span
                              class="font-700 text-[var(--lew-color-primary)]"
                              >¥{{ fen2yuan(balanceAvailable) }}</span
                            >
                            （本金 ¥{{
                              fen2yuan(memberInfo.balancePrincipal)
                            }}
                            / 赠送 ¥{{
                              fen2yuan(memberInfo.balanceBonus)
                            }}）</span
                          >
                          <span class="text-[var(--app-text-muted)]"
                            >积分
                            <span
                              class="font-600 text-[var(--app-text-primary)]"
                              >{{ memberInfo.points }}</span
                            ></span
                          >
                        </template>
                      </div>
                    </AppLoading>
                  </div>
                </div>
              </div>

              <!-- 金额明细（全部来自服务端快照，前端只展示） -->
              <div>
                <div class="mb-2 flex items-center justify-between">
                  <span class="text-13.5px font-600">金额明细</span>
                  <span class="text-11.5px text-[var(--app-text-muted)]"
                    >服务端算价快照，前端不做折扣计算</span
                  >
                </div>
                <div class="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <div class="rounded-8px bg-[var(--app-bg-hover)] p-2.5">
                    <div class="text-12px text-[var(--app-text-muted)]">
                      项目原价
                    </div>
                    <div class="mt-1 text-15px font-600">
                      ¥{{ fen2yuan(selected.originalPrice) }}
                    </div>
                  </div>
                  <div class="rounded-8px bg-[var(--app-bg-hover)] p-2.5">
                    <div class="text-12px text-[var(--app-text-muted)]">
                      等级优惠（{{ bookingDiscountText }}）
                    </div>
                    <div
                      class="mt-1 text-15px font-600 text-[var(--lew-color-success)]"
                    >
                      - ¥{{ fen2yuan(selected.levelDiscountAmount) }}
                    </div>
                  </div>
                  <div class="rounded-8px bg-[var(--app-bg-hover)] p-2.5">
                    <div class="text-12px text-[var(--app-text-muted)]">
                      积分抵扣
                    </div>
                    <div
                      class="mt-1 text-15px font-600 text-[var(--lew-color-success)]"
                    >
                      - ¥{{ fen2yuan(selected.pointsDiscountAmount) }}
                    </div>
                  </div>
                  <div class="rounded-8px bg-[var(--app-bg-hover)] p-2.5">
                    <div
                      class="truncate text-12px text-[var(--app-text-muted)]"
                      :title="selected.adjustReason ?? '手动改价（可正可负）'"
                    >
                      手动改价{{
                        selected.adjustReason
                          ? `（${selected.adjustReason}）`
                          : ''
                      }}
                    </div>
                    <div class="mt-1 text-15px font-600">
                      ¥{{ fen2yuan(selected.adjustAmount) }}
                    </div>
                  </div>
                </div>

                <div
                  class="mt-2 grid grid-cols-2 gap-2 rounded-10px border border-[var(--app-border)] p-3 sm:grid-cols-4"
                >
                  <div>
                    <div class="text-12px text-[var(--app-text-muted)]">
                      应付金额
                    </div>
                    <div class="mt-1 text-16px font-700">
                      ¥{{ fen2yuan(payableFen) }}
                    </div>
                  </div>
                  <div>
                    <div class="text-12px text-[var(--app-text-muted)]">
                      已收金额
                    </div>
                    <div class="mt-1 text-16px font-700">
                      ¥{{ fen2yuan(paidFen) }}
                    </div>
                    <div
                      class="mt-0.5 truncate text-11.5px text-[var(--app-text-muted)]"
                    >
                      {{ selected.payChannelSummary ?? '暂无收款渠道' }}
                    </div>
                  </div>
                  <div>
                    <div class="text-12px text-[var(--app-text-muted)]">
                      已退款
                    </div>
                    <div class="mt-1 text-16px font-700">
                      ¥{{ fen2yuan(selected.refundAmount) }}
                    </div>
                  </div>
                  <div
                    class="rounded-8px bg-[var(--lew-color-warning-light)] px-2 py-1"
                  >
                    <div class="text-12px text-[var(--lew-color-warning)]">
                      待收尾款
                    </div>
                    <div
                      class="mt-1 text-16px font-700 text-[var(--lew-color-warning)]"
                    >
                      ¥{{ fen2yuan(dueFen) }}
                    </div>
                  </div>
                </div>
              </div>

              <!-- 待收尾款：项目明细 -->
              <div>
                <div class="mb-2 flex items-center justify-between">
                  <span class="flex items-center gap-2">
                    <span
                      class="h-14px w-3px rounded-full bg-[var(--lew-color-warning)]"
                    ></span>
                    <span
                      class="text-14px font-600 text-[var(--lew-color-warning)]"
                      >待收尾款</span
                    >
                  </span>
                  <span
                    class="text-15px font-700 text-[var(--lew-color-warning)]"
                    >¥{{ fen2yuan(dueFen) }}</span
                  >
                </div>
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
                /biz/receivables/:id/settle
                处理；此处仍可用混合支付补收（挂账可与 balance 等渠道叠加）。
              </p>
            </template>
          </div>
        </AppLoading>

        <!-- ============ 右栏：支付方式（混合支付） ============ -->
        <aside
          class="app-card ml-4 flex max-h-[calc(100vh-210px)] w-360px shrink-0 flex-col gap-3 p-4"
          :style="panelSlideStyle(110)"
        >
          <div class="flex items-center justify-between">
            <span class="text-14px font-600">
              支付方式
              <span class="text-11.5px font-400 text-[var(--app-text-muted)]"
                >（可加多行混合支付）</span
              >
            </span>
            <IconButton
              :title="payCollapsed ? '展开支付区' : '收起支付区'"
              @click="payCollapsed = !payCollapsed"
            >
              <component
                :is="payCollapsed ? ChevronDown : ChevronUp"
                :size="14"
              />
            </IconButton>
          </div>

          <p v-if="!selected" class="table-empty m-0 py-4 text-12px">
            请先选择单据
          </p>

          <template v-else-if="payCollapsed">
            <div
              class="rounded-8px bg-[var(--app-bg-hover)] px-2.5 py-2 text-12px text-[var(--app-text-secondary)]"
            >
              本次收款合计
              <span class="font-600 text-[var(--lew-color-primary)]"
                >¥{{ fen2yuan(paymentsTotalFen) }}</span
              >
              · {{ paymentAllocations.length }} 笔
            </div>
            <LewButton
              v-permission="'biz:payment:create'"
              class="shrink-0"
              type="fill"
              width="100%"
              size="large"
              :loading="detailLoading || settling"
              @click="handleSettle"
            >
              <Wallet :size="15" style="margin-right: 4px" /> 去收款
            </LewButton>
          </template>

          <template v-else>
            <!-- 可滚动的配置区：支付行多时只滚这一段，合计与「去收款」常驻底部 -->
            <div class="flex min-h-0 flex-1 flex-col gap-3 overflow-auto pr-1">
              <div
                v-for="row in paymentRows"
                :key="row.key"
                class="rounded-8px border border-[var(--app-border)] p-2.5"
              >
                <div class="flex items-center gap-2">
                  <LewSelect
                    v-model="row.channel"
                    width="100%"
                    size="small"
                    :options="channelOptions"
                  />
                  <IconButton
                    color="error"
                    title="删除该行"
                    @click="removeRow(row.key)"
                  >
                    <Trash2 :size="14" />
                  </IconButton>
                </div>

                <div class="mt-2">
                  <LewInput
                    v-model="row.amount"
                    width="100%"
                    size="small"
                    placeholder="金额（元）"
                    :disabled="row.channel === 'card'"
                  />
                </div>

                <!-- 现金：实收（找零） -->
                <div
                  v-if="row.channel === 'cash'"
                  class="mt-2 flex items-center gap-2"
                >
                  <span class="shrink-0 text-12px text-[var(--app-text-muted)]"
                    >实收(元)</span
                  >
                  <LewInput
                    v-model="row.receivedAmount"
                    width="100%"
                    size="small"
                    placeholder="顾客实际递交的现金"
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
                <p
                  v-if="row.channel === 'balance'"
                  class="page-subtitle m-0 mt-1"
                >
                  <template v-if="memberForbidden">
                    当前账号没有查看会员余额的权限（biz:member:list），储值余额收款不可用。
                    这不是顾客余额不足 —— 请让店长在「角色管理」里为你的角色勾上
                    「会员管理」的查询权限。
                  </template>
                  <template v-else>
                    可用余额 ¥{{ fen2yuan(balanceAvailable) }}（本金 ¥{{
                      fen2yuan(memberInfo?.balancePrincipal)
                    }}
                    / 赠送 ¥{{
                      fen2yuan(memberInfo?.balanceBonus)
                    }}）；余额不足会直接失败，不做部分扣减。
                  </template>
                </p>
              </div>

              <div class="flex items-center justify-between">
                <span class="text-11.5px text-[var(--app-text-muted)]"
                  >共 {{ paymentAllocations.length }} 笔</span
                >
                <LewButton type="text" size="small" @click="addRow('cash', 0)">
                  <Plus :size="13" style="margin-right: 3px" /> 添加一行
                </LewButton>
              </div>

              <!-- 挂账主体（存在 credit 行时） -->
              <div
                v-if="hasCreditRow"
                class="border-t border-[var(--app-border)] pt-3"
              >
                <div class="mb-1.5 text-13px font-600">挂账主体</div>
                <LewSelect
                  v-model="creditAccountId"
                  width="100%"
                  size="small"
                  :options="creditAccountOptions"
                  placeholder="选择挂账主体（多笔挂账共用）"
                />
              </div>

              <!-- 积分抵扣 -->
              <div class="border-t border-[var(--app-border)] pt-3">
                <div class="mb-1.5 flex items-center justify-between">
                  <span class="text-13px font-600">积分抵扣</span>
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
                  width="100%"
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
              <div class="border-t border-[var(--app-border)] pt-3">
                <div class="mb-1.5 text-13px font-600">备注</div>
                <LewTextarea
                  v-model="remark"
                  :rows="2"
                  :max-length="200"
                  placeholder="选填；挂账 / 部分收款建议写明原因"
                />
              </div>
            </div>

            <!-- 合计与差额 -->
            <div
              class="shrink-0 rounded-10px border border-[var(--app-border)] p-3"
            >
              <div class="grid grid-cols-3 gap-2 text-center">
                <div>
                  <div class="text-12px text-[var(--app-text-muted)]">
                    本单应收
                  </div>
                  <div class="mt-1 text-15px font-700">
                    ¥{{ fen2yuan(dueFen) }}
                  </div>
                </div>
                <div class="border-x border-[var(--app-border)]">
                  <div class="text-12px text-[var(--app-text-muted)]">
                    本次收款合计
                  </div>
                  <div
                    class="mt-1 text-15px font-700 text-[var(--lew-color-primary)]"
                  >
                    ¥{{ fen2yuan(paymentsTotalFen) }}
                  </div>
                </div>
                <div>
                  <div class="text-12px text-[var(--app-text-muted)]">差额</div>
                  <div
                    class="mt-1 text-15px font-700"
                    :class="
                      diffFen === 0
                        ? 'text-[var(--lew-color-success)]'
                        : 'text-[var(--lew-color-warning)]'
                    "
                  >
                    ¥{{ fen2yuan(diffFen) }}
                  </div>
                </div>
              </div>

              <div
                v-if="paymentAllocations.length"
                class="mt-2.5 flex flex-col gap-1 border-t border-dashed border-[var(--app-border)] pt-2"
              >
                <div
                  v-for="allocation in paymentAllocations"
                  :key="allocation.key"
                  class="flex items-center justify-between text-12.5px"
                >
                  <span class="text-[var(--app-text-secondary)]">{{
                    allocation.label
                  }}</span>
                  <span class="font-600">{{
                    allocation.isCard
                      ? '核销一次（不计金额）'
                      : `¥${fen2yuan(allocation.amount)}`
                  }}</span>
                </div>
              </div>

              <p v-if="hasOnlineRow" class="page-subtitle m-0 mt-2">
                含在线扫码渠道：提交后会返回二维码，需顾客在 5 分钟内扫码支付。
              </p>
            </div>

            <LewButton
              v-permission="'biz:payment:create'"
              class="shrink-0"
              type="fill"
              width="100%"
              size="large"
              :loading="detailLoading || settling"
              @click="handleSettle"
            >
              <Wallet :size="15" style="margin-right: 4px" /> 去收款
            </LewButton>
          </template>
        </aside>
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
            title="点击放大（方便顾客远距离扫码）"
            class="h-full w-full cursor-zoom-in object-contain"
            @click="
              openImagePreview(
                [qrPayment?.codeUrl ?? ''],
                0,
                qrPayment?.channel === 'alipay_qr'
                  ? '支付宝收款码'
                  : '微信收款码',
              )
            "
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
