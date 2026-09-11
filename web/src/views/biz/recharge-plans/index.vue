<script setup lang="ts">
import { h, nextTick, ref } from 'vue';
import { Pencil, Plus, Trash2 } from 'lucide-vue-next';
import {
  LewButton,
  LewForm,
  LewMessage,
  LewModal,
  LewPagination,
  LewSelect,
  LewTable,
} from 'lew-ui';
import type { LewFormOption, LewTableColumn } from 'lew-ui';
import { withPassThroughRule } from '~/utils/form';
import {
  createRechargePlan,
  deleteRechargePlan,
  updateRechargePlan,
} from '~/api/biz/recharge-plans';
import type { RechargePlan, RechargePlanBody } from '~/api/biz/recharge-plans';
import { useTable } from '~/composables/useTable';
import { formatDateTime } from '~/composables/useFormat';
import { renderStatus } from '~/utils/render';
import { confirmDanger } from '~/utils/confirm';
import IconButton from '~/components/IconButton.vue';

// ---------- 金额工具（接口「分」↔ 表单「元」） ----------
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

const STATUS_OPTIONS = [
  { label: '启用', value: 'active' },
  { label: '禁用', value: 'disabled' },
];
/** 赠送比例上限（后端配置项 biz.member.maxBonusPermille，默认 200‰ = 20%） */
const MAX_BONUS_RATIO = 0.2;
const BONUS_LIMIT_TIPS =
  '赠送比例上限 20%（配置项 biz.member.maxBonusPermille），超出后端会拒绝';

// ---------- 列表 ----------
const query = ref<{ status?: string }>({});
const {
  items,
  loading,
  currentPage,
  pageSize,
  total,
  search,
  refresh,
  handleChange,
} = useTable<RechargePlan>({
  url: '/biz/recharge-plans',
  query: () => query.value,
});

const columns: LewTableColumn[] = [
  { title: 'ID', field: 'id', width: 70 },
  { title: '方案名', field: 'name', width: 150 },
  {
    title: '实付(元)',
    field: 'payAmount',
    width: 110,
    customRender: ({ row }) =>
      fen2yuan((row as unknown as RechargePlan).payAmount),
  },
  {
    title: '赠送(元)',
    field: 'bonusAmount',
    width: 110,
    customRender: ({ row }) =>
      fen2yuan((row as unknown as RechargePlan).bonusAmount),
  },
  {
    title: '赠送比例',
    field: 'bonusRatio',
    width: 110,
    customRender: ({ row }) => {
      const plan = row as unknown as RechargePlan;
      if (plan.payAmount <= 0) return '-';
      const ratio = plan.bonusAmount / plan.payAmount;
      const text = `${(ratio * 100).toFixed(1)}%`;
      // 超过 20% 上限标红：可提交但后端可能拒绝
      if (ratio > MAX_BONUS_RATIO) {
        return h('span', { class: 'text-[var(--lew-color-error)]' }, text);
      }
      return text;
    },
  },
  { title: '排序', field: 'sort', width: 80 },
  {
    title: '状态',
    field: 'status',
    width: 90,
    customRender: ({ row }) =>
      renderStatus((row as unknown as RechargePlan).status),
  },
  { title: '备注', field: 'remark' },
  {
    title: '创建时间',
    field: 'createdAt',
    width: 170,
    customRender: ({ row }) =>
      formatDateTime((row as unknown as RechargePlan).createdAt),
  },
  { title: '操作', field: 'operation', width: 100, fixed: 'right' },
];

void search();

// ---------- 新增 / 编辑 ----------
const modalVisible = ref(false);
const editingId = ref<number | null>(null);
const formRef = ref();
const form = ref({
  name: '',
  /** 元（顾客实付） */
  payAmount: 0,
  /** 元（赠送，进 balance_bonus，不可退） */
  bonusAmount: 0,
  sort: 0,
  status: true,
  remark: '',
});
/** 表单 key：每次打开弹窗自增，强制重建 LewForm 以回填数据 */
const formKey = ref(0);

const formOptions: LewFormOption[] = withPassThroughRule([
  {
    field: 'name',
    label: '方案名',
    as: 'input',
    rule: "Yup.string().required('不能为空')",
    props: { placeholder: '如 充 1000 送 100', clearable: true },
  },
  {
    field: 'payAmount',
    label: '实付金额(元)',
    as: 'input-number',
    rule: "Yup.number().required('不能为空').moreThan(0, '必须大于 0')",
    tips: '顾客实际支付的金额，计入可退本金',
    props: { min: 0.01, precision: 2 },
  },
  {
    field: 'bonusAmount',
    label: '赠送金额(元)',
    as: 'input-number',
    tips: BONUS_LIMIT_TIPS,
    props: { min: 0, precision: 2 },
  },
  {
    field: 'sort',
    label: '排序',
    as: 'input-number',
    props: { min: 0 },
  },
  { field: 'status', label: '状态', as: 'switch' },
  {
    field: 'remark',
    label: '备注',
    as: 'textarea',
    props: { placeholder: '选填', rows: 2 },
  },
]);

function openCreate() {
  editingId.value = null;
  formKey.value += 1;
  modalVisible.value = true;
  // LewForm 为受控组件，需在挂载后通过 setForm 填充
  void nextTick(() => {
    formRef.value?.setForm?.({
      name: '',
      payAmount: 0,
      bonusAmount: 0,
      sort: 0,
      status: true,
      remark: '',
    });
  });
}

function openEdit(row: RechargePlan) {
  editingId.value = row.id;
  formKey.value += 1;
  modalVisible.value = true;
  // 分 → 元回填
  void nextTick(() => {
    formRef.value?.setForm?.({
      name: row.name,
      payAmount: row.payAmount / 100,
      bonusAmount: row.bonusAmount / 100,
      sort: row.sort,
      status: row.status === 'active',
      remark: row.remark ?? '',
    });
  });
}

async function handleSubmit() {
  const valid = await formRef.value?.validate();
  if (!valid) return;
  // LewForm 为受控组件，用 getForm 读取用户真实输入
  const values = (formRef.value?.getForm?.() ??
    form.value) as typeof form.value;
  const payAmount = yuan2fen(values.payAmount);
  const bonusAmount = yuan2fen(values.bonusAmount);
  if (payAmount <= 0) {
    LewMessage.error('实付金额必须大于 0');
    return;
  }
  // 上限由后端配置决定，前端只做提示性校验，不硬拦截
  if (bonusAmount / payAmount > MAX_BONUS_RATIO) {
    LewMessage.warning('赠送比例超过 20% 上限，后端可能拒绝该方案');
  }
  const body: RechargePlanBody = {
    name: values.name,
    payAmount,
    bonusAmount,
    sort: Number(values.sort ?? 0),
    status: values.status ? 'active' : 'disabled',
    remark: values.remark || null,
  };
  if (editingId.value === null) {
    await createRechargePlan(body);
    LewMessage.success('创建成功');
  } else {
    await updateRechargePlan(editingId.value, body);
    LewMessage.success('更新成功');
  }
  modalVisible.value = false;
  void refresh();
}

// ---------- 删除 ----------
function handleDelete(row: RechargePlan) {
  confirmDanger({
    title: '删除确认',
    content: `确定删除充值方案「${row.name}」吗？已充值的会员余额不受影响。`,
    onConfirm: async () => {
      await deleteRechargePlan(row.id);
      LewMessage.success('删除成功');
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
        <h2 class="page-title m-0">充值方案</h2>
        <p class="page-subtitle mt-1 mb-0">实付与赠送金额分开管理</p>
      </div>
      <LewButton
        v-permission="'biz:rechargeplan:create'"
        type="fill"
        @click="openCreate"
      >
        <Plus :size="15" style="margin-right: 4px" /> 新增方案
      </LewButton>
    </div>

    <!-- 搜索栏 -->
    <div class="app-card flex flex-wrap items-center gap-3 p-4">
      <LewSelect
        v-model="query.status"
        width="130px"
        :options="STATUS_OPTIONS"
        placeholder="全部状态"
        clearable
      />
      <LewButton type="light" :loading="loading" @click="search()"
        >查询</LewButton
      >
      <span class="text-12.5px text-[var(--app-text-muted)]">
        {{ BONUS_LIMIT_TIPS }}
      </span>
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
              permission="biz:rechargeplan:update"
              title="编辑"
              @click="openEdit(row as unknown as RechargePlan)"
            >
              <Pencil :size="14" />
            </IconButton>
            <IconButton
              permission="biz:rechargeplan:delete"
              color="error"
              title="删除"
              @click="handleDelete(row as unknown as RechargePlan)"
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

    <!-- 新增 / 编辑弹窗 -->
    <LewModal
      v-model:visible="modalVisible"
      :title="editingId === null ? '新增充值方案' : '编辑充值方案'"
      width="520px"
      :footer-buttons="[
        {
          props: {
            type: 'text',
            color: 'gray',
            size: 'small',
            text: '取消',
            request: () => {
              modalVisible = false;
            },
          },
        },
        {
          props: {
            type: 'fill',
            color: 'primary',
            size: 'small',
            text: '保存',
            request: handleSubmit,
          },
        },
      ]"
    >
      <div class="p-5">
        <LewForm
          :key="formKey"
          ref="formRef"
          v-model="form"
          :options="formOptions"
          label-width="96px"
        />
      </div>
    </LewModal>
  </div>
</template>
