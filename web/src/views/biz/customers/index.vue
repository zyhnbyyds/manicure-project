<script setup lang="ts">
import { h, nextTick, ref } from 'vue';
import {
  History,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Trash2,
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
} from 'lew-ui';
import type { LewFormOption, LewTableColumn } from 'lew-ui';
import { withPassThroughRule } from '~/utils/form';
import {
  createCustomer,
  deleteCustomer,
  getCustomer,
  recountCustomer,
  restoreCustomer,
  updateCustomer,
} from '~/api/biz/customers';
import type {
  CreateCustomerBody,
  Customer,
  CustomerBooking,
} from '~/api/biz/customers';
import type { BookingPayStatus, BookingStatus } from '~/api/biz/bookings';
import { useTable } from '~/composables/useTable';
import { formatDateTime } from '~/composables/useFormat';
import { confirmDanger } from '~/utils/confirm';
import { trimCell } from '~/utils/table-text';
import IconButton from '~/components/IconButton.vue';

/** 枚举 → 中文展示（以后端枚举值为准，不另造字符串） */
const bookingStatusText: Record<BookingStatus, string> = {
  pending: '待确认',
  confirmed: '已确认',
  arrived: '已到店',
  completed: '已完成',
  cancelled: '已取消',
  no_show: '爽约',
};

const payStatusText: Record<BookingPayStatus, string> = {
  unpaid: '未收款',
  partial: '部分收款',
  refunded: '已退款',
  paid: '已结清',
  credit: '挂账',
};

const genderText: Record<Customer['gender'], string> = {
  unknown: '未知',
  male: '男',
  female: '女',
};

/** 金额：接口是「分」，展示「元」 */
function money(cents: number | null | undefined): string {
  return `¥ ${((cents ?? 0) / 100).toFixed(2)}`;
}

// ---------- 列表 ----------
const balanceOptions = [
  { label: '有储值余额', value: 'true' },
  { label: '无储值余额', value: 'false' },
];
const customerStatusOptions = [
  { label: '在用档案', value: 'active' },
  { label: '已删除档案', value: 'deleted' },
];

const query = ref<{
  keyword?: string;
  hasBalance?: string;
  status?: 'active' | 'deleted';
}>({ status: 'active' });

const {
  items,
  loading,
  currentPage,
  pageSize,
  total,
  search,
  refresh,
  handleChange,
} = useTable<Customer>({
  url: '/biz/customers',
  query: () => ({
    ...(query.value.keyword ? { keyword: query.value.keyword } : {}),
    ...(query.value.hasBalance ? { hasBalance: query.value.hasBalance } : {}),
    ...(query.value.status ? { status: query.value.status } : {}),
  }),
});

const columns: LewTableColumn[] = [
  { title: 'ID', field: 'id', width: 70 },
  { title: '姓名', field: 'name', width: 120 },
  {
    title: '手机号',
    field: 'phone',
    width: 130,
    customRender: ({ row }) => (row as unknown as Customer).phone ?? '-',
  },
  {
    title: '性别',
    field: 'gender',
    width: 70,
    customRender: ({ row }) =>
      genderText[(row as unknown as Customer).gender] ?? '-',
  },
  {
    title: '会员号',
    field: 'memberNo',
    width: 130,
    customRender: ({ row }) => (row as unknown as Customer).memberNo ?? '-',
  },
  {
    title: '到店次数',
    field: 'visitCount',
    width: 90,
    customRender: ({ row }) => (row as unknown as Customer).visitCount ?? 0,
  },
  {
    title: '最近到店',
    field: 'lastVisitAt',
    width: 160,
    customRender: ({ row }) =>
      formatDateTime((row as unknown as Customer).lastVisitAt),
  },
  {
    title: '累计消费',
    field: 'totalSpent',
    width: 110,
    customRender: ({ row }) =>
      h(
        'span',
        { class: 'tabular-nums' },
        money((row as unknown as Customer).totalSpent),
      ),
  },
  {
    title: '积分',
    field: 'points',
    width: 80,
    customRender: ({ row }) => (row as unknown as Customer).points ?? 0,
  },
  {
    title: '储值余额',
    field: 'balance',
    width: 120,
    customRender: ({ row }) => {
      const customer = row as unknown as Customer;
      return h(
        'span',
        { class: 'tabular-nums' },
        money(customer.balancePrincipal + customer.balanceBonus),
      );
    },
  },
  {
    title: '备注',
    field: 'remark',
    customRender: ({ row }) => {
      const text = (row as unknown as Customer).remark;
      return trimCell(text);
    },
  },
  {
    title: '状态',
    field: 'deletedAt',
    width: 100,
    customRender: ({ row }) => {
      const customer = row as unknown as Customer;
      return customer.deletedAt
        ? h('span', { class: 'text-[var(--lew-color-error)]' }, '已删除')
        : h('span', { class: 'text-[var(--lew-color-success)]' }, '在用');
    },
  },
  { title: '操作', field: 'operation', width: 150, fixed: 'right' },
];

void search();

// ---------- 新增 / 编辑 ----------
type FormValues = {
  name: string;
  phone: string;
  gender: Customer['gender'];
  birthday: string;
  remark: string;
};

function emptyForm(): FormValues {
  return { name: '', phone: '', gender: 'unknown', birthday: '', remark: '' };
}

const modalVisible = ref(false);
const editingId = ref<number | null>(null);
const formRef = ref();
const form = ref<FormValues>(emptyForm());
/** 表单 key：每次打开弹窗自增，强制重建 LewForm 以回填数据 */
const formKey = ref(0);

const formOptions: LewFormOption[] = withPassThroughRule([
  {
    field: 'name',
    label: '姓名',
    as: 'input',
    rule: "Yup.string().required('不能为空')",
    props: { placeholder: '如 张女士', clearable: true },
  },
  {
    field: 'phone',
    label: '手机号',
    as: 'input',
    tips: '选填（散客可不填）；手机号唯一，重复会被拒绝',
    props: { placeholder: '如 13800000002', clearable: true },
  },
  {
    field: 'gender',
    label: '性别',
    as: 'select',
    props: {
      options: [
        { label: '未知', value: 'unknown' },
        { label: '女', value: 'female' },
        { label: '男', value: 'male' },
      ],
    },
  },
  {
    field: 'birthday',
    label: '生日',
    as: 'date-picker',
    rule: 'Yup.string().nullable()',
    props: {
      valueFormat: 'YYYY-MM-DD',
      placeholder: '选填',
      clearable: true,
    },
  },
  {
    field: 'remark',
    label: '备注',
    as: 'textarea',
    props: { placeholder: '选填，如偏好裸色系', rows: 2 },
  },
]);

function openCreate() {
  editingId.value = null;
  formKey.value += 1;
  modalVisible.value = true;
  void nextTick(() => {
    formRef.value?.setForm?.(emptyForm());
  });
}

function openEdit(row: Customer) {
  editingId.value = row.id;
  formKey.value += 1;
  modalVisible.value = true;
  void nextTick(() => {
    formRef.value?.setForm?.({
      name: row.name,
      phone: row.phone ?? '',
      gender: row.gender,
      birthday: row.birthday ?? '',
      remark: row.remark ?? '',
    });
  });
}

async function handleSubmit() {
  const valid = await formRef.value?.validate();
  if (!valid) return;
  const values = (formRef.value?.getForm?.() ?? form.value) as FormValues;
  const body: CreateCustomerBody = {
    name: values.name,
    phone: values.phone || null,
    gender: values.gender,
    birthday: values.birthday || null,
    remark: values.remark || null,
  };
  try {
    if (editingId.value === null) {
      await createCustomer(body);
      LewMessage.success('创建成功');
    } else {
      await updateCustomer(editingId.value, body);
      LewMessage.success('更新成功');
    }
  } catch {
    // 手机号重复等 409 的原文提示由 request 拦截器统一弹出，弹窗保持打开以便修改
    return;
  }
  modalVisible.value = false;
  void refresh();
}

// ---------- 删除 ----------
function handleDelete(row: Customer) {
  confirmDanger({
    title: '删除确认',
    content: `确定删除顾客「${row.name}」吗？存在预约记录时会被拒绝。`,
    onConfirm: async () => {
      try {
        await deleteCustomer(row.id);
        LewMessage.success('删除成功');
        void refresh();
      } catch {
        // 409 原文提示由 request 拦截器统一弹出
      }
    },
  });
}

function handleRestore(row: Customer) {
  confirmDanger({
    type: 'normal',
    confirmColor: 'primary',
    confirmText: '恢复',
    title: '恢复顾客档案',
    content:
      `确定恢复顾客「${row.name}」吗？恢复后会一并恢复其余额、积分、会员与次卡历史，` +
      '小程序可重新绑定该手机号。',
    onConfirm: async () => {
      await restoreCustomer(row.id);
      LewMessage.success('恢复成功');
      void refresh();
    },
  });
}

// ---------- 重算到店统计 ----------
function handleRecount(row: Customer) {
  confirmDanger({
    type: 'normal',
    confirmColor: 'primary',
    confirmText: '重算',
    title: '重算到店统计',
    content: `将按「已完成」的预约重新计算「${row.name}」的到店次数与最近到店时间（幂等，可反复执行）。`,
    onConfirm: async () => {
      const result = await recountCustomer(row.id);
      LewMessage.success(
        `重算完成：到店 ${result.visitCount} 次${
          result.lastVisitAt
            ? `，最近 ${formatDateTime(result.lastVisitAt)}`
            : ''
        }`,
      );
      void refresh();
    },
  });
}

// ---------- 历史预约抽屉 ----------
const drawerVisible = ref(false);
const selectedCustomer = ref<Customer | null>(null);

const {
  items: customerBookings,
  loading: bookingsLoading,
  currentPage: historyPage,
  pageSize: historyPageSize,
  total: historyTotal,
  search: searchHistory,
  handleChange: handleHistoryChange,
} = useTable<CustomerBooking>({
  // url 用 getter：抽屉打开时才确定顾客 id
  get url() {
    return `/biz/customers/${selectedCustomer.value?.id ?? 0}/bookings`;
  },
});

const historyColumns: LewTableColumn[] = [
  { title: '单号', field: 'bookingNo', width: 170 },
  {
    title: '开始时间',
    field: 'startAt',
    width: 160,
    customRender: ({ row }) =>
      formatDateTime((row as unknown as CustomerBooking).startAt),
  },
  {
    title: '时长',
    field: 'durationMinutes',
    width: 80,
    customRender: ({ row }) =>
      `${(row as unknown as CustomerBooking).durationMinutes} 分钟`,
  },
  {
    title: '项目',
    field: 'items',
    customRender: ({ row }) => {
      const list = (row as unknown as CustomerBooking).items ?? [];
      return list.length ? list.map((item) => item.name).join('、') : '-';
    },
  },
  {
    title: '应付',
    field: 'payableAmount',
    width: 110,
    customRender: ({ row }) =>
      h(
        'span',
        { class: 'tabular-nums' },
        money((row as unknown as CustomerBooking).payableAmount),
      ),
  },
  {
    title: '已收',
    field: 'paidAmount',
    width: 110,
    customRender: ({ row }) =>
      h(
        'span',
        { class: 'tabular-nums' },
        money((row as unknown as CustomerBooking).paidAmount),
      ),
  },
  {
    title: '服务状态',
    field: 'status',
    width: 90,
    customRender: ({ row }) =>
      bookingStatusText[(row as unknown as CustomerBooking).status] ?? '-',
  },
  {
    title: '资金状态',
    field: 'payStatus',
    width: 90,
    customRender: ({ row }) =>
      payStatusText[(row as unknown as CustomerBooking).payStatus] ?? '-',
  },
];

async function openHistory(row: Customer) {
  drawerVisible.value = true;
  // 详情接口会带上最新的会员字段，抽屉里展示更准
  selectedCustomer.value = row;
  void searchHistory();
  try {
    selectedCustomer.value = await getCustomer(row.id);
  } catch {
    // 详情失败时沿用列表行数据
  }
}
</script>

<template>
  <div class="page-container">
    <!-- 页头 -->
    <div class="flex items-center justify-between">
      <div>
        <h2 class="page-title m-0">顾客档案</h2>
        <p class="page-subtitle mt-1 mb-0">
          顾客即会员档案；到店统计由「已完成」预约驱动，可手动重算
        </p>
      </div>
      <LewButton
        v-permission="'biz:customer:create'"
        type="fill"
        @click="openCreate"
      >
        <Plus :size="15" style="margin-right: 4px" /> 新增顾客
      </LewButton>
    </div>

    <!-- 搜索栏 -->
    <div class="app-card flex flex-wrap items-center gap-3 p-4">
      <LewInput
        v-model="query.keyword"
        width="220px"
        placeholder="姓名 / 手机号"
        clearable
        @keyup.enter="search()"
      />
      <LewSelect
        v-model="query.hasBalance"
        width="160px"
        :options="balanceOptions"
        placeholder="储值余额"
        clearable
      />
      <LewSelect
        v-model="query.status"
        width="150px"
        :options="customerStatusOptions"
        placeholder="档案状态"
        clearable
      />
      <LewButton type="light" :loading="loading" @click="search()"
        >查询</LewButton
      >
      <LewButton
        type="text"
        color="gray"
        @click="
          () => {
            query = {};
            search();
          }
        "
        >重置</LewButton
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
              permission="biz:customer:list"
              title="历史预约"
              @click="openHistory(row as unknown as Customer)"
            >
              <History :size="14" />
            </IconButton>
            <IconButton
              permission="biz:customer:update"
              title="重算到店统计"
              @click="handleRecount(row as unknown as Customer)"
            >
              <RefreshCw :size="14" />
            </IconButton>
            <IconButton
              permission="biz:customer:update"
              title="编辑"
              @click="openEdit(row as unknown as Customer)"
            >
              <Pencil :size="14" />
            </IconButton>
            <IconButton
              v-if="(row as unknown as Customer).deletedAt"
              permission="biz:customer:update"
              title="恢复档案"
              @click="handleRestore(row as unknown as Customer)"
            >
              <RotateCcw :size="14" />
            </IconButton>
            <IconButton
              v-else
              permission="biz:customer:delete"
              color="error"
              title="删除"
              @click="handleDelete(row as unknown as Customer)"
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
      :title="editingId === null ? '新增顾客' : '编辑顾客'"
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
          label-width="72px"
          :options="formOptions"
        />
      </div>
    </LewModal>

    <!-- 历史预约抽屉 -->
    <LewDrawer
      v-model:visible="drawerVisible"
      :title="`历史预约 - ${selectedCustomer?.name ?? ''}`"
      position="right"
      width="900px"
      :footer-buttons="[
        {
          props: {
            type: 'text',
            color: 'gray',
            size: 'small',
            text: '关闭',
            request: () => {
              drawerVisible = false;
            },
          },
        },
      ]"
    >
      <div class="flex flex-col gap-4 p-5">
        <div class="app-card p-4">
          <div class="mb-3 text-14px font-600">档案</div>
          <div class="grid grid-cols-3 gap-2 text-13px">
            <div class="text-[var(--app-text-muted)]">手机号</div>
            <div>{{ selectedCustomer?.phone ?? '-' }}</div>
            <div class="text-[var(--app-text-muted)]">会员号</div>
            <div>{{ selectedCustomer?.memberNo ?? '未入会' }}</div>
            <div class="text-[var(--app-text-muted)]">到店次数</div>
            <div>{{ selectedCustomer?.visitCount ?? 0 }}</div>
            <div class="text-[var(--app-text-muted)]">最近到店</div>
            <div>{{ formatDateTime(selectedCustomer?.lastVisitAt) }}</div>
            <div class="text-[var(--app-text-muted)]">累计消费</div>
            <div>{{ money(selectedCustomer?.totalSpent) }}</div>
            <div class="text-[var(--app-text-muted)]">积分</div>
            <div>{{ selectedCustomer?.points ?? 0 }}</div>
            <div class="text-[var(--app-text-muted)]">储值余额</div>
            <div>
              {{
                money(
                  (selectedCustomer?.balancePrincipal ?? 0) +
                    (selectedCustomer?.balanceBonus ?? 0),
                )
              }}
            </div>
            <div class="text-[var(--app-text-muted)]">备注</div>
            <div class="col-span-2">{{ selectedCustomer?.remark ?? '-' }}</div>
          </div>
        </div>

        <div class="app-card p-4">
          <div class="mb-3 text-14px font-600">历史预约</div>
          <LewTable
            :columns="historyColumns"
            :data-source="customerBookings"
            :loading="bookingsLoading"
            :focusable="false"
            size="small"
          />
          <div class="flex justify-end p-3">
            <LewPagination
              v-model:current-page="historyPage"
              v-model:page-size="historyPageSize"
              :total="historyTotal"
              @change="handleHistoryChange"
            />
          </div>
        </div>
      </div>
    </LewDrawer>
  </div>
</template>
