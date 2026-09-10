<script setup lang="ts">
import { computed, h, ref, watch } from 'vue';
import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  Eye,
  Plus,
  RotateCcw,
  Trash2,
  UserCheck,
  UserX,
  Wallet,
  XCircle,
} from 'lucide-vue-next';
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
} from 'lew-ui';
import type { LewModalFooterButtonItem, LewTableColumn } from 'lew-ui';
import {
  applyBookingRefund,
  arriveBooking,
  availableSlots,
  cancelBooking,
  completeBooking,
  createBooking,
  deleteBooking,
  getBooking,
  getBookingCustomerBrief,
  noShowBooking,
  previewBookingRefund,
  settleBooking,
  updateBooking,
} from '~/api/biz/bookings';
import type {
  AvailableSlot,
  Booking,
  BookingConflictItem,
  BookingCustomerBrief,
  BookingDetail,
  BookingPayStatus,
  BookingStatus,
  CreateBookingBody,
  PayChannel,
  PaymentInput,
  RefundLiable,
  RefundMode,
  RefundPreview,
  SettleBookingBody,
  SlotReason,
} from '~/api/biz/bookings';
import { listCustomers } from '~/api/biz/customers';
import { listCreditAccountOptions } from '~/api/biz/credit-accounts';
import { listMemberCards } from '~/api/biz/member-cards';
import { listActiveServiceItems } from '~/api/biz/service-items';
import type { ServiceItem } from '~/api/biz/service-items';
import { listActiveStaffs } from '~/api/biz/staffs';
import { useTable } from '~/composables/useTable';
import { formatDateTime } from '~/composables/useFormat';
import { useUserStore } from '~/store/user';
import { confirmDanger } from '~/utils/confirm';
import IconButton from '~/components/IconButton.vue';

const userStore = useUserStore();

/* ------------------------------------------------------------------ *
 * 展示工具：金额「分 → 元」，时间统一东八区
 * ------------------------------------------------------------------ */

function money(cents: number | null | undefined): string {
  return `¥ ${((cents ?? 0) / 100).toFixed(2)}`;
}

function centsToYuan(cents: number | null | undefined): number {
  return Number(((cents ?? 0) / 100).toFixed(2));
}

function yuanToCents(yuan: number | null | undefined): number {
  return Math.round((yuan ?? 0) * 100);
}

/**
 * 时段展示只取 `HH:mm`。
 *
 * `available-slots` 返回的是带 `+08:00` 偏移的 ISO8601，而列表行的 `startAt/endAt`
 * 是 UTC 序列化（带 `Z`）——所以**不能**简单截取字符串第 11~16 位（会漏掉时区换算）。
 * 统一交给 `formatDateTime`（固定东八区），两种形态都能得到正确的墙上时间。
 */
function shortClock(value: string | null | undefined): string {
  if (!value) return '--:--';
  return formatDateTime(value, 'HH:mm');
}

function shopDate(value: string | null | undefined): string {
  if (!value) return '-';
  return formatDateTime(value, 'YYYY-MM-DD');
}

const statusText: Record<BookingStatus, string> = {
  pending: '待确认',
  confirmed: '已确认',
  arrived: '已到店',
  completed: '已完成',
  cancelled: '已取消',
  no_show: '爽约',
};

const statusColor: Record<BookingStatus, string> = {
  pending: 'var(--lew-color-warning)',
  confirmed: 'var(--lew-color-primary)',
  arrived: 'var(--lew-color-primary)',
  completed: 'var(--lew-color-success)',
  cancelled: 'var(--app-text-muted)',
  no_show: 'var(--lew-color-error)',
};

const payStatusText: Record<BookingPayStatus, string> = {
  unpaid: '未收款',
  partial: '部分收款',
  paid: '已结清',
  refunded: '已退款',
  credit: '挂账',
};

const payStatusColor: Record<BookingPayStatus, string> = {
  unpaid: 'var(--lew-color-error)',
  partial: 'var(--lew-color-warning)',
  paid: 'var(--lew-color-success)',
  refunded: 'var(--app-text-muted)',
  credit: 'var(--lew-color-warning)',
};

const channelText: Record<PayChannel, string> = {
  cash: '现金',
  wechat_offline: '微信（线下）',
  alipay_offline: '支付宝（线下）',
  wxpay_native: '微信扫码',
  alipay_qr: '支付宝扫码',
  balance: '储值余额',
  card: '次卡核销',
  credit: '挂账',
};

/** 可约时段为空时的差异化提示（§5.1：不能笼统说「无可约时段」） */
const slotReasonText: Record<SlotReason, string> = {
  off: '该美甲师当天请假（整天休息），请换日期或换美甲师',
  no_shift: '该美甲师当天没有排班，请换日期或先在「排班管理」里配置班次',
  staff_cannot_do:
    '该美甲师不能做所选项目（可做项目白名单未覆盖），请换美甲师或调整项目',
  fully_booked: '当天已约满：没有能容纳所选总时长的空档',
  out_of_window: '所选日期超出了允许提前预约的窗口',
};

const channelOptions = [
  { label: '现金', value: 'cash' },
  { label: '微信（线下收款）', value: 'wechat_offline' },
  { label: '支付宝（线下收款）', value: 'alipay_offline' },
  { label: '微信 Native 扫码', value: 'wxpay_native' },
  { label: '支付宝当面付', value: 'alipay_qr' },
  { label: '储值余额', value: 'balance' },
  { label: '次卡核销', value: 'card' },
  { label: '挂账（需选挂账主体）', value: 'credit' },
];

const statusOptions = (Object.keys(statusText) as BookingStatus[]).map(
  (value) => ({ label: statusText[value], value }),
);

const payStatusOptions = (Object.keys(payStatusText) as BookingPayStatus[]).map(
  (value) => ({ label: payStatusText[value], value }),
);

/* ------------------------------------------------------------------ *
 * 列表与筛选
 * ------------------------------------------------------------------ */

const today = formatDateTime(new Date(), 'YYYY-MM-DD');

const dateMode = ref<'single' | 'range'>('single');
const query = ref<{
  date?: string;
  dateFrom?: string;
  dateTo?: string;
  staffId?: string;
  status?: BookingStatus;
  payStatus?: BookingPayStatus;
  keyword?: string;
}>({ date: today });

const {
  items,
  loading,
  currentPage,
  pageSize,
  total,
  search,
  refresh,
  handleChange,
} = useTable<Booking>({
  url: '/biz/bookings',
  query: () => {
    const value = query.value;
    const params: Record<string, unknown> = {};
    if (dateMode.value === 'single') {
      if (value.date) params.date = value.date;
    } else {
      if (value.dateFrom) params.dateFrom = value.dateFrom;
      if (value.dateTo) params.dateTo = value.dateTo;
    }
    if (value.staffId) params.staffId = Number(value.staffId);
    if (value.status) params.status = value.status;
    if (value.payStatus) params.payStatus = value.payStatus;
    if (value.keyword) params.keyword = value.keyword;
    return params;
  },
});

const staffOptions = ref<{ label: string; value: string }[]>([]);

async function loadStaffOptions() {
  const data = await listActiveStaffs(200);
  staffOptions.value = data.items.map((staff) => ({
    label: staff.nickname,
    value: String(staff.id),
  }));
}
void loadStaffOptions();

const columns: LewTableColumn[] = [
  { title: '单号', field: 'bookingNo', width: 165 },
  {
    title: '顾客',
    field: 'customerName',
    width: 150,
    customRender: ({ row }) => {
      const booking = row as unknown as Booking;
      return h('div', { class: 'leading-5' }, [
        h('div', {}, booking.customerName),
        h(
          'div',
          { class: 'text-12px text-[var(--app-text-muted)]' },
          booking.customerPhone ?? '-',
        ),
      ]);
    },
  },
  {
    title: '美甲师',
    field: 'staffName',
    width: 100,
    customRender: ({ row }) => (row as unknown as Booking).staffName ?? '-',
  },
  {
    title: '时间',
    field: 'startAt',
    width: 165,
    customRender: ({ row }) => {
      const booking = row as unknown as Booking;
      return h(
        'span',
        { class: 'tabular-nums' },
        `${formatDateTime(booking.startAt, 'MM-DD HH:mm')} - ${shortClock(
          booking.endAt,
        )}`,
      );
    },
  },
  {
    title: '时长',
    field: 'durationMinutes',
    width: 80,
    customRender: ({ row }) => {
      const booking = row as unknown as Booking;
      return `${booking.durationMinutes}+${booking.bufferMinutes} 分`;
    },
  },
  {
    title: '应付',
    field: 'payableAmount',
    width: 105,
    customRender: ({ row }) =>
      h(
        'span',
        { class: 'tabular-nums' },
        money((row as unknown as Booking).payableAmount),
      ),
  },
  {
    title: '已收 / 尾款',
    field: 'paidAmount',
    width: 135,
    customRender: ({ row }) => {
      const booking = row as unknown as Booking;
      return h('span', { class: 'tabular-nums' }, [
        h('span', {}, money(booking.paidAmount)),
        h('span', { class: 'text-[var(--app-text-muted)]' }, ' / '),
        h(
          'span',
          {
            class: booking.dueAmount > 0 ? 'text-[var(--lew-color-error)]' : '',
          },
          money(booking.dueAmount),
        ),
      ]);
    },
  },
  {
    title: '资金状态',
    field: 'payStatus',
    width: 100,
    customRender: ({ row }) => {
      const value = (row as unknown as Booking).payStatus;
      return h(
        'span',
        { style: `color:${payStatusColor[value] ?? 'inherit'}` },
        payStatusText[value] ?? value,
      );
    },
  },
  {
    title: '渠道',
    field: 'payChannelSummary',
    width: 110,
    customRender: ({ row }) =>
      (row as unknown as Booking).payChannelSummary ?? '-',
  },
  {
    title: '服务状态',
    field: 'status',
    width: 95,
    customRender: ({ row }) => {
      const value = (row as unknown as Booking).status;
      return h(
        'span',
        { style: `color:${statusColor[value] ?? 'inherit'}` },
        statusText[value] ?? value,
      );
    },
  },
  {
    title: '备注',
    field: 'remark',
    customRender: ({ row }) => {
      const booking = row as unknown as Booking;
      const parts: string[] = [];
      if (booking.remark) parts.push(booking.remark);
      if (booking.adjustAmount !== 0)
        parts.push(
          `改价 ${booking.adjustAmount > 0 ? '+' : ''}${centsToYuan(booking.adjustAmount)} 元`,
        );
      if (booking.cancelReason) parts.push(`原因：${booking.cancelReason}`);
      if (!parts.length) return '-';
      const text = parts.join('；');
      return h(
        'span',
        { class: 'block w-full truncate align-middle', title: text },
        text,
      );
    },
  },
  { title: '操作', field: 'operation', width: 300, fixed: 'right' },
];

void search();

function handleReset() {
  query.value = { date: today };
  dateMode.value = 'single';
  void search();
}

/* ------------------------------------------------------------------ *
 * 行内操作：到店 / 完成 / 爽约 / 取消
 * ------------------------------------------------------------------ */

const can = {
  arrive: userStore.hasPermission('biz:booking:arrive'),
  complete: userStore.hasPermission('biz:booking:complete'),
  noshow: userStore.hasPermission('biz:booking:noshow'),
  cancel: userStore.hasPermission('biz:booking:cancel'),
  update: userStore.hasPermission('biz:booking:update'),
  settle: userStore.hasPermission('biz:payment:create'),
  refund: userStore.hasPermission('biz:refund:apply'),
  remove: userStore.hasPermission('biz:booking:delete'),
  adjust: userStore.hasPermission('biz:booking:adjust'),
  credit: userStore.hasPermission('biz:credit:list'),
  card: userStore.hasPermission('biz:card:list'),
};

function canArrive(row: Booking) {
  return row.status === 'confirmed';
}

function canComplete(row: Booking) {
  return row.status === 'arrived';
}

function canNoShow(row: Booking) {
  return row.status === 'confirmed';
}

function canCancel(row: Booking) {
  return row.status === 'pending' || row.status === 'confirmed';
}

function canReschedule(row: Booking) {
  return row.status === 'pending' || row.status === 'confirmed';
}

function canSettle(row: Booking) {
  return row.status !== 'cancelled' && row.status !== 'no_show';
}

function canRefund(row: Booking) {
  return row.paidAmount > 0 && row.status !== 'cancelled';
}

async function handleArrive(row: Booking) {
  await arriveBooking(row.id);
  LewMessage.success('已标记到店');
  void refresh();
}

async function handleComplete(row: Booking) {
  await completeBooking(row.id);
  LewMessage.success('已完成，并累加到店统计与提成');
  void refresh();
}

// 爽约 / 取消共用一个「必填原因」弹窗
const reasonVisible = ref(false);
const reasonAction = ref<'no-show' | 'cancel'>('no-show');
const reasonTarget = ref<Booking | null>(null);
const reasonText = ref('');
const reasonSaving = ref(false);

const reasonTitle = computed(() =>
  reasonAction.value === 'no-show' ? '标记爽约' : '取消预约',
);

const reasonHint = computed(() => {
  const booking = reasonTarget.value;
  if (!booking) return '';
  if (reasonAction.value === 'cancel') {
    return booking.paidAmount > 0
      ? `该单已有实收 ${money(booking.paidAmount)}，取消后请到「退款审批」发起退款，退款不会自动发生。`
      : '取消后时段会立即释放，可被重新预约。';
  }
  return '爽约会记录到顾客档案；若已收定金，需另行发起退款。';
});

function openReason(row: Booking, action: 'no-show' | 'cancel') {
  reasonAction.value = action;
  reasonTarget.value = row;
  reasonText.value = '';
  reasonVisible.value = true;
}

async function submitReason() {
  const booking = reasonTarget.value;
  if (!booking) return;
  if (!reasonText.value.trim()) {
    LewMessage.error('请填写原因');
    return;
  }
  reasonSaving.value = true;
  try {
    if (reasonAction.value === 'no-show') {
      await noShowBooking(booking.id, reasonText.value.trim());
      LewMessage.success('已标记爽约');
    } else {
      await cancelBooking(booking.id, reasonText.value.trim());
      LewMessage.success('已取消');
    }
    reasonVisible.value = false;
    void refresh();
  } finally {
    reasonSaving.value = false;
  }
}

/* ------------------------------------------------------------------ *
 * 详情
 * ------------------------------------------------------------------ */

const detailVisible = ref(false);
const detail = ref<BookingDetail | null>(null);
const detailLoading = ref(false);

async function openDetail(row: Booking) {
  detailVisible.value = true;
  detailLoading.value = true;
  detail.value = null;
  try {
    detail.value = await getBooking(row.id);
  } finally {
    detailLoading.value = false;
  }
}

/* ------------------------------------------------------------------ *
 * 创建预约（§10.4）
 * ------------------------------------------------------------------ */

type PaymentRow = {
  key: number;
  channel: string;
  amountYuan?: number;
  receivedYuan?: number;
  memberCardId?: string;
};

let paymentKeySeed = 0;

function newPaymentRow(channel = 'cash'): PaymentRow {
  paymentKeySeed += 1;
  return { key: paymentKeySeed, channel };
}

const createVisible = ref(false);
const createSaving = ref(false);
const createForm = ref({
  customerId: '',
  serviceItemIds: [] as string[],
  staffId: '',
  date: today,
  /** 选中的时段（带 +08:00 偏移的 ISO8601） */
  startAt: '',
  payMode: 'full' as 'full' | 'deposit',
  depositYuan: undefined as number | undefined,
  pointsUsed: undefined as number | undefined,
  adjustYuan: undefined as number | undefined,
  adjustReason: '',
  creditAccountId: '',
  remark: '',
});

const createPaymentRows = ref<PaymentRow[]>([newPaymentRow()]);

// 顾客搜索（§9.5：首期不在弹窗里新建顾客）
const customerKeyword = ref('');
const customerOptions = ref<{ label: string; value: string }[]>([]);
const customerSearching = ref(false);
const customerBrief = ref<BookingCustomerBrief | null>(null);

async function searchCustomerOptions() {
  customerSearching.value = true;
  try {
    const keyword = customerKeyword.value.trim();
    const data = await listCustomers(1, 30, keyword ? { keyword } : {});
    customerOptions.value = data.items.map((customer) => ({
      label: customer.phone
        ? `${customer.name} / ${customer.phone}`
        : customer.name,
      value: String(customer.id),
    }));
  } finally {
    customerSearching.value = false;
  }
}

/** 次卡核销需要选卡（按顾客过滤，只列启用中的卡） */
async function loadMemberCards(customerId: number) {
  if (!can.card || !customerId) {
    memberCardOptions.value = [];
    return;
  }
  const data = await listMemberCards(1, 50, {
    customerId,
    status: 'active',
  });
  memberCardOptions.value = data.items.map((card) => ({
    label: `${card.cardName}（${card.cardNo} · 剩 ${
      card.remainTimes ?? card.totalTimes - card.usedTimes
    } 次）`,
    value: String(card.id),
  }));
}

/** 挂账主体（结算 / 下单挂账都要选） */
async function loadCreditAccounts() {
  if (!can.credit || creditAccountOptions.value.length) return;
  const data = await listCreditAccountOptions();
  creditAccountOptions.value = data.items.map((account) => ({
    label: `${account.name}（${
      account.type === 'company'
        ? '公司'
        : account.type === 'staff'
          ? '员工'
          : '顾客'
    }${account.creditLimit ? ` · 额度 ${money(account.creditLimit)}` : ''}）`,
    value: String(account.id),
  }));
}

watch(
  () => createForm.value.customerId,
  async (value) => {
    customerBrief.value = null;
    memberCardOptions.value = [];
    if (!value) return;
    customerBrief.value = await getBookingCustomerBrief(Number(value));
    await loadMemberCards(Number(value));
  },
);

// 服务项目（多选，实时累加时长与价格）
const allServiceItems = ref<ServiceItem[]>([]);
const serviceItemOptions = computed(() =>
  allServiceItems.value.map((item) => ({
    label: `${item.name}（${item.durationMinutes} 分钟 · ${money(item.price)}）`,
    value: String(item.id),
  })),
);

async function loadServiceItems() {
  const data = await listActiveServiceItems(200);
  allServiceItems.value = data.items;
}

const selectedItems = computed(() =>
  allServiceItems.value.filter((item) =>
    createForm.value.serviceItemIds.includes(String(item.id)),
  ),
);

const totalDuration = computed(() =>
  selectedItems.value.reduce((sum, item) => sum + item.durationMinutes, 0),
);

const totalBuffer = computed(() =>
  selectedItems.value.reduce(
    (max, item) => Math.max(max, item.bufferMinutes),
    0,
  ),
);

/** 默认配置下的算价预估（服务端为准，§5.7：等级折扣 → 积分抵扣 → 改价） */
const POINTS_PER_YUAN = 100;
const MAX_POINTS_PERMILLE = 300;
const DEFAULT_DEPOSIT_PERMILLE = 300;

const quote = computed(() => {
  const originalPrice = selectedItems.value.reduce(
    (sum, item) => sum + item.price,
    0,
  );
  const permille = customerBrief.value?.discountPermille ?? 1000;
  const levelDiscountAmount = Math.floor(
    (originalPrice * (1000 - permille)) / 1000,
  );
  const base4Points = Math.max(originalPrice - levelDiscountAmount, 0);
  const maxPointsDiscountAmount = Math.floor(
    (base4Points * MAX_POINTS_PERMILLE) / 1000,
  );
  const maxPoints =
    Math.max(Math.ceil(maxPointsDiscountAmount / 100), 0) * POINTS_PER_YUAN;
  const requested = Math.max(Math.trunc(createForm.value.pointsUsed ?? 0), 0);
  const pointsUsed = Math.min(
    requested - (requested % POINTS_PER_YUAN),
    maxPoints,
  );
  const pointsDiscountAmount = Math.floor(pointsUsed / POINTS_PER_YUAN) * 100;
  const adjustAmount = yuanToCents(createForm.value.adjustYuan);
  const payableAmount = Math.max(
    originalPrice - levelDiscountAmount - pointsDiscountAmount + adjustAmount,
    0,
  );
  const depositAmount =
    createForm.value.payMode === 'deposit'
      ? Math.min(
          createForm.value.depositYuan === undefined
            ? Math.floor((payableAmount * DEFAULT_DEPOSIT_PERMILLE) / 1000)
            : yuanToCents(createForm.value.depositYuan),
          payableAmount,
        )
      : payableAmount;
  return {
    originalPrice,
    permille,
    levelDiscountAmount,
    pointsUsed,
    pointsDiscountAmount,
    maxPoints,
    adjustAmount,
    payableAmount,
    depositAmount,
  };
});

/** 本次下单应收（全款 = 应付；定金 = 定金值） */
const payTarget = computed(() =>
  createForm.value.payMode === 'full'
    ? quote.value.payableAmount
    : quote.value.depositAmount,
);

const paymentTotal = computed(() =>
  createPaymentRows.value.reduce(
    (sum, row) => sum + yuanToCents(row.amountYuan),
    0,
  ),
);

const needCreditAccount = computed(() =>
  createPaymentRows.value.some((row) => row.channel === 'credit'),
);

// 可约时段
const slots = ref<AvailableSlot[]>([]);
const slotReason = ref<SlotReason | null>(null);
const slotLoading = ref(false);
const slotMeta = ref<{ durationMinutes: number; bufferMinutes: number } | null>(
  null,
);

async function loadSlots() {
  const form = createForm.value;
  if (!form.staffId) {
    LewMessage.error('请先选择美甲师');
    return;
  }
  if (!form.date) {
    LewMessage.error('请先选择日期');
    return;
  }
  if (!form.serviceItemIds.length) {
    LewMessage.error('请先选择服务项目');
    return;
  }
  slotLoading.value = true;
  try {
    const result = await availableSlots({
      staffId: Number(form.staffId),
      date: form.date,
      serviceItemIds: form.serviceItemIds.map(Number),
    });
    slots.value = result.slots;
    slotReason.value = result.reason ?? null;
    slotMeta.value = {
      durationMinutes: result.durationMinutes,
      bufferMinutes: result.bufferMinutes,
    };
  } finally {
    slotLoading.value = false;
  }
}

function openCreate() {
  createForm.value = {
    customerId: '',
    serviceItemIds: [],
    staffId: '',
    date: today,
    startAt: '',
    payMode: 'full',
    depositYuan: undefined,
    pointsUsed: undefined,
    adjustYuan: undefined,
    adjustReason: '',
    creditAccountId: '',
    remark: '',
  };
  createPaymentRows.value = [newPaymentRow()];
  customerBrief.value = null;
  customerKeyword.value = '';
  customerOptions.value = [];
  slots.value = [];
  slotReason.value = null;
  slotMeta.value = null;
  createVisible.value = true;
  if (!allServiceItems.value.length) void loadServiceItems();
  void loadCreditAccounts();
}

/** 选中的项目/美甲师/日期变化后，旧时段不再有效 */
watch(
  () => [
    createForm.value.staffId,
    createForm.value.date,
    createForm.value.serviceItemIds.join(','),
  ],
  () => {
    createForm.value.startAt = '';
    slots.value = [];
    slotReason.value = null;
  },
);

function addPaymentRow() {
  createPaymentRows.value = [...createPaymentRows.value, newPaymentRow()];
}

function removePaymentRow(key: number) {
  createPaymentRows.value = createPaymentRows.value.filter(
    (row) => row.key !== key,
  );
}

/** 按「本次应收」填充第一行（含积分抵扣后的服务端口径提示） */
function fillPayTarget() {
  const first = createPaymentRows.value[0];
  if (!first) return;
  first.amountYuan = centsToYuan(payTarget.value);
  if (createPaymentRows.value.length > 1) createPaymentRows.value = [first];
}

function buildPayments(rows: PaymentRow[]): PaymentInput[] {
  const payments: PaymentInput[] = [];
  for (const row of rows) {
    const amount = yuanToCents(row.amountYuan);
    if (amount <= 0) continue;
    const payment: PaymentInput = {
      channel: row.channel as PayChannel,
      amount,
    };
    if (row.channel === 'cash' && row.receivedYuan !== undefined)
      payment.receivedAmount = yuanToCents(row.receivedYuan);
    if (row.channel === 'card' && row.memberCardId)
      payment.memberCardId = Number(row.memberCardId);
    payments.push(payment);
  }
  return payments;
}

async function submitCreate(force = false) {
  const form = createForm.value;
  if (!form.customerId) {
    LewMessage.error('请先搜索并选择顾客');
    return;
  }
  if (!form.serviceItemIds.length) {
    LewMessage.error('请选择 1~3 个服务项目');
    return;
  }
  if (form.serviceItemIds.length > 3) {
    LewMessage.error('单次最多选择 3 个服务项目');
    return;
  }
  if (!form.staffId) {
    LewMessage.error('请选择美甲师');
    return;
  }
  if (!form.startAt) {
    LewMessage.error('请先查询并选择一个可约时段');
    return;
  }
  if (form.adjustYuan !== undefined && form.adjustYuan !== 0) {
    if (!can.adjust) {
      LewMessage.error('没有改价权限（biz:booking:adjust）');
      return;
    }
    if (!form.adjustReason.trim()) {
      LewMessage.error('改价必须填写原因');
      return;
    }
  }
  if (needCreditAccount.value && !form.creditAccountId) {
    LewMessage.error('挂账必须选择挂账主体');
    return;
  }
  const payments = buildPayments(createPaymentRows.value);
  if (
    payments.some(
      (payment) => payment.channel === 'card' && !payment.memberCardId,
    )
  ) {
    LewMessage.error('次卡核销必须选择次卡');
    return;
  }
  if (paymentTotal.value > payTarget.value) {
    LewMessage.error(
      `收款合计 ${money(paymentTotal.value)} 超过本次应收 ${money(payTarget.value)}`,
    );
    return;
  }
  if (form.payMode === 'full' && paymentTotal.value !== payTarget.value) {
    LewMessage.error(
      `全款模式必须收清：本次应收 ${money(payTarget.value)}，已填 ${money(paymentTotal.value)}（挂账请显式添加「挂账」收款项）`,
    );
    return;
  }

  const body: CreateBookingBody = {
    customerId: Number(form.customerId),
    staffId: Number(form.staffId),
    startAt: form.startAt,
    serviceItemIds: form.serviceItemIds.map(Number),
    payMode: form.payMode,
    ...(form.payMode === 'deposit' && form.depositYuan !== undefined
      ? { depositAmount: yuanToCents(form.depositYuan) }
      : {}),
    ...(payments.length ? { payments } : {}),
    ...(form.pointsUsed !== undefined && form.pointsUsed > 0
      ? { pointsUsed: Math.trunc(form.pointsUsed) }
      : {}),
    ...(form.adjustYuan !== undefined && form.adjustYuan !== 0
      ? {
          adjustAmount: yuanToCents(form.adjustYuan),
          adjustReason: form.adjustReason.trim(),
        }
      : {}),
    ...(needCreditAccount.value && form.creditAccountId
      ? { creditAccountId: Number(form.creditAccountId) }
      : {}),
    ...(form.remark.trim() ? { remark: form.remark.trim() } : {}),
    force,
  };

  createSaving.value = true;
  try {
    const outcome = await createBooking(body);
    if (!outcome.ok) {
      // 顾客同时段已有预约（软拦，带 conflicts 清单）：列清单 + force 二次确认
      if (outcome.conflicts.length) {
        openCreateConflict(outcome.message, outcome.conflicts);
        return;
      }
      // 美甲师时段被占：保留表单内容，提示并自动刷新可约时段（§10.4）
      if (outcome.message.includes('时段')) {
        LewMessage.warning('该时段刚被占用，请重新选择');
        createForm.value.startAt = '';
        await loadSlots();
        return;
      }
      // 其余 409（美甲师停用 / 余额不足 / 挂账超额…）原样提示
      LewMessage.error(outcome.message);
      return;
    }
    LewMessage.success(
      `创建成功：${outcome.data.bookingNo}，应付 ${money(
        outcome.data.payableAmount,
      )}，已收 ${money(outcome.data.paidAmount)}`,
    );
    createVisible.value = false;
    void refresh();
  } finally {
    createSaving.value = false;
  }
}

// 创建 / 改期共用的冲突清单弹窗
const createConflictVisible = ref(false);
const createConflictMessage = ref('');
const createConflictList = ref<BookingConflictItem[]>([]);
const createConflictRetry = ref<null | (() => Promise<void>)>(null);
const createConflictSaving = ref(false);

function openCreateConflict(
  message: string,
  conflicts: BookingConflictItem[],
  retry: null | (() => Promise<void>) = null,
) {
  createConflictMessage.value = message;
  createConflictList.value = conflicts;
  createConflictRetry.value =
    retry ?? (conflicts.length ? () => submitCreate(true) : null);
  createConflictVisible.value = true;
}

const createConflictFooter = computed<LewModalFooterButtonItem[]>(() => {
  const buttons: LewModalFooterButtonItem[] = [
    {
      props: {
        type: 'text',
        color: 'gray',
        size: 'small',
        text: createConflictRetry.value ? '取消' : '知道了',
        request: () => {
          createConflictVisible.value = false;
        },
      },
    },
  ];
  if (createConflictRetry.value) {
    buttons.push({
      props: {
        type: 'fill',
        color: 'error',
        size: 'small',
        text: '确认强制创建',
        loading: createConflictSaving.value,
        request: async () => {
          const retry = createConflictRetry.value;
          createConflictVisible.value = false;
          if (!retry) return;
          createConflictSaving.value = true;
          try {
            await retry();
          } finally {
            createConflictSaving.value = false;
          }
        },
      },
    });
  }
  return buttons;
});

/* ------------------------------------------------------------------ *
 * 结算（§17.2：尾款 / 挂账 / 补收，混合支付多行）
 * ------------------------------------------------------------------ */

const settleVisible = ref(false);
const settleSaving = ref(false);
const settleLoading = ref(false);
const settleTarget = ref<BookingDetail | null>(null);
const settleForm = ref({
  pointsUsed: undefined as number | undefined,
  creditAccountId: '',
  remark: '',
});
const settlePaymentRows = ref<PaymentRow[]>([newPaymentRow()]);
const creditAccountOptions = ref<{ label: string; value: string }[]>([]);
const memberCardOptions = ref<{ label: string; value: string }[]>([]);

async function openSettle(row: Booking) {
  settleVisible.value = true;
  settleSaving.value = false;
  settleLoading.value = true;
  settleTarget.value = null;
  settleForm.value = {
    pointsUsed: undefined,
    creditAccountId: '',
    remark: '',
  };
  settlePaymentRows.value = [newPaymentRow()];
  try {
    const detailRow = await getBooking(row.id);
    settleTarget.value = detailRow;
    await loadCreditAccounts();
    await loadMemberCards(row.customerId);
  } finally {
    settleLoading.value = false;
  }
}

const settleDue = computed(() => settleTarget.value?.dueAmount ?? 0);

const settlePaymentTotal = computed(() =>
  settlePaymentRows.value.reduce(
    (sum, row) => sum + yuanToCents(row.amountYuan),
    0,
  ),
);

const settleNeedCreditAccount = computed(() =>
  settlePaymentRows.value.some((row) => row.channel === 'credit'),
);

async function submitSettle() {
  const booking = settleTarget.value;
  if (!booking) return;
  if (settleNeedCreditAccount.value && !settleForm.value.creditAccountId) {
    LewMessage.error('挂账必须选择挂账主体');
    return;
  }
  if (settlePaymentTotal.value > settleDue.value) {
    LewMessage.error(
      `收款合计 ${money(settlePaymentTotal.value)} 超过待收尾款 ${money(settleDue.value)}`,
    );
    return;
  }
  const payments = buildPayments(settlePaymentRows.value);
  if (
    payments.some(
      (payment) => payment.channel === 'card' && !payment.memberCardId,
    )
  ) {
    LewMessage.error('次卡核销必须选择次卡');
    return;
  }
  const currentPoints = Math.round(
    (booking.pointsDiscountAmount / 100) * POINTS_PER_YUAN,
  );
  if (
    settleForm.value.pointsUsed !== undefined &&
    settleForm.value.pointsUsed < currentPoints
  ) {
    LewMessage.error('结算只能增加积分抵扣，减少需走冲正流程');
    return;
  }
  const body: SettleBookingBody = {
    ...(payments.length ? { payments } : {}),
    ...(settleForm.value.pointsUsed !== undefined
      ? { pointsUsed: Math.trunc(settleForm.value.pointsUsed) }
      : {}),
    ...(settleNeedCreditAccount.value && settleForm.value.creditAccountId
      ? { creditAccountId: Number(settleForm.value.creditAccountId) }
      : {}),
    ...(settleForm.value.remark.trim()
      ? { remark: settleForm.value.remark.trim() }
      : {}),
  };
  settleSaving.value = true;
  try {
    const result = await settleBooking(booking.id, body);
    LewMessage.success(
      `结算完成：已收 ${money(result.paidAmount)}，尾款 ${money(result.dueAmount)}`,
    );
    settleVisible.value = false;
    void refresh();
  } finally {
    settleSaving.value = false;
  }
}

/* ------------------------------------------------------------------ *
 * 改期（锁 + 复检，§6.3）
 * ------------------------------------------------------------------ */

const rescheduleVisible = ref(false);
const rescheduleSaving = ref(false);
const rescheduleTarget = ref<BookingDetail | null>(null);
const rescheduleForm = ref({ staffId: '', date: '', startAt: '' });
const rescheduleSlots = ref<AvailableSlot[]>([]);
const rescheduleReason = ref<SlotReason | null>(null);
const rescheduleLoading = ref(false);

async function openReschedule(row: Booking) {
  rescheduleVisible.value = true;
  rescheduleTarget.value = null;
  rescheduleSlots.value = [];
  rescheduleReason.value = null;
  const detailRow = await getBooking(row.id);
  rescheduleTarget.value = detailRow;
  rescheduleForm.value = {
    staffId: String(detailRow.staffId),
    date: shopDate(detailRow.startAt),
    startAt: '',
  };
}

async function loadRescheduleSlots() {
  const booking = rescheduleTarget.value;
  if (!booking) return;
  if (!rescheduleForm.value.staffId || !rescheduleForm.value.date) {
    LewMessage.error('请选择美甲师与日期');
    return;
  }
  rescheduleLoading.value = true;
  try {
    const result = await availableSlots({
      staffId: Number(rescheduleForm.value.staffId),
      date: rescheduleForm.value.date,
      serviceItemIds: booking.items.map((item) => item.serviceItemId),
    });
    rescheduleSlots.value = result.slots;
    rescheduleReason.value = result.reason ?? null;
  } finally {
    rescheduleLoading.value = false;
  }
}

async function submitReschedule(force = false) {
  const booking = rescheduleTarget.value;
  if (!booking) return;
  if (!rescheduleForm.value.startAt) {
    LewMessage.error('请先查询并选择新的时段');
    return;
  }
  rescheduleSaving.value = true;
  try {
    const outcome = await updateBooking(booking.id, {
      staffId: Number(rescheduleForm.value.staffId),
      startAt: rescheduleForm.value.startAt,
      force,
    });
    if (!outcome.ok) {
      if (outcome.conflicts.length) {
        openCreateConflict(outcome.message, outcome.conflicts, () =>
          submitReschedule(true),
        );
        return;
      }
      if (outcome.message.includes('时段')) {
        LewMessage.warning('该时段刚被占用，请重新选择');
        rescheduleForm.value.startAt = '';
        await loadRescheduleSlots();
        return;
      }
      LewMessage.error(outcome.message);
      return;
    }
    if (outcome.data.warning) LewMessage.warning(outcome.data.warning);
    LewMessage.success('改期成功');
    rescheduleVisible.value = false;
    void refresh();
  } finally {
    rescheduleSaving.value = false;
  }
}

/* ------------------------------------------------------------------ *
 * 退款入口（§17.4：只发起申请，审批在「退款审批」页）
 * ------------------------------------------------------------------ */

const refundVisible = ref(false);
const refundSaving = ref(false);
const refundTarget = ref<Booking | null>(null);
const refundPreview = ref<RefundPreview | null>(null);
const refundLoading = ref(false);
const refundForm = ref({
  amountYuan: undefined as number | undefined,
  mode: 'original' as RefundMode,
  liable: 'customer' as RefundLiable,
  reason: '',
  remark: '',
});

async function openRefund(row: Booking) {
  refundVisible.value = true;
  refundSaving.value = false;
  refundTarget.value = row;
  refundPreview.value = null;
  refundForm.value = {
    amountYuan: undefined,
    mode: 'original',
    liable: 'customer',
    reason: '',
    remark: '',
  };
  refundLoading.value = true;
  try {
    const preview = await previewBookingRefund(row.id);
    refundPreview.value = preview;
    refundForm.value.liable = preview.liable;
    refundForm.value.amountYuan = centsToYuan(preview.suggestAmount);
  } finally {
    refundLoading.value = false;
  }
}

async function submitRefund() {
  const booking = refundTarget.value;
  if (!booking) return;
  if (!refundForm.value.reason.trim()) {
    LewMessage.error('退款必须填写原因');
    return;
  }
  refundSaving.value = true;
  try {
    const result = await applyBookingRefund(booking.id, {
      ...(refundForm.value.amountYuan !== undefined
        ? { amount: yuanToCents(refundForm.value.amountYuan) }
        : {}),
      mode: refundForm.value.mode,
      liable: refundForm.value.liable,
      reason: refundForm.value.reason.trim(),
      ...(refundForm.value.remark.trim()
        ? { remark: refundForm.value.remark.trim() }
        : {}),
    });
    LewMessage.success(
      `退款申请已提交（${result.refundNo}，待审批）；审批通过后才真正退款`,
    );
    refundVisible.value = false;
    void refresh();
  } finally {
    refundSaving.value = false;
  }
}

/* ------------------------------------------------------------------ *
 * 软删（仅管理员；有实收时后端拒绝）
 * ------------------------------------------------------------------ */

function handleDelete(row: Booking) {
  confirmDanger({
    title: '软删预约',
    content: `确定软删预约「${row.bookingNo}」吗？已有实收时必须先完成退款流程。`,
    onConfirm: async () => {
      try {
        await deleteBooking(row.id);
        LewMessage.success('已删除');
        void refresh();
      } catch {
        // 409 原文提示由 request 拦截器统一弹出
      }
    },
  });
}

/* ------------------------------------------------------------------ *
 * 行内操作的中间态（避免 IconButton 连点）
 * ------------------------------------------------------------------ */
</script>

<template>
  <div class="page-container">
    <!-- 页头 -->
    <div class="flex items-center justify-between">
      <div>
        <h2 class="page-title m-0">预约管理</h2>
        <p class="page-subtitle mt-1 mb-0">
          列表 + 筛选 + 状态流转；日历时间轴本期不做（§10.3）
        </p>
      </div>
      <LewButton
        v-permission="'biz:booking:create'"
        type="fill"
        @click="openCreate"
      >
        <Plus :size="15" style="margin-right: 4px" /> 新建预约
      </LewButton>
    </div>

    <!-- 筛选栏 -->
    <div class="app-card flex flex-wrap items-center gap-3 p-4">
      <LewSelect
        v-model="dateMode"
        width="120px"
        :options="[
          { label: '按单日', value: 'single' },
          { label: '按区间', value: 'range' },
        ]"
      />
      <template v-if="dateMode === 'single'">
        <LewDatePicker
          v-model="query.date"
          width="160px"
          value-format="YYYY-MM-DD"
          placeholder="店内日期"
          clearable
        />
      </template>
      <template v-else>
        <LewDatePicker
          v-model="query.dateFrom"
          width="160px"
          value-format="YYYY-MM-DD"
          placeholder="起始日"
          clearable
        />
        <span class="text-[var(--app-text-muted)]">~</span>
        <LewDatePicker
          v-model="query.dateTo"
          width="160px"
          value-format="YYYY-MM-DD"
          placeholder="结束日"
          clearable
        />
      </template>
      <LewSelect
        v-model="query.staffId"
        width="150px"
        :options="staffOptions"
        placeholder="全部美甲师"
        clearable
      />
      <LewSelect
        v-model="query.status"
        width="130px"
        :options="statusOptions"
        placeholder="全部服务状态"
        clearable
      />
      <LewSelect
        v-model="query.payStatus"
        width="130px"
        :options="payStatusOptions"
        placeholder="全部资金状态"
        clearable
      />
      <LewInput
        v-model="query.keyword"
        width="200px"
        placeholder="单号 / 顾客 / 手机号"
        clearable
        @keyup.enter="search()"
      />
      <LewButton type="light" :loading="loading" @click="search()"
        >查询</LewButton
      >
      <LewButton type="text" color="gray" @click="handleReset">重置</LewButton>
    </div>

    <!-- 列表 -->
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
              @click="openDetail(row as unknown as Booking)"
            >
              <Eye :size="14" />
            </IconButton>
            <IconButton
              v-if="can.arrive && canArrive(row as unknown as Booking)"
              permission="biz:booking:arrive"
              title="到店"
              @click="handleArrive(row as unknown as Booking)"
            >
              <UserCheck :size="14" />
            </IconButton>
            <IconButton
              v-if="can.complete && canComplete(row as unknown as Booking)"
              permission="biz:booking:complete"
              title="完成服务"
              @click="handleComplete(row as unknown as Booking)"
            >
              <CheckCircle2 :size="14" />
            </IconButton>
            <IconButton
              v-if="can.noshow && canNoShow(row as unknown as Booking)"
              permission="biz:booking:noshow"
              color="error"
              title="爽约（需填原因）"
              @click="openReason(row as unknown as Booking, 'no-show')"
            >
              <UserX :size="14" />
            </IconButton>
            <IconButton
              v-if="can.cancel && canCancel(row as unknown as Booking)"
              permission="biz:booking:cancel"
              color="error"
              title="取消（需填原因）"
              @click="openReason(row as unknown as Booking, 'cancel')"
            >
              <XCircle :size="14" />
            </IconButton>
            <IconButton
              v-if="can.settle && canSettle(row as unknown as Booking)"
              permission="biz:payment:create"
              title="结算 / 收尾款"
              @click="openSettle(row as unknown as Booking)"
            >
              <Wallet :size="14" />
            </IconButton>
            <IconButton
              v-if="can.update && canReschedule(row as unknown as Booking)"
              permission="biz:booking:update"
              title="改期 / 改美甲师"
              @click="openReschedule(row as unknown as Booking)"
            >
              <CalendarClock :size="14" />
            </IconButton>
            <IconButton
              v-if="can.refund && canRefund(row as unknown as Booking)"
              permission="biz:refund:apply"
              title="发起退款（需审批）"
              @click="openRefund(row as unknown as Booking)"
            >
              <RotateCcw :size="14" />
            </IconButton>
            <IconButton
              v-if="can.remove"
              permission="biz:booking:delete"
              color="error"
              title="软删（仅误录清理）"
              @click="handleDelete(row as unknown as Booking)"
            >
              <Trash2 :size="14" />
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

    <!-- 创建预约（§10.4） -->
    <LewModal
      v-model:visible="createVisible"
      title="新建预约"
      width="880px"
      :footer-buttons="[
        {
          props: {
            type: 'text',
            color: 'gray',
            size: 'small',
            text: '取消',
            request: () => {
              createVisible = false;
            },
          },
        },
        {
          props: {
            type: 'fill',
            color: 'primary',
            size: 'small',
            text: '提交预约',
            loading: createSaving,
            request: () => submitCreate(false),
          },
        },
      ]"
    >
      <div class="flex flex-col gap-4 p-5">
        <!-- 顾客 -->
        <div class="app-card p-4">
          <div class="mb-2 text-14px font-600">
            1. 选择顾客（首期不在弹窗里新建顾客）
          </div>
          <div class="flex items-center gap-2">
            <LewInput
              v-model="customerKeyword"
              width="240px"
              placeholder="姓名 / 手机号"
              clearable
              @keyup.enter="searchCustomerOptions"
            />
            <LewButton
              type="light"
              size="small"
              :loading="customerSearching"
              @click="searchCustomerOptions"
              >搜索</LewButton
            >
            <LewSelect
              v-model="createForm.customerId"
              width="300px"
              :options="customerOptions"
              placeholder="选择顾客"
              clearable
              searchable
            />
          </div>
          <div
            v-if="customerBrief"
            class="mt-2 rounded-8px bg-[var(--app-bg-hover)] p-3 text-12.5px leading-5"
          >
            <div>
              等级：<span class="font-600">{{
                customerBrief.levelName ?? '无等级（不打折）'
              }}</span>
              · 折扣率：{{
                ((customerBrief.discountPermille ?? 1000) / 10).toFixed(1)
              }}
              折
            </div>
            <div>
              积分：{{ customerBrief.points }} · 储值余额：{{
                money(
                  customerBrief.balancePrincipal + customerBrief.balanceBonus,
                )
              }}
            </div>
          </div>
        </div>

        <!-- 服务项目 -->
        <div class="app-card p-4">
          <div class="mb-2 text-14px font-600">
            2. 选择服务项目（最多 3 个，实时累加时长与价格）
          </div>
          <LewSelect
            v-model="createForm.serviceItemIds"
            width="100%"
            multiple
            :options="serviceItemOptions"
            placeholder="选择 1~3 个服务项目"
          />
          <div class="mt-2 text-12.5px leading-5">
            <span class="text-[var(--app-text-secondary)]"
              >总时长
              <span class="font-600 tabular-nums"
                >{{ totalDuration }} 分钟</span
              >
              ，缓冲
              <span class="font-600 tabular-nums">{{ totalBuffer }} 分钟</span>
            </span>
            <span class="ml-3 text-[var(--app-text-muted)]"
              >（缓冲取所选项目的最大值，参与冲突判定）</span
            >
          </div>
        </div>

        <!-- 美甲师 + 日期 + 时段 -->
        <div class="app-card p-4">
          <div class="mb-2 text-14px font-600">
            3. 选美甲师、日期并查询可约时段
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <LewSelect
              v-model="createForm.staffId"
              width="180px"
              :options="staffOptions"
              placeholder="选择美甲师"
              clearable
            />
            <LewDatePicker
              v-model="createForm.date"
              width="170px"
              value-format="YYYY-MM-DD"
              placeholder="店内日期"
              clearable
            />
            <LewButton type="light" :loading="slotLoading" @click="loadSlots"
              >查询可约时段</LewButton
            >
            <span
              v-if="slotMeta"
              class="text-12.5px text-[var(--app-text-muted)]"
            >
              需连续 {{ slotMeta.durationMinutes }} 分钟 + 缓冲
              {{ slotMeta.bufferMinutes }} 分钟
            </span>
          </div>

          <div v-if="slots.length" class="mt-3 flex flex-wrap gap-2">
            <button
              v-for="slot in slots"
              :key="slot.startAt"
              type="button"
              class="cursor-pointer rounded-8px border px-3 py-1.5 text-13px tabular-nums transition-colors"
              :class="
                createForm.startAt === slot.startAt
                  ? 'border-[var(--lew-color-primary)] bg-[var(--lew-color-primary-light)] font-600 text-[var(--lew-color-primary)]'
                  : 'border-[var(--app-border)] hover:bg-[var(--app-bg-hover)]'
              "
              @click="createForm.startAt = slot.startAt"
            >
              {{ shortClock(slot.startAt) }}
            </button>
          </div>
          <div
            v-else-if="slotReason"
            class="mt-3 rounded-8px border border-[var(--lew-color-warning)] p-3 text-13px"
          >
            {{ slotReasonText[slotReason] }}
          </div>
          <div v-else class="mt-3 text-12.5px text-[var(--app-text-muted)]">
            选好项目、美甲师与日期后点「查询可约时段」。
          </div>
          <div v-if="createForm.startAt" class="mt-2 text-13px">
            已选：
            <span class="font-600 tabular-nums"
              >{{ shortClock(createForm.startAt) }} -
              {{
                shortClock(
                  slots.find((s) => s.startAt === createForm.startAt)?.endAt,
                )
              }}</span
            >
          </div>
        </div>

        <!-- 收款 -->
        <div class="app-card p-4">
          <div class="mb-2 text-14px font-600">4. 收款（可混合支付）</div>
          <div class="mb-3 grid grid-cols-2 gap-x-4 gap-y-1 text-13px">
            <div class="text-[var(--app-text-muted)]">项目原价</div>
            <div class="tabular-nums">{{ money(quote.originalPrice) }}</div>
            <div class="text-[var(--app-text-muted)]">
              等级优惠（{{ (quote.permille / 10).toFixed(1) }} 折）
            </div>
            <div class="tabular-nums">
              - {{ money(quote.levelDiscountAmount) }}
            </div>
            <div class="text-[var(--app-text-muted)]">
              积分抵扣（可用上限 {{ quote.maxPoints }} 分）
            </div>
            <div class="tabular-nums">
              - {{ money(quote.pointsDiscountAmount) }}
            </div>
            <div class="text-[var(--app-text-muted)]">改价</div>
            <div class="tabular-nums">
              {{ money(quote.adjustAmount) }}
            </div>
            <div class="font-600">应付（服务端复算为准）</div>
            <div class="font-600 tabular-nums">
              {{ money(quote.payableAmount) }}
            </div>
          </div>

          <div class="flex flex-wrap items-center gap-3">
            <span class="text-13px text-[var(--app-text-secondary)]"
              >收款方式</span
            >
            <LewSelect
              v-model="createForm.payMode"
              width="150px"
              :options="[
                { label: '收全款', value: 'full' },
                { label: '收定金', value: 'deposit' },
              ]"
            />
            <template v-if="createForm.payMode === 'deposit'">
              <span class="text-13px text-[var(--app-text-secondary)]"
                >定金（元）</span
              >
              <LewInputNumber
                v-model="createForm.depositYuan"
                width="140px"
                :min="0"
                placeholder="留空按默认定金比例 30%"
              />
            </template>
            <span class="text-12.5px text-[var(--app-text-muted)]"
              >本次应收：<span class="font-600 tabular-nums">{{
                money(payTarget)
              }}</span></span
            >
            <LewButton type="text" size="small" @click="fillPayTarget"
              >按应收填充</LewButton
            >
          </div>

          <div class="mt-3 flex flex-col gap-2">
            <div
              v-for="row in createPaymentRows"
              :key="row.key"
              class="flex flex-wrap items-center gap-2"
            >
              <LewSelect
                v-model="row.channel"
                width="190px"
                :options="channelOptions"
              />
              <LewInputNumber
                v-model="row.amountYuan"
                width="140px"
                :min="0"
                placeholder="金额（元）"
              />
              <template v-if="row.channel === 'cash'">
                <span class="text-12.5px text-[var(--app-text-muted)]"
                  >实收</span
                >
                <LewInputNumber
                  v-model="row.receivedYuan"
                  width="130px"
                  :min="0"
                  placeholder="选填（找零）"
                />
              </template>
              <template v-if="row.channel === 'card'">
                <LewSelect
                  v-model="row.memberCardId"
                  width="240px"
                  :options="memberCardOptions"
                  placeholder="选择次卡"
                  clearable
                />
              </template>
              <IconButton
                v-if="createPaymentRows.length > 1"
                color="error"
                title="删除该行"
                @click="removePaymentRow(row.key)"
              >
                <Trash2 :size="14" />
              </IconButton>
            </div>
            <div class="flex items-center gap-2">
              <LewButton type="light" size="small" @click="addPaymentRow"
                ><Plus
                  :size="14"
                  style="margin-right: 4px"
                />添加支付行</LewButton
              >
              <span class="text-12.5px text-[var(--app-text-muted)]"
                >已填合计：<span class="font-600 tabular-nums">{{
                  money(paymentTotal)
                }}</span>
                （全款模式需收清；定金模式可少于应收，差额记为尾款）</span
              >
            </div>
            <LewSelect
              v-if="needCreditAccount"
              v-model="createForm.creditAccountId"
              width="320px"
              :options="creditAccountOptions"
              placeholder="选择挂账主体（挂账不产生实收）"
              clearable
            />
          </div>

          <div class="mt-3 flex flex-wrap items-center gap-3">
            <span class="text-13px text-[var(--app-text-secondary)]"
              >使用积分</span
            >
            <LewInputNumber
              v-model="createForm.pointsUsed"
              width="150px"
              :min="0"
              placeholder="选填"
            />
            <span class="text-12.5px text-[var(--app-text-muted)]"
              >按默认配置 100 积分抵 1 元、最多抵 30%（服务端复算）</span
            >
          </div>

          <div v-if="can.adjust" class="mt-3 flex flex-wrap items-center gap-3">
            <span class="text-13px text-[var(--app-text-secondary)]"
              >改价（元）</span
            >
            <LewInputNumber
              v-model="createForm.adjustYuan"
              width="140px"
              placeholder="可正可负"
            />
            <LewInput
              v-model="createForm.adjustReason"
              width="240px"
              placeholder="改价原因（改价必填）"
              clearable
            />
          </div>
          <div v-else class="mt-3 text-12.5px text-[var(--app-text-muted)]">
            无「biz:booking:adjust」权限，不显示改价入口。
          </div>
        </div>

        <!-- 备注 -->
        <div class="app-card p-4">
          <div class="mb-2 text-14px font-600">5. 备注</div>
          <LewInput
            v-model="createForm.remark"
            width="100%"
            placeholder="顾客需求 / 到店提醒（选填）"
            clearable
          />
        </div>
      </div>
    </LewModal>

    <!-- 爽约 / 取消原因 -->
    <LewModal
      v-model:visible="reasonVisible"
      :title="reasonTitle"
      width="480px"
      :footer-buttons="[
        {
          props: {
            type: 'text',
            color: 'gray',
            size: 'small',
            text: '取消',
            request: () => {
              reasonVisible = false;
            },
          },
        },
        {
          props: {
            type: 'fill',
            color: 'error',
            size: 'small',
            text: '确认',
            loading: reasonSaving,
            request: submitReason,
          },
        },
      ]"
    >
      <div class="flex flex-col gap-3 p-5">
        <div class="text-13px">
          预约：<span class="font-600">{{ reasonTarget?.bookingNo }}</span> （{{
            reasonTarget?.customerName
          }}
          · {{ formatDateTime(reasonTarget?.startAt, 'MM-DD HH:mm') }}）
        </div>
        <div
          class="rounded-8px border border-[var(--lew-color-warning)] p-3 text-12.5px leading-5"
        >
          {{ reasonHint }}
        </div>
        <LewInput
          v-model="reasonText"
          width="100%"
          placeholder="请填写原因（必填）"
          :max-length="200"
          show-count
          clearable
        />
      </div>
    </LewModal>

    <!-- 预约详情 -->
    <LewModal
      v-model:visible="detailVisible"
      :title="`预约详情 - ${detail?.bookingNo ?? ''}`"
      width="820px"
      :hide-footer="true"
    >
      <div v-if="detail" class="flex flex-col gap-4 p-5">
        <div class="app-card p-4">
          <div class="grid grid-cols-3 gap-2 text-13px">
            <div class="text-[var(--app-text-muted)]">顾客</div>
            <div>
              {{ detail.customerName }} · {{ detail.customerPhone ?? '-' }}
            </div>
            <div class="text-[var(--app-text-muted)]">美甲师</div>
            <div>{{ detail.staffName ?? '-' }}</div>
            <div class="text-[var(--app-text-muted)]">开始时间</div>
            <div>{{ formatDateTime(detail.startAt) }}</div>
            <div class="text-[var(--app-text-muted)]">结束时间</div>
            <div>
              {{ formatDateTime(detail.endAt) }}（不含缓冲
              {{ detail.bufferMinutes }} 分钟）
            </div>
            <div class="text-[var(--app-text-muted)]">服务状态</div>
            <div>{{ statusText[detail.status] }}</div>
            <div class="text-[var(--app-text-muted)]">资金状态</div>
            <div>
              {{ payStatusText[detail.payStatus] }}（{{
                detail.payChannelSummary ?? '-'
              }}）
            </div>
            <div class="text-[var(--app-text-muted)]">原价 / 等级优惠</div>
            <div class="tabular-nums">
              {{ money(detail.originalPrice) }} / -
              {{ money(detail.levelDiscountAmount) }}
            </div>
            <div class="text-[var(--app-text-muted)]">积分抵扣 / 改价</div>
            <div class="tabular-nums">
              - {{ money(detail.pointsDiscountAmount) }} /
              {{ money(detail.adjustAmount) }}
              {{ detail.adjustReason ? '（' + detail.adjustReason + '）' : '' }}
            </div>
            <div class="text-[var(--app-text-muted)]">应付 / 已收 / 尾款</div>
            <div class="tabular-nums">
              {{ money(detail.payableAmount) }} /
              {{ money(detail.paidAmount) }} /
              {{ money(detail.dueAmount) }}
            </div>
            <div class="text-[var(--app-text-muted)]">备注</div>
            <div class="col-span-2">{{ detail.remark ?? '-' }}</div>
          </div>
        </div>

        <div class="app-card p-4">
          <div class="mb-2 text-14px font-600">项目明细（快照）</div>
          <LewTable
            :data-source="detail.items"
            :focusable="false"
            size="small"
            :columns="[
              { title: '项目', field: 'name' },
              { title: '时长(分)', field: 'durationMinutes', width: 100 },
              {
                title: '单价',
                field: 'price',
                width: 120,
                customRender: ({ row }) =>
                  money((row as unknown as { price: number }).price),
              },
            ]"
          />
        </div>

        <div class="app-card p-4">
          <div class="mb-2 text-14px font-600">支付单</div>
          <LewTable
            :data-source="detail.payments"
            :focusable="false"
            size="small"
            :columns="[
              { title: '支付单号', field: 'paymentNo', width: 170 },
              {
                title: '用途',
                field: 'purpose',
                width: 90,
                customRender: ({ row }) =>
                  (row as unknown as { purpose: string }).purpose === 'deposit'
                    ? '定金'
                    : (row as unknown as { purpose: string }).purpose ===
                        'final'
                      ? '尾款'
                      : (row as unknown as { purpose: string }).purpose,
              },
              {
                title: '渠道',
                field: 'channel',
                width: 110,
                customRender: ({ row }) =>
                  channelText[
                    (row as unknown as { channel: PayChannel }).channel
                  ] ?? (row as unknown as { channel: string }).channel,
              },
              {
                title: '金额',
                field: 'amount',
                width: 110,
                customRender: ({ row }) =>
                  money((row as unknown as { amount: number }).amount),
              },
              {
                title: '实收',
                field: 'receivedAmount',
                width: 110,
                customRender: ({ row }) =>
                  money(
                    (row as unknown as { receivedAmount: number })
                      .receivedAmount,
                  ),
              },
              { title: '状态', field: 'status', width: 110 },
              {
                title: '支付时间',
                field: 'paidAt',
                width: 160,
                customRender: ({ row }) =>
                  formatDateTime(
                    (row as unknown as { paidAt: string | null }).paidAt,
                  ),
              },
            ]"
          />
        </div>
      </div>
      <div v-else class="p-5 text-13px text-[var(--app-text-muted)]">
        {{ detailLoading ? '加载中…' : '暂无数据' }}
      </div>
    </LewModal>

    <!-- 结算 -->
    <LewModal
      v-model:visible="settleVisible"
      :title="`结算 - ${settleTarget?.bookingNo ?? ''}`"
      width="760px"
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
            text: '确认收款',
            loading: settleSaving,
            request: submitSettle,
          },
        },
      ]"
    >
      <div v-if="settleTarget" class="flex flex-col gap-3 p-5">
        <div class="grid grid-cols-2 gap-x-4 gap-y-1 text-13px">
          <div class="text-[var(--app-text-muted)]">项目原价</div>
          <div class="tabular-nums">
            {{ money(settleTarget.originalPrice) }}
          </div>
          <div class="text-[var(--app-text-muted)]">
            等级优惠（{{ (settleTarget.levelDiscountPermille / 10).toFixed(1) }}
            折）
          </div>
          <div class="tabular-nums">
            - {{ money(settleTarget.levelDiscountAmount) }}
          </div>
          <div class="text-[var(--app-text-muted)]">积分抵扣</div>
          <div class="tabular-nums">
            - {{ money(settleTarget.pointsDiscountAmount) }}
          </div>
          <div class="text-[var(--app-text-muted)]">
            改价{{
              settleTarget.adjustReason
                ? `（${settleTarget.adjustReason}）`
                : ''
            }}
          </div>
          <div class="tabular-nums">{{ money(settleTarget.adjustAmount) }}</div>
          <div class="font-600">应付</div>
          <div class="font-600 tabular-nums">
            {{ money(settleTarget.payableAmount) }}
          </div>
          <div class="text-[var(--app-text-muted)]">已收</div>
          <div class="tabular-nums">{{ money(settleTarget.paidAmount) }}</div>
          <div class="font-600">待收尾款</div>
          <div class="font-600 tabular-nums text-[var(--lew-color-error)]">
            {{ money(settleTarget.dueAmount) }}
          </div>
        </div>

        <div class="flex flex-wrap items-center gap-3">
          <span class="text-13px text-[var(--app-text-secondary)]"
            >追加积分抵扣</span
          >
          <LewInputNumber
            v-model="settleForm.pointsUsed"
            width="150px"
            :min="0"
            placeholder="选填（只能增加）"
          />
          <span class="text-12.5px text-[var(--app-text-muted)]"
            >当前已抵积分：
            {{
              Math.round(
                (settleTarget.pointsDiscountAmount / 100) * POINTS_PER_YUAN,
              )
            }}
            ；减少需走冲正流程</span
          >
        </div>

        <div class="flex flex-col gap-2">
          <div
            v-for="row in settlePaymentRows"
            :key="row.key"
            class="flex flex-wrap items-center gap-2"
          >
            <LewSelect
              v-model="row.channel"
              width="190px"
              :options="channelOptions"
            />
            <LewInputNumber
              v-model="row.amountYuan"
              width="140px"
              :min="0"
              placeholder="金额（元）"
            />
            <template v-if="row.channel === 'cash'">
              <span class="text-12.5px text-[var(--app-text-muted)]">实收</span>
              <LewInputNumber
                v-model="row.receivedYuan"
                width="130px"
                :min="0"
                placeholder="选填（找零）"
              />
            </template>
            <template v-if="row.channel === 'card'">
              <LewSelect
                v-model="row.memberCardId"
                width="240px"
                :options="memberCardOptions"
                placeholder="选择次卡"
                clearable
              />
            </template>
            <IconButton
              v-if="settlePaymentRows.length > 1"
              color="error"
              title="删除该行"
              @click="
                settlePaymentRows = settlePaymentRows.filter(
                  (item) => item.key !== row.key,
                )
              "
            >
              <Trash2 :size="14" />
            </IconButton>
          </div>
          <div class="flex items-center gap-2">
            <LewButton
              type="light"
              size="small"
              @click="
                settlePaymentRows = [...settlePaymentRows, newPaymentRow()]
              "
              ><Plus
                :size="14"
                style="margin-right: 4px"
              />添加支付行</LewButton
            >
            <LewButton
              type="text"
              size="small"
              @click="
                settlePaymentRows = [
                  { ...newPaymentRow(), amountYuan: centsToYuan(settleDue) },
                ]
              "
              >按尾款填充</LewButton
            >
            <span class="text-12.5px text-[var(--app-text-muted)]"
              >已填合计：<span class="font-600 tabular-nums">{{
                money(settlePaymentTotal)
              }}</span></span
            >
          </div>
          <LewSelect
            v-if="settleNeedCreditAccount"
            v-model="settleForm.creditAccountId"
            width="320px"
            :options="creditAccountOptions"
            placeholder="选择挂账主体（挂账不产生实收，只产生应收单）"
            clearable
          />
        </div>

        <LewInput
          v-model="settleForm.remark"
          width="100%"
          placeholder="结算备注（选填）"
          clearable
        />
      </div>
      <div v-else class="p-5 text-13px text-[var(--app-text-muted)]">
        加载中…
      </div>
    </LewModal>

    <!-- 改期 -->
    <LewModal
      v-model:visible="rescheduleVisible"
      :title="`改期 - ${rescheduleTarget?.bookingNo ?? ''}`"
      width="640px"
      :footer-buttons="[
        {
          props: {
            type: 'text',
            color: 'gray',
            size: 'small',
            text: '取消',
            request: () => {
              rescheduleVisible = false;
            },
          },
        },
        {
          props: {
            type: 'fill',
            color: 'primary',
            size: 'small',
            text: '确认改期',
            loading: rescheduleSaving,
            request: () => submitReschedule(false),
          },
        },
      ]"
    >
      <div v-if="rescheduleTarget" class="flex flex-col gap-3 p-5">
        <div class="text-13px">
          当前：
          <span class="font-600">
            {{ rescheduleTarget.staffName }} ·
            {{ formatDateTime(rescheduleTarget.startAt) }} -
            {{ shortClock(rescheduleTarget.endAt) }}
          </span>
          （时长 {{ rescheduleTarget.durationMinutes }} 分钟，缓冲
          {{ rescheduleTarget.bufferMinutes }} 分钟）
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <LewSelect
            v-model="rescheduleForm.staffId"
            width="180px"
            :options="staffOptions"
            placeholder="美甲师"
          />
          <LewDatePicker
            v-model="rescheduleForm.date"
            width="170px"
            value-format="YYYY-MM-DD"
            placeholder="新日期"
            clearable
          />
          <LewButton
            type="light"
            :loading="rescheduleLoading"
            @click="loadRescheduleSlots"
            >查询可约时段</LewButton
          >
        </div>
        <div v-if="rescheduleSlots.length" class="flex flex-wrap gap-2">
          <button
            v-for="slot in rescheduleSlots"
            :key="slot.startAt"
            type="button"
            class="cursor-pointer rounded-8px border px-3 py-1.5 text-13px tabular-nums transition-colors"
            :class="
              rescheduleForm.startAt === slot.startAt
                ? 'border-[var(--lew-color-primary)] bg-[var(--lew-color-primary-light)] font-600 text-[var(--lew-color-primary)]'
                : 'border-[var(--app-border)] hover:bg-[var(--app-bg-hover)]'
            "
            @click="rescheduleForm.startAt = slot.startAt"
          >
            {{ shortClock(slot.startAt) }}
          </button>
        </div>
        <div
          v-else-if="rescheduleReason"
          class="rounded-8px border border-[var(--lew-color-warning)] p-3 text-13px"
        >
          {{ slotReasonText[rescheduleReason] }}
        </div>
        <div class="text-12.5px text-[var(--app-text-muted)]">
          改期走「锁 +
          冲突复检」；若已收金额高于新应付，差额需到「退款审批」发起退款，不做差额补收。
        </div>
      </div>
      <div v-else class="p-5 text-13px text-[var(--app-text-muted)]">
        加载中…
      </div>
    </LewModal>

    <!-- 退款申请 -->
    <LewModal
      v-model:visible="refundVisible"
      :title="`发起退款 - ${refundTarget?.bookingNo ?? ''}`"
      width="700px"
      :footer-buttons="[
        {
          props: {
            type: 'text',
            color: 'gray',
            size: 'small',
            text: '取消',
            request: () => {
              refundVisible = false;
            },
          },
        },
        {
          props: {
            type: 'fill',
            color: 'error',
            size: 'small',
            text: '提交退款申请',
            loading: refundSaving,
            request: submitRefund,
          },
        },
      ]"
    >
      <div v-if="refundPreview" class="flex flex-col gap-3 p-5">
        <div
          class="rounded-8px border border-[var(--lew-color-warning)] p-3 text-12.5px leading-5"
        >
          此处只**发起申请**，不会立即打款：退款单会进入「退款审批」页，审批通过后才执行。
          申请与审批是分离的两个权限点。
        </div>
        <div class="grid grid-cols-2 gap-x-4 gap-y-1 text-13px">
          <div class="text-[var(--app-text-muted)]">距预约开始</div>
          <div class="tabular-nums">
            {{ refundPreview.hoursToStart.toFixed(1) }} 小时
          </div>
          <div class="text-[var(--app-text-muted)]">判责主体</div>
          <div>
            {{
              refundPreview.liable === 'store'
                ? '门店责任（全退）'
                : refundPreview.liable === 'force_majeure'
                  ? '不可抗力（全退）'
                  : '顾客责任（按规则扣减）'
            }}
          </div>
          <div class="text-[var(--app-text-muted)]">命中规则</div>
          <div>
            {{ refundPreview.policyName ?? '未命中规则（按 100% 退）'
            }}{{
              refundPreview.hoursBefore !== null
                ? `（提前 ${refundPreview.hoursBefore} 小时）`
                : ''
            }}
          </div>
          <div class="text-[var(--app-text-muted)]">退款比例</div>
          <div class="tabular-nums">
            {{ (refundPreview.refundPermille / 10).toFixed(1) }}%
          </div>
          <div class="text-[var(--app-text-muted)]">已收 / 已退</div>
          <div class="tabular-nums">
            {{ money(refundPreview.paidAmount) }} /
            {{ money(refundPreview.refundedAmount) }}
          </div>
          <div class="text-[var(--app-text-muted)]">可退 / 建议退款</div>
          <div class="tabular-nums">
            {{ money(refundPreview.refundableAmount) }} /
            <span class="font-600">{{
              money(refundPreview.suggestAmount)
            }}</span>
          </div>
          <div class="text-[var(--app-text-muted)]">判责扣减</div>
          <div class="tabular-nums">
            {{ money(refundPreview.deductAmount) }}
          </div>
        </div>

        <LewTable
          v-if="refundPreview.payments.length"
          :data-source="refundPreview.payments"
          :focusable="false"
          size="small"
          :columns="[
            { title: '支付单号', field: 'paymentNo', width: 170 },
            { title: '渠道', field: 'channel', width: 130 },
            {
              title: '支付金额',
              field: 'amount',
              width: 110,
              customRender: ({ row }) =>
                money((row as unknown as { amount: number }).amount),
            },
            {
              title: '可退',
              field: 'refundableAmount',
              width: 110,
              customRender: ({ row }) =>
                money(
                  (row as unknown as { refundableAmount: number })
                    .refundableAmount,
                ),
            },
          ]"
        />

        <div class="flex flex-wrap items-center gap-3">
          <span class="text-13px text-[var(--app-text-secondary)]"
            >退款金额（元）</span
          >
          <LewInputNumber
            v-model="refundForm.amountYuan"
            width="150px"
            :min="0"
            placeholder="默认取建议值"
          />
          <span class="text-12.5px text-[var(--app-text-muted)]"
            >可改，但必须填原因</span
          >
        </div>
        <div class="flex flex-wrap items-center gap-3">
          <span class="text-13px text-[var(--app-text-secondary)]"
            >退款去向</span
          >
          <LewSelect
            v-model="refundForm.mode"
            width="160px"
            :options="[
              { label: '原路退回（仅在线支付）', value: 'original' },
              { label: '现金退款', value: 'cash' },
              { label: '退入储值余额', value: 'balance' },
            ]"
          />
          <span class="text-13px text-[var(--app-text-secondary)]">判责</span>
          <LewSelect
            v-model="refundForm.liable"
            width="160px"
            :options="[
              { label: '顾客责任', value: 'customer' },
              { label: '门店责任', value: 'store' },
              { label: '不可抗力', value: 'force_majeure' },
            ]"
          />
        </div>
        <LewInput
          v-model="refundForm.reason"
          width="100%"
          placeholder="退款原因（必填）"
          :max-length="200"
          show-count
          clearable
        />
        <LewInput
          v-model="refundForm.remark"
          width="100%"
          placeholder="备注（选填）"
          clearable
        />
      </div>
      <div v-else class="p-5 text-13px text-[var(--app-text-muted)]">
        {{ refundLoading ? '正在试算判责…' : '暂无数据' }}
      </div>
    </LewModal>

    <!-- 冲突清单（创建 / 改期的顾客软拦） -->
    <LewModal
      v-model:visible="createConflictVisible"
      title="该顾客此时段已有预约"
      width="640px"
      :footer-buttons="createConflictFooter"
    >
      <div class="flex flex-col gap-3 p-5">
        <div
          class="flex items-start gap-2 rounded-8px border border-[var(--lew-color-warning)] p-3 text-13px"
        >
          <AlertTriangle :size="16" class="mt-0.5 shrink-0" />
          <div>
            <div class="font-600">{{ createConflictMessage }}</div>
            <div class="mt-1 text-[var(--app-text-secondary)]">
              这通常意味着重复录入。若确实需要一位顾客同时做多个项目（由不同美甲师分别操作），
              可确认后强制创建。
            </div>
          </div>
        </div>
        <LewTable
          :data-source="createConflictList"
          :focusable="false"
          size="small"
          :columns="[
            { title: '单号', field: 'bookingNo', width: 170 },
            {
              title: '开始',
              field: 'startAt',
              width: 170,
              customRender: ({ row }) =>
                formatDateTime((row as unknown as BookingConflictItem).startAt),
            },
            {
              title: '结束',
              field: 'endAt',
              width: 170,
              customRender: ({ row }) =>
                formatDateTime((row as unknown as BookingConflictItem).endAt),
            },
          ]"
        />
      </div>
    </LewModal>
  </div>
</template>
