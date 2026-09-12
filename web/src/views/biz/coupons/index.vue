<script setup lang="ts">
import { h, nextTick, ref } from 'vue';
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
  createCouponTemplate,
  deleteCouponTemplate,
  updateCouponTemplate,
} from '~/api/biz/coupons';
import type { CouponTemplate, CouponTemplateBody } from '~/api/biz/coupons';
import { useTable } from '~/composables/useTable';
import { formatDateTime } from '~/composables/useFormat';
import { confirmDanger } from '~/utils/confirm';
import IconButton from '~/components/IconButton.vue';

const TEMPLATE_URL = '/biz/coupon-templates';

const STATUS_OPTIONS = [
  { label: '启用', value: 'active' },
  { label: '停用', value: 'disabled' },
];

/** 分 → 元（展示用；不做任何折算，后端存的就是分） */
function fenToYuan(fen: number | null | undefined): string {
  if (fen === null || fen === undefined) return '-';
  return (fen / 100).toFixed(2);
}

/** 元 → 分（提交用；四舍五入到分，避免浮点误差落库） */
function yuanToFen(yuan: number | string | null | undefined): number {
  const value = Number(yuan ?? 0);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.round(value * 100);
}

// ---------- 列表 ----------
const query = ref<{ keyword?: string; status?: string }>({});
const {
  items,
  loading,
  currentPage,
  pageSize,
  total,
  search,
  refresh,
  handleChange,
} = useTable<CouponTemplate>({ url: TEMPLATE_URL, query: () => query.value });

const columns: LewTableColumn[] = [
  { title: 'ID', field: 'id', width: 70 },
  { title: '券名', field: 'name', width: 180 },
  {
    title: '使用门槛',
    field: 'thresholdAmount',
    width: 110,
    customRender: ({ row }) => {
      const value = (row as unknown as CouponTemplate).thresholdAmount;
      return value > 0 ? `满 ${fenToYuan(value)} 元` : '无门槛';
    },
  },
  {
    title: '面额',
    field: 'discountAmount',
    width: 110,
    customRender: ({ row }) =>
      h(
        'span',
        { class: 'font-600 text-[var(--lew-color-error)]' },
        `¥${fenToYuan((row as unknown as CouponTemplate).discountAmount)}`,
      ),
  },
  {
    title: '有效期',
    field: 'validDays',
    width: 140,
    customRender: ({ row }) => {
      const tpl = row as unknown as CouponTemplate;
      if (tpl.validDays > 0) return `领取后 ${tpl.validDays} 天`;
      if (tpl.validTo) return `至 ${formatDateTime(tpl.validTo)}`;
      return '长期有效';
    },
  },
  {
    title: '已发出',
    field: 'claimedCount',
    width: 90,
    // 停用前要看得到影响面：已经发出去多少张
    customRender: ({ row }) => {
      const count = (row as unknown as CouponTemplate).claimedCount;
      return count > 0
        ? h('span', { class: 'font-600' }, `${count} 张`)
        : h('span', { class: 'text-[var(--lew-color-info)]' }, '0');
    },
  },
  {
    title: '状态',
    field: 'status',
    width: 80,
    customRender: ({ row }) =>
      (row as unknown as CouponTemplate).status === 'active'
        ? h('span', { class: 'text-[var(--lew-color-success)]' }, '启用')
        : h('span', { class: 'text-[var(--lew-color-error)]' }, '停用'),
  },
  { title: '排序', field: 'sort', width: 70 },
  {
    title: '创建时间',
    field: 'createdAt',
    width: 165,
    customRender: ({ row }) =>
      formatDateTime((row as unknown as CouponTemplate).createdAt),
  },
  { title: '操作', field: 'operation', width: 100, fixed: 'right' },
];

void search();

// ---------- 新增 / 编辑 ----------
const modalVisible = ref(false);
const editingId = ref<number | null>(null);
const formRef = ref();
/**
 * 表单里金额用**元**（运营习惯），提交时换算成分。
 * `form` 只是 v-model 的落脚点，真实取值走 `formRef.getForm()`。
 */
const form = ref({
  name: '',
  thresholdYuan: 0,
  discountYuan: 0,
  validDays: 30,
  status: true,
  sort: 0,
  remark: '',
});
/** 表单 key：每次打开弹窗自增，强制重建 LewForm 以回填数据 */
const formKey = ref(0);

const formOptions: LewFormOption[] = withPassThroughRule([
  {
    field: 'name',
    label: '券名',
    as: 'input',
    rule: "Yup.string().required('不能为空').max(50, '最多 50 字')",
    props: { placeholder: '如 满 100 减 20', clearable: true },
  },
  {
    field: 'discountYuan',
    label: '面额（元）',
    as: 'input-number',
    rule: "Yup.number().min(0.01, '必须大于 0').required('不能为空')",
    props: { min: 0.01, precision: 2 },
  },
  {
    field: 'thresholdYuan',
    label: '门槛（元）',
    as: 'input-number',
    tips: '0 = 无门槛；应不小于面额',
    props: { min: 0, precision: 2 },
  },
  {
    field: 'validDays',
    label: '有效天数',
    as: 'input-number',
    tips: '从领取当天起算；0 = 长期有效',
    props: { min: 0 },
  },
  { field: 'status', label: '状态', as: 'switch' },
  { field: 'sort', label: '排序', as: 'input-number', props: { min: 0 } },
  {
    field: 'remark',
    label: '备注',
    as: 'textarea',
    props: { placeholder: '选填（仅后台可见）', rows: 2 },
  },
]);

function openCreate() {
  editingId.value = null;
  formKey.value += 1;
  modalVisible.value = true;
  void nextTick(() => {
    formRef.value?.setForm?.({
      name: '',
      thresholdYuan: 0,
      discountYuan: 0,
      validDays: 30,
      status: true,
      sort: 0,
      remark: '',
    });
  });
}

function openEdit(row: CouponTemplate) {
  editingId.value = row.id;
  formKey.value += 1;
  modalVisible.value = true;
  void nextTick(() => {
    formRef.value?.setForm?.({
      name: row.name,
      // 分 → 元（表单用元）
      thresholdYuan: row.thresholdAmount / 100,
      discountYuan: row.discountAmount / 100,
      validDays: row.validDays,
      status: row.status === 'active',
      sort: row.sort,
      remark: row.remark ?? '',
    });
  });
}

async function handleSubmit() {
  const valid = await formRef.value?.validate();
  if (!valid) return;
  const values = (formRef.value?.getForm?.() ?? form.value) as typeof form.value;

  const discountAmount = yuanToFen(values.discountYuan);
  const thresholdAmount = yuanToFen(values.thresholdYuan);
  // 前端先拦一道，省一次往返；后端的 assertTemplateInput 仍是权威
  if (discountAmount <= 0) {
    LewMessage.error('面额必须大于 0');
    return;
  }
  if (thresholdAmount > 0 && discountAmount > thresholdAmount) {
    LewMessage.error('面额不应大于使用门槛');
    return;
  }

  const body: CouponTemplateBody = {
    name: values.name,
    discountAmount,
    thresholdAmount,
    validDays: Number(values.validDays ?? 0),
    status: values.status ? 'active' : 'disabled',
    sort: Number(values.sort ?? 0),
    remark: values.remark || null,
  };
  if (editingId.value === null) {
    await createCouponTemplate(body);
    LewMessage.success('创建成功');
  } else {
    await updateCouponTemplate(editingId.value, body);
    LewMessage.success('更新成功');
  }
  modalVisible.value = false;
  await refresh();
}

function handleDelete(row: CouponTemplate) {
  confirmDanger({
    title: '停用确认',
    content:
      row.claimedCount > 0
        ? `「${row.name}」已经发出 ${row.claimedCount} 张。停用只影响以后发放，` +
          '顾客手里已有的券仍然可用。确定停用吗？'
        : `确定停用「${row.name}」吗？`,
    onConfirm: async () => {
      await deleteCouponTemplate(row.id);
      LewMessage.success('已停用');
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
        <h2 class="page-title m-0">优惠券模板</h2>
        <p class="page-subtitle mt-1 mb-0">
          模板是「以后还发不发」的开关；停用不影响顾客手里已有的券（面额与门槛在发券时已快照）
        </p>
      </div>
      <div class="flex gap-2">
        <LewButton
          v-permission="'biz:coupon:create'"
          type="fill"
          @click="openCreate"
        >
          <Plus :size="15" style="margin-right: 4px" /> 新增券模板
        </LewButton>
      </div>
    </div>

    <!-- 筛选 -->
    <div class="app-card flex items-center gap-3 p-4">
      <LewInput
        v-model="query.keyword"
        width="220px"
        placeholder="券名"
        clearable
        @enter="search()"
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
              permission="biz:coupon:update"
              title="编辑"
              @click="openEdit(row as unknown as CouponTemplate)"
            >
              <Pencil :size="14" />
            </IconButton>
            <IconButton
              permission="biz:coupon:delete"
              color="error"
              title="停用"
              @click="handleDelete(row as unknown as CouponTemplate)"
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
      :title="editingId === null ? '新增券模板' : '编辑券模板'"
      width="500px"
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
          label-width="92px"
        />
      </div>
    </LewModal>
  </div>
</template>
