<script setup lang="ts">
import { computed, h, nextTick, reactive, ref } from 'vue';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import {
  Ban,
  CalendarClock,
  Pause,
  Pencil,
  Play,
  Plus,
  Trash2,
} from 'lucide-vue-next';
import {
  LewButton,
  LewDrawer,
  LewForm,
  LewMessage,
  LewModal,
  LewPagination,
  LewSelect,
  LewTable,
} from 'lew-ui';
import type { LewFormOption, LewTableColumn } from 'lew-ui';
import { get } from '~/request';
import type { PageResult } from '~/types/api';
import {
  createRecurrence,
  deleteRecurrence,
  listRecurrenceBookings,
  listRecurrenceCustomerOptions,
  listRecurrenceServiceItemOptions,
  listRecurrenceStaffOptions,
  pauseRecurrence,
  resumeRecurrence,
  stopRecurrence,
  updateRecurrence,
} from '~/api/biz/recurrences';
import type {
  Recurrence,
  RecurrenceBody,
  RecurrenceBooking,
  RecurrenceConflictPolicy,
  RecurrenceCreateResult,
  RecurrenceStatus,
} from '~/api/biz/recurrences';
import { useTable } from '~/composables/useTable';
import { formatDateTime } from '~/composables/useFormat';
import { confirmDanger } from '~/utils/confirm';
import IconButton from '~/components/IconButton.vue';

// 后端时间为 UTC，展示与本地日推算统一按东八区（与 useFormat 一致）
dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.tz.setDefault('Asia/Shanghai');

const WEEKDAY_OPTIONS = [
  { label: '周一', value: '1' },
  { label: '周二', value: '2' },
  { label: '周三', value: '3' },
  { label: '周四', value: '4' },
  { label: '周五', value: '5' },
  { label: '周六', value: '6' },
  { label: '周日', value: '7' },
];
const WEEKDAY_LABELS: Record<number, string> = {
  1: '周一',
  2: '周二',
  3: '周三',
  4: '周四',
  5: '周五',
  6: '周六',
  7: '周日',
};
const STATUS_OPTIONS = [
  { label: '进行中', value: 'active' },
  { label: '已暂停', value: 'paused' },
  { label: '已停止', value: 'stopped' },
];
const STATUS_LABELS: Record<RecurrenceStatus, string> = {
  active: '进行中',
  paused: '已暂停',
  stopped: '已停止',
};
const POLICY_OPTIONS = [
  { label: '跳过冲突（skip）', value: 'skip' },
  { label: '照旧生成并通知（notify）', value: 'notify' },
];
const BOOKING_STATUS_LABELS: Record<string, string> = {
  pending: '待确认',
  confirmed: '已确认',
  arrived: '已到店',
  completed: '已完成',
  cancelled: '已取消',
  no_show: '爽约',
};
const PAY_STATUS_LABELS: Record<string, string> = {
  unpaid: '未收款',
  partial: '部分收款',
  paid: '已结清',
  refunded: '已退款',
  credit: '挂账',
};

/** 与后端 shop-time 一致的东八区本地日 */
function shopDate(value: string | Date): string {
  return dayjs(value).tz().format('YYYY-MM-DD');
}
function isoWeekdayOf(date: string): number {
  const day = dayjs(date).day();
  return day === 0 ? 7 : day;
}

/** 前端自行推算「本次创建将要生成的日期清单」 */
function listGenerateDates(
  startDate: string,
  endDate: string | null,
  generateDays: number,
  weekday: number,
): string[] {
  if (!startDate) return [];
  const start = dayjs(startDate);
  if (!start.isValid()) return [];
  const windowDays = Math.max(1, Number(generateDays) || 1);
  let last = start.add(windowDays - 1, 'day');
  if (endDate) {
    const end = dayjs(endDate);
    if (end.isValid() && end.isBefore(last, 'day')) last = end;
  }
  if (last.isBefore(start, 'day')) return [];
  const dates: string[] = [];
  for (
    let cursor = start;
    !cursor.isAfter(last, 'day');
    cursor = cursor.add(1, 'day')
  ) {
    if (isoWeekdayOf(cursor.format('YYYY-MM-DD')) === weekday) {
      dates.push(cursor.format('YYYY-MM-DD'));
    }
  }
  return dates;
}

// ---------- 下拉数据 ----------
const customerOptions = reactive<{ label: string; value: number }[]>([]);
const staffOptions = reactive<{ label: string; value: number }[]>([]);
const serviceItemOptions = reactive<{ label: string; value: number }[]>([]);
const serviceItemNames = ref<Record<number, string>>({});

async function loadOptions() {
  const [customers, staffs, items] = await Promise.all([
    listRecurrenceCustomerOptions(),
    listRecurrenceStaffOptions(),
    listRecurrenceServiceItemOptions(),
  ]);
  customerOptions.splice(
    0,
    customerOptions.length,
    ...customers.items.map((customer) => ({
      label: customer.phone
        ? `${customer.name}（${customer.phone}）`
        : customer.name,
      value: customer.id,
    })),
  );
  staffOptions.splice(
    0,
    staffOptions.length,
    ...staffs.items.map((staff) => ({
      label: staff.nickname,
      value: staff.id,
    })),
  );
  serviceItemOptions.splice(
    0,
    serviceItemOptions.length,
    ...items.items.map((item) => ({ label: item.name, value: item.id })),
  );
  const names: Record<number, string> = {};
  for (const item of items.items) names[item.id] = item.name;
  serviceItemNames.value = names;
}
void loadOptions();

// ---------- 列表 ----------
const query = ref<{ customerId?: string; staffId?: string; status?: string }>(
  {},
);
const {
  items,
  loading,
  currentPage,
  pageSize,
  total,
  search,
  refresh,
  handleChange,
} = useTable<Recurrence>({
  url: '/biz/recurrences',
  query: () => query.value,
});

function serviceItemLabel(row: Recurrence) {
  const ids = row.serviceItemIds ?? [];
  if (!ids.length) return '-';
  return ids.map((id) => serviceItemNames.value[id] ?? `#${id}`).join('、');
}

/** 下次生成日：优先后端返回，其次按游标 +1 天推算（不超过生效结束日） */
function nextGenerateDate(row: Recurrence): string {
  if (row.nextGenerateDate) return row.nextGenerateDate;
  if (row.status !== 'active') return '-';
  const base = row.generatedUntil ?? row.startDate;
  let next = dayjs(base).add(1, 'day');
  if (row.endDate && next.isAfter(dayjs(row.endDate), 'day'))
    return '已到有效期终点';
  // 推到下一个命中的星期几
  for (let step = 0; step < 7; step += 1) {
    if (isoWeekdayOf(next.format('YYYY-MM-DD')) === row.weekday) break;
    next = next.add(1, 'day');
  }
  return `${next.format('YYYY-MM-DD')}（推算）`;
}

const columns: LewTableColumn[] = [
  { title: 'ID', field: 'id', width: 70 },
  {
    title: '规则名',
    field: 'name',
    width: 140,
    customRender: ({ row }) =>
      (row as unknown as Recurrence).name ??
      `#${(row as unknown as Recurrence).id}`,
  },
  {
    title: '顾客',
    field: 'customerName',
    width: 110,
    customRender: ({ row }) =>
      (row as unknown as Recurrence).customerName ?? '-',
  },
  {
    title: '美甲师',
    field: 'staffName',
    width: 100,
    customRender: ({ row }) => (row as unknown as Recurrence).staffName ?? '-',
  },
  {
    title: '项目',
    field: 'serviceItemIds',
    width: 180,
    customRender: ({ row }) =>
      h(
        'span',
        {
          class: 'block w-full truncate',
          title: serviceItemLabel(row as unknown as Recurrence),
        },
        serviceItemLabel(row as unknown as Recurrence),
      ),
  },
  {
    title: '周期',
    field: 'weekday',
    width: 130,
    customRender: ({ row }) => {
      const rule = row as unknown as Recurrence;
      return `${WEEKDAY_LABELS[rule.weekday] ?? '?'} ${String(rule.startTime).slice(0, 5)}`;
    },
  },
  {
    title: '生效期',
    field: 'startDate',
    width: 195,
    customRender: ({ row }) => {
      const rule = row as unknown as Recurrence;
      return `${rule.startDate} ~ ${rule.endDate ?? '长期'}`;
    },
  },
  {
    title: '滚动窗口',
    field: 'generateDays',
    width: 95,
    customRender: ({ row }) =>
      `${(row as unknown as Recurrence).generateDays} 天`,
  },
  {
    title: '已生成至',
    field: 'generatedUntil',
    width: 120,
    customRender: ({ row }) =>
      (row as unknown as Recurrence).generatedUntil ?? '尚未生成',
  },
  {
    title: '下次生成日',
    field: 'nextGenerateDate',
    width: 160,
    customRender: ({ row }) => nextGenerateDate(row as unknown as Recurrence),
  },
  {
    title: '冲突策略',
    field: 'conflictPolicy',
    width: 100,
    customRender: ({ row }) =>
      (row as unknown as Recurrence).conflictPolicy === 'skip'
        ? '跳过'
        : '通知',
  },
  {
    title: '状态',
    field: 'status',
    width: 90,
    customRender: ({ row }) => {
      const status = (row as unknown as Recurrence).status;
      const cls =
        status === 'active'
          ? 'text-[var(--lew-color-success)] font-600'
          : status === 'paused'
            ? 'text-[var(--lew-color-warning)]'
            : 'text-[var(--app-text-muted)]';
      return h('span', { class: cls }, STATUS_LABELS[status]);
    },
  },
  { title: '操作', field: 'operation', width: 190, fixed: 'right' },
];

void search();

// ---------- 新增 / 编辑 ----------
const modalVisible = ref(false);
const editingId = ref<number | null>(null);
const formRef = ref();
const form = ref({
  name: '',
  customerId: undefined as number | undefined,
  staffId: undefined as number | undefined,
  serviceItemIds: [] as number[],
  weekday: '1',
  startTime: '10:00',
  startDate: '',
  endDate: '',
  generateDays: 30,
  conflictPolicy: 'notify' as RecurrenceConflictPolicy,
  remark: '',
});
/** 表单 key：每次打开弹窗自增，强制重建 LewForm 以回填数据 */
const formKey = ref(0);
const submitting = ref(false);
/** 创建结果（generated / skipped），非空时弹窗切换为结果视图 */
const createResult = ref<RecurrenceCreateResult | null>(null);

const isEditing = computed(() => editingId.value !== null);

const formOptions: LewFormOption[] = [
  {
    field: 'name',
    label: '规则名',
    as: 'input',
    props: { placeholder: '选填，如 张三每周三美甲', clearable: true },
  },
  {
    field: 'customerId',
    label: '顾客',
    as: 'select',
    rule: "Yup.number().required('不能为空').typeError('请选择顾客')",
    props: { options: customerOptions, placeholder: '请选择顾客' },
  },
  {
    field: 'staffId',
    label: '美甲师',
    as: 'select',
    rule: "Yup.number().required('不能为空').typeError('请选择美甲师')",
    props: { options: staffOptions, placeholder: '请选择美甲师' },
  },
  {
    field: 'serviceItemIds',
    label: '服务项目',
    as: 'select',
    rule: "Yup.array().min(1, '至少选择一个项目').required()",
    props: {
      options: serviceItemOptions,
      multiple: true,
      placeholder: '可多选',
    },
  },
  {
    field: 'weekday',
    label: '星期几',
    as: 'select',
    rule: "Yup.string().required('不能为空')",
    props: { options: WEEKDAY_OPTIONS },
  },
  {
    field: 'startTime',
    label: '开始时间',
    as: 'input',
    rule: "Yup.string().required('不能为空')",
    tips: 'HH:mm，如 10:00',
    props: { placeholder: '如 10:00', clearable: true },
  },
  {
    field: 'startDate',
    label: '生效开始',
    as: 'date-picker',
    rule: "Yup.string().required('不能为空')",
    props: { valueFormat: 'YYYY-MM-DD', placeholder: '开始日期' },
  },
  {
    field: 'endDate',
    label: '生效结束',
    as: 'date-picker',
    rule: 'Yup.string().nullable()',
    props: { valueFormat: 'YYYY-MM-DD', placeholder: '留空 = 长期' },
  },
  {
    field: 'generateDays',
    label: '提前生成',
    as: 'input-number',
    tips: '滚动窗口天数，创建时立即生成第一个窗口',
    props: { min: 1, max: 365 },
  },
  {
    field: 'conflictPolicy',
    label: '冲突策略',
    as: 'select',
    rule: "Yup.string().required('不能为空')",
    props: { options: POLICY_OPTIONS },
  },
  {
    field: 'remark',
    label: '备注',
    as: 'textarea',
    props: { placeholder: '选填', rows: 2 },
  },
];

/** LewForm `@change` 回吐的实时值，用于「将要生成的日期」预览 */
const live = ref<Record<string, unknown>>({});
function onFormChange(value: unknown) {
  if (value && typeof value === 'object') {
    live.value = { ...(value as Record<string, unknown>) };
  }
}

/** 按表单值（或已组装好的请求体）推算日期清单 */
function datesFrom(values: {
  startDate?: unknown;
  endDate?: unknown;
  generateDays?: unknown;
  weekday?: unknown;
}) {
  return listGenerateDates(
    String(values.startDate ?? ''),
    values.endDate ? String(values.endDate) : null,
    Number(values.generateDays ?? 30),
    Number(values.weekday ?? 1),
  );
}

const previewDates = computed(() => datesFrom(live.value));

/** 冲突预检：一次性拉取窗口内该美甲师的预约，本地比对同一时刻 */
const conflictDates = ref<string[]>([]);
const conflictChecking = ref(false);
const conflictCheckFailed = ref(false);

async function checkConflicts() {
  const values = (formRef.value?.getForm?.() ?? live.value) as Record<
    string,
    unknown
  >;
  conflictDates.value = [];
  conflictCheckFailed.value = false;
  const staffId = Number(values.staffId ?? 0);
  const dates = datesFrom(values);
  if (!staffId || !dates.length) return;
  const first = dates[0];
  const last = dates[dates.length - 1];
  if (!first || !last) return;
  conflictChecking.value = true;
  try {
    // 预约列表接口用于预检；无 biz:booking:list 权限时会 403，此处降级为「无法预检」
    const data = await get<PageResult<{ startAt: string; staffId: number }>>(
      '/biz/bookings',
      {
        page: 1,
        pageSize: 200,
        staffId,
        dateFrom: first,
        dateTo: last,
      },
    );
    const target = String(values.startTime ?? '').slice(0, 5);
    const hits: string[] = [];
    for (const booking of data.items) {
      const localDate = shopDate(booking.startAt);
      const localTime = dayjs(booking.startAt).tz().format('HH:mm');
      if (
        dates.includes(localDate) &&
        localTime === target &&
        !hits.includes(localDate)
      ) {
        hits.push(localDate);
      }
    }
    conflictDates.value = hits;
  } catch {
    conflictCheckFailed.value = true;
  } finally {
    conflictChecking.value = false;
  }
}

function openCreate() {
  editingId.value = null;
  createResult.value = null;
  conflictDates.value = [];
  conflictCheckFailed.value = false;
  formKey.value += 1;
  modalVisible.value = true;
  const payload = {
    name: '',
    customerId: undefined,
    staffId: undefined,
    serviceItemIds: [],
    weekday: '1',
    startTime: '10:00',
    startDate: dayjs().format('YYYY-MM-DD'),
    endDate: '',
    generateDays: 30,
    conflictPolicy: 'notify',
    remark: '',
  };
  live.value = { ...payload };
  void nextTick(() => {
    formRef.value?.setForm?.(payload);
  });
}

function openEdit(row: Recurrence) {
  editingId.value = row.id;
  createResult.value = null;
  conflictDates.value = [];
  conflictCheckFailed.value = false;
  formKey.value += 1;
  modalVisible.value = true;
  const payload = {
    name: row.name ?? '',
    customerId: row.customerId,
    staffId: row.staffId,
    serviceItemIds: row.serviceItemIds ?? [],
    weekday: String(row.weekday),
    startTime: String(row.startTime).slice(0, 5),
    startDate: row.startDate,
    endDate: row.endDate ?? '',
    generateDays: row.generateDays,
    conflictPolicy: row.conflictPolicy,
    remark: row.remark ?? '',
  };
  live.value = { ...payload };
  void nextTick(() => {
    formRef.value?.setForm?.(payload);
  });
}

/** 校验并组装请求体 */
function buildBody(): RecurrenceBody | null {
  const values = (formRef.value?.getForm?.() ??
    form.value) as typeof form.value;
  const startTime = String(values.startTime ?? '').trim();
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(startTime)) {
    LewMessage.error('开始时间格式应为 HH:mm，如 10:00');
    return null;
  }
  if (!values.customerId) {
    LewMessage.error('请选择顾客');
    return null;
  }
  if (!values.staffId) {
    LewMessage.error('请选择美甲师');
    return null;
  }
  if (!values.serviceItemIds?.length) {
    LewMessage.error('请至少选择一个服务项目');
    return null;
  }
  if (!values.startDate) {
    LewMessage.error('请选择生效开始日期');
    return null;
  }
  if (values.endDate && values.endDate < values.startDate) {
    LewMessage.error('生效结束日期不能早于开始日期');
    return null;
  }
  const generateDays = Number(values.generateDays ?? 30);
  if (
    !Number.isInteger(generateDays) ||
    generateDays < 1 ||
    generateDays > 365
  ) {
    LewMessage.error('提前生成天数应为 1~365 的整数');
    return null;
  }
  return {
    name: values.name || null,
    customerId: values.customerId,
    staffId: values.staffId,
    serviceItemIds: values.serviceItemIds,
    weekday: Number(values.weekday),
    startTime,
    startDate: values.startDate,
    endDate: values.endDate || null,
    generateDays,
    conflictPolicy: values.conflictPolicy,
    remark: values.remark || null,
  };
}

async function handleSubmit() {
  const valid = await formRef.value?.validate();
  if (!valid) return;
  const body = buildBody();
  if (!body) return;
  if (isEditing.value && editingId.value !== null) {
    await updateRecurrence(editingId.value, body);
    LewMessage.success('已更新（不回溯已生成的预约）');
    modalVisible.value = false;
    await refresh();
    return;
  }
  // 创建前先让店员确认「将要生成的日期」与冲突情况，再提交
  await checkConflicts();
  const dates = datesFrom(body);
  const policyLabel = body.conflictPolicy === 'skip' ? '跳过' : '通知';
  const conflictNote = conflictDates.value.length
    ? `\n其中 ${conflictDates.value.length} 个日期该美甲师已有同时段预约（按「${policyLabel}」策略处理）。`
    : '';
  confirmDanger({
    type: 'normal',
    title: '创建周期规则',
    content: `本次将生成 ${dates.length} 个预约（${WEEKDAY_LABELS[body.weekday] ?? ''} ${body.startTime}），首次生成不收款（pay_status=unpaid）。${conflictNote}\n确认创建吗？`,
    confirmText: '确认创建',
    confirmColor: 'primary',
    onConfirm: async () => {
      submitting.value = true;
      try {
        createResult.value = await createRecurrence(body);
        LewMessage.success(
          `已生成 ${createResult.value.generated} 单，跳过 ${createResult.value.skipped} 单`,
        );
        await refresh();
      } finally {
        submitting.value = false;
      }
    },
  });
}

// ---------- 状态操作 ----------
function handlePause(row: Recurrence) {
  confirmDanger({
    type: 'normal',
    title: '暂停规则',
    content: `暂停后不再生成新的预约，已生成的预约保留。确认暂停「${row.name ?? row.id}」吗？`,
    confirmText: '暂停',
    confirmColor: 'warning',
    onConfirm: async () => {
      await pauseRecurrence(row.id);
      LewMessage.success('已暂停');
      await refresh();
    },
  });
}

async function handleResume(row: Recurrence) {
  await resumeRecurrence(row.id);
  LewMessage.success('已恢复生成');
  await refresh();
}

function handleStop(row: Recurrence) {
  confirmDanger({
    type: 'warning',
    title: '停止规则',
    content: `停止是终态，之后不再生成任何预约（已生成的预约保留）。确认停止「${row.name ?? row.id}」吗？`,
    confirmText: '停止',
    onConfirm: async () => {
      await stopRecurrence(row.id);
      LewMessage.success('已停止');
      await refresh();
    },
  });
}

function handleDelete(row: Recurrence) {
  confirmDanger({
    title: '删除确认',
    content: `确定删除规则「${row.name ?? row.id}」吗？将停止并软删规则，已生成的预约保留（recurrence_id 置空）。`,
    onConfirm: async () => {
      await deleteRecurrence(row.id);
      LewMessage.success('删除成功');
      await refresh();
    },
  });
}

// ---------- 已生成预约抽屉 ----------
const bookingsVisible = ref(false);
const bookingsRule = ref<Recurrence | null>(null);
const bookings = ref<RecurrenceBooking[]>([]);
const bookingsLoading = ref(false);

/** 已生成预约列表列（时间按东八区展示） */
const bookingColumns: LewTableColumn[] = [
  { title: '预约单号', field: 'bookingNo', width: 160 },
  {
    title: '开始时间',
    field: 'startAt',
    width: 175,
    customRender: ({ row }) =>
      formatDateTime((row as unknown as RecurrenceBooking).startAt),
  },
  {
    title: '结束时间',
    field: 'endAt',
    width: 175,
    customRender: ({ row }) =>
      formatDateTime((row as unknown as RecurrenceBooking).endAt),
  },
  {
    title: '状态',
    field: 'status',
    width: 100,
    customRender: ({ row }) =>
      BOOKING_STATUS_LABELS[(row as unknown as RecurrenceBooking).status] ??
      (row as unknown as RecurrenceBooking).status,
  },
  {
    title: '支付状态',
    field: 'payStatus',
    width: 100,
    customRender: ({ row }) =>
      PAY_STATUS_LABELS[(row as unknown as RecurrenceBooking).payStatus] ??
      (row as unknown as RecurrenceBooking).payStatus,
  },
  {
    title: '顾客',
    field: 'customerName',
    customRender: ({ row }) =>
      (row as unknown as RecurrenceBooking).customerName ?? '-',
  },
];

async function openBookings(row: Recurrence) {
  bookingsRule.value = row;
  bookingsVisible.value = true;
  bookingsLoading.value = true;
  try {
    const data = await listRecurrenceBookings(row.id);
    bookings.value = data.items;
  } finally {
    bookingsLoading.value = false;
  }
}
</script>

<template>
  <div class="page-container">
    <!-- 页头 -->
    <div class="flex items-center justify-between">
      <div>
        <h2 class="page-title m-0">周期预约</h2>
        <p class="page-subtitle mt-1 mb-0">
          创建前会预览将要生成的日期；首次生成不收预付款；改规则不回溯已生成的单
        </p>
      </div>
      <LewButton
        v-permission="'biz:recurrence:create'"
        type="fill"
        @click="openCreate"
      >
        <Plus :size="15" style="margin-right: 4px" /> 新增规则
      </LewButton>
    </div>

    <!-- 筛选 -->
    <div class="app-card flex flex-wrap items-center gap-3 p-4">
      <LewSelect
        v-model="query.customerId"
        width="200px"
        :options="
          customerOptions.map((item) => ({
            label: item.label,
            value: String(item.value),
          }))
        "
        placeholder="全部顾客"
        clearable
      />
      <LewSelect
        v-model="query.staffId"
        width="160px"
        :options="
          staffOptions.map((item) => ({
            label: item.label,
            value: String(item.value),
          }))
        "
        placeholder="全部美甲师"
        clearable
      />
      <LewSelect
        v-model="query.status"
        width="140px"
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
              permission="biz:recurrence:list"
              title="已生成预约"
              @click="openBookings(row as unknown as Recurrence)"
            >
              <CalendarClock :size="14" />
            </IconButton>
            <IconButton
              v-if="(row as unknown as Recurrence).status === 'active'"
              permission="biz:recurrence:update"
              title="暂停"
              @click="handlePause(row as unknown as Recurrence)"
            >
              <Pause :size="14" />
            </IconButton>
            <IconButton
              v-else-if="(row as unknown as Recurrence).status === 'paused'"
              permission="biz:recurrence:update"
              title="恢复"
              @click="handleResume(row as unknown as Recurrence)"
            >
              <Play :size="14" />
            </IconButton>
            <IconButton
              v-if="(row as unknown as Recurrence).status !== 'stopped'"
              permission="biz:recurrence:update"
              color="error"
              title="停止"
              @click="handleStop(row as unknown as Recurrence)"
            >
              <Ban :size="14" />
            </IconButton>
            <IconButton
              permission="biz:recurrence:update"
              title="编辑"
              @click="openEdit(row as unknown as Recurrence)"
            >
              <Pencil :size="14" />
            </IconButton>
            <IconButton
              permission="biz:recurrence:delete"
              color="error"
              title="删除"
              @click="handleDelete(row as unknown as Recurrence)"
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
      :title="
        createResult ? '生成结果' : isEditing ? '编辑周期规则' : '新增周期规则'
      "
      width="680px"
      :footer-buttons="
        createResult
          ? [
              {
                props: {
                  type: 'fill',
                  color: 'primary',
                  size: 'small',
                  text: '完成',
                  request: () => {
                    modalVisible = false;
                  },
                },
              },
            ]
          : [
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
                  text: isEditing ? '保存' : '创建并生成',
                  loading: submitting,
                  request: handleSubmit,
                },
              },
            ]
      "
    >
      <!-- 生成结果 -->
      <div v-if="createResult" class="flex flex-col gap-3 p-5">
        <div class="grid grid-cols-2 gap-3">
          <div class="rounded-8px border border-[var(--app-border)] p-3">
            <div class="text-12px text-[var(--app-text-muted)]">生成成功</div>
            <div
              class="mt-1 text-22px font-700 text-[var(--lew-color-success)]"
            >
              {{ createResult.generated }}
            </div>
          </div>
          <div class="rounded-8px border border-[var(--app-border)] p-3">
            <div class="text-12px text-[var(--app-text-muted)]">
              跳过（冲突 / 无班次）
            </div>
            <div
              class="mt-1 text-22px font-700 text-[var(--lew-color-warning)]"
            >
              {{ createResult.skipped }}
            </div>
          </div>
        </div>
        <p class="m-0 text-12.5px text-[var(--app-text-secondary)]">
          首次生成默认不收预付款（pay_status=unpaid）；被跳过的日期已记入通知日志，
          可在「通知记录」里查看，并到「预约管理」手工补单。
        </p>
      </div>

      <!-- 表单 -->
      <div v-else class="flex flex-col gap-3 p-5">
        <LewForm
          :key="formKey"
          ref="formRef"
          v-model="form"
          :options="formOptions"
          label-width="96px"
          @change="onFormChange"
        />

        <!-- 日期预览（仅创建时） -->
        <div
          v-if="!isEditing"
          class="rounded-8px border border-[var(--app-border)] p-3"
        >
          <div class="mb-2 flex items-center justify-between">
            <span class="text-13.5px font-600">
              将要生成的日期（{{ previewDates.length }} 个）
            </span>
            <LewButton
              type="text"
              size="small"
              :loading="conflictChecking"
              @click="checkConflicts"
              >检查冲突</LewButton
            >
          </div>
          <div v-if="previewDates.length" class="flex flex-wrap gap-1.5">
            <span
              v-for="date in previewDates"
              :key="date"
              class="rounded-6px px-2 py-0.5 text-12px"
              :class="
                conflictDates.includes(date)
                  ? 'bg-[var(--lew-color-error-light)] text-[var(--lew-color-error)]'
                  : 'bg-[var(--app-bg-hover)] text-[var(--app-text-secondary)]'
              "
            >
              {{ date }}
            </span>
          </div>
          <div v-else class="table-empty">
            请先选择「星期几」与「生效开始」日期
          </div>
          <p class="mt-2 mb-0 text-11.5px text-[var(--app-text-muted)]">
            <template v-if="conflictDates.length">
              与现有预约可能冲突的日期：{{
                conflictDates.join('、')
              }}（按冲突策略处理）
            </template>
            <template v-else-if="conflictCheckFailed">
              无法预检冲突（当前账号没有预约查看权限或接口异常）；生成时仍会按冲突策略处理。
            </template>
            <template v-else>
              仅为前端推算结果，实际以生成时的班次与冲突复检为准。
            </template>
          </p>
        </div>
        <p
          v-else
          class="m-0 rounded-8px bg-[var(--app-bg-hover)] p-2.5 text-11.5px text-[var(--app-text-muted)]"
        >
          修改规则只影响未来生成，不回溯已生成的预约；已生成的单据要改请逐单改期。
        </p>
      </div>
    </LewModal>

    <!-- 已生成预约抽屉 -->
    <LewDrawer
      v-model:visible="bookingsVisible"
      :title="`已生成预约 - ${bookingsRule?.name ?? bookingsRule?.id ?? ''}`"
      width="860px"
      hide-footer
    >
      <div class="p-5">
        <LewTable
          :data-source="bookings"
          :loading="bookingsLoading"
          :focusable="false"
          size="small"
          :columns="bookingColumns"
        />
        <div v-if="!bookingsLoading && !bookings.length" class="table-empty">
          该规则还没有生成预约
        </div>
        <p class="mt-3 mb-0 text-11.5px text-[var(--app-text-muted)]">
          提示：周期单默认不收预付款；未到店前会有明显标识。撤销本窗口生成的单
          （仅限未被收款的单）本期未实现，见交付说明。
        </p>
      </div>
    </LewDrawer>
  </div>
</template>
