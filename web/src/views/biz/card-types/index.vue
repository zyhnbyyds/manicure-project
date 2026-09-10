<script setup lang="ts">
import { nextTick, reactive, ref } from 'vue';
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
  createCardType,
  deleteCardType,
  listServiceItemOptions,
  updateCardType,
} from '~/api/biz/card-types';
import type { CardType, CardTypeBody } from '~/api/biz/card-types';
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
} = useTable<CardType>({ url: '/biz/card-types', query: () => query.value });

const columns: LewTableColumn[] = [
  { title: 'ID', field: 'id', width: 70 },
  { title: '卡种名', field: 'name', width: 150 },
  {
    title: '售价(元)',
    field: 'price',
    width: 110,
    customRender: ({ row }) => fen2yuan((row as unknown as CardType).price),
  },
  { title: '总次数', field: 'totalTimes', width: 90 },
  {
    title: '有效期',
    field: 'validDays',
    width: 110,
    customRender: ({ row }) => {
      const validDays = (row as unknown as CardType).validDays;
      // 0 = 永久有效
      return validDays === 0 ? '永久' : `${validDays} 天`;
    },
  },
  {
    title: '适用项目',
    field: 'serviceItemIds',
    customRender: ({ row }) => {
      const cardType = row as unknown as CardType;
      const names = cardType.serviceItems?.map((item) => item.name) ?? [];
      if (names.length) return names.join('、');
      const count = cardType.serviceItemIds?.length ?? 0;
      return count ? `${count} 个项目` : '-';
    },
  },
  { title: '排序', field: 'sort', width: 80 },
  {
    title: '状态',
    field: 'status',
    width: 90,
    customRender: ({ row }) =>
      renderStatus((row as unknown as CardType).status),
  },
  { title: '备注', field: 'remark' },
  {
    title: '创建时间',
    field: 'createdAt',
    width: 170,
    customRender: ({ row }) =>
      formatDateTime((row as unknown as CardType).createdAt),
  },
  { title: '操作', field: 'operation', width: 100, fixed: 'right' },
];

void search();

// ---------- 适用项目下拉 ----------
const serviceItemOptions = reactive<{ label: string; value: number }[]>([]);
async function loadServiceItems() {
  const data = await listServiceItemOptions();
  serviceItemOptions.splice(
    0,
    serviceItemOptions.length,
    ...data.map((item) => ({ label: item.name, value: item.id })),
  );
}
void loadServiceItems();

// ---------- 新增 / 编辑 ----------
const modalVisible = ref(false);
const editingId = ref<number | null>(null);
const formRef = ref();
const form = ref({
  name: '',
  /** 元 */
  price: 0,
  totalTimes: 1,
  /** 0 = 永久有效 */
  validDays: 0,
  /** 适用项目（整体替换） */
  serviceItemIds: [] as number[],
  sort: 0,
  status: true,
  remark: '',
});
/** 表单 key：每次打开弹窗自增，强制重建 LewForm 以回填数据 */
const formKey = ref(0);

const formOptions: LewFormOption[] = [
  {
    field: 'name',
    label: '卡种名',
    as: 'input',
    rule: "Yup.string().required('不能为空')",
    props: { placeholder: '如 10 次美甲卡', clearable: true },
  },
  {
    field: 'price',
    label: '售价(元)',
    as: 'input-number',
    rule: "Yup.number().required('不能为空')",
    tips: '发卡时可改价；积分兑换发出的卡售价为 0',
    props: { min: 0, precision: 2 },
  },
  {
    field: 'totalTimes',
    label: '总次数',
    as: 'input-number',
    rule: "Yup.number().required('不能为空').min(1, '至少 1 次')",
    props: { min: 1, precision: 0 },
  },
  {
    field: 'validDays',
    label: '有效期(天)',
    as: 'input-number',
    tips: '0 = 永久有效',
    props: { min: 0, precision: 0 },
  },
  {
    field: 'serviceItemIds',
    label: '适用项目',
    as: 'select',
    rule: "Yup.array().min(1, '至少选择 1 个适用项目')",
    props: {
      options: serviceItemOptions,
      multiple: true,
      placeholder: '请选择适用项目（至少 1 个）',
    },
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
];

function openCreate() {
  editingId.value = null;
  formKey.value += 1;
  modalVisible.value = true;
  // LewForm 为受控组件，需在挂载后通过 setForm 填充
  void nextTick(() => {
    formRef.value?.setForm?.({
      name: '',
      price: 0,
      totalTimes: 1,
      validDays: 0,
      serviceItemIds: [],
      sort: 0,
      status: true,
      remark: '',
    });
  });
}

function openEdit(row: CardType) {
  editingId.value = row.id;
  formKey.value += 1;
  modalVisible.value = true;
  // 分 → 元回填；适用项目整体回填
  void nextTick(() => {
    formRef.value?.setForm?.({
      name: row.name,
      price: row.price / 100,
      totalTimes: row.totalTimes,
      validDays: row.validDays,
      serviceItemIds: row.serviceItemIds ?? [],
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
  const serviceItemIds = (values.serviceItemIds ?? []).map((id) => Number(id));
  if (!serviceItemIds.length) {
    LewMessage.error('请至少选择 1 个适用项目');
    return;
  }
  const body: CardTypeBody = {
    name: values.name,
    price: yuan2fen(values.price),
    totalTimes: Number(values.totalTimes ?? 1),
    validDays: Number(values.validDays ?? 0),
    // 适用项目为整体替换语义，直接传完整数组
    serviceItemIds,
    sort: Number(values.sort ?? 0),
    status: values.status ? 'active' : 'disabled',
    remark: values.remark || null,
  };
  if (editingId.value === null) {
    await createCardType(body);
    LewMessage.success('创建成功');
  } else {
    await updateCardType(editingId.value, body);
    LewMessage.success('更新成功');
  }
  modalVisible.value = false;
  void refresh();
}

// ---------- 删除 ----------
function handleDelete(row: CardType) {
  confirmDanger({
    title: '删除确认',
    content: `确定删除次卡卡种「${row.name}」吗？已发出的卡不受影响。`,
    onConfirm: async () => {
      await deleteCardType(row.id);
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
        <h2 class="page-title m-0">次卡卡种</h2>
        <p class="page-subtitle mt-1 mb-0">适用项目、次数与有效期</p>
      </div>
      <LewButton
        v-permission="'biz:cardtype:create'"
        type="fill"
        @click="openCreate"
      >
        <Plus :size="15" style="margin-right: 4px" /> 新增卡种
      </LewButton>
    </div>

    <!-- 搜索栏 -->
    <div class="app-card flex items-center gap-3 p-4">
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
              permission="biz:cardtype:update"
              title="编辑"
              @click="openEdit(row as unknown as CardType)"
            >
              <Pencil :size="14" />
            </IconButton>
            <IconButton
              permission="biz:cardtype:delete"
              color="error"
              title="删除"
              @click="handleDelete(row as unknown as CardType)"
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
      :title="editingId === null ? '新增卡种' : '编辑卡种'"
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
          label-width="88px"
        />
      </div>
    </LewModal>
  </div>
</template>
