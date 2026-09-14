<script setup lang="ts">
import { computed, h, nextTick, ref } from 'vue';
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
import { numberProps, withPassThroughRule } from '~/utils/form';
import {
  createMemberLevel,
  deleteMemberLevel,
  updateMemberLevel,
} from '~/api/biz/member-levels';
import type { MemberLevel, MemberLevelBody } from '~/api/biz/member-levels';
import { useTable } from '~/composables/useTable';
import { formatDateTime } from '~/composables/useFormat';
import { renderStatus } from '~/utils/render';
import { confirmDanger } from '~/utils/confirm';
import IconButton from '~/components/IconButton.vue';

// ---------- 金额 / 折扣工具 ----------
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
/** 千分比 → 折扣文案：1000 = 不打折，950 = 9.5 折 */
function permilleLabel(permille: number): string {
  if (!Number.isFinite(permille) || permille >= 1000) return '不打折';
  return `${(permille / 100).toFixed(1)} 折`;
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
} = useTable<MemberLevel>({
  url: '/biz/member-levels',
  query: () => query.value,
});

const columns: LewTableColumn[] = [
  { title: 'ID', field: 'id', width: 70 },
  { title: '等级名', field: 'name', width: 140 },
  {
    title: '折扣',
    field: 'discountPermille',
    width: 110,
    customRender: ({ row }) => {
      const permille = (row as unknown as MemberLevel).discountPermille;
      if (permille >= 1000) {
        return h('span', { class: 'text-[var(--app-text-muted)]' }, '不打折');
      }
      return permilleLabel(permille);
    },
  },
  {
    title: '升级门槛(元)',
    field: 'upgradeAmount',
    width: 120,
    customRender: ({ row }) =>
      fen2yuan((row as unknown as MemberLevel).upgradeAmount),
  },
  { title: '排序', field: 'sort', width: 80 },
  {
    title: '状态',
    field: 'status',
    width: 90,
    customRender: ({ row }) =>
      renderStatus((row as unknown as MemberLevel).status),
  },
  { title: '备注', field: 'remark' },
  {
    title: '创建时间',
    field: 'createdAt',
    width: 170,
    customRender: ({ row }) =>
      formatDateTime((row as unknown as MemberLevel).createdAt),
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
  /** 千分比：950 = 9.5 折（1000‰ = 不打折不允许配置，故默认给 950） */
  discountPermille: 950,
  /** 元 */
  upgradeAmount: 0,
  sort: 0,
  status: true,
  remark: '',
});
/** 表单 key：每次打开弹窗自增，强制重建 LewForm 以回填数据 */
const formKey = ref(0);

/**
 * LewForm 是受控组件，内部维护自己的 formData，**不会**通过 v-model 回写父级；
 * 实时换算提示必须靠 `@change`（LewForm 在字段变化后会带上完整表单数据）同步本地副本。
 * 提交时仍以 getForm() 为准。
 */
function onFormChange(values: unknown) {
  form.value = { ...form.value, ...(values as Partial<typeof form.value>) };
}

/** 折扣率实时换算提示（千分比 → 折） */
const discountHint = computed(() => {
  const permille = Number(form.value.discountPermille ?? 0);
  if (!Number.isFinite(permille) || permille <= 0) {
    return '请输入 1~999 之间的千分比，如 950';
  }
  if (permille >= 1000) return '1000‰ = 不打折，不允许配置';
  return `≈ ${(permille / 100).toFixed(1)} 折`;
});

const formOptions: LewFormOption[] = withPassThroughRule([
  {
    field: 'name',
    label: '等级名',
    as: 'input',
    rule: "Yup.string().required('不能为空')",
    props: { placeholder: '如 黄金会员', clearable: true },
  },
  {
    field: 'discountPermille',
    label: '折扣率(‰)',
    as: 'input-number',
    rule: "Yup.number().required('不能为空')",
    tips: '千分比：950 = 9.5 折，1000 = 不打折；必须大于 0 且小于 1000',
    props: numberProps({ min: 0 }),
  },
  {
    field: 'upgradeAmount',
    label: '升级门槛(元)',
    as: 'input-number',
    tips: '累计消费达到该金额后自动升级（只升不降）',
    props: numberProps({ min: 0, decimals: 2 }),
  },
  {
    field: 'sort',
    label: '排序',
    as: 'input-number',
    tips: '由低到高，门槛必须随排序单调不减',
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
      discountPermille: 950,
      upgradeAmount: 0,
      sort: 0,
      status: true,
      remark: '',
    });
  });
}

function openEdit(row: MemberLevel) {
  editingId.value = row.id;
  formKey.value += 1;
  modalVisible.value = true;
  // 分 → 元回填
  void nextTick(() => {
    formRef.value?.setForm?.({
      name: row.name,
      discountPermille: row.discountPermille,
      upgradeAmount: row.upgradeAmount / 100,
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
  const permille = Number(values.discountPermille ?? 0);
  // 1000‰ = 不打折（应把等级配置成「启用但无折扣」以外的形态），不允许保存
  if (!Number.isFinite(permille) || permille <= 0 || permille >= 1000) {
    LewMessage.error('折扣率必须大于 0 且小于 1000‰（1000‰ = 不打折，不允许）');
    return;
  }
  const body: MemberLevelBody = {
    name: values.name,
    discountPermille: permille,
    upgradeAmount: yuan2fen(values.upgradeAmount),
    sort: Number(values.sort ?? 0),
    status: values.status ? 'active' : 'disabled',
    remark: values.remark || null,
  };
  if (editingId.value === null) {
    await createMemberLevel(body);
    LewMessage.success('创建成功');
  } else {
    await updateMemberLevel(editingId.value, body);
    LewMessage.success('更新成功');
  }
  modalVisible.value = false;
  void refresh();
}

// ---------- 删除 ----------
function handleDelete(row: MemberLevel) {
  confirmDanger({
    title: '删除确认',
    content: `确定删除会员等级「${row.name}」吗？有会员在该等级时会被拒绝。`,
    onConfirm: async () => {
      // 后端在「有会员在该等级」时返回 409，request 拦截器会把后端提示原样弹出
      await deleteMemberLevel(row.id);
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
        <h2 class="page-title m-0">会员等级</h2>
        <p class="page-subtitle mt-1 mb-0">等级折扣率与升级门槛</p>
      </div>
      <LewButton
        v-permission="'biz:memberlevel:create'"
        type="fill"
        @click="openCreate"
      >
        <Plus :size="15" style="margin-right: 4px" /> 新增等级
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
              permission="biz:memberlevel:update"
              title="编辑"
              @click="openEdit(row as unknown as MemberLevel)"
            >
              <Pencil :size="14" />
            </IconButton>
            <IconButton
              permission="biz:memberlevel:delete"
              color="error"
              title="删除"
              @click="handleDelete(row as unknown as MemberLevel)"
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
      :title="editingId === null ? '新增会员等级' : '编辑会员等级'"
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
          @change="onFormChange"
        />
        <!-- 折扣率实时换算 -->
        <p class="mt-3 mb-0 text-12.5px text-[var(--app-text-muted)]">
          当前折扣率换算：{{ discountHint }}
        </p>
      </div>
    </LewModal>
  </div>
</template>
