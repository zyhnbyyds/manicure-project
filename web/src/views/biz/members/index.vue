<script setup lang="ts">
import { computed, h, nextTick, ref, shallowRef } from 'vue';
import {
  Calculator,
  Coins,
  RefreshCw,
  RotateCcw,
  ScrollText,
  SlidersHorizontal,
  Ticket,
  TicketPercent,
  UserPlus,
  Wallet,
} from 'lucide-vue-next';
import {
  LewButton,
  LewDrawer,
  LewForm,
  LewInput,
  LewMessage,
  LewModal,
  LewPagination,
  LewSelect,
  LewTable,
  LewTabs,
} from 'lew-ui';
import type {
  LewFormOption,
  LewTableColumn,
  LewTabsOption,
} from 'lew-ui';
import { withPassThroughRule } from '~/utils/form';
import type { PageResult } from '~/types/api';
import {
  adjustMember,
  enrollMember,
  getMember,
  listCustomerBookings,
  listMemberTransactions,
  recountMember,
  rechargeMember,
  refundMember,
  type CustomerBookingBrief,
  type Member,
  type MemberDetail,
  type MemberTransaction,
  type RechargeChannel,
} from '~/api/biz/members';
import {
  issueMemberCard,
  listMemberCards,
  type MemberCard,
} from '~/api/biz/member-cards';
import { listActiveMemberLevels } from '~/api/biz/member-levels';
import {
  listActiveRechargePlans,
  type RechargePlan,
} from '~/api/biz/recharge-plans';
import {
  listActiveCardTypes,
  listServiceItemOptions,
  type CardType,
  type ServiceItemOption,
} from '~/api/biz/card-types';
import {
  listPointsGoods,
  previewPoints,
  redeemPoints,
  type PointsGoods,
  type PointsPreview,
} from '~/api/biz/points-goods';
import {
  issueCouponToMember,
  listActiveCouponTemplates,
} from '~/api/biz/coupons';
import { formatDateTime } from '~/composables/useFormat';
import { useTable } from '~/composables/useTable';
import { confirmDanger } from '~/utils/confirm';
import IconButton from '~/components/IconButton.vue';

// ---------- 金额换算（接口单位「分」，展示「元」） ----------
function fen2yuan(fen: number | null | undefined): string {
  if (fen === null || fen === undefined) return '0.00';
  return (fen / 100).toFixed(2);
}

function yuan2fen(yuan: number | null | undefined): number {
  const value = Number(yuan ?? 0);
  return Number.isFinite(value) ? Math.round(value * 100) : 0;
}

/** 折扣率千分比 → 「9.5 折」 */
function discountText(permille: number | null | undefined): string {
  if (!permille || permille >= 1000) return '不打折';
  return `${(permille / 100).toFixed(1)} 折`;
}

// 等级信息在两个接口里的形状不同，这里统一取值（对齐后端真实字段）：
// - 列表 `GET /biz/members` → 扁平 levelName / levelDiscountPermille
// - 详情 `GET /biz/members/:id` → 嵌套 level: { id, name, discountPermille, upgradeAmount }
type MemberLevelView = Member | MemberDetail | null | undefined;

/** 等级名（非会员返回 null） */
function memberLevelName(member: MemberLevelView): string | null {
  if (!member || member.levelId === null) return null;
  return member.levelName ?? (member as MemberDetail).level?.name ?? null;
}

/** 折扣率千分比（非会员返回 null） */
function memberDiscountPermille(member: MemberLevelView): number | null {
  if (!member || member.levelId === null) return null;
  return (
    member.levelDiscountPermille ??
    (member as MemberDetail).level?.discountPermille ??
    null
  );
}

// ---------- 抽屉内的子列表分页（接口无 total，多取一条判 hasMore） ----------
function createPager<T extends { id: number }>(
  fetcher: (page: number, pageSize: number) => Promise<PageResult<T>>,
  size = 10,
) {
  const items = shallowRef<T[]>([]);
  const loading = ref(false);
  const currentPage = ref(1);
  const pageSize = ref(size);
  const hasMore = ref(false);
  const total = computed(() =>
    hasMore.value
      ? currentPage.value * pageSize.value + 1
      : (currentPage.value - 1) * pageSize.value + items.value.length,
  );

  async function load(page = currentPage.value) {
    loading.value = true;
    try {
      // 多取一条用于判断 hasMore
      const data = await fetcher(page, pageSize.value + 1);
      items.value = data.items.slice(0, pageSize.value);
      hasMore.value = data.items.length > pageSize.value;
      currentPage.value = page;
    } finally {
      loading.value = false;
    }
  }

  function handleChange(data: { currentPage: number; pageSize: number }) {
    pageSize.value = data.pageSize;
    return load(data.currentPage);
  }

  function reset() {
    currentPage.value = 1;
    return load(1);
  }

  return {
    items,
    loading,
    currentPage,
    pageSize,
    total,
    load,
    handleChange,
    reset,
  };
}

// ---------- 列表 ----------
const query = ref<{
  keyword?: string;
  levelId?: string;
  hasBalance?: string;
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
} = useTable<Member>({ url: '/biz/members', query: () => query.value });

const hasBalanceOptions = [{ label: '仅看有储值余额', value: 'true' }];

const levelOptions = shallowRef<{ label: string; value: string }[]>([]);
async function loadLevels() {
  const levels = await listActiveMemberLevels();
  levelOptions.value = levels.map((level) => ({
    label: `${level.name}（${discountText(level.discountPermille)}）`,
    value: String(level.id),
  }));
}
void loadLevels();

const columns: LewTableColumn[] = [
  { title: 'ID', field: 'id', width: 70 },
  {
    title: '会员号',
    field: 'memberNo',
    width: 150,
    customRender: ({ row }) => (row as unknown as Member).memberNo ?? '散客',
  },
  { title: '姓名', field: 'name', width: 110 },
  { title: '手机号', field: 'phone', width: 130 },
  {
    title: '等级',
    field: 'levelName',
    width: 110,
    customRender: ({ row }) => {
      const member = row as unknown as Member;
      if (member.levelId === null)
        return h('span', { class: 'text-[var(--app-text-muted)]' }, '非会员');
      return memberLevelName(member) ?? `#${member.levelId}`;
    },
  },
  {
    title: '折扣',
    field: 'levelDiscountPermille',
    width: 90,
    customRender: ({ row }) =>
      discountText(memberDiscountPermille(row as unknown as Member)),
  },
  {
    title: '储值余额(元)',
    field: 'balancePrincipal',
    width: 130,
    customRender: ({ row }) => {
      const member = row as unknown as Member;
      const principal = member.balancePrincipal ?? 0;
      const bonus = member.balanceBonus ?? 0;
      return h(
        'span',
        {
          class: 'cursor-default',
          title: `本金 ¥${fen2yuan(principal)} / 赠送 ¥${fen2yuan(bonus)}（赠送不可退）`,
        },
        `¥${fen2yuan(principal + bonus)}`,
      );
    },
  },
  {
    title: '积分',
    field: 'points',
    width: 90,
    customRender: ({ row }) => String((row as unknown as Member).points ?? 0),
  },
  {
    title: '累计消费(元)',
    field: 'totalSpent',
    width: 130,
    customRender: ({ row }) =>
      `¥${fen2yuan((row as unknown as Member).totalSpent)}`,
  },
  {
    title: '到店次数',
    field: 'visitCount',
    width: 100,
    customRender: ({ row }) =>
      String((row as unknown as Member).visitCount ?? 0),
  },
  {
    title: '入会时间',
    field: 'memberSince',
    width: 170,
    customRender: ({ row }) =>
      formatDateTime((row as unknown as Member).memberSince),
  },
  { title: '操作', field: 'operation', width: 100, fixed: 'right' },
];

void search();

// ---------- 详情抽屉 ----------
const drawerVisible = ref(false);
const detailLoading = ref(false);
const detail = ref<MemberDetail | null>(null);
const activeTab = ref('profile');

const tabOptions: LewTabsOption[] = [
  { label: '档案', value: 'profile' },
  { label: '账务流水', value: 'transactions' },
  { label: '次卡', value: 'cards' },
  { label: '预约历史', value: 'bookings' },
];

const {
  items: txnItems,
  loading: txnLoading,
  currentPage: txnPage,
  pageSize: txnPageSize,
  total: txnTotal,
  handleChange: txnHandleChange,
  reset: txnReset,
} = createPager<MemberTransaction>((page, size) =>
  listMemberTransactions(detail.value?.id ?? 0, page, size),
);

const {
  items: bookingItems,
  loading: bookingLoading,
  currentPage: bookingPage,
  pageSize: bookingPageSize,
  total: bookingTotal,
  handleChange: bookingHandleChange,
  reset: bookingReset,
} = createPager<CustomerBookingBrief>((page, size) =>
  listCustomerBookings(detail.value?.id ?? 0, page, size),
);

const cards = shallowRef<MemberCard[]>([]);
const cardsLoading = ref(false);
async function loadCards() {
  const id = detail.value?.id;
  if (!id) {
    cards.value = [];
    return;
  }
  cardsLoading.value = true;
  try {
    const data = await listMemberCards(1, 100, { customerId: id });
    cards.value = data.items;
  } finally {
    cardsLoading.value = false;
  }
}

async function reloadDetail() {
  const id = detail.value?.id;
  if (!id) return;
  detail.value = await getMember(id);
}

async function openDetail(row: Member) {
  drawerVisible.value = true;
  activeTab.value = 'profile';
  detail.value = row;
  detailLoading.value = true;
  try {
    detail.value = await getMember(row.id);
  } catch {
    // 错误提示已由请求拦截器统一处理，这里保留列表行的降级数据
  } finally {
    detailLoading.value = false;
  }
  await Promise.all([txnReset(), bookingReset(), loadCards()]);
}

/** 列表行「充值」：先打开详情抽屉（拿到最新账务），再弹出充值弹窗 */
async function handleRowRecharge(row: Member) {
  await openDetail(row);
  await openRecharge();
}

// ---------- 发券（权限 biz:member:coupon）----------
const couponVisible = ref(false);
const couponMember = ref<Member | null>(null);
const couponFormRef = ref();
const couponFormKey = ref(0);
const couponForm = ref({ templateId: undefined as number | undefined });
const templateOptions = reactive<{ label: string; value: number }[]>([]);

/** 券模板下拉：只列启用中的（停用的服务端也会拒 409，没必要让运营选到） */
async function loadTemplateOptions() {
  const page = await listActiveCouponTemplates();
  templateOptions.splice(
    0,
    templateOptions.length,
    ...page.items.map((tpl) => {
      const threshold =
        tpl.thresholdAmount > 0
          ? `满 ${(tpl.thresholdAmount / 100).toFixed(2)} 元`
          : '无门槛';
      return {
        label: `${tpl.name}（${threshold}减 ${(tpl.discountAmount / 100).toFixed(2)} 元）`,
        value: tpl.id,
      };
    }),
  );
}

const couponFormOptions: LewFormOption[] = withPassThroughRule([
  {
    field: 'templateId',
    label: '券模板',
    as: 'select',
    rule: "Yup.number().required('请选择券模板')",
    props: { options: templateOptions, placeholder: '选择要发放的券' },
  },
]);

async function openCoupon(row: Member) {
  await loadTemplateOptions();
  couponMember.value = row;
  couponFormKey.value += 1;
  couponVisible.value = true;
  void nextTick(() => {
    couponFormRef.value?.setForm?.({ templateId: undefined });
  });
}

/**
 * 发券。
 *
 * 服务端**允许重复发放**（补偿/补发是正常诉求），所以这里不做任何去重提示；
 * 发完提示「可在会员详情核对」，运营点开详情就能看到。
 */
async function submitCoupon() {
  const valid = await couponFormRef.value?.validate();
  if (!valid) return;
  const values = couponFormRef.value?.getForm?.() ?? couponForm.value;
  if (!values.templateId || !couponMember.value) return;
  await issueCouponToMember(couponMember.value.id, values.templateId);
  LewMessage.success('发券成功（可在会员详情核对）');
  couponVisible.value = false;
  await refresh();
}
// ---------- 子表格渲染 ----------
const TXN_TYPE_TEXT: Record<string, string> = {
  recharge: '充值',
  consume: '消费',
  refund: '退款',
  card_buy: '购卡',
  card_use: '次卡核销',
  card_revert: '撤销核销',
  points_earn: '积分累计',
  points_spend: '积分抵扣',
  points_redeem: '积分兑换',
  level_change: '等级变更',
  adjust: '手工调整',
};

const CARD_STATUS_TEXT: Record<string, { text: string; class: string }> = {
  active: { text: '生效中', class: 'text-[var(--lew-color-success)]' },
  used_up: { text: '已用完', class: 'text-[var(--app-text-muted)]' },
  expired: { text: '已过期', class: 'text-[var(--lew-color-warning)]' },
  refunded: { text: '已退卡', class: 'text-[var(--lew-color-error)]' },
};

const BOOKING_STATUS_TEXT: Record<string, { text: string; class: string }> = {
  pending: { text: '待确认', class: 'text-[var(--lew-color-warning)]' },
  confirmed: { text: '已确认', class: 'text-[var(--lew-color-primary)]' },
  arrived: { text: '已到店', class: 'text-[var(--lew-color-primary)]' },
  completed: { text: '已完成', class: 'text-[var(--lew-color-success)]' },
  cancelled: { text: '已取消', class: 'text-[var(--app-text-muted)]' },
  no_show: { text: '爽约', class: 'text-[var(--lew-color-error)]' },
};

const PAY_STATUS_TEXT: Record<string, { text: string; class: string }> = {
  unpaid: { text: '未收款', class: 'text-[var(--lew-color-error)]' },
  partial: { text: '待收尾款', class: 'text-[var(--lew-color-warning)]' },
  paid: { text: '已结清', class: 'text-[var(--lew-color-success)]' },
  refunded: { text: '已退款', class: 'text-[var(--lew-color-error)]' },
  credit: { text: '挂账', class: 'text-[var(--lew-color-primary)]' },
};

function renderMapped(
  map: Record<string, { text: string; class: string }>,
  key: string,
) {
  const hit = map[key];
  return h('span', { class: hit?.class ?? '' }, hit?.text ?? key);
}

const txnColumns: LewTableColumn[] = [
  { title: 'ID', field: 'id', width: 70 },
  {
    title: '类型',
    field: 'type',
    width: 110,
    customRender: ({ row }) =>
      TXN_TYPE_TEXT[(row as unknown as MemberTransaction).type] ??
      (row as unknown as MemberTransaction).type,
  },
  {
    title: '业务金额(元)',
    field: 'amount',
    width: 120,
    customRender: ({ row }) =>
      fen2yuan((row as unknown as MemberTransaction).amount),
  },
  {
    title: '本金变动(元)',
    field: 'balanceDeltaPrincipal',
    width: 130,
    customRender: ({ row }) =>
      fen2yuan((row as unknown as MemberTransaction).balanceDeltaPrincipal),
  },
  {
    title: '赠送变动(元)',
    field: 'balanceDeltaBonus',
    width: 130,
    customRender: ({ row }) =>
      fen2yuan((row as unknown as MemberTransaction).balanceDeltaBonus),
  },
  {
    title: '积分变动',
    field: 'pointsDelta',
    width: 100,
    customRender: ({ row }) =>
      String((row as unknown as MemberTransaction).pointsDelta ?? 0),
  },
  {
    title: '收付方式',
    field: 'payChannel',
    width: 100,
    customRender: ({ row }) =>
      (row as unknown as MemberTransaction).payChannel ?? '-',
  },
  {
    title: '备注',
    field: 'remark',
    customRender: ({ row }) =>
      (row as unknown as MemberTransaction).remark ?? '-',
  },
  {
    title: '时间',
    field: 'createdAt',
    width: 170,
    customRender: ({ row }) =>
      formatDateTime((row as unknown as MemberTransaction).createdAt),
  },
];

const cardColumns: LewTableColumn[] = [
  { title: 'ID', field: 'id', width: 70 },
  { title: '卡号', field: 'cardNo', width: 160 },
  { title: '卡种', field: 'cardName', width: 150 },
  {
    title: '总次数',
    field: 'totalTimes',
    width: 80,
    customRender: ({ row }) =>
      String((row as unknown as MemberCard).totalTimes),
  },
  {
    title: '已核销',
    field: 'usedTimes',
    width: 80,
    customRender: ({ row }) => String((row as unknown as MemberCard).usedTimes),
  },
  {
    title: '剩余',
    field: 'remainTimes',
    width: 80,
    customRender: ({ row }) => {
      const card = row as unknown as MemberCard;
      return String(card.remainTimes ?? card.totalTimes - card.usedTimes);
    },
  },
  {
    title: '售价(元)',
    field: 'price',
    width: 100,
    customRender: ({ row }) => fen2yuan((row as unknown as MemberCard).price),
  },
  {
    title: '到期时间',
    field: 'expireAt',
    width: 170,
    customRender: ({ row }) => {
      const expireAt = (row as unknown as MemberCard).expireAt;
      return expireAt ? formatDateTime(expireAt) : '永久';
    },
  },
  {
    title: '状态',
    field: 'status',
    width: 100,
    customRender: ({ row }) =>
      renderMapped(CARD_STATUS_TEXT, (row as unknown as MemberCard).status),
  },
];

const bookingColumns: LewTableColumn[] = [
  { title: 'ID', field: 'id', width: 70 },
  { title: '预约号', field: 'bookingNo', width: 160 },
  {
    title: '开始时间',
    field: 'startAt',
    width: 170,
    customRender: ({ row }) =>
      formatDateTime((row as unknown as CustomerBookingBrief).startAt),
  },
  {
    title: '状态',
    field: 'status',
    width: 100,
    customRender: ({ row }) =>
      renderMapped(
        BOOKING_STATUS_TEXT,
        (row as unknown as CustomerBookingBrief).status,
      ),
  },
  {
    title: '项目',
    field: 'itemNames',
    customRender: ({ row }) => {
      const booking = row as unknown as CustomerBookingBrief;
      // 后端实际返回 items[]（biz_booking_item 投影），itemNames 仅作兼容
      const names =
        booking.itemNames ??
        booking.serviceItems?.map((item) => item.name).join('、') ??
        booking.items?.map((item) => item.name).join('、');
      return names || '-';
    },
  },
  {
    title: '应付(元)',
    field: 'payableAmount',
    width: 110,
    customRender: ({ row }) =>
      fen2yuan((row as unknown as CustomerBookingBrief).payableAmount),
  },
  {
    title: '已收(元)',
    field: 'paidAmount',
    width: 110,
    customRender: ({ row }) =>
      fen2yuan((row as unknown as CustomerBookingBrief).paidAmount),
  },
  {
    title: '尾款(元)',
    field: 'dueAmount',
    width: 110,
    customRender: ({ row }) =>
      fen2yuan((row as unknown as CustomerBookingBrief).dueAmount),
  },
  {
    title: '资金状态',
    field: 'payStatus',
    width: 110,
    customRender: ({ row }) =>
      renderMapped(
        PAY_STATUS_TEXT,
        (row as unknown as CustomerBookingBrief).payStatus,
      ),
  },
];

// ---------- 充值（实付与赠送分开展示） ----------
const rechargeVisible = ref(false);
const rechargeFormKey = ref(0);
const rechargeFormRef = ref();
const rechargeForm = ref({
  planId: undefined as string | undefined,
  payAmount: 0,
  payChannel: 'cash',
  remark: '',
});
/**
 * LewForm 是受控组件：内部维护自己的 formData，**不会**通过 v-model 回写父级。
 * 需要实时预览的字段必须靠 `@change`（LewForm 会在字段变化后带上完整表单数据派发）同步到本地副本。
 * 提交时仍以 getForm() 为准。
 */
function onRechargeChange(values: unknown) {
  rechargeForm.value = {
    ...rechargeForm.value,
    ...(values as Partial<typeof rechargeForm.value>),
  };
}
const rechargePlans = shallowRef<RechargePlan[]>([]);
const rechargePlanOptions = computed(() =>
  rechargePlans.value.map((plan) => ({
    label: `${plan.name}（实付 ¥${fen2yuan(plan.payAmount)}，赠 ¥${fen2yuan(plan.bonusAmount)}）`,
    value: String(plan.id),
  })),
);
const rechargeChannelOptions = [
  { label: '现金', value: 'cash' },
  { label: '微信（记账）', value: 'wechat' },
  { label: '微信线下收款码', value: 'wechat_offline' },
  { label: '支付宝（记账）', value: 'alipay' },
  { label: '支付宝线下收款码', value: 'alipay_offline' },
];

/** 弹窗内实时预览：实付 / 赠送分开 */
const rechargePreview = computed(() => {
  const plan = rechargePlans.value.find(
    (item) => String(item.id) === rechargeForm.value.planId,
  );
  if (plan) return { pay: plan.payAmount, bonus: plan.bonusAmount };
  return { pay: yuan2fen(rechargeForm.value.payAmount), bonus: 0 };
});

async function openRecharge() {
  if (!detail.value) return;
  if (!rechargePlans.value.length) {
    try {
      rechargePlans.value = await listActiveRechargePlans();
    } catch {
      // 提示已由拦截器处理，不阻断弹窗
    }
  }
  rechargeFormKey.value += 1;
  rechargeVisible.value = true;
  void nextTick(() => {
    rechargeFormRef.value?.setForm?.({
      planId: undefined,
      payAmount: 0,
      payChannel: 'cash',
      remark: '',
    });
  });
}

async function submitRecharge() {
  const id = detail.value?.id;
  if (!id) return;
  const valid = await rechargeFormRef.value?.validate();
  if (!valid) return;
  const values = (rechargeFormRef.value?.getForm?.() ??
    rechargeForm.value) as typeof rechargeForm.value;
  const planId = values.planId ? Number(values.planId) : undefined;
  const payAmount = planId ? undefined : yuan2fen(values.payAmount);
  if (!planId && (!payAmount || payAmount <= 0)) {
    LewMessage.error('请选择充值方案，或填写大于 0 的自定义实付金额');
    return;
  }
  if (!values.remark?.trim()) {
    LewMessage.error('请填写充值备注');
    return;
  }
  const pay = rechargePreview.value.pay;
  const bonus = rechargePreview.value.bonus;
  confirmDanger({
    type: 'normal',
    title: '充值确认',
    content: `实付 ¥${fen2yuan(pay)}，赠送 ¥${fen2yuan(bonus)}。赠送金额不可退、不可提现，且赠送比例上限为 20%。确定充值吗？`,
    confirmText: '确认充值',
    confirmColor: 'primary',
    onConfirm: async () => {
      await rechargeMember(id, {
        planId,
        payAmount,
        payChannel: values.payChannel as RechargeChannel,
        remark: values.remark,
      });
      LewMessage.success('充值成功');
      rechargeVisible.value = false;
      await reloadDetail();
      void refresh();
    },
  });
}

// ---------- 冲正退款（§15.4 / §9.6） ----------
// 后端 `POST /biz/members/:id/refund` 的 mode 语义（见 MemberAccountsService.refundMember）：
//   cash    → 只写一笔 `adjust` 冲正流水（amount），**不改动储值余额**（现金退给顾客）
//   balance → 按 bonusDeductMode 顺序**从储值余额扣减** amount，并写负数 delta 流水
// 两者都不产生退款审批单，与 §15.4「走退款单 + 审批」的写法不一致（见交付说明）。
const refundVisible = ref(false);
const refundFormKey = ref(0);
const refundFormRef = ref();
const refundForm = ref({ amount: 0, mode: 'cash', reason: '' });
const refundModeOptions = [
  { label: '现金冲正（写流水，不改动储值余额）', value: 'cash' },
  { label: '储值冲正（从储值余额扣回）', value: 'balance' },
];

function openRefund() {
  if (!detail.value) return;
  const amount = Number(fen2yuan(detail.value.balancePrincipal));
  refundFormKey.value += 1;
  refundVisible.value = true;
  void nextTick(() => {
    refundFormRef.value?.setForm?.({
      amount,
      mode: 'cash',
      reason: '',
    });
  });
}

async function submitRefund() {
  const id = detail.value?.id;
  if (!id) return;
  const valid = await refundFormRef.value?.validate();
  if (!valid) return;
  const values = (refundFormRef.value?.getForm?.() ??
    refundForm.value) as typeof refundForm.value;
  const amount = yuan2fen(values.amount);
  const principal = detail.value?.balancePrincipal ?? 0;
  const available = principal + (detail.value?.balanceBonus ?? 0);
  if (amount <= 0) {
    LewMessage.error('冲正金额必须大于 0');
    return;
  }
  // 现金冲正不动余额，但业务上只应退实付本金（赠送不退、余额不可提现）
  if (values.mode === 'cash' && amount > principal) {
    LewMessage.error(
      `现金冲正不得超过实付本金余额 ¥${fen2yuan(principal)}（赠送余额不可退、不可提现）`,
    );
    return;
  }
  // 储值冲正是从余额扣减，余额不足后端会 409，这里先挡一层
  if (values.mode === 'balance' && amount > available) {
    LewMessage.error(
      `储值冲正不得超过当前储值余额 ¥${fen2yuan(available)}（本金 + 赠送）`,
    );
    return;
  }
  if (!values.reason?.trim()) {
    LewMessage.error('冲正原因必填');
    return;
  }
  const isCash = values.mode === 'cash';
  confirmDanger({
    title: '冲正退款确认',
    content: isCash
      ? `将记录一笔现金冲正 ¥${fen2yuan(amount)}（写反向流水，**不改变储值余额**）。确定提交吗？`
      : `将从储值余额扣回 ¥${fen2yuan(amount)}（按赠送优先顺序扣减，余额不足会直接失败）并写反向流水。确定提交吗？`,
    confirmText: '确认冲正',
    onConfirm: async () => {
      await refundMember(id, {
        amount,
        mode: values.mode as 'cash' | 'balance',
        reason: values.reason,
      });
      LewMessage.success(
        isCash
          ? '现金冲正已记录（余额未变动）'
          : '储值冲正成功，余额与流水已更新',
      );
      refundVisible.value = false;
      await reloadDetail();
      void refresh();
    },
  });
}

// ---------- 手工调级 / 调积分 ----------
const adjustVisible = ref(false);
const adjustFormKey = ref(0);
const adjustFormRef = ref();
const adjustForm = ref({
  levelId: undefined as string | undefined,
  pointsDelta: 0,
  reason: '',
});

function openAdjust() {
  if (!detail.value) return;
  adjustFormKey.value += 1;
  adjustVisible.value = true;
  void nextTick(() => {
    adjustFormRef.value?.setForm?.({
      levelId: detail.value?.levelId ? String(detail.value.levelId) : undefined,
      pointsDelta: 0,
      reason: '',
    });
  });
}

async function submitAdjust() {
  const id = detail.value?.id;
  if (!id) return;
  const valid = await adjustFormRef.value?.validate();
  if (!valid) return;
  const values = (adjustFormRef.value?.getForm?.() ??
    adjustForm.value) as typeof adjustForm.value;
  // 后端语义：levelId !== undefined 即视为一次「调级」（会写 level_change 流水）。
  // 弹窗里预填了当前等级，所以只有真的改了等级才发送，避免产生无意义的调级流水。
  const currentLevelId = detail.value?.levelId ?? null;
  const pickedLevelId = values.levelId ? Number(values.levelId) : undefined;
  const levelId =
    pickedLevelId === undefined || pickedLevelId === currentLevelId
      ? undefined
      : pickedLevelId;
  const pointsDelta = Number(values.pointsDelta ?? 0);
  if (levelId === undefined && !pointsDelta) {
    LewMessage.error('请选择目标等级或填写积分增减量');
    return;
  }
  if (!values.reason?.trim()) {
    LewMessage.error('调整原因必填');
    return;
  }
  confirmDanger({
    type: 'normal',
    title: '手工调整确认',
    content: '手工调级会写 level_change 流水，且会被「重算」覆盖。确定提交吗？',
    confirmText: '确认调整',
    confirmColor: 'primary',
    onConfirm: async () => {
      await adjustMember(id, { levelId, pointsDelta, reason: values.reason });
      LewMessage.success('调整成功');
      adjustVisible.value = false;
      await reloadDetail();
      void refresh();
    },
  });
}

// ---------- 重算 ----------
function handleRecount() {
  const id = detail.value?.id;
  if (!id) return;
  confirmDanger({
    type: 'normal',
    title: '重算确认',
    content:
      '将按账务流水重算储值余额、积分、累计消费与等级（对账修复）。重算会覆盖手工调级结果，确定继续吗？',
    confirmText: '开始重算',
    confirmColor: 'primary',
    onConfirm: async () => {
      await recountMember(id, {});
      LewMessage.success('重算完成');
      await reloadDetail();
      void refresh();
    },
  });
}

// ---------- 纳为会员 ----------
const enrollVisible = ref(false);
const enrollFormKey = ref(0);
const enrollFormRef = ref();
const enrollForm = ref({ customerId: undefined as number | undefined });

function openEnroll(customerId?: number) {
  enrollFormKey.value += 1;
  enrollVisible.value = true;
  void nextTick(() => {
    enrollFormRef.value?.setForm?.({ customerId: customerId ?? undefined });
  });
}

async function submitEnroll() {
  const valid = await enrollFormRef.value?.validate();
  if (!valid) return;
  const values = (enrollFormRef.value?.getForm?.() ??
    enrollForm.value) as typeof enrollForm.value;
  const customerId = Number(values.customerId ?? 0);
  if (!customerId) {
    LewMessage.error('请填写顾客 ID');
    return;
  }
  confirmDanger({
    type: 'normal',
    title: '纳为会员',
    content: `将把顾客 #${customerId} 纳为会员（建会员号、置入会时间）。手机号是会员的必填锚点，顾客必须有手机号。确定继续吗？`,
    confirmText: '确认入会',
    confirmColor: 'primary',
    onConfirm: async () => {
      await enrollMember({ customerId });
      LewMessage.success('已纳为会员');
      enrollVisible.value = false;
      await reloadDetail();
      void refresh();
    },
  });
}

// ---------- 发卡 ----------
const issueVisible = ref(false);
const issueFormKey = ref(0);
const issueFormRef = ref();
const issueForm = ref({
  cardTypeId: undefined as string | undefined,
  payChannel: 'cash',
  price: 0,
  remark: '',
});
/** 同充值弹窗：靠 @change 同步本地副本，只用于实时展示卡种默认售价 */
function onIssueChange(values: unknown) {
  issueForm.value = {
    ...issueForm.value,
    ...(values as Partial<typeof issueForm.value>),
  };
}
const cardTypes = shallowRef<CardType[]>([]);
const cardTypeOptions = computed(() =>
  cardTypes.value.map((type) => ({
    label: `${type.name}（售价 ¥${fen2yuan(type.price)} / ${type.totalTimes} 次）`,
    value: String(type.id),
  })),
);
const cardPayChannelOptions = [
  { label: '现金', value: 'cash' },
  { label: '微信', value: 'wechat' },
  { label: '支付宝', value: 'alipay' },
  { label: '储值余额', value: 'balance' },
];
const issueSelectedCardType = computed(() =>
  cardTypes.value.find(
    (type) => String(type.id) === issueForm.value.cardTypeId,
  ),
);

async function openIssueCard() {
  if (!detail.value) return;
  if (!cardTypes.value.length) {
    try {
      cardTypes.value = await listActiveCardTypes();
    } catch {
      // 提示已由拦截器处理
    }
  }
  issueFormKey.value += 1;
  issueVisible.value = true;
  void nextTick(() => {
    issueFormRef.value?.setForm?.({
      cardTypeId: undefined,
      payChannel: 'cash',
      price: 0,
      remark: '',
    });
  });
}

async function submitIssueCard() {
  const id = detail.value?.id;
  if (!id) return;
  const valid = await issueFormRef.value?.validate();
  if (!valid) return;
  const values = (issueFormRef.value?.getForm?.() ??
    issueForm.value) as typeof issueForm.value;
  if (!values.cardTypeId) {
    LewMessage.error('请选择卡种');
    return;
  }
  const price = yuan2fen(values.price);
  confirmDanger({
    type: 'normal',
    title: '发卡确认',
    content: `将按 ¥${fen2yuan(price || (issueSelectedCardType.value?.price ?? 0))} 收款并立即发放次卡（购卡会累计消费与积分）。确定发卡吗？`,
    confirmText: '确认发卡',
    confirmColor: 'primary',
    onConfirm: async () => {
      await issueMemberCard({
        customerId: id,
        cardTypeId: Number(values.cardTypeId),
        payChannel: values.payChannel as
          | 'cash'
          | 'wechat'
          | 'alipay'
          | 'balance',
        price: price > 0 ? price : undefined,
        remark: values.remark || undefined,
      });
      LewMessage.success('发卡成功');
      issueVisible.value = false;
      await Promise.all([reloadDetail(), loadCards()]);
      void refresh();
    },
  });
}

// ---------- 积分兑换 ----------
const redeemVisible = ref(false);
const redeemFormKey = ref(0);
const redeemFormRef = ref();
const redeemForm = ref({
  goodsId: undefined as string | undefined,
  remark: '',
});
/** 同充值弹窗：靠 @change 同步本地副本，只用于实时展示所需积分 */
function onRedeemChange(values: unknown) {
  redeemForm.value = {
    ...redeemForm.value,
    ...(values as Partial<typeof redeemForm.value>),
  };
}
const pointsGoods = shallowRef<PointsGoods[]>([]);
const pointsGoodsOptions = computed(() =>
  pointsGoods.value.map((goods) => ({
    label: `${goods.name}（${goods.points} 分）`,
    value: String(goods.id),
  })),
);
const redeemSelectedGoods = computed(() =>
  pointsGoods.value.find(
    (goods) => String(goods.id) === redeemForm.value.goodsId,
  ),
);

async function openRedeem() {
  if (!detail.value) return;
  if (!pointsGoods.value.length) {
    try {
      const data = await listPointsGoods(1, 100, { status: 'active' });
      pointsGoods.value = data.items;
    } catch {
      // 提示已由拦截器处理
    }
  }
  redeemFormKey.value += 1;
  redeemVisible.value = true;
  void nextTick(() => {
    redeemFormRef.value?.setForm?.({ goodsId: undefined, remark: '' });
  });
}

async function submitRedeem() {
  const id = detail.value?.id;
  if (!id) return;
  const valid = await redeemFormRef.value?.validate();
  if (!valid) return;
  const values = (redeemFormRef.value?.getForm?.() ??
    redeemForm.value) as typeof redeemForm.value;
  if (!values.goodsId) {
    LewMessage.error('请选择兑换品');
    return;
  }
  const goods = redeemSelectedGoods.value;
  if (goods && (detail.value?.points ?? 0) < goods.points) {
    LewMessage.error(
      `积分不足：当前 ${detail.value?.points ?? 0} 分，需要 ${goods.points} 分`,
    );
    return;
  }
  confirmDanger({
    type: 'normal',
    title: '积分兑换确认',
    content: `将扣除 ${goods?.points ?? 0} 积分并发放一张次卡（同一事务完成，扣积分 + 发卡 + 写流水）。确定兑换吗？`,
    confirmText: '确认兑换',
    confirmColor: 'primary',
    onConfirm: async () => {
      await redeemPoints(id, {
        goodsId: Number(values.goodsId),
        remark: values.remark || undefined,
      });
      LewMessage.success('兑换成功，次卡已发放');
      redeemVisible.value = false;
      await Promise.all([reloadDetail(), loadCards()]);
      void refresh();
    },
  });
}

// ---------- 积分抵扣试算 ----------
const pointsPreviewVisible = ref(false);
const pointsPreviewFormKey = ref(0);
const pointsPreviewFormRef = ref();
const pointsPreviewForm = ref({ serviceItemIds: [] as string[] });
const serviceItems = shallowRef<ServiceItemOption[]>([]);
const serviceItemOptions = computed(() =>
  serviceItems.value.map((item) => ({
    label: item.name,
    value: String(item.id),
  })),
);
const pointsPreviewResult = ref<PointsPreview | null>(null);
const pointsPreviewLoading = ref(false);

async function openPointsPreview() {
  if (!detail.value) return;
  if (!serviceItems.value.length) {
    try {
      serviceItems.value = await listServiceItemOptions();
    } catch {
      // 提示已由拦截器处理
    }
  }
  pointsPreviewResult.value = null;
  pointsPreviewFormKey.value += 1;
  pointsPreviewVisible.value = true;
  void nextTick(() => {
    pointsPreviewFormRef.value?.setForm?.({ serviceItemIds: [] });
  });
}

async function submitPointsPreview() {
  const id = detail.value?.id;
  if (!id) return;
  const valid = await pointsPreviewFormRef.value?.validate();
  if (!valid) return;
  const values = (pointsPreviewFormRef.value?.getForm?.() ??
    pointsPreviewForm.value) as typeof pointsPreviewForm.value;
  const serviceItemIds = (values.serviceItemIds ?? []).map((item) =>
    Number(item),
  );
  if (!serviceItemIds.length) {
    LewMessage.error('请至少选择 1 个服务项目');
    return;
  }
  // 后端 zod 限制：serviceItemIds 为 1~3 个
  if (serviceItemIds.length > 3) {
    LewMessage.error('一次最多只能试算 3 个服务项目');
    return;
  }
  pointsPreviewLoading.value = true;
  try {
    pointsPreviewResult.value = await previewPoints({
      customerId: id,
      serviceItemIds,
    });
  } finally {
    pointsPreviewLoading.value = false;
  }
}

// 抽屉里展示用的只读字段
const balanceTotal = computed(
  () =>
    (detail.value?.balancePrincipal ?? 0) + (detail.value?.balanceBonus ?? 0),
);
</script>

<template>
  <div class="page-container">
    <!-- 页头 -->
    <div class="flex items-center justify-between">
      <div>
        <h2 class="page-title m-0">会员管理</h2>
        <p class="page-subtitle mt-1 mb-0">
          会员档案、账务流水、储值、积分与次卡（流水只读、不可修改删除）
        </p>
      </div>
      <LewButton
        v-permission="'biz:member:update'"
        type="fill"
        @click="openEnroll()"
      >
        <UserPlus :size="15" style="margin-right: 4px" /> 纳为会员
      </LewButton>
    </div>

    <!-- 搜索栏 -->
    <div class="app-card flex flex-wrap items-center gap-3 p-4">
      <LewInput
        v-model="query.keyword"
        width="220px"
        placeholder="姓名 / 手机号 / 会员号"
        clearable
      />
      <LewSelect
        v-model="query.levelId"
        width="180px"
        :options="levelOptions"
        placeholder="全部等级"
        clearable
      />
      <LewSelect
        v-model="query.hasBalance"
        width="170px"
        :options="hasBalanceOptions"
        placeholder="不限余额"
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
              title="会员详情"
              @click="openDetail(row as unknown as Member)"
            >
              <ScrollText :size="14" />
            </IconButton>
            <IconButton
              permission="biz:member:recharge"
              title="充值"
              @click="handleRowRecharge(row as unknown as Member)"
            >
              <Wallet :size="14" />
            </IconButton><IconButton
              permission="biz:member:coupon"
              title="发券"
              @click="openCoupon(row as unknown as Member)"
            >
              <TicketPercent :size="14" />
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

    <!-- 会员详情抽屉：四个 Tab -->
    <LewDrawer
      v-model:visible="drawerVisible"
      :title="`会员详情 - ${detail?.name ?? ''}`"
      width="920px"
      position="right"
      :hide-footer="true"
    >
      <div class="flex flex-col gap-3 p-4">
        <!-- 操作区（按权限点显示） -->
        <div class="flex flex-wrap items-center gap-2 pb-2">
          <LewButton
            v-permission="'biz:member:recharge'"
            type="fill"
            size="small"
            @click="openRecharge"
          >
            充值
          </LewButton>
          <LewButton
            v-permission="'biz:member:refund'"
            type="light"
            color="error"
            size="small"
            @click="openRefund"
          >
            <RotateCcw :size="13" style="margin-right: 4px" /> 冲正退款
          </LewButton>
          <LewButton
            v-permission="'biz:member:adjust'"
            type="light"
            size="small"
            @click="openAdjust"
          >
            <SlidersHorizontal :size="13" style="margin-right: 4px" />
            调级/调积分
          </LewButton>
          <LewButton
            v-permission="'biz:member:recount'"
            type="light"
            color="warning"
            size="small"
            @click="handleRecount"
          >
            <RefreshCw :size="13" style="margin-right: 4px" /> 重算
          </LewButton>
          <LewButton
            v-if="detail && detail.levelId === null"
            v-permission="'biz:member:update'"
            type="light"
            size="small"
            @click="openEnroll(detail.id)"
          >
            <UserPlus :size="13" style="margin-right: 4px" /> 纳为会员
          </LewButton>
          <LewButton
            v-permission="'biz:card:issue'"
            type="light"
            size="small"
            @click="openIssueCard"
          >
            <Ticket :size="13" style="margin-right: 4px" /> 发卡
          </LewButton>
          <LewButton
            v-permission="'biz:points:redeem'"
            type="light"
            size="small"
            @click="openRedeem"
          >
            <Coins :size="13" style="margin-right: 4px" /> 积分兑换
          </LewButton>
          <LewButton type="light" size="small" @click="openPointsPreview">
            <Calculator :size="13" style="margin-right: 4px" /> 积分抵扣试算
          </LewButton>
        </div>

        <LewTabs v-model="activeTab" :options="tabOptions" />

        <!-- Tab 1：档案 -->
        <div v-if="activeTab === 'profile'" class="grid grid-cols-3 gap-3">
          <div>
            <div class="text-12px text-[var(--app-text-muted)]">会员号</div>
            <div>{{ detail?.memberNo ?? '散客（未入会）' }}</div>
          </div>
          <div>
            <div class="text-12px text-[var(--app-text-muted)]">姓名</div>
            <div>{{ detail?.name ?? '-' }}</div>
          </div>
          <div>
            <div class="text-12px text-[var(--app-text-muted)]">手机号</div>
            <div>{{ detail?.phone ?? '-' }}</div>
          </div>
          <div>
            <div class="text-12px text-[var(--app-text-muted)]">等级</div>
            <div>
              {{ memberLevelName(detail) ?? '未入会' }}（{{
                discountText(memberDiscountPermille(detail))
              }}）
            </div>
          </div>
          <div>
            <div class="text-12px text-[var(--app-text-muted)]">
              储值余额（本金 + 赠送）
            </div>
            <div>
              ¥{{ fen2yuan(balanceTotal) }}（本金 ¥{{
                fen2yuan(detail?.balancePrincipal)
              }}
              / 赠送 ¥{{ fen2yuan(detail?.balanceBonus) }}）
            </div>
          </div>
          <div>
            <div class="text-12px text-[var(--app-text-muted)]">积分</div>
            <div>
              {{ detail?.points ?? 0 }}（累计 {{ detail?.pointsTotal ?? 0 }}）
            </div>
          </div>
          <div>
            <div class="text-12px text-[var(--app-text-muted)]">
              累计消费(元)
            </div>
            <div>¥{{ fen2yuan(detail?.totalSpent) }}</div>
          </div>
          <div>
            <div class="text-12px text-[var(--app-text-muted)]">到店次数</div>
            <div>{{ detail?.visitCount ?? 0 }}</div>
          </div>
          <div>
            <div class="text-12px text-[var(--app-text-muted)]">最近到店</div>
            <div>{{ formatDateTime(detail?.lastVisitAt) }}</div>
          </div>
          <div>
            <div class="text-12px text-[var(--app-text-muted)]">入会时间</div>
            <div>{{ formatDateTime(detail?.memberSince) }}</div>
          </div>
          <div>
            <div class="text-12px text-[var(--app-text-muted)]">生日</div>
            <div>{{ detail?.birthday ?? '-' }}</div>
          </div>
          <div>
            <div class="text-12px text-[var(--app-text-muted)]">备注</div>
            <div>{{ detail?.remark ?? '-' }}</div>
          </div>
        </div>

        <!-- Tab 2：账务流水（只读，无任何编辑/删除入口） -->
        <div
          v-else-if="activeTab === 'transactions'"
          class="app-card overflow-hidden"
        >
          <p class="page-subtitle m-0 px-3 pt-3">
            流水只追加、不可修改或删除；对账不平时请使用「重算」修复。
          </p>
          <LewTable
            :columns="txnColumns"
            :data-source="txnItems"
            :loading="txnLoading || detailLoading"
            :focusable="false"
            size="small"
          />
          <div class="flex justify-end p-3">
            <LewPagination
              v-model:current-page="txnPage"
              v-model:page-size="txnPageSize"
              :total="txnTotal"
              @change="txnHandleChange"
            />
          </div>
        </div>

        <!-- Tab 3：次卡 -->
        <div v-else-if="activeTab === 'cards'" class="app-card overflow-hidden">
          <LewTable
            :columns="cardColumns"
            :data-source="cards"
            :loading="cardsLoading"
            :focusable="false"
            size="small"
          />
          <p v-if="!cardsLoading && !cards.length" class="table-empty">
            该会员暂无次卡
          </p>
        </div>

        <!-- Tab 4：预约历史 -->
        <div v-else class="app-card overflow-hidden">
          <LewTable
            :columns="bookingColumns"
            :data-source="bookingItems"
            :loading="bookingLoading || detailLoading"
            :focusable="false"
            size="small"
          />
          <div class="flex justify-end p-3">
            <LewPagination
              v-model:current-page="bookingPage"
              v-model:page-size="bookingPageSize"
              :total="bookingTotal"
              @change="bookingHandleChange"
            />
          </div>
        </div>
      </div>
    </LewDrawer>

    <!-- 发券弹窗：只列启用模板；服务端允许重复发放，故不做去重提示 -->
    <LewModal
      v-model:visible="couponVisible"
      :title="`发券给 ${couponMember?.name ?? ''}`"
      width="480px"
      :footer-buttons="[
        {
          props: {
            type: 'text',
            color: 'gray',
            size: 'small',
            text: '取消',
            request: () => {
              couponVisible = false;
            },
          },
        },
        {
          props: {
            type: 'fill',
            color: 'primary',
            size: 'small',
            text: '发放',
            request: submitCoupon,
          },
        },
      ]"
    >
      <div class="p-5">
        <LewForm
          :key="couponFormKey"
          ref="couponFormRef"
          v-model="couponForm"
          :options="couponFormOptions"
          label-width="88px"
        />
      </div>
    </LewModal>
    <!-- 充值弹窗：实付与赠送分开展示 -->
    <LewModal
      v-model:visible="rechargeVisible"
      title="会员充值"
      width="520px"
      :footer-buttons="[
        {
          props: {
            type: 'text',
            color: 'gray',
            size: 'small',
            text: '取消',
            request: () => {
              rechargeVisible = false;
            },
          },
        },
        {
          props: {
            type: 'fill',
            color: 'primary',
            size: 'small',
            text: '充值',
            request: submitRecharge,
          },
        },
      ]"
    >
      <div class="p-5">
        <LewForm
          :key="rechargeFormKey"
          ref="rechargeFormRef"
          v-model="rechargeForm"
          label-width="110px"
          @change="onRechargeChange"
          :options="withPassThroughRule([
            {
              field: 'planId',
              label: '充值方案',
              as: 'select',
              props: {
                options: rechargePlanOptions,
                placeholder: '选择方案，或留空自定义金额',
                clearable: true,
              },
            },
            {
              field: 'payAmount',
              label: '自定义实付(元)',
              as: 'input-number',
              props: { min: 0, placeholder: '不走方案时填写' },
            },
            {
              field: 'payChannel',
              label: '收款方式',
              as: 'select',
              rule: `Yup.string().required('不能为空')`,
              props: { options: rechargeChannelOptions },
            },
            {
              field: 'remark',
              label: '备注',
              as: 'textarea',
              rule: `Yup.string().required('不能为空')`,
              props: { placeholder: '充值备注（必填）', rows: 2 },
            },
          ])"
        />
        <div
          class="mt-3 rounded-8px border border-[var(--app-border)] p-3 text-13px"
        >
          <div class="flex justify-between">
            <span>实付金额</span>
            <span class="font-600">¥{{ fen2yuan(rechargePreview.pay) }}</span>
          </div>
          <div class="mt-1 flex justify-between">
            <span>赠送金额</span>
            <span class="font-600 text-[var(--lew-color-warning)]"
              >¥{{ fen2yuan(rechargePreview.bonus) }}</span
            >
          </div>
          <p class="m-0 mt-2 text-12px text-[var(--app-text-muted)]">
            赠送进入「赠送余额」，<span class="text-[var(--lew-color-error)]"
              >不可退、不可提现</span
            >；赠送比例上限 20%（配置项
            biz.member.maxBonusPermille），超出后端会拒绝。单次充值下限由配置项
            biz.member.minRechargeAmount 控制（默认 100
            元），且会员必须已有手机号。
          </p>
        </div>
      </div>
    </LewModal>

    <!-- 冲正退款弹窗 -->
    <LewModal
      v-model:visible="refundVisible"
      title="冲正退款"
      width="520px"
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
            text: '提交冲正',
            request: submitRefund,
          },
        },
      ]"
    >
      <div class="p-5">
        <p class="page-subtitle mt-0 mb-3">
          当前储值余额：本金 ¥{{ fen2yuan(detail?.balancePrincipal) }} / 赠送
          ¥{{
            fen2yuan(detail?.balanceBonus)
          }}（赠送不可退、余额不可提现，只能退实付本金）。<br />
          <span class="text-[var(--lew-color-warning)]">
            「现金冲正」只写冲正流水、<b>不改动储值余额</b>；「储值冲正」会
            <b>从余额扣回</b>。 该接口不产生退款审批单（与 §15.4「走退款单 +
            审批」不一致，见交付说明）。
          </span>
        </p>
        <LewForm
          :key="refundFormKey"
          ref="refundFormRef"
          v-model="refundForm"
          label-width="110px"
          :options="withPassThroughRule([
            {
              field: 'amount',
              label: '退款金额(元)',
              as: 'input-number',
              rule: `Yup.number().required('不能为空')`,
              props: { min: 0 },
            },
            {
              field: 'mode',
              label: '退款去向',
              as: 'select',
              rule: `Yup.string().required('不能为空')`,
              props: { options: refundModeOptions },
            },
            {
              field: 'reason',
              label: '退款原因',
              as: 'textarea',
              rule: `Yup.string().required('不能为空')`,
              props: { placeholder: '冲正原因（必填）', rows: 2 },
            },
          ])"
        />
      </div>
    </LewModal>

    <!-- 手工调级 / 调积分弹窗 -->
    <LewModal
      v-model:visible="adjustVisible"
      title="手工调级 / 调积分"
      width="520px"
      :footer-buttons="[
        {
          props: {
            type: 'text',
            color: 'gray',
            size: 'small',
            text: '取消',
            request: () => {
              adjustVisible = false;
            },
          },
        },
        {
          props: {
            type: 'fill',
            color: 'primary',
            size: 'small',
            text: '提交调整',
            request: submitAdjust,
          },
        },
      ]"
    >
      <div class="p-5">
        <p class="page-subtitle mt-0 mb-3">
          当前等级：{{ memberLevelName(detail) ?? '未入会' }}，当前积分：{{
            detail?.points ?? 0
          }}。调整会写流水留痕，且会被「重算」覆盖。
        </p>
        <LewForm
          :key="adjustFormKey"
          ref="adjustFormRef"
          v-model="adjustForm"
          label-width="110px"
          :options="withPassThroughRule([
            {
              field: 'levelId',
              label: '目标等级',
              as: 'select',
              rule: 'Yup.string().nullable()',
              props: {
                options: levelOptions,
                placeholder: '不调级则留空',
                clearable: true,
              },
            },
            {
              field: 'pointsDelta',
              label: '积分增减',
              as: 'input-number',
              props: { placeholder: '可正可负，如 -100' },
            },
            {
              field: 'reason',
              label: '调整原因',
              as: 'textarea',
              rule: `Yup.string().required('不能为空')`,
              props: { placeholder: '手工调整原因（必填）', rows: 2 },
            },
          ])"
        />
      </div>
    </LewModal>

    <!-- 纳为会员弹窗 -->
    <LewModal
      v-model:visible="enrollVisible"
      title="纳为会员"
      width="440px"
      :footer-buttons="[
        {
          props: {
            type: 'text',
            color: 'gray',
            size: 'small',
            text: '取消',
            request: () => {
              enrollVisible = false;
            },
          },
        },
        {
          props: {
            type: 'fill',
            color: 'primary',
            size: 'small',
            text: '确认入会',
            request: submitEnroll,
          },
        },
      ]"
    >
      <div class="p-5">
        <LewForm
          :key="enrollFormKey"
          ref="enrollFormRef"
          v-model="enrollForm"
          label-width="90px"
          :options="withPassThroughRule([
            {
              field: 'customerId',
              label: '顾客 ID',
              as: 'input-number',
              rule: `Yup.number().required('不能为空')`,
              props: { min: 1, placeholder: '已有顾客档案的 ID' },
            },
          ])"
        />
        <p class="page-subtitle mb-0 mt-3">
          顾客必须已有手机号（会员的必填锚点）；入会后等级置为最低启用等级。
        </p>
      </div>
    </LewModal>

    <!-- 发卡弹窗 -->
    <LewModal
      v-model:visible="issueVisible"
      title="发放次卡"
      width="520px"
      :footer-buttons="[
        {
          props: {
            type: 'text',
            color: 'gray',
            size: 'small',
            text: '取消',
            request: () => {
              issueVisible = false;
            },
          },
        },
        {
          props: {
            type: 'fill',
            color: 'primary',
            size: 'small',
            text: '发卡',
            request: submitIssueCard,
          },
        },
      ]"
    >
      <div class="p-5">
        <LewForm
          :key="issueFormKey"
          ref="issueFormRef"
          v-model="issueForm"
          label-width="110px"
          @change="onIssueChange"
          :options="withPassThroughRule([
            {
              field: 'cardTypeId',
              label: '卡种',
              as: 'select',
              rule: `Yup.string().required('不能为空')`,
              props: {
                options: cardTypeOptions,
                placeholder: '请选择卡种',
              },
            },
            {
              field: 'payChannel',
              label: '支付方式',
              as: 'select',
              rule: `Yup.string().required('不能为空')`,
              props: { options: cardPayChannelOptions },
            },
            {
              field: 'price',
              label: '购卡价(元)',
              as: 'input-number',
              props: { min: 0, placeholder: '不填取卡种售价' },
            },
            {
              field: 'remark',
              label: '备注',
              as: 'textarea',
              props: { placeholder: '选填', rows: 2 },
            },
          ])"
        />
        <p class="page-subtitle mb-0 mt-3">
          卡种默认售价 ¥{{
            fen2yuan(issueSelectedCardType?.price ?? 0)
          }}；发卡会累计消费与积分，支付方式不允许再用另一张次卡。
        </p>
      </div>
    </LewModal>

    <!-- 积分兑换弹窗 -->
    <LewModal
      v-model:visible="redeemVisible"
      title="积分兑换"
      width="520px"
      :footer-buttons="[
        {
          props: {
            type: 'text',
            color: 'gray',
            size: 'small',
            text: '取消',
            request: () => {
              redeemVisible = false;
            },
          },
        },
        {
          props: {
            type: 'fill',
            color: 'primary',
            size: 'small',
            text: '兑换',
            request: submitRedeem,
          },
        },
      ]"
    >
      <div class="p-5">
        <p class="page-subtitle mt-0 mb-3">
          当前积分
          {{
            detail?.points ?? 0
          }}；兑换品直接指向卡种，兑换成功后立即发一张次卡。
        </p>
        <LewForm
          :key="redeemFormKey"
          ref="redeemFormRef"
          v-model="redeemForm"
          label-width="110px"
          @change="onRedeemChange"
          :options="withPassThroughRule([
            {
              field: 'goodsId',
              label: '兑换品',
              as: 'select',
              rule: `Yup.string().required('不能为空')`,
              props: {
                options: pointsGoodsOptions,
                placeholder: '请选择兑换品',
              },
            },
            {
              field: 'remark',
              label: '备注',
              as: 'textarea',
              props: { placeholder: '选填', rows: 2 },
            },
          ])"
        />
      </div>
    </LewModal>

    <!-- 积分抵扣试算弹窗 -->
    <LewModal
      v-model:visible="pointsPreviewVisible"
      title="积分抵扣试算"
      width="560px"
      :hide-footer="true"
    >
      <div class="p-5">
        <LewForm
          :key="pointsPreviewFormKey"
          ref="pointsPreviewFormRef"
          v-model="pointsPreviewForm"
          label-width="110px"
          :options="withPassThroughRule([
            {
              field: 'serviceItemIds',
              label: '服务项目',
              as: 'select',
              rule: `Yup.array().min(1, '至少选择 1 个项目').max(3, '最多选择 3 个项目')`,
              props: {
                options: serviceItemOptions,
                multiple: true,
                placeholder: '选择本单项目（可多选）',
              },
            },
          ])"
        />
        <div class="mt-3 flex items-center gap-2">
          <LewButton
            type="light"
            size="small"
            :loading="pointsPreviewLoading"
            @click="submitPointsPreview"
            >试算</LewButton
          >
          <span class="page-subtitle"
            >金额以服务端复算为准（折扣 → 抵扣，单笔抵扣上限 30%）</span
          >
        </div>
        <div
          v-if="pointsPreviewResult"
          class="mt-3 rounded-8px border border-[var(--app-border)] p-3 text-13px"
        >
          <div class="flex justify-between">
            <span>本单最多可用积分</span>
            <span class="font-600">{{
              pointsPreviewResult?.maxPoints ?? 0
            }}</span>
          </div>
          <div class="mt-1 flex justify-between">
            <span>最多可抵扣金额</span>
            <span class="font-600"
              >¥{{ fen2yuan(pointsPreviewResult?.maxDiscountAmount) }}</span
            >
          </div>
          <p class="m-0 mt-2 text-12px text-[var(--app-text-muted)]">
            汇率：100 分抵 1 元；实际抵扣在下单收款时由服务端复算。
          </p>
        </div>
      </div>
    </LewModal>
  </div>
</template>
