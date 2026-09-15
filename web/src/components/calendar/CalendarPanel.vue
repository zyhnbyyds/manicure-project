<script setup lang="ts">
import { computed } from 'vue';
import dayjs from 'dayjs';
import { LewButton, LewTabs } from 'lew-ui';
import CalendarWeekGrid from './CalendarWeekGrid.vue';
import CalendarDayTimeline from './CalendarDayTimeline.vue';
import { buildRange, todayString, weekdayLabel } from './calendar-utils';
import type {
  CalendarBookingBlock,
  CalendarMode,
  CalendarScheduleCell,
  CalendarStaff,
} from './calendar-utils';

/**
 * 日历面板（排班管理页 / 预约管理页共用）。
 *
 * 只负责**渲染 + 日期导航**，不做取数：两个页面的数据源不一样
 * （排班页只有班次，预约页还有预约块），取数留在各自的页面里。
 *
 * 页面侧用同一个 `buildRange(anchor, mode)` 算出要请求的区间 —— 面板内也调它，
 * 保证「面板显示的范围」和「页面请求的范围」永远是同一个。
 */
const props = defineProps<{
  /** 锚点日期 `YYYY-MM-DD`（周视图 = 该日所在周；日视图 = 该日） */
  modelValue: string;
  mode: CalendarMode;
  staffs: CalendarStaff[];
  cells?: CalendarScheduleCell[];
  bookings?: CalendarBookingBlock[];
  loading?: boolean;
  emptyText?: string;
}>();

const emit = defineEmits<{
  'update:modelValue': [value: string];
  'update:mode': [value: CalendarMode];
  'select-booking': [id: number];
}>();

const modeProxy = computed({
  get: () => props.mode,
  set: (value: string) => emit('update:mode', value as CalendarMode),
});

const modeOptions = [
  { label: '周视图', value: 'week' },
  { label: '日视图', value: 'day' },
];

const range = computed(() => buildRange(props.modelValue, props.mode));

const rangeLabel = computed(() => {
  if (props.mode === 'day') {
    const day = range.value.days[0];
    return day ? `${day.date}（${weekdayLabel(day.weekday)}）` : '';
  }
  return `${range.value.from} ~ ${range.value.to}`;
});

const isToday = computed(() => props.modelValue === todayString());

/** 周视图按周跳，日视图按天跳 */
function shift(direction: number) {
  const days = props.mode === 'week' ? direction * 7 : direction;
  emit(
    'update:modelValue',
    dayjs(props.modelValue).add(days, 'day').format('YYYY-MM-DD'),
  );
}

function backToToday() {
  emit('update:modelValue', todayString());
}
</script>

<template>
  <div class="flex flex-col gap-3">
    <!-- 工具栏：日期导航 + 视图切换 -->
    <div class="flex flex-wrap items-center gap-2">
      <LewButton type="text" color="gray" @click="shift(-1)"
        >上一{{ mode === 'week' ? '周' : '天' }}</LewButton
      >
      <span
        class="min-w-[196px] rounded-6px bg-[var(--app-bg-hover)] px-2.5 py-1 text-center text-13px font-600 tabular-nums"
        >{{ rangeLabel }}</span
      >
      <LewButton type="text" color="gray" @click="shift(1)"
        >下一{{ mode === 'week' ? '周' : '天' }}</LewButton
      >
      <LewButton type="light" :disabled="isToday" @click="backToToday">{{
        mode === 'week' ? '本周' : '今天'
      }}</LewButton>

      <div class="ml-auto">
        <LewTabs v-model="modeProxy" :options="modeOptions" type="line" />
      </div>
    </div>

    <!-- 周视图：列 = 7 天，行 = 美甲师 -->
    <CalendarWeekGrid
      v-if="mode === 'week'"
      :days="range.days"
      :staffs="staffs"
      :cells="cells"
      :bookings="bookings"
      :loading="loading"
      :empty-text="emptyText"
      @select-booking="emit('select-booking', $event)"
    />

    <!-- 日视图：单日纵向时间轴 -->
    <CalendarDayTimeline
      v-else
      :days="range.days"
      :staffs="staffs"
      :cells="cells"
      :bookings="bookings"
      :loading="loading"
      :empty-text="emptyText"
      @select-booking="emit('select-booking', $event)"
    />
  </div>
</template>
