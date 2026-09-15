<script setup lang="ts">
import { computed } from 'vue';
import { Loader2 } from 'lucide-vue-next';
import {
  centsToYuanText,
  isDeadStatus,
  shortTime,
  shopDateOf,
  shopMinutesOf,
  shopTimeOf,
  statusColor,
  statusLabel,
  todayString,
  weekdayLabel,
} from './calendar-utils';
import type {
  CalendarBookingBlock,
  CalendarDay,
  CalendarScheduleCell,
  CalendarStaff,
} from './calendar-utils';

/**
 * 周视图日历：**列 = 一周 7 天，行 = 美甲师，格子里是班次 + 预约块**。
 *
 * 只读组件 —— 所有点击都只向上抛 `select-booking`，由页面决定打开哪个弹窗。
 * 这样排班页和预约页能共用同一套渲染，各自的写操作仍走各自的既有入口。
 */
const props = defineProps<{
  days: CalendarDay[];
  staffs: CalendarStaff[];
  /** 班次矩阵（排班页与预约页都传；不传就只画预约块） */
  cells?: CalendarScheduleCell[];
  bookings?: CalendarBookingBlock[];
  loading?: boolean;
  emptyText?: string;
}>();

const emit = defineEmits<{ 'select-booking': [id: number] }>();

const today = todayString();

/** `staffId|date` → 班次格；日历一屏最多 7 × 50 格，用 Map 避免嵌套 filter */
const cellIndex = computed(() => {
  const map = new Map<string, CalendarScheduleCell>();
  for (const cell of props.cells ?? []) {
    map.set(`${cell.staffId}|${cell.date}`, cell);
  }
  return map;
});

/** `staffId|date` → 当天的预约块（按开始时间升序） */
const bookingIndex = computed(() => {
  const map = new Map<string, CalendarBookingBlock[]>();
  for (const booking of props.bookings ?? []) {
    const key = `${booking.staffId}|${shopDateOf(booking.startAt)}`;
    const list = map.get(key) ?? [];
    list.push(booking);
    map.set(key, list);
  }
  for (const list of map.values()) {
    list.sort((a, b) => shopMinutesOf(a.startAt) - shopMinutesOf(b.startAt));
  }
  return map;
});

const gridTemplateColumns = computed(
  () => `132px repeat(${Math.max(props.days.length, 1)}, minmax(0, 1fr))`,
);

function cellOf(staffId: number, date: string) {
  return cellIndex.value.get(`${staffId}|${date}`);
}

function bookingsOf(staffId: number, date: string) {
  return bookingIndex.value.get(`${staffId}|${date}`) ?? [];
}

function blockTitle(booking: CalendarBookingBlock): string {
  return [
    booking.bookingNo,
    booking.customerName,
    `${shopTimeOf(booking.startAt)} - ${shopTimeOf(booking.endAt)}`,
    statusLabel(booking.status),
    `应付 ${centsToYuanText(booking.payableAmount)}`,
  ].join(' · ');
}
</script>

<template>
  <div class="relative">
    <!-- 加载遮罩：日历重取数是整块替换，遮罩比逐格骨架更不容易闪 -->
    <div
      v-if="loading"
      class="absolute inset-0 z-10 flex items-start justify-center bg-[var(--app-bg-card)]/70 pt-12"
    >
      <span
        class="flex items-center gap-2 rounded-full border border-[var(--app-border)] bg-[var(--app-bg-card)] px-3 py-1.5 text-12.5px text-[var(--app-text-secondary)] shadow-[var(--app-shadow)]"
      >
        <Loader2 :size="14" class="animate-spin" /> 正在加载日历…
      </span>
    </div>

    <div class="overflow-x-auto">
      <div class="min-w-[900px]">
        <!-- 表头：第一列是美甲师，后面 7 列是日期 -->
        <div
          class="grid border-b border-[var(--app-border)] bg-[var(--app-bg-hover)]"
          :style="{ gridTemplateColumns }"
        >
          <div class="px-3 py-2 text-12.5px text-[var(--app-text-secondary)]">
            美甲师
          </div>
          <div
            v-for="day in days"
            :key="day.date"
            class="px-2 py-2 text-center text-12.5px"
            :class="
              day.date === today
                ? 'font-600 text-[var(--lew-color-primary)]'
                : 'text-[var(--app-text-secondary)]'
            "
          >
            <div>{{ weekdayLabel(day.weekday) }}</div>
            <div class="text-11.5px tabular-nums">
              {{ day.date.slice(5) }}
              <span v-if="day.date === today" class="ml-1">今天</span>
            </div>
          </div>
        </div>

        <div
          v-if="!staffs.length"
          class="py-12 text-center text-12.5px text-[var(--app-text-muted)]"
        >
          {{ emptyText ?? '没有可展示的美甲师' }}
        </div>

        <!-- 每个美甲师一行 -->
        <div
          v-for="staff in staffs"
          :key="staff.id"
          class="grid border-b border-[var(--app-border)] last:border-b-0"
          :style="{ gridTemplateColumns }"
        >
          <div class="px-3 py-2 text-13px">{{ staff.nickname }}</div>

          <div
            v-for="day in days"
            :key="day.date"
            class="min-h-[104px] border-l border-[var(--app-border)] p-1.5"
            :class="
              day.date === today ? 'bg-[var(--lew-color-primary-light)]' : ''
            "
          >
            <!-- 班次（底色块）：休息 / 未排班 / 实际时段 -->
            <div class="mb-1 flex flex-wrap gap-1">
              <span
                v-if="cellOf(staff.id, day.date)?.off"
                class="rounded-4px bg-[var(--app-bg-hover)] px-1.5 py-0.5 text-11px text-[var(--app-text-muted)]"
              >
                休息
              </span>
              <span
                v-else-if="!cellOf(staff.id, day.date)?.segments.length"
                class="rounded-4px px-1.5 py-0.5 text-11px text-[var(--app-text-muted)]"
              >
                未排班
              </span>
              <span
                v-for="(segment, index) in cellOf(staff.id, day.date)
                  ?.segments ?? []"
                :key="index"
                class="rounded-4px px-1.5 py-0.5 text-11px tabular-nums"
                :class="
                  cellOf(staff.id, day.date)?.source === 'override'
                    ? 'bg-[var(--app-bg-hover)] font-600 text-[var(--app-text-secondary)]'
                    : 'bg-[var(--app-bg-hover)] text-[var(--app-text-muted)]'
                "
                :title="
                  cellOf(staff.id, day.date)?.source === 'override'
                    ? '当天有日期例外（请假 / 自定义时段）'
                    : cellOf(staff.id, day.date)?.source === 'store'
                      ? '本店专属周模板'
                      : '通用周模板'
                "
              >
                {{ shortTime(segment.startTime) }}-{{
                  shortTime(segment.endTime)
                }}
              </span>
            </div>

            <!-- 预约块 -->
            <div class="flex flex-col gap-1">
              <button
                v-for="booking in bookingsOf(staff.id, day.date)"
                :key="booking.id"
                type="button"
                class="w-full cursor-pointer rounded-4px border-l-[3px] bg-[var(--app-bg-hover)] px-1.5 py-1 text-left text-11.5px transition-[filter] hover:brightness-95"
                :class="isDeadStatus(booking.status) ? 'opacity-60' : ''"
                :style="{ borderLeftColor: statusColor(booking.status) }"
                :title="blockTitle(booking)"
                @click="emit('select-booking', booking.id)"
              >
                <span
                  class="mr-1 tabular-nums text-[var(--app-text-secondary)]"
                  >{{ shopTimeOf(booking.startAt) }}</span
                >
                <span
                  :class="isDeadStatus(booking.status) ? 'line-through' : ''"
                  >{{ booking.customerName }}</span
                >
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
