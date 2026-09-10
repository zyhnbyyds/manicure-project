<script setup lang="ts">
import { h, nextTick, reactive, ref } from 'vue';
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
import {
  createCommissionRule,
  deleteCommissionRule,
  listCommissionStaffOptions,
  listServiceItemOptions,
  updateCommissionRule,
} from '~/api/biz/commission-rules';
import type {
  CommissionBase,
  CommissionRule,
  CommissionRuleBody,
  CommissionScope,
} from '~/api/biz/commission-rules';
import { useTable } from '~/composables/useTable';
import { confirmDanger } from '~/utils/confirm';
import IconButton from '~/components/IconButton.vue';

// ---------- 金额工具 ----------
function fen2yuan(value: number | null | undefined): string {
  if (value === null || value === undefined) return '-';
  return (value / 100).toFixed(2);
}
function yuan2fen(value: unknown): number {
  const num = Number(value ?? 0);
  return Number.isFinite(num) ? Math.round(num * 100) : 0;
}
/** 千分比 → 百分比展示（50‰ = 5%） */
function permille2percent(permille: number): string {
  if (!permille) return '-';
  return `${(permille / 10).toFixed(2).replace(/\.?0+$/, '')}%`;
}

const SCOPE_OPTIONS = [
  { label: '按美甲师', value: 'staff' },
  { label: '按项目分类', value: 'category' },
  { label: '按服务项目', value: 'service_item' },
];
const SCOPE_LABELS: Record<CommissionScope, string> = {
  staff: '按美甲师',
  category: '按项目分类',
  service_item: '按服务项目',
};
const BASE_OPTIONS = [
  { label: '实收（默认，防挂账提前计提）', value: 'paid' },
  { label: '应付', value: 'payable' },
  { label: '原价', value: 'original' },
];
const BASE_LABELS: Record<CommissionBase, string> = {
  paid: '实收',
  payable: '应付',
  original: '原价',
};
const STATUS_OPTIONS = [
  { label: '启用', value: 'active' },
  { label: '禁用', value: 'disabled' },
];

// ---------- 项目 / 分类 / 美甲师下拉 ----------
const serviceItemOptions = reactive<{ label: string; value: number }[]>([]);
const categoryOptions = reactive<{ label: string; value: string }[]>([]);
const staffOptions = reactive<{ label: string; value: number }[]>([]);

async function loadOptions() {
  const [items, staffs] = await Promise.all([
    listServiceItemOptions(),
    listCommissionStaffOptions(),
  ]);
  serviceItemOptions.splice(
    0,
    serviceItemOptions.length,
    ...items.items.map((item) => ({ label: item.name, value: item.id })),
  );
  const categories = [
    ...new Set(
      items.items
        .map((item) => item.category)
        .filter((category): category is string => Boolean(category)),
    ),
  ];
  categoryOptions.splice(
    0,
    categoryOptions.length,
    ...categories.map((category) => ({ label: category, value: category })),
  );
  staffOptions.splice(
    0,
    staffOptions.length,
    ...staffs.items.map((staff) => ({
      label: staff.nickname,
      value: staff.id,
    })),
  );
}
void loadOptions();

// ---------- 列表 ----------
const query = ref<{ scope?: string; status?: string }>({});
const {
  items,
  loading,
  currentPage,
  pageSize,
  total,
  search,
  refresh,
  handleChange,
} = useTable<CommissionRule>({
  url: '/biz/commission-rules',
  query: () => query.value,
});

/** 维度命中目标的可读名称 */
function targetLabel(row: CommissionRule) {
  if (row.scope === 'service_item') {
    return (
      serviceItemOptions.find((option) => option.value === row.targetId)
        ?.label ?? (row.targetId ? `项目 #${row.targetId}` : '-')
    );
  }
  if (row.scope === 'staff') {
    const id = row.staffId ?? row.targetId;
    return (
      staffOptions.find((option) => option.value === id)?.label ??
      (id ? `美甲师 #${id}` : '-')
    );
  }
  return row.category ?? '-';
}

const columns: LewTableColumn[] = [
  { title: 'ID', field: 'id', width: 70 },
  { title: '规则名称', field: 'name', width: 170 },
  {
    title: '维度',
    field: 'scope',
    width: 110,
    customRender: ({ row }) =>
      SCOPE_LABELS[(row as unknown as CommissionRule).scope] ?? '-',
  },
  {
    title: '维度取值',
    field: 'target',
    width: 150,
    customRender: ({ row }) => targetLabel(row as unknown as CommissionRule),
  },
  {
    title: '比例',
    field: 'permille',
    width: 100,
    customRender: ({ row }) => {
      const permille = (row as unknown as CommissionRule).permille;
      return permille
        ? h('span', { class: 'font-600' }, permille2percent(permille))
        : '-';
    },
  },
  {
    title: '固定额',
    field: 'fixedAmount',
    width: 110,
    customRender: ({ row }) => {
      const amount = (row as unknown as CommissionRule).fixedAmount;
      return amount
        ? h('span', { class: 'font-600' }, `¥${fen2yuan(amount)}`)
        : '-';
    },
  },
  {
    title: '计提基数',
    field: 'base',
    width: 100,
    customRender: ({ row }) =>
      BASE_LABELS[(row as unknown as CommissionRule).base] ?? '-',
  },
  {
    title: '生效期',
    field: 'effectiveFrom',
    width: 200,
    customRender: ({ row }) => {
      const rule = row as unknown as CommissionRule;
      return `${rule.effectiveFrom} ~ ${rule.effectiveTo ?? '长期'}`;
    },
  },
  {
    title: '优先级',
    field: 'sort',
    width: 85,
    customRender: ({ row }) => {
      const sort = (row as unknown as CommissionRule).sort;
      return h(
        'span',
        { title: '同维度取 sort 最小且生效期命中的一条' },
        String(sort),
      );
    },
  },
  {
    title: '状态',
    field: 'status',
    width: 80,
    customRender: ({ row }) =>
      (row as unknown as CommissionRule).status === 'active'
        ? h('span', { class: 'text-[var(--lew-color-success)]' }, '启用')
        : h('span', { class: 'text-[var(--lew-color-error)]' }, '禁用'),
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
  scope: 'staff' as CommissionScope,
  targetId: undefined as number | undefined,
  staffId: undefined as number | undefined,
  category: undefined as string | undefined,
  permille: 0,
  /** 元 */
  fixedAmount: 0,
  base: 'paid' as CommissionBase,
  effectiveFrom: '',
  effectiveTo: '',
  status: true,
  sort: 0,
  remark: '',
});
/** 表单 key：每次打开弹窗自增，强制重建 LewForm 以回填数据 */
const formKey = ref(0);

const formOptions: LewFormOption[] = [
  {
    field: 'name',
    label: '规则名称',
    as: 'input',
    rule: "Yup.string().required('不能为空')",
    props: { placeholder: '如 美甲项目 10%', clearable: true },
  },
  {
    field: 'scope',
    label: '维度',
    as: 'select',
    rule: "Yup.string().required('不能为空')",
    tips: '优先级：服务项目 > 项目分类 > 美甲师',
    props: { options: SCOPE_OPTIONS },
  },
  {
    field: 'staffId',
    label: '美甲师',
    as: 'select',
    visible: (formData: Record<string, unknown>) => formData.scope === 'staff',
    rule: "Yup.number().nullable().typeError('请选择美甲师')",
    props: {
      options: staffOptions,
      placeholder: '请选择美甲师',
      clearable: true,
    },
  },
  {
    field: 'category',
    label: '项目分类',
    as: 'select',
    visible: (formData: Record<string, unknown>) =>
      formData.scope === 'category',
    rule: 'Yup.string().nullable()',
    tips: '分类取自服务项目的 category 字段',
    props: {
      options: categoryOptions,
      placeholder: '请选择分类',
      clearable: true,
    },
  },
  {
    field: 'targetId',
    label: '服务项目',
    as: 'select',
    visible: (formData: Record<string, unknown>) =>
      formData.scope === 'service_item',
    rule: "Yup.number().nullable().typeError('请选择服务项目')",
    props: {
      options: serviceItemOptions,
      placeholder: '请选择服务项目',
      clearable: true,
    },
  },
  {
    field: 'permille',
    label: '比例(‰)',
    as: 'input-number',
    tips: '千分比：50 = 5%；与固定额可同时存在（取两者之和）',
    props: { min: 0, max: 1000 },
  },
  {
    field: 'fixedAmount',
    label: '固定额(元)',
    as: 'input-number',
    tips: '每项固定提成，单位元',
    props: { min: 0, step: 0.01 },
  },
  {
    field: 'base',
    label: '计提基数',
    as: 'select',
    rule: "Yup.string().required('不能为空')",
    props: { options: BASE_OPTIONS },
  },
  {
    field: 'effectiveFrom',
    label: '生效开始',
    as: 'date-picker',
    rule: "Yup.string().required('不能为空')",
    props: { valueFormat: 'YYYY-MM-DD', placeholder: '开始日期' },
  },
  {
    field: 'effectiveTo',
    label: '生效结束',
    as: 'date-picker',
    rule: 'Yup.string().nullable()',
    props: { valueFormat: 'YYYY-MM-DD', placeholder: '留空 = 长期有效' },
  },
  { field: 'status', label: '状态', as: 'switch' },
  {
    field: 'sort',
    label: '优先级',
    as: 'input-number',
    tips: '同维度取 sort 最小且生效期命中的一条',
    props: { min: 0 },
  },
  {
    field: 'remark',
    label: '备注',
    as: 'textarea',
    props: { placeholder: '选填', rows: 2 },
  },
];

function openCreate() {
  editingId.value = null;
  formKey.value += 1;
  modalVisible.value = true;
  void nextTick(() => {
    formRef.value?.setForm?.({
      name: '',
      scope: 'staff',
      targetId: undefined,
      staffId: undefined,
      category: undefined,
      permille: 0,
      fixedAmount: 0,
      base: 'paid',
      effectiveFrom: '',
      effectiveTo: '',
      status: true,
      sort: 0,
      remark: '',
    });
  });
}

function openEdit(row: CommissionRule) {
  editingId.value = row.id;
  formKey.value += 1;
  modalVisible.value = true;
  void nextTick(() => {
    formRef.value?.setForm?.({
      name: row.name,
      scope: row.scope,
      targetId: row.targetId ?? undefined,
      staffId: row.staffId ?? undefined,
      category: row.category ?? undefined,
      permille: row.permille,
      fixedAmount: row.fixedAmount / 100,
      base: row.base,
      effectiveFrom: row.effectiveFrom,
      effectiveTo: row.effectiveTo ?? '',
      status: row.status === 'active',
      sort: row.sort,
      remark: row.remark ?? '',
    });
  });
}

async function handleSubmit() {
  const valid = await formRef.value?.validate();
  if (!valid) return;
  const values = (formRef.value?.getForm?.() ??
    form.value) as typeof form.value;
  const scope = values.scope as CommissionScope;
  if (scope === 'staff' && !values.staffId) {
    LewMessage.error('请选择美甲师');
    return;
  }
  if (scope === 'category' && !values.category) {
    LewMessage.error('请选择项目分类');
    return;
  }
  if (scope === 'service_item' && !values.targetId) {
    LewMessage.error('请选择服务项目');
    return;
  }
  const permille = Number(values.permille ?? 0);
  const fixedAmount = yuan2fen(values.fixedAmount);
  if (permille <= 0 && fixedAmount <= 0) {
    LewMessage.error('比例与固定额至少填写一项');
    return;
  }
  if (permille > 1000) {
    LewMessage.error('比例不能超过 1000‰（100%）');
    return;
  }
  if (values.effectiveTo && values.effectiveTo < values.effectiveFrom) {
    LewMessage.error('生效结束日期不能早于开始日期');
    return;
  }
  const body: CommissionRuleBody = {
    name: values.name,
    scope,
    staffId: scope === 'staff' ? (values.staffId ?? null) : null,
    category: scope === 'category' ? (values.category ?? null) : null,
    targetId: scope === 'service_item' ? (values.targetId ?? null) : null,
    permille,
    fixedAmount,
    base: values.base,
    effectiveFrom: values.effectiveFrom,
    effectiveTo: values.effectiveTo || null,
    status: values.status ? 'active' : 'disabled',
    sort: Number(values.sort ?? 0),
    remark: values.remark || null,
  };
  if (editingId.value === null) {
    await createCommissionRule(body);
    LewMessage.success('创建成功');
  } else {
    await updateCommissionRule(editingId.value, body);
    LewMessage.success('更新成功（只影响之后计提）');
  }
  modalVisible.value = false;
  await refresh();
}

function handleDelete(row: CommissionRule) {
  confirmDanger({
    title: '删除确认',
    content: `确定删除提成规则「${row.name}」吗？软删后不再参与计提，历史记录保留 rule_id。`,
    onConfirm: async () => {
      await deleteCommissionRule(row.id);
      LewMessage.success('删除成功');
      await refresh();
    },
  });
}
</script>

<template>
  <div class="page-container">
    <!-- 页头 -->
    <div class="flex items-center justify-between">
      <div>
        <h2 class="page-title m-0">提成规则</h2>
        <p class="page-subtitle mt-1 mb-0">
          优先级：服务项目 &gt; 项目分类 &gt;
          美甲师；默认按实收计提；未命中规则不提成
        </p>
      </div>
      <LewButton
        v-permission="'biz:commission:rule'"
        type="fill"
        @click="openCreate"
      >
        <Plus :size="15" style="margin-right: 4px" /> 新增规则
      </LewButton>
    </div>

    <!-- 筛选 -->
    <div class="app-card flex items-center gap-3 p-4">
      <LewSelect
        v-model="query.scope"
        width="160px"
        :options="SCOPE_OPTIONS"
        placeholder="全部维度"
        clearable
      />
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
              permission="biz:commission:rule"
              title="编辑"
              @click="openEdit(row as unknown as CommissionRule)"
            >
              <Pencil :size="14" />
            </IconButton>
            <IconButton
              permission="biz:commission:rule"
              color="error"
              title="删除"
              @click="handleDelete(row as unknown as CommissionRule)"
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
      :title="editingId === null ? '新增提成规则' : '编辑提成规则'"
      width="560px"
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
