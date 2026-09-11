<script setup lang="ts">
import { h, nextTick, reactive, ref } from 'vue';
import { Pencil, Plus, RotateCcw, Trash2 } from 'lucide-vue-next';
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
  LewTextarea,
} from 'lew-ui';
import type { LewFormOption, LewTableColumn } from 'lew-ui';
import { withPassThroughRule } from '~/utils/form';
import {
  createPointsGoods,
  deletePointsGoods,
  listPointsGoods,
  revertPointsRedeem,
  updatePointsGoods,
} from '~/api/biz/points-goods';
import type {
  PointsGoods,
  PointsGoodsBody,
  PointsRedeem,
} from '~/api/biz/points-goods';
import { listActiveCardTypes } from '~/api/biz/card-types';
import { listCustomers } from '~/api/biz/customers';
import { useTable } from '~/composables/useTable';
import { formatDateTime } from '~/composables/useFormat';
import { confirmDanger } from '~/utils/confirm';
import IconButton from '~/components/IconButton.vue';

const GOODS_URL = '/biz/points-goods';

const STATUS_OPTIONS = [
  { label: '启用', value: 'active' },
  { label: '禁用', value: 'disabled' },
];

// ---------- 卡种下拉 ----------
const cardTypeOptions = reactive<{ label: string; value: number }[]>([]);
async function loadCardTypes() {
  const cards = await listActiveCardTypes();
  cardTypeOptions.splice(
    0,
    cardTypeOptions.length,
    ...cards.map((card) => ({
      label: `${card.name}（${card.totalTimes} 次）`,
      value: card.id,
    })),
  );
}
void loadCardTypes();

// ---------- 兑换品列表 ----------
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
} = useTable<PointsGoods>({ url: GOODS_URL, query: () => query.value });

const columns: LewTableColumn[] = [
  { title: 'ID', field: 'id', width: 70 },
  { title: '兑换品名称', field: 'name', width: 170 },
  {
    title: '对应卡种',
    field: 'cardTypeName',
    width: 160,
    customRender: ({ row }) => {
      const goods = row as unknown as PointsGoods;
      return (
        goods.cardTypeName ??
        cardTypeOptions.find((option) => option.value === goods.cardTypeId)
          ?.label ??
        '-'
      );
    },
  },
  {
    title: '所需积分',
    field: 'points',
    width: 100,
    customRender: ({ row }) =>
      h(
        'span',
        { class: 'font-600 text-[var(--lew-color-warning)]' },
        String((row as unknown as PointsGoods).points),
      ),
  },
  {
    title: '库存',
    field: 'stock',
    width: 100,
    customRender: ({ row }) => {
      const stock = (row as unknown as PointsGoods).stock;
      if (stock < 0) return '不限';
      return stock === 0
        ? h('span', { class: 'text-[var(--lew-color-error)]' }, '0（已兑完）')
        : String(stock);
    },
  },
  {
    title: '每人限兑',
    field: 'perLimit',
    width: 100,
    customRender: ({ row }) => {
      const limit = (row as unknown as PointsGoods).perLimit;
      return limit === 0 ? '不限' : `${limit} 次`;
    },
  },
  {
    title: '状态',
    field: 'status',
    width: 80,
    customRender: ({ row }) =>
      (row as unknown as PointsGoods).status === 'active'
        ? h('span', { class: 'text-[var(--lew-color-success)]' }, '启用')
        : h('span', { class: 'text-[var(--lew-color-error)]' }, '禁用'),
  },
  { title: '排序', field: 'sort', width: 70 },
  {
    title: '创建时间',
    field: 'createdAt',
    width: 165,
    customRender: ({ row }) =>
      formatDateTime((row as unknown as PointsGoods).createdAt),
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
  cardTypeId: undefined as number | undefined,
  points: 0,
  stock: -1,
  perLimit: 0,
  status: true,
  sort: 0,
  remark: '',
});
/** 表单 key：每次打开弹窗自增，强制重建 LewForm 以回填数据 */
const formKey = ref(0);

const formOptions: LewFormOption[] = withPassThroughRule([
  {
    field: 'name',
    label: '兑换品名称',
    as: 'input',
    rule: "Yup.string().required('不能为空')",
    props: { placeholder: '如 1000 积分兑 1 次美甲', clearable: true },
  },
  {
    field: 'cardTypeId',
    label: '对应卡种',
    as: 'select',
    rule: "Yup.number().required('不能为空').typeError('请选择卡种')",
    props: { options: cardTypeOptions, placeholder: '兑换后发放的次卡卡种' },
  },
  {
    field: 'points',
    label: '所需积分',
    as: 'input-number',
    rule: "Yup.number().min(1, '必须大于 0').required('不能为空')",
    props: { min: 1 },
  },
  {
    field: 'stock',
    label: '库存',
    as: 'input-number',
    tips: '-1 = 不限库存；0 = 已兑完',
    props: { min: -1 },
  },
  {
    field: 'perLimit',
    label: '每人限兑',
    as: 'input-number',
    tips: '0 = 不限',
    props: { min: 0 },
  },
  { field: 'status', label: '状态', as: 'switch' },
  { field: 'sort', label: '排序', as: 'input-number', props: { min: 0 } },
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
      cardTypeId: undefined,
      points: 0,
      stock: -1,
      perLimit: 0,
      status: true,
      sort: 0,
      remark: '',
    });
  });
}

function openEdit(row: PointsGoods) {
  editingId.value = row.id;
  formKey.value += 1;
  modalVisible.value = true;
  void nextTick(() => {
    formRef.value?.setForm?.({
      name: row.name,
      cardTypeId: row.cardTypeId,
      points: row.points,
      stock: row.stock,
      perLimit: row.perLimit,
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
  if (!values.cardTypeId) {
    LewMessage.error('请选择对应卡种');
    return;
  }
  const body: PointsGoodsBody = {
    name: values.name,
    cardTypeId: values.cardTypeId,
    points: Number(values.points ?? 0),
    stock: Number(values.stock ?? -1),
    perLimit: Number(values.perLimit ?? 0),
    status: values.status ? 'active' : 'disabled',
    sort: Number(values.sort ?? 0),
    remark: values.remark || null,
  };
  if (editingId.value === null) {
    await createPointsGoods(body);
    LewMessage.success('创建成功');
  } else {
    await updatePointsGoods(editingId.value, body);
    LewMessage.success('更新成功');
  }
  modalVisible.value = false;
  await refresh();
}

function handleDelete(row: PointsGoods) {
  confirmDanger({
    title: '删除确认',
    content: `确定删除兑换品「${row.name}」吗？`,
    onConfirm: async () => {
      await deletePointsGoods(row.id);
      LewMessage.success('删除成功');
      await refresh();
    },
  });
}

// ---------- 兑换记录抽屉 ----------
const redeemVisible = ref(false);
const redeemGoodsOptions = reactive<{ label: string; value: string }[]>([]);
const redeemStatusOptions = [
  { label: '成功', value: 'success' },
  { label: '已撤销', value: 'reverted' },
];
const customerOptions = reactive<{ label: string; value: string }[]>([]);

const redeemQuery = ref<{
  customerId?: string;
  goodsId?: string;
  status?: string;
}>({});
const {
  items: redeemItems,
  loading: redeemLoading,
  currentPage: redeemPage,
  pageSize: redeemPageSize,
  total: redeemTotal,
  search: redeemSearch,
  refresh: redeemRefresh,
  handleChange: redeemPageChange,
} = useTable<PointsRedeem>({
  url: '/biz/points-redeems',
  query: () => redeemQuery.value,
});

const redeemColumns: LewTableColumn[] = [
  { title: '兑换单号', field: 'redeemNo', width: 160 },
  {
    title: '顾客',
    field: 'customerName',
    width: 120,
    customRender: ({ row }) =>
      (row as unknown as PointsRedeem).customerName ?? '-',
  },
  {
    title: '兑换品',
    field: 'goodsName',
    width: 150,
    customRender: ({ row }) =>
      (row as unknown as PointsRedeem).goodsName ?? '-',
  },
  {
    title: '扣减积分',
    field: 'points',
    width: 100,
    customRender: ({ row }) =>
      h(
        'span',
        { class: 'font-600 text-[var(--lew-color-warning)]' },
        String((row as unknown as PointsRedeem).points),
      ),
  },
  {
    title: '发放次卡',
    field: 'memberCardId',
    width: 150,
    customRender: ({ row }) => {
      const cardId = (row as unknown as PointsRedeem).memberCardId;
      return cardId ? `卡 #${cardId}` : '-';
    },
  },
  {
    title: '状态',
    field: 'status',
    width: 90,
    customRender: ({ row }) =>
      (row as unknown as PointsRedeem).status === 'success'
        ? h('span', { class: 'text-[var(--lew-color-success)]' }, '成功')
        : h('span', { class: 'text-[var(--app-text-muted)]' }, '已撤销'),
  },
  {
    title: '兑换时间',
    field: 'createdAt',
    width: 165,
    customRender: ({ row }) =>
      formatDateTime((row as unknown as PointsRedeem).createdAt),
  },
  { title: '操作', field: 'operation', width: 80, fixed: 'right' },
];

async function openRedeems(row?: PointsGoods) {
  redeemVisible.value = true;
  if (row) redeemQuery.value.goodsId = String(row.id);
  if (!redeemGoodsOptions.length) {
    const data = await listPointsGoods(1, 200);
    redeemGoodsOptions.splice(
      0,
      redeemGoodsOptions.length,
      ...data.items.map((goods) => ({
        label: goods.name,
        value: String(goods.id),
      })),
    );
  }
  if (!customerOptions.length) {
    const data = await listCustomers(1, 200);
    customerOptions.splice(
      0,
      customerOptions.length,
      ...data.items.map((customer) => ({
        label: customer.phone
          ? `${customer.name}（${customer.phone}）`
          : customer.name,
        value: String(customer.id),
      })),
    );
  }
  await redeemSearch();
}

// ---------- 撤销兑换 ----------
const revertVisible = ref(false);
const revertTarget = ref<PointsRedeem | null>(null);
const revertReason = ref('');

function openRevert(row: PointsRedeem) {
  revertTarget.value = row;
  revertReason.value = '';
  revertVisible.value = true;
}

async function handleRevert() {
  const target = revertTarget.value;
  if (!target) return;
  if (!revertReason.value.trim()) {
    LewMessage.error('请填写撤销原因');
    return;
  }
  confirmDanger({
    type: 'warning',
    title: '撤销兑换',
    content: `确定撤销兑换单「${target.redeemNo}」吗？将回补 ${target.points} 积分并作废对应次卡。`,
    confirmText: '撤销',
    onConfirm: async () => {
      await revertPointsRedeem(target.id, {
        reason: revertReason.value.trim(),
      });
      LewMessage.success('已撤销兑换');
      revertVisible.value = false;
      await redeemRefresh();
    },
  });
}
</script>

<template>
  <div class="page-container">
    <!-- 页头 -->
    <div class="flex items-center justify-between">
      <div>
        <h2 class="page-title m-0">积分兑换品</h2>
        <p class="page-subtitle mt-1 mb-0">
          兑换后发放对应次卡；库存 -1 不限，每人限兑 0 不限
        </p>
      </div>
      <div class="flex gap-2">
        <LewButton
          v-permission="'biz:points:redeem'"
          type="light"
          @click="openRedeems()"
        >
          <RotateCcw :size="15" style="margin-right: 4px" /> 兑换记录
        </LewButton>
        <LewButton
          v-permission="'biz:pointsgoods:create'"
          type="fill"
          @click="openCreate"
        >
          <Plus :size="15" style="margin-right: 4px" /> 新增兑换品
        </LewButton>
      </div>
    </div>

    <!-- 筛选 -->
    <div class="app-card flex items-center gap-3 p-4">
      <LewInput
        v-model="query.keyword"
        width="220px"
        placeholder="兑换品名称"
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
              permission="biz:points:redeem"
              title="兑换记录"
              @click="openRedeems(row as unknown as PointsGoods)"
            >
              <RotateCcw :size="14" />
            </IconButton>
            <IconButton
              permission="biz:pointsgoods:update"
              title="编辑"
              @click="openEdit(row as unknown as PointsGoods)"
            >
              <Pencil :size="14" />
            </IconButton>
            <IconButton
              permission="biz:pointsgoods:delete"
              color="error"
              title="删除"
              @click="handleDelete(row as unknown as PointsGoods)"
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
      :title="editingId === null ? '新增兑换品' : '编辑兑换品'"
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

    <!-- 兑换记录抽屉 -->
    <LewDrawer
      v-model:visible="redeemVisible"
      title="兑换记录"
      width="900px"
      hide-footer
    >
      <div class="flex flex-col gap-3 p-5">
        <div class="flex flex-wrap items-center gap-3">
          <LewSelect
            v-model="redeemQuery.customerId"
            width="200px"
            :options="customerOptions"
            placeholder="全部顾客"
            clearable
          />
          <LewSelect
            v-model="redeemQuery.goodsId"
            width="200px"
            :options="redeemGoodsOptions"
            placeholder="全部兑换品"
            clearable
          />
          <LewSelect
            v-model="redeemQuery.status"
            width="140px"
            :options="redeemStatusOptions"
            placeholder="全部状态"
            clearable
          />
          <LewButton
            type="light"
            :loading="redeemLoading"
            @click="redeemSearch()"
            >查询</LewButton
          >
        </div>

        <div class="app-card overflow-hidden">
          <LewTable
            :columns="redeemColumns"
            :data-source="redeemItems"
            :loading="redeemLoading"
            :focusable="false"
            size="small"
          >
            <template #operation="{ row }">
              <IconButton
                permission="biz:points:revert"
                color="error"
                title="撤销兑换"
                :disabled="
                  (row as unknown as PointsRedeem).status !== 'success'
                "
                @click="openRevert(row as unknown as PointsRedeem)"
              >
                <RotateCcw :size="14" />
              </IconButton>
            </template>
          </LewTable>

          <div class="flex justify-end p-3">
            <LewPagination
              v-model:current-page="redeemPage"
              v-model:page-size="redeemPageSize"
              :total="redeemTotal"
              @change="redeemPageChange"
            />
          </div>
        </div>
      </div>
    </LewDrawer>

    <!-- 撤销兑换弹窗 -->
    <LewModal v-model:visible="revertVisible" title="撤销兑换" width="460px">
      <div class="flex flex-col gap-3 p-5">
        <div class="text-13.5px">
          兑换单
          <span class="font-600">{{ revertTarget?.redeemNo }}</span>
          ，扣减
          <span class="font-600 text-[var(--lew-color-warning)]"
            >{{ revertTarget?.points }} 积分</span
          >
        </div>
        <p class="m-0 text-12.5px text-[var(--app-text-muted)]">
          撤销后回补积分并作废对应次卡，操作不可恢复。
        </p>
        <LewTextarea
          v-model="revertReason"
          min-height="90px"
          placeholder="请填写撤销原因（必填）"
        />
        <div class="flex justify-end gap-2">
          <LewButton type="text" color="gray" @click="revertVisible = false"
            >取消</LewButton
          >
          <LewButton
            v-permission="'biz:points:revert'"
            type="fill"
            color="error"
            @click="handleRevert"
            >确认撤销</LewButton
          >
        </div>
      </div>
    </LewModal>
  </div>
</template>
