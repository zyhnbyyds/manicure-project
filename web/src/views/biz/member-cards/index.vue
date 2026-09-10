<script setup lang="ts">
import { h, nextTick, reactive, ref } from 'vue';
import { Undo2, Wallet } from 'lucide-vue-next';
import {
  LewButton,
  LewForm,
  LewInput,
  LewMessage,
  LewModal,
  LewPagination,
  LewSelect,
  LewTable,
} from 'lew-ui';
import type { LewFormOption, LewTableColumn } from 'lew-ui';
import { listActiveCardTypes } from '~/api/biz/card-types';
import { refundMemberCard, revertMemberCardUse } from '~/api/biz/member-cards';
import type {
  CardPayChannel,
  MemberCard,
  MemberCardStatus,
} from '~/api/biz/member-cards';
import { formatDateTime } from '~/composables/useFormat';
import { useTable } from '~/composables/useTable';
import { confirmDanger } from '~/utils/confirm';
import IconButton from '~/components/IconButton.vue';

// ---------- 枚举映射 ----------
const CARD_STATUS_OPTIONS = [
  { label: '生效中', value: 'active' },
  { label: '已用完', value: 'used_up' },
  { label: '已过期', value: 'expired' },
  { label: '已退卡', value: 'refunded' },
];

const CARD_STATUS_MAP: Record<
  MemberCardStatus,
  { text: string; class: string }
> = {
  active: { text: '生效中', class: 'text-[var(--lew-color-success)]' },
  used_up: { text: '已用完', class: 'text-[var(--app-text-muted)]' },
  expired: { text: '已过期', class: 'text-[var(--lew-color-warning)]' },
  refunded: { text: '已退卡', class: 'text-[var(--lew-color-error)]' },
};

/** 次卡状态标签（带颜色） */
function renderCardStatus(status: MemberCardStatus) {
  const item = CARD_STATUS_MAP[status];
  return h('span', { class: item.class }, item.text);
}

/** 购卡支付方式中文 */
const PAY_CHANNEL_LABELS: Record<CardPayChannel, string> = {
  cash: '现金',
  wechat: '微信',
  alipay: '支付宝',
  balance: '储值余额',
};

// ---------- 金额工具（接口「分」↔ 表单「元」） ----------
/** 分 → 元，保留两位 */
function fen2yuan(value: number): string {
  return (value / 100).toFixed(2);
}

/** 元 → 分，四舍五入取整 */
function yuan2fen(value: unknown): number {
  const num = Number(value ?? 0);
  return Number.isFinite(num) ? Math.round(num * 100) : 0;
}

/** 剩余次数：后端未返回时用「总次数 − 已核销」兜底 */
function remainTimes(card: MemberCard): number {
  return card.remainTimes ?? card.totalTimes - card.usedTimes;
}

/** 会员展示：姓名（缺失时用 #ID）+ 手机号 */
function memberText(card: MemberCard): string {
  const name = card.customerName ?? `#${card.customerId}`;
  return card.customerPhone ? `${name} / ${card.customerPhone}` : name;
}

/** 仅生效中 / 已用完的卡可撤销核销与退卡 */
function canOperate(card: MemberCard): boolean {
  return card.status === 'active' || card.status === 'used_up';
}

// ---------- 卡种下拉 ----------
const cardTypeOptions = reactive<{ label: string; value: string }[]>([]);
async function loadCardTypes() {
  const list = await listActiveCardTypes();
  cardTypeOptions.splice(
    0,
    cardTypeOptions.length,
    ...list.map((cardType) => ({
      label: cardType.name,
      value: String(cardType.id),
    })),
  );
}
void loadCardTypes();

// ---------- 列表 ----------
const query = ref<{
  customerId?: string;
  status?: string;
  cardTypeId?: string;
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
} = useTable<MemberCard>({
  url: '/biz/member-cards',
  query: () => query.value,
});

const columns: LewTableColumn[] = [
  { title: 'ID', field: 'id', width: 70 },
  { title: '卡号', field: 'cardNo', width: 160 },
  {
    title: '会员',
    field: 'customerName',
    width: 140,
    customRender: ({ row }) =>
      h('span', null, memberText(row as unknown as MemberCard)),
  },
  { title: '卡种', field: 'cardName', width: 150 },
  { title: '总次数', field: 'totalTimes', width: 80 },
  { title: '已核销', field: 'usedTimes', width: 80 },
  {
    title: '剩余',
    field: 'remainTimes',
    width: 80,
    customRender: ({ row }) => remainTimes(row as unknown as MemberCard),
  },
  {
    title: '售价(元)',
    field: 'price',
    width: 100,
    customRender: ({ row }) => fen2yuan((row as unknown as MemberCard).price),
  },
  {
    title: '购卡方式',
    field: 'payChannel',
    width: 100,
    customRender: ({ row }) =>
      PAY_CHANNEL_LABELS[(row as unknown as MemberCard).payChannel] ?? '-',
  },
  {
    title: '购买时间',
    field: 'purchasedAt',
    width: 170,
    customRender: ({ row }) =>
      formatDateTime((row as unknown as MemberCard).purchasedAt),
  },
  {
    title: '到期时间',
    field: 'expireAt',
    width: 170,
    customRender: ({ row }) => {
      const card = row as unknown as MemberCard;
      return card.expireAt ? formatDateTime(card.expireAt) : '永久';
    },
  },
  {
    title: '状态',
    field: 'status',
    width: 90,
    customRender: ({ row }) =>
      renderCardStatus((row as unknown as MemberCard).status),
  },
  { title: '操作', field: 'operation', width: 110, fixed: 'right' },
];

void search();

// ---------- 撤销核销 ----------
const revertVisible = ref(false);
const revertTarget = ref<MemberCard | null>(null);
const revertFormRef = ref();
const revertForm = ref({ reason: '' });
/** 表单 key：每次打开弹窗自增，强制重建 LewForm 以回填数据 */
const revertFormKey = ref(0);

const revertFormOptions: LewFormOption[] = [
  {
    field: 'reason',
    label: '撤销原因',
    as: 'textarea',
    rule: "Yup.string().required('不能为空')",
    props: { placeholder: '请说明撤销原因（会写入核销记录）', rows: 3 },
  },
];

function openRevert(row: MemberCard) {
  revertTarget.value = row;
  revertFormKey.value += 1;
  revertVisible.value = true;
  void nextTick(() => {
    revertFormRef.value?.setForm?.({ reason: '' });
  });
}

async function handleRevertSubmit() {
  const valid = await revertFormRef.value?.validate();
  if (!valid) return;
  const values = (revertFormRef.value?.getForm?.() ??
    revertForm.value) as typeof revertForm.value;
  const target = revertTarget.value;
  if (!target) return;
  confirmDanger({
    type: 'normal',
    title: '撤销核销',
    content: `确定撤销次卡「${target.cardNo}」的最近一次核销吗？将回补次数并写入核销记录。`,
    confirmText: '确认撤销',
    confirmColor: 'primary',
    onConfirm: async () => {
      await revertMemberCardUse(target.id, { reason: values.reason });
      LewMessage.success('已撤销核销');
      revertVisible.value = false;
      void refresh();
    },
  });
}

// ---------- 退卡 ----------
const refundVisible = ref(false);
const refundTarget = ref<MemberCard | null>(null);
const refundFormRef = ref();
const refundForm = ref({ amount: 0, reason: '' });
const refundFormKey = ref(0);

const refundFormOptions: LewFormOption[] = [
  {
    field: 'amount',
    label: '退款金额(元)',
    as: 'input-number',
    rule: "Yup.number().required('不能为空')",
    props: { min: 0, precision: 2, placeholder: '按剩余次数人工核算' },
  },
  {
    field: 'reason',
    label: '退卡原因',
    as: 'textarea',
    rule: "Yup.string().required('不能为空')",
    props: { placeholder: '请说明退卡原因', rows: 3 },
  },
];

/** 默认退款金额（元）：按剩余次数占比折算，保留两位 */
function defaultRefundYuan(card: MemberCard): number {
  if (card.totalTimes <= 0) return 0;
  const remain = Math.max(0, remainTimes(card));
  return Math.round(((card.price * remain) / card.totalTimes) * 100) / 100;
}

function openRefund(row: MemberCard) {
  refundTarget.value = row;
  refundFormKey.value += 1;
  refundVisible.value = true;
  void nextTick(() => {
    refundFormRef.value?.setForm?.({
      amount: defaultRefundYuan(row),
      reason: '',
    });
  });
}

async function handleRefundSubmit() {
  const valid = await refundFormRef.value?.validate();
  if (!valid) return;
  const values = (refundFormRef.value?.getForm?.() ??
    refundForm.value) as typeof refundForm.value;
  const target = refundTarget.value;
  if (!target) return;
  const yuan = Number(values.amount);
  if (!Number.isFinite(yuan) || yuan < 0) {
    LewMessage.error('请输入正确的退款金额');
    return;
  }
  const amount = yuan2fen(yuan);
  confirmDanger({
    type: 'warning',
    title: '退卡确认',
    content: `确定对次卡「${target.cardNo}」退卡吗？退款金额 ￥${fen2yuan(amount)}，退卡将冲减累计消费，此操作不可恢复。`,
    confirmText: '确认退卡',
    confirmColor: 'error',
    onConfirm: async () => {
      await refundMemberCard(target.id, { amount, reason: values.reason });
      LewMessage.success('已退卡');
      refundVisible.value = false;
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
        <h2 class="page-title m-0">会员次卡</h2>
        <p class="page-subtitle mt-1 mb-0">次卡查询、撤销核销与退卡</p>
      </div>
    </div>

    <!-- 搜索栏 -->
    <div class="app-card flex items-center gap-3 p-4">
      <LewInput
        v-model="query.customerId"
        width="160px"
        placeholder="顾客 ID"
        clearable
        @enter="search()"
      />
      <LewSelect
        v-model="query.status"
        width="140px"
        :options="CARD_STATUS_OPTIONS"
        placeholder="全部状态"
        clearable
      />
      <LewSelect
        v-model="query.cardTypeId"
        width="180px"
        :options="cardTypeOptions"
        placeholder="全部卡种"
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
              v-if="canOperate(row as unknown as MemberCard)"
              permission="biz:card:revoke"
              title="撤销核销"
              @click="openRevert(row as unknown as MemberCard)"
            >
              <Undo2 :size="14" />
            </IconButton>
            <IconButton
              v-if="canOperate(row as unknown as MemberCard)"
              permission="biz:card:refund"
              color="error"
              title="退卡"
              @click="openRefund(row as unknown as MemberCard)"
            >
              <Wallet :size="14" />
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

    <!-- 撤销核销弹窗 -->
    <LewModal
      v-model:visible="revertVisible"
      title="撤销核销"
      width="480px"
      :footer-buttons="[
        {
          props: {
            type: 'text',
            color: 'gray',
            size: 'small',
            text: '取消',
            request: () => {
              revertVisible = false;
            },
          },
        },
        {
          props: {
            type: 'fill',
            color: 'primary',
            size: 'small',
            text: '保存',
            request: handleRevertSubmit,
          },
        },
      ]"
    >
      <div class="p-5">
        <LewForm
          :key="revertFormKey"
          ref="revertFormRef"
          v-model="revertForm"
          :options="revertFormOptions"
          label-width="96px"
        />
      </div>
    </LewModal>

    <!-- 退卡弹窗 -->
    <LewModal
      v-model:visible="refundVisible"
      title="退卡"
      width="480px"
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
            text: '提交退卡',
            request: handleRefundSubmit,
          },
        },
      ]"
    >
      <div class="p-5">
        <LewForm
          :key="refundFormKey"
          ref="refundFormRef"
          v-model="refundForm"
          :options="refundFormOptions"
          label-width="96px"
        />
      </div>
    </LewModal>
  </div>
</template>
