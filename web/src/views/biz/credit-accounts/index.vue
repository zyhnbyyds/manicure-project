<script setup lang="ts">
import { h, nextTick, reactive, ref } from 'vue';
import { Pencil, Plus, Trash2 } from 'lucide-vue-next';
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
import { withPassThroughRule } from '~/utils/form';
import {
  createCreditAccount,
  deleteCreditAccount,
  listCustomerOptions,
  updateCreditAccount,
} from '~/api/biz/credit-accounts';
import type {
  CreditAccount,
  CreditAccountBody,
  CreditAccountType,
} from '~/api/biz/credit-accounts';
import { useTable } from '~/composables/useTable';
import { formatDateTime } from '~/composables/useFormat';
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

const TYPE_OPTIONS = [
  { label: '顾客', value: 'customer' },
  { label: '公司', value: 'company' },
  { label: '员工', value: 'staff' },
];
const TYPE_LABELS: Record<CreditAccountType, string> = {
  customer: '顾客',
  company: '公司',
  staff: '员工',
};
const STATUS_OPTIONS = [
  { label: '启用', value: 'active' },
  { label: '禁用', value: 'disabled' },
];

// ---------- 列表 ----------
const query = ref<{ keyword?: string; type?: string; status?: string }>({});
const {
  items,
  loading,
  currentPage,
  pageSize,
  total,
  search,
  refresh,
  handleChange,
} = useTable<CreditAccount>({
  url: '/biz/credit-accounts',
  query: () => query.value,
});

const columns: LewTableColumn[] = [
  { title: 'ID', field: 'id', width: 70 },
  { title: '主体名称', field: 'name', width: 160 },
  {
    title: '类型',
    field: 'type',
    width: 80,
    customRender: ({ row }) =>
      TYPE_LABELS[(row as unknown as CreditAccount).type] ?? '-',
  },
  {
    title: '关联顾客',
    field: 'customerName',
    width: 120,
    customRender: ({ row }) =>
      (row as unknown as CreditAccount).customerName ?? '-',
  },
  { title: '联系人', field: 'contact', width: 100 },
  { title: '电话', field: 'phone', width: 130 },
  {
    title: '额度',
    field: 'creditLimit',
    width: 110,
    customRender: ({ row }) => {
      const account = row as unknown as CreditAccount;
      return account.creditLimit === 0
        ? h('span', { class: 'text-[var(--app-text-muted)]' }, '不限')
        : `¥${fen2yuan(account.creditLimit)}`;
    },
  },
  {
    title: '已挂未结',
    field: 'usedAmount',
    width: 110,
    customRender: ({ row }) => {
      const account = row as unknown as CreditAccount;
      return h(
        'span',
        {
          class:
            account.usedAmount > 0
              ? 'text-[var(--lew-color-warning)] font-600'
              : '',
        },
        `¥${fen2yuan(account.usedAmount)}`,
      );
    },
  },
  {
    title: '可用额度',
    field: 'available',
    width: 110,
    customRender: ({ row }) => {
      const account = row as unknown as CreditAccount;
      if (account.creditLimit === 0) return '不限';
      const available = account.creditLimit - account.usedAmount;
      return h(
        'span',
        {
          class: available <= 0 ? 'text-[var(--lew-color-error)] font-600' : '',
        },
        `¥${fen2yuan(available)}`,
      );
    },
  },
  {
    title: '月结日',
    field: 'settleDay',
    width: 90,
    customRender: ({ row }) => {
      const day = (row as unknown as CreditAccount).settleDay;
      return day === 0 ? '不定期' : `每月 ${day} 日`;
    },
  },
  {
    title: '状态',
    field: 'status',
    width: 80,
    customRender: ({ row }) =>
      (row as unknown as CreditAccount).status === 'active'
        ? h('span', { class: 'text-[var(--lew-color-success)]' }, '启用')
        : h('span', { class: 'text-[var(--lew-color-error)]' }, '禁用'),
  },
  { title: '备注', field: 'remark' },
  {
    title: '创建时间',
    field: 'createdAt',
    width: 165,
    customRender: ({ row }) =>
      formatDateTime((row as unknown as CreditAccount).createdAt),
  },
  { title: '操作', field: 'operation', width: 100, fixed: 'right' },
];

void search();

// ---------- 关联顾客下拉 ----------
const customerOptions = reactive<{ label: string; value: number }[]>([]);
async function loadCustomers() {
  const data = await listCustomerOptions();
  customerOptions.splice(
    0,
    customerOptions.length,
    ...data.items.map((customer) => ({
      label: customer.phone
        ? `${customer.name}（${customer.phone}）`
        : customer.name,
      value: customer.id,
    })),
  );
}
void loadCustomers();

// ---------- 新增 / 编辑 ----------
const modalVisible = ref(false);
const editingId = ref<number | null>(null);
const formRef = ref();
const form = ref({
  name: '',
  type: 'customer' as CreditAccountType,
  customerId: undefined as number | undefined,
  contact: '',
  phone: '',
  /** 元 */
  creditLimit: 0,
  settleDay: 0,
  status: true,
  remark: '',
});
/** 表单 key：每次打开弹窗自增，强制重建 LewForm 以回填数据 */
const formKey = ref(0);

const formOptions: LewFormOption[] = withPassThroughRule([
  {
    field: 'name',
    label: '主体名称',
    as: 'input',
    rule: "Yup.string().required('不能为空')",
    props: { placeholder: '如 XX 公司 / 张三', clearable: true },
  },
  {
    field: 'type',
    label: '类型',
    as: 'select',
    rule: "Yup.string().required('不能为空')",
    props: { options: TYPE_OPTIONS },
  },
  {
    field: 'customerId',
    label: '关联顾客',
    as: 'select',
    // 只有「顾客」类型才需要关联档案
    visible: (formData: Record<string, unknown>) =>
      formData.type === 'customer',
    props: {
      options: customerOptions,
      placeholder: '请选择顾客',
      clearable: true,
    },
  },
  {
    field: 'contact',
    label: '联系人',
    as: 'input',
    props: { placeholder: '选填', clearable: true },
  },
  {
    field: 'phone',
    label: '联系电话',
    as: 'input',
    props: { placeholder: '选填', clearable: true },
  },
  {
    field: 'creditLimit',
    label: '额度(元)',
    as: 'input-number',
    tips: '0 = 不限额度',
    props: { min: 0, precision: 2 },
  },
  {
    field: 'settleDay',
    label: '月结日',
    as: 'input-number',
    tips: '1~28，0 = 不定期（应收无到期日）',
    props: { min: 0, max: 28 },
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
  void nextTick(() => {
    formRef.value?.setForm?.({
      name: '',
      type: 'customer',
      customerId: undefined,
      contact: '',
      phone: '',
      creditLimit: 0,
      settleDay: 0,
      status: true,
      remark: '',
    });
  });
}

function openEdit(row: CreditAccount) {
  editingId.value = row.id;
  formKey.value += 1;
  modalVisible.value = true;
  void nextTick(() => {
    formRef.value?.setForm?.({
      name: row.name,
      type: row.type,
      customerId: row.customerId ?? undefined,
      contact: row.contact ?? '',
      phone: row.phone ?? '',
      creditLimit: row.creditLimit / 100,
      settleDay: row.settleDay,
      status: row.status === 'active',
      remark: row.remark ?? '',
    });
  });
}

async function handleSubmit() {
  const valid = await formRef.value?.validate();
  if (!valid) return;
  const values = (formRef.value?.getForm?.() ??
    form.value) as typeof form.value;
  const type = values.type as CreditAccountType;
  // 月结日只允许 1..28 或 0
  const settleDay = Number(values.settleDay ?? 0);
  if (settleDay !== 0 && (settleDay < 1 || settleDay > 28)) {
    LewMessage.error('月结日只能是 1~28，或填 0 表示不定期');
    return;
  }
  const body: CreditAccountBody = {
    name: values.name,
    type,
    customerId: type === 'customer' ? (values.customerId ?? null) : null,
    contact: values.contact || null,
    phone: values.phone || null,
    creditLimit: yuan2fen(values.creditLimit),
    settleDay,
    status: values.status ? 'active' : 'disabled',
    remark: values.remark || null,
  };
  if (editingId.value === null) {
    await createCreditAccount(body);
    LewMessage.success('创建成功');
  } else {
    await updateCreditAccount(editingId.value, body);
    LewMessage.success('更新成功');
  }
  modalVisible.value = false;
  void refresh();
}

// ---------- 删除 ----------
function handleDelete(row: CreditAccount) {
  confirmDanger({
    title: '删除确认',
    content: `确定删除挂账主体「${row.name}」吗？有未结应收时会被拒绝。`,
    onConfirm: async () => {
      // 后端在「有未结应收」时返回 409，request 拦截器会把后端提示原样弹出
      await deleteCreditAccount(row.id);
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
        <h2 class="page-title m-0">挂账主体</h2>
        <p class="page-subtitle mt-1 mb-0">
          维护可挂账的顾客 / 公司 / 员工，额度 0 表示不限
        </p>
      </div>
      <LewButton
        v-permission="'biz:credit:create'"
        type="fill"
        @click="openCreate"
      >
        <Plus :size="15" style="margin-right: 4px" /> 新增主体
      </LewButton>
    </div>

    <!-- 搜索栏 -->
    <div class="app-card flex items-center gap-3 p-4">
      <LewInput
        v-model="query.keyword"
        width="200px"
        placeholder="主体名称 / 联系人 / 电话"
        clearable
        @enter="search()"
      />
      <LewSelect
        v-model="query.type"
        width="140px"
        :options="TYPE_OPTIONS"
        placeholder="全部类型"
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
              permission="biz:credit:update"
              title="编辑"
              @click="openEdit(row as unknown as CreditAccount)"
            >
              <Pencil :size="14" />
            </IconButton>
            <IconButton
              permission="biz:credit:delete"
              color="error"
              title="删除"
              @click="handleDelete(row as unknown as CreditAccount)"
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
      :title="editingId === null ? '新增挂账主体' : '编辑挂账主体'"
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
          label-width="88px"
        />
      </div>
    </LewModal>
  </div>
</template>
