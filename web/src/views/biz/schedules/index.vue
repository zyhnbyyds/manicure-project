<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { AlertTriangle, Pencil, Plus, Trash2 } from 'lucide-vue-next';
import {
  LewButton,
  LewDatePicker,
  LewForm,
  LewMessage,
  LewModal,
  LewSelect,
  LewTable,
  LewTabs,
} from 'lew-ui';
import type {
  LewFormOption,
  LewModalFooterButtonItem,
  LewTableColumn,
} from 'lew-ui';
import {
  createOverride,
  deleteOverride,
  getScheduleCalendar,
  getWeeklyShifts,
  listOverrides,
  replaceWeeklyShifts,
} from '~/api/biz/schedules';
import type {
  CreateOverrideBody,
  ScheduleCalendarCell,
  ScheduleConflictItem,
  ScheduleOverride,
  WeeklyShift,
  WeeklyShiftInput,
} from '~/api/biz/schedules';
import { listStaffs } from '~/api/biz/staffs';
import { useStoreScopeStore } from '~/store/store-scope';
import { formatDateTime } from '~/composables/useFormat';
import { confirmDanger } from '~/utils/confirm';
import IconButton from '~/components/IconButton.vue';
import CalendarPanel from '~/components/calendar/CalendarPanel.vue';
import { buildRange, todayString } from '~/components/calendar/calendar-utils';
import type {
  CalendarMode,
  CalendarStaff,
} from '~/components/calendar/calendar-utils';

const storeScope = useStoreScopeStore();

const weekdayLabels = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

/** 墙钟时间统一成后端要求的 `HH:MM:SS` */
function toShiftTime(value: string | null | undefined): string {
  const text = (value ?? '').trim();
  if (/^\d{2}:\d{2}$/.test(text)) return `${text}:00`;
  if (/^\d{2}:\d{2}:\d{2}$/.test(text)) return text;
  return '';
}

/** 展示用：`HH:MM:SS` → `HH:mm` */
function shortTime(value: string | null | undefined): string {
  if (!value) return '--:--';
  return value.slice(0, 5);
}

function renderShiftRange(row: ScheduleOverride): string {
  if (row.type === 'off') return '整天休息';
  return `${shortTime(row.startTime)} - ${shortTime(row.endTime)}`;
}

// ---------- 顶部：选美甲师 ----------
const staffOptions = ref<{ label: string; value: string }[]>([]);
const selectedStaffId = ref('');

async function loadStaffOptions() {
  const data = await listStaffs(1, 200);
  staffOptions.value = data.items.map((staff) => ({
    label:
      staff.status === 'active'
        ? staff.nickname
        : `${staff.nickname}（已停用）`,
    value: String(staff.id),
  }));
  if (!selectedStaffId.value && staffOptions.value.length) {
    selectedStaffId.value = staffOptions.value[0]?.value ?? '';
  }
}
void loadStaffOptions();

const activeTab = ref('weekly');
const tabOptions = [
  { label: '周模板', value: 'weekly' },
  { label: '日期例外', value: 'overrides' },
  { label: '日历视图', value: 'calendar' },
];

const currentStaffId = computed(() => Number(selectedStaffId.value) || 0);

/**
 * 排班跟谁走：**顶栏的门店切换器**（超管切 B 店就排 B 店的专属班次，店长默认只看本店）。
 *
 * `null` = 没有选定具体门店（单店或多店视图中「通用模板」那一层）。
 */
const activeStoreId = computed(() => storeScope.activeStoreId);

// ---------- 周模板 ----------
const weeklyShifts = ref<WeeklyShift[]>([]);
const weeklyLoading = ref(false);
/** 当前展示的周模板来自哪一层：`store` = 该门店专属；`shared` = 通用 */
const weeklySource = ref<'store' | 'shared'>('shared');

const weekRows = computed(() =>
  weekdayLabels.map((label, index) => ({
    weekday: index + 1,
    label,
    segments: weeklyShifts.value.filter((shift) => shift.weekday === index + 1),
  })),
);

const weekColumns: LewTableColumn[] = [
  { title: '星期', field: 'label', width: 100 },
  { title: '班次（可多段）', field: 'segments' },
  { title: '操作', field: 'operation', width: 90, fixed: 'right' },
];

async function loadWeekly(staffId: number) {
  if (!staffId) {
    weeklyShifts.value = [];
    return;
  }
  weeklyLoading.value = true;
  try {
    /**
     * 门店：当前排班要展示**这家店的班次**（专属优先、通用兜底），
     * 后端返回 `{ shifts, source }` —— 通用层说明「该店没配专属班次」。
     */
    const data = activeStoreId.value
      ? await getWeeklyShifts(staffId, activeStoreId.value)
      : await getWeeklyShifts(staffId);
    weeklyShifts.value = data.shifts;
    weeklySource.value = data.source;
  } finally {
    weeklyLoading.value = false;
  }
}

// 编辑某一天（本地先改，确认时整体 PUT）
type SegmentDraft = { startTime: string; endTime: string };
const dayModalVisible = ref(false);
const editingWeekday = ref(1);
const segmentsDraft = ref<SegmentDraft[]>([]);
const weekSaving = ref(false);

const editingWeekdayLabel = computed(
  () => weekdayLabels[editingWeekday.value - 1] ?? '',
);

function openDayEdit(weekday: number) {
  editingWeekday.value = weekday;
  segmentsDraft.value = weeklyShifts.value
    .filter((shift) => shift.weekday === weekday)
    .map((shift) => ({
      startTime: shortTime(shift.startTime).replace('--:--', ''),
      endTime: shortTime(shift.endTime).replace('--:--', ''),
    }));
  if (!segmentsDraft.value.length)
    segmentsDraft.value = [{ startTime: '', endTime: '' }];
  dayModalVisible.value = true;
}

function addSegment() {
  segmentsDraft.value = [
    ...segmentsDraft.value,
    { startTime: '', endTime: '' },
  ];
}

function removeSegment(index: number) {
  segmentsDraft.value = segmentsDraft.value.filter((_, i) => i !== index);
}

async function saveDay() {
  const staffId = currentStaffId.value;
  if (!staffId) return;
  const normalized: WeeklyShiftInput[] = [];
  for (const [index, segment] of segmentsDraft.value.entries()) {
    const start = toShiftTime(segment.startTime);
    const end = toShiftTime(segment.endTime);
    const hasAny = Boolean(segment.startTime || segment.endTime);
    if (!hasAny) continue;
    if (!start || !end) {
      LewMessage.error(
        `${weekdayLabels[editingWeekday.value - 1] ?? ''} 第 ${index + 1} 段：请填写完整的开始 / 结束时间`,
      );
      return;
    }
    if (start >= end) {
      LewMessage.error(
        `${weekdayLabels[editingWeekday.value - 1] ?? ''} 第 ${index + 1} 段：结束时间必须晚于开始时间`,
      );
      return;
    }
    normalized.push({
      weekday: editingWeekday.value,
      startTime: start,
      endTime: end,
    });
  }

  // 用编辑结果替换该天，其余天保持原样，最后**整体 PUT**
  const rest = weeklyShifts.value.filter(
    (shift) => shift.weekday !== editingWeekday.value,
  );
  const shifts: WeeklyShiftInput[] = [
    ...rest.map((shift) => ({
      weekday: shift.weekday,
      startTime: toShiftTime(shift.startTime),
      endTime: toShiftTime(shift.endTime),
    })),
    ...normalized,
  ].sort(
    (a, b) => a.weekday - b.weekday || a.startTime.localeCompare(b.startTime),
  );

  weekSaving.value = true;
  try {
    const outcome = await replaceWeeklyShifts(
      staffId,
      shifts,
      activeStoreId.value ?? undefined,
    );
    if (!outcome.ok) {
      // 周模板刻意不提供 force（§6.4）：必须先改期再保存
      openConflictModal(outcome.message, outcome.conflicts, null);
      return;
    }
    LewMessage.success('周模板已保存');
    dayModalVisible.value = false;
    await loadWeekly(staffId);
  } finally {
    weekSaving.value = false;
  }
}

// ---------- 日期例外 ----------
const overrideQuery = ref<{ from?: string; to?: string }>({});
const overrides = ref<ScheduleOverride[]>([]);
const overridesLoading = ref(false);

const overrideColumns: LewTableColumn[] = [
  { title: '日期', field: 'date', width: 130 },
  {
    title: '类型',
    field: 'type',
    width: 100,
    customRender: ({ row }) =>
      (row as unknown as ScheduleOverride).type === 'off'
        ? '请假'
        : '自定义时段',
  },
  {
    title: '时段',
    field: 'startTime',
    width: 160,
    customRender: ({ row }) =>
      renderShiftRange(row as unknown as ScheduleOverride),
  },
  {
    title: '原因',
    field: 'reason',
    customRender: ({ row }) =>
      (row as unknown as ScheduleOverride).reason ?? '-',
  },
  { title: '操作', field: 'operation', width: 90, fixed: 'right' },
];

async function loadOverrides(staffId: number) {
  if (!staffId) {
    overrides.value = [];
    return;
  }
  overridesLoading.value = true;
  try {
    overrides.value = await listOverrides(staffId, {
      ...(overrideQuery.value.from ? { from: overrideQuery.value.from } : {}),
      ...(overrideQuery.value.to ? { to: overrideQuery.value.to } : {}),
    });
  } finally {
    overridesLoading.value = false;
  }
}

// ---------- 新增例外 ----------
type OverrideFormValues = {
  type: 'off' | 'custom';
  date: string;
  startTime: string;
  endTime: string;
  reason: string;
};

function emptyOverrideForm(): OverrideFormValues {
  return { type: 'off', date: '', startTime: '', endTime: '', reason: '' };
}

const overrideModalVisible = ref(false);
const overrideFormRef = ref();
const overrideForm = ref<OverrideFormValues>(emptyOverrideForm());
const overrideFormKey = ref(0);
const overrideSaving = ref(false);

const overrideFormOptions = computed<LewFormOption[]>(() => [
  {
    field: 'type',
    label: '类型',
    as: 'select',
    rule: "Yup.string().required('不能为空')",
    tips: '请假 = 当天不可约；自定义时段 = 当天用这些时段替代周模板',
    props: {
      options: [
        { label: '请假（整天休息）', value: 'off' },
        { label: '自定义时段（加班 / 调整）', value: 'custom' },
      ],
    },
  },
  {
    field: 'date',
    label: '日期',
    as: 'date-picker',
    rule: "Yup.string().required('不能为空')",
    props: {
      valueFormat: 'YYYY-MM-DD',
      placeholder: '选择日期',
      clearable: true,
    },
  },
  {
    field: 'startTime',
    label: '开始时间',
    as: 'date-picker',
    visible: (formData: Record<string, unknown>) => formData.type === 'custom',
    props: {
      valueFormat: 'HH:mm',
      placeholder: '如 10:00',
      clearable: true,
    },
  },
  {
    field: 'endTime',
    label: '结束时间',
    as: 'date-picker',
    visible: (formData: Record<string, unknown>) => formData.type === 'custom',
    props: {
      valueFormat: 'HH:mm',
      placeholder: '如 18:00',
      clearable: true,
    },
  },
  {
    field: 'reason',
    label: '原因',
    as: 'input',
    props: { placeholder: '如 调休 / 外出培训', clearable: true },
  },
]);

function openCreateOverride() {
  overrideFormKey.value += 1;
  overrideModalVisible.value = true;
  void nextTick(() => {
    overrideFormRef.value?.setForm?.(emptyOverrideForm());
  });
}

async function submitOverride(force = false) {
  const staffId = currentStaffId.value;
  if (!staffId) return;
  const valid = await overrideFormRef.value?.validate();
  if (!valid) return;
  const values = (overrideFormRef.value?.getForm?.() ??
    overrideForm.value) as OverrideFormValues;

  if (values.type === 'custom') {
    if (!values.startTime || !values.endTime) {
      LewMessage.error('自定义时段必须填写开始与结束时间');
      return;
    }
    if (toShiftTime(values.startTime) >= toShiftTime(values.endTime)) {
      LewMessage.error('结束时间必须晚于开始时间');
      return;
    }
  }

  const body: CreateOverrideBody = {
    date: values.date,
    type: values.type,
    startTime: values.type === 'custom' ? toShiftTime(values.startTime) : null,
    endTime: values.type === 'custom' ? toShiftTime(values.endTime) : null,
    reason: values.reason || null,
  };

  overrideSaving.value = true;
  try {
    const outcome = await createOverride(staffId, body, force);
    if (!outcome.ok) {
      // 409：必须先把受影响的预约清单摊给店员看，确认后才带 force=true 重试
      openConflictModal(outcome.message, outcome.conflicts, () =>
        submitOverride(true),
      );
      return;
    }
    LewMessage.success('例外已保存');
    overrideModalVisible.value = false;
    await loadOverrides(staffId);
  } finally {
    overrideSaving.value = false;
  }
}

async function removeOverride(row: ScheduleOverride, force = false) {
  const staffId = currentStaffId.value;
  if (!staffId) return;
  const outcome = await deleteOverride(staffId, row.id, force);
  if (!outcome.ok) {
    openConflictModal(
      outcome.message,
      outcome.conflicts,
      () => removeOverride(row, true),
      '确认强制删除',
    );
    return;
  }
  LewMessage.success('已删除');
  await loadOverrides(staffId);
}

function handleDeleteOverride(row: ScheduleOverride) {
  confirmDanger({
    title: '删除确认',
    content: `确定删除 ${row.date} 的例外（${renderShiftRange(row)}）吗？`,
    onConfirm: async () => {
      try {
        await removeOverride(row);
      } catch {
        // 其它错误由 request 拦截器统一提示
      }
    },
  });
}

// ---------- 冲突清单弹窗（§6.4 的核心保护） ----------
const conflictVisible = ref(false);
const conflictMessage = ref('');
const conflictList = ref<ScheduleConflictItem[]>([]);
const conflictRetry = ref<null | (() => Promise<void>)>(null);
const conflictConfirmText = ref('确认强制保存');
const conflictSaving = ref(false);

function openConflictModal(
  message: string,
  conflicts: ScheduleConflictItem[],
  retry: null | (() => Promise<void>),
  confirmText = '确认强制保存',
) {
  conflictMessage.value = message;
  conflictList.value = conflicts;
  conflictRetry.value = retry;
  conflictConfirmText.value = confirmText;
  conflictVisible.value = true;
}

async function handleConflictConfirm() {
  const retry = conflictRetry.value;
  conflictVisible.value = false;
  if (!retry) return;
  conflictSaving.value = true;
  try {
    await retry();
  } finally {
    conflictSaving.value = false;
  }
}

/** 无 force 的场景（周模板）只给「知道了」，可 force 的场景给二次确认按钮 */
const conflictFooterButtons = computed<LewModalFooterButtonItem[]>(() => {
  const buttons: LewModalFooterButtonItem[] = [
    {
      props: {
        type: 'text',
        color: 'gray',
        size: 'small',
        text: conflictRetry.value ? '取消' : '知道了',
        request: () => {
          conflictVisible.value = false;
        },
      },
    },
  ];
  if (conflictRetry.value) {
    buttons.push({
      props: {
        type: 'fill',
        color: 'error',
        size: 'small',
        text: conflictConfirmText.value,
        loading: conflictSaving.value,
        request: handleConflictConfirm,
      },
    });
  }
  return buttons;
});

// ---------- 日历视图 ----------

/**
 * 日历展示**全部美甲师**（行 = 人、列 = 天），不跟随上方那一个选择器 ——
 * 周视图的价值就是横向对比；要看单人请切回「周模板」页签。
 */
const calendarAnchor = ref(todayString());
const calendarMode = ref<CalendarMode>('week');
const calendarLoading = ref(false);
const calendarStaffs = ref<CalendarStaff[]>([]);
const calendarCells = ref<ScheduleCalendarCell[]>([]);

/** 面板里也用同一个函数算区间，保证「显示的范围」=「请求的范围」 */
const calendarRange = computed(() =>
  buildRange(calendarAnchor.value, calendarMode.value),
);

async function loadCalendar() {
  if (activeTab.value !== 'calendar') return;
  calendarLoading.value = true;
  try {
    const data = await getScheduleCalendar({
      from: calendarRange.value.from,
      to: calendarRange.value.to,
      storeId: activeStoreId.value || undefined,
    });
    calendarStaffs.value = data.staffs;
    calendarCells.value = data.cells;
  } finally {
    calendarLoading.value = false;
  }
}

// ---------- 联动加载 ----------
watch(
  selectedStaffId,
  (value) => {
    const staffId = Number(value) || 0;
    void loadWeekly(staffId);
    void loadOverrides(staffId);
  },
  { immediate: true },
);

/** 切门店 → 整个排班跟着变（换一家店看的是那家店的专属班次） */
watch(activeStoreId, () => {
  const staffId = currentStaffId.value;
  if (staffId) void loadWeekly(staffId);
  void loadCalendar();
});

/** 页签切到日历、或日历自己的日期/视图变了，才去拉区间矩阵 */
watch([calendarAnchor, calendarMode, activeTab], () => {
  void loadCalendar();
});
</script>

<template>
  <div class="page-container">
    <!-- 页头 -->
    <div class="flex items-center justify-between">
      <div>
        <h2 class="page-title m-0">排班管理</h2>
        <p class="page-subtitle mt-1 mb-0">
          先选美甲师 →
          维护周模板与日期例外；改动若让既有预约越界，会先弹出受影响清单
        </p>
      </div>
    </div>

    <!-- 顶部：选美甲师 -->
    <div class="app-card flex flex-wrap items-center gap-3 p-4">
      <span class="text-13px text-[var(--app-text-secondary)]">美甲师</span>
      <LewSelect
        v-model="selectedStaffId"
        width="220px"
        :options="staffOptions"
        placeholder="请选择美甲师"
        clearable
      />
      <span class="text-12.5px text-[var(--app-text-muted)]"
        >周模板为「整体替换」，保存时会先检查未来 30 天内的既有预约</span
      >
    </div>

    <div class="app-card p-4">
      <LewTabs v-model="activeTab" :options="tabOptions" type="line" />

      <!-- 周模板 -->
      <div v-if="activeTab === 'weekly'" class="mt-4">
        <!-- 门店层级提示：当前看的是「这家店的专属模板」还是「全店通用的模板」 -->
        <div
          v-if="storeScope.hasSwitcher"
          class="mb-3 rounded-6px px-3 py-2 text-12.5px"
          :class="
            weeklySource === 'store'
              ? 'bg-[var(--lew-color-primary-light)] text-[var(--lew-color-primary)]'
              : 'bg-[var(--lew-color-warning-light)] text-[var(--lew-color-warning)]'
          "
        >
          <template v-if="weeklySource === 'store'">
            当前显示「{{
              storeScope.activeLabel
            }}」的专属班次：保存时只会改动这家店的班次， 不影响其他店。
          </template>
          <template v-else>
            {{
              storeScope.activeLabel !== '全部门店'
                ? `「${storeScope.activeLabel}」还没有专属班次，`
                : ''
            }}
            当前显示的是「通用班次」（对能服务到的所有门店生效）。若想单独排这一家店，
            可直接编辑并保存 —— 保存会把它变成该店专属班次。
          </template>
        </div>
        <LewTable
          :columns="weekColumns"
          :data-source="weekRows"
          :loading="weeklyLoading"
          :focusable="false"
          size="small"
        >
          <template #segments="{ row }">
            <div class="flex flex-wrap items-center gap-1">
              <template
                v-if="
                  (row as unknown as { segments: WeeklyShift[] }).segments
                    .length
                "
              >
                <span
                  v-for="segment in (
                    row as unknown as { segments: WeeklyShift[] }
                  ).segments"
                  :key="segment.id"
                  class="rounded-6px bg-[var(--app-bg-hover)] px-2 py-0.5 text-12.5px tabular-nums"
                >
                  {{ shortTime(segment.startTime) }} -
                  {{ shortTime(segment.endTime) }}
                </span>
              </template>
              <span v-else class="text-[var(--app-text-muted)]">休息</span>
            </div>
          </template>
          <template #operation="{ row }">
            <IconButton
              permission="biz:schedule:update"
              title="编辑该天班次"
              @click="
                openDayEdit((row as unknown as { weekday: number }).weekday)
              "
            >
              <Pencil :size="14" />
            </IconButton>
          </template>
        </LewTable>
      </div>

      <!-- 日期例外 -->
      <div
        v-else-if="activeTab === 'overrides'"
        class="mt-4 flex flex-col gap-3"
      >
        <div class="flex flex-wrap items-center gap-3">
          <LewDatePicker
            v-model="overrideQuery.from"
            width="160px"
            value-format="YYYY-MM-DD"
            placeholder="起始日"
            clearable
          />
          <span class="text-[var(--app-text-muted)]">~</span>
          <LewDatePicker
            v-model="overrideQuery.to"
            width="160px"
            value-format="YYYY-MM-DD"
            placeholder="结束日"
            clearable
          />
          <LewButton
            type="light"
            :loading="overridesLoading"
            @click="loadOverrides(currentStaffId)"
            >查询</LewButton
          >
          <LewButton
            type="text"
            color="gray"
            @click="
              () => {
                overrideQuery = {};
                loadOverrides(currentStaffId);
              }
            "
            >重置</LewButton
          >
          <LewButton
            v-permission="'biz:schedule:update'"
            type="fill"
            @click="openCreateOverride"
          >
            <Plus :size="15" style="margin-right: 4px" /> 新增例外
          </LewButton>
        </div>

        <LewTable
          :columns="overrideColumns"
          :data-source="overrides"
          :loading="overridesLoading"
          :focusable="false"
          size="small"
        >
          <template #operation="{ row }">
            <IconButton
              permission="biz:schedule:update"
              color="error"
              title="删除例外"
              @click="handleDeleteOverride(row as unknown as ScheduleOverride)"
            >
              <Trash2 :size="14" />
            </IconButton>
          </template>
        </LewTable>
      </div>

      <!-- 日历视图：日期 × 美甲师的实际生效班次（只读，编辑请回上面两个页签） -->
      <div v-else-if="activeTab === 'calendar'" class="mt-4">
        <p class="mb-3 mt-0 text-12.5px text-[var(--app-text-muted)]">
          日历展示<span class="font-600">实际生效</span
          >的班次：已把周模板与日期例外合并求值。 灰色时段 =
          来自周模板（门店专属优先、通用兜底），深色加粗 = 当天有日期例外
          （请假或自定义时段）。这里只做展示，要编辑请切回「周模板 /
          日期例外」。
        </p>
        <CalendarPanel
          v-model="calendarAnchor"
          v-model:mode="calendarMode"
          :staffs="calendarStaffs"
          :cells="calendarCells"
          :loading="calendarLoading"
          empty-text="还没有美甲师档案"
        />
      </div>
    </div>

    <!-- 编辑某天班次 -->
    <LewModal
      v-model:visible="dayModalVisible"
      :title="`编辑 ${editingWeekdayLabel} 的班次`"
      width="560px"
      :footer-buttons="[
        {
          props: {
            type: 'text',
            color: 'gray',
            size: 'small',
            text: '取消',
            request: () => {
              dayModalVisible = false;
            },
          },
        },
        {
          props: {
            type: 'fill',
            color: 'primary',
            size: 'small',
            text: '保存周模板',
            loading: weekSaving,
            request: saveDay,
          },
        },
      ]"
    >
      <div class="flex flex-col gap-3 p-5">
        <div class="text-12.5px text-[var(--app-text-secondary)]">
          一天可有多段（如上午 / 下午）；清空所有段 = 该天休息。保存会
          <span class="font-600">整体替换</span> 该美甲师的周模板。
        </div>
        <div
          v-for="(segment, index) in segmentsDraft"
          :key="index"
          class="flex items-center gap-2"
        >
          <LewDatePicker
            v-model="segment.startTime"
            width="140px"
            value-format="HH:mm"
            placeholder="开始 10:00"
            clearable
          />
          <span class="text-[var(--app-text-muted)]">~</span>
          <LewDatePicker
            v-model="segment.endTime"
            width="140px"
            value-format="HH:mm"
            placeholder="结束 18:00"
            clearable
          />
          <IconButton
            color="error"
            title="删除该段"
            @click="removeSegment(index)"
          >
            <Trash2 :size="14" />
          </IconButton>
        </div>
        <div>
          <LewButton type="light" size="small" @click="addSegment">
            <Plus :size="14" style="margin-right: 4px" /> 添加时段
          </LewButton>
        </div>
      </div>
    </LewModal>

    <!-- 新增日期例外 -->
    <LewModal
      v-model:visible="overrideModalVisible"
      title="新增日期例外"
      width="520px"
      :footer-buttons="[
        {
          props: {
            type: 'text',
            color: 'gray',
            size: 'small',
            text: '取消',
            request: () => {
              overrideModalVisible = false;
            },
          },
        },
        {
          props: {
            type: 'fill',
            color: 'primary',
            size: 'small',
            text: '保存',
            loading: overrideSaving,
            request: () => submitOverride(false),
          },
        },
      ]"
    >
      <div class="p-5">
        <LewForm
          :key="overrideFormKey"
          ref="overrideFormRef"
          v-model="overrideForm"
          label-width="80px"
          :options="overrideFormOptions"
        />
      </div>
    </LewModal>

    <!-- 受影响预约清单（409） -->
    <LewModal
      v-model:visible="conflictVisible"
      title="有预约会落在新班次之外"
      width="640px"
      :footer-buttons="conflictFooterButtons"
    >
      <div class="flex flex-col gap-3 p-5">
        <div
          class="flex items-start gap-2 rounded-8px border border-[var(--lew-color-error)] p-3 text-13px"
        >
          <AlertTriangle :size="16" class="mt-0.5 shrink-0" />
          <div>
            <div class="font-600">{{ conflictMessage }}</div>
            <div class="mt-1 text-[var(--app-text-secondary)]">
              已存在的预约是事实，不会被静默作废。请先改期 /
              取消这些单据；若确认继续，这些预约将落在班次之外，需要人工跟进。
            </div>
          </div>
        </div>
        <LewTable
          :data-source="conflictList"
          :focusable="false"
          size="small"
          :columns="[
            { title: '单号', field: 'bookingNo', width: 170 },
            { title: '顾客', field: 'customerName', width: 120 },
            {
              title: '开始',
              field: 'startAt',
              width: 170,
              customRender: ({ row }) =>
                formatDateTime(
                  (row as unknown as ScheduleConflictItem).startAt,
                ),
            },
            {
              title: '结束',
              field: 'endAt',
              width: 170,
              customRender: ({ row }) =>
                formatDateTime((row as unknown as ScheduleConflictItem).endAt),
            },
          ]"
        />
      </div>
    </LewModal>
  </div>
</template>
