<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { Loader2 } from 'lucide-vue-next';
import {
  centsToYuanText,
  isDeadStatus,
  minutesLabel,
  shopDateOf,
  shopMinutesOf,
  shopTimeOf,
  statusColor,
  statusLabel,
  timeToMinutes,
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
 * 日视图日历：**单日纵向时间轴，列 = 美甲师**。
 *
 * 预约块按真实时刻绝对定位（不是"每小时一行塞列表"），所以一眼就能看出
 * 谁几点到几点被占住、中间空了多长 —— 这正是周视图看不清的部分。
 */
const props = defineProps<{
  days: CalendarDay[];
  staffs: CalendarStaff[];
  cells?: CalendarScheduleCell[];
  bookings?: CalendarBookingBlock[];
  loading?: boolean;
  emptyText?: string;
}>();

const emit = defineEmits<{ 'select-booking': [id: number] }>();

/** 每小时的高度（px）—— 56 足够放两行小字，又不至于一屏只能看半天 */
const HOUR_HEIGHT = 56;

const today = todayString();

/** 当前店内分钟数（今天才画红线；每分钟刷一次刻度） */
function currentShopMinutes(): number {
  return shopMinutesOf(new Date().toISOString());
}
const nowMinutes = ref(currentShopMinutes());
let timer: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  timer = setInterval(() => {
    nowMinutes.value = currentShopMinutes();
  }, 60_000);
});
onUnmounted(() => {
  if (timer) clearInterval(timer);
});

/**
 * 时间轴范围：取「所有班次段 + 所有预约块」的最小开始、最大结束，
 * 各自向下/向上取整到整点。没有任何数据时回落到 09:00–21:00（营业常态）。
 */
const range = computed(() => {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const cell of props.cells ?? []) {
    for (const segment of cell.segments) {
      min = Math.min(min, timeToMinutes(segment.startTime));
      max = Math.max(max, timeToMinutes(segment.endTime));
    }
  }
  for (const booking of props.bookings ?? []) {
    min = Math.min(min, shopMinutesOf(booking.startAt));
    max = Math.max(max, shopMinutesOf(booking.endAt));
  }
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) {
    return { start: 9 * 60, end: 21 * 60 };
  }
  const start = Math.max(Math.floor(min / 60) * 60, 0);
  const end = Math.min(Math.max(Math.ceil(max / 60) * 60, start + 60), 24 * 60);
  // 至少铺 4 小时：只排了半小时的班次时，别把时间轴画成一条缝
  if (end - start >= 240) return { start, end };
  return { start: Math.max(start - 120, 0), end: start + 240 };
});

const hours = computed(() => {
  const list: number[] = [];
  // 含右端点：不然 20:00 收班时最后一条刻度线会缺失
  for (
    let minute = range.value.start;
    minute <= range.value.end;
    minute += 60
  ) {
    list.push(minute);
  }
  return list;
});

const bodyHeight = computed(
  () => ((range.value.end - range.value.start) / 60) * HOUR_HEIGHT,
);

const isToday = computed(
  () =>
    props.days[0]?.date === today &&
    nowMinutes.value >= range.value.start &&
    nowMinutes.value <= range.value.end,
);

function offsetTop(minutes: number): number {
  return ((minutes - range.value.start) / 60) * HOUR_HEIGHT;
}

const cellIndex = computed(() => {
  const map = new Map<number, CalendarScheduleCell>();
  for (const cell of props.cells ?? []) map.set(cell.staffId, cell);
  return map;
});

function segmentsOf(staffId: number) {
  return cellIndex.value.get(staffId)?.segments ?? [];
}

function isOff(staffId: number): boolean {
  return cellIndex.value.get(staffId)?.off ?? false;
}

/** 该美甲师当天的预约块（已按开始时间升序） */
function bookingsOf(staffId: number): CalendarBookingBlock[] {
  const date = props.days[0]?.date;
  return (props.bookings ?? [])
    .filter(
      (booking) =>
        booking.staffId === staffId &&
        (!date || shopDateOf(booking.startAt) === date),
    )
    .sort((a, b) => shopMinutesOf(a.startAt) - shopMinutesOf(b.startAt));
}

function segmentStyle(segment: { startTime: string; endTime: string }) {
  const start = timeToMinutes(segment.startTime);
  const end = Math.max(timeToMinutes(segment.endTime), start + 15);
  return {
    top: `${offsetTop(start)}px`,
    height: `${((end - start) / 60) * HOUR_HEIGHT}px`,
  };
}

function blockStyle(booking: CalendarBookingBlock) {
  const start = shopMinutesOf(booking.startAt);
  const end = Math.max(shopMinutesOf(booking.endAt), start + 15);
  const rawHeight = ((end - start) / 60) * HOUR_HEIGHT;
  return {
    top: `${offsetTop(start)}px`,
    // 至少 22px：15 分钟的单子也要能点得到
    height: `${Math.max(rawHeight - 2, 22)}px`,
    borderLeftColor: statusColor(booking.status),
  };
}
</script>

<template>
  <div class="relative">
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

    <div class="mb-2 text-12.5px text-[var(--app-text-secondary)]">
      <template v-if="days[0]">
        {{ days[0].date }}（{{ weekdayLabel(days[0].weekday) }}）
        <span
          v-if="days[0].date === today"
          class="ml-1 text-[var(--lew-color-primary)]"
          >今天</span
        >
      </template>
    </div>

    <div
      v-if="!staffs.length"
      class="py-12 text-center text-12.5px text-[var(--app-text-muted)]"
    >
      {{ emptyText ?? '没有可展示的美甲师' }}
    </div>

    <div
      v-else
      class="max-h-[620px] overflow-auto rounded-6px border border-[var(--app-border)]"
    >
      <div class="flex min-w-[560px]">
        <!-- 时间轴 -->
        <div class="w-[64px] shrink-0 border-r border-[var(--app-border)]">
          <div class="h-[40px] border-b border-[var(--app-border)]" />
          <div class="relative" :style="{ height: `${bodyHeight}px` }">
            <div
              v-for="minute in hours"
              :key="minute"
              class="absolute left-0 right-2 -translate-y-1/2 text-right text-11px tabular-nums text-[var(--app-text-muted)]"
              :style="{ top: `${offsetTop(minute)}px` }"
            >
              {{ minutesLabel(minute) }}
            </div>
          </div>
        </div>

        <!-- 每位美甲师一列 -->
        <div
          v-for="staff in staffs"
          :key="staff.id"
          class="min-w-[180px] flex-1 border-r border-[var(--app-border)] last:border-r-0"
        >
          <div
            class="flex h-[40px] items-center gap-1.5 border-b border-[var(--app-border)] px-2 text-12.5px"
          >
            <span>{{ staff.nickname }}</span>
            <span
              v-if="isOff(staff.id)"
              class="text-11px text-[var(--app-text-muted)]"
              >休息</span
            >
          </div>

          <div class="relative" :style="{ height: `${bodyHeight}px` }">
            <!-- 小时横线 -->
            <div
              v-for="minute in hours"
              :key="minute"
              class="absolute left-0 right-0 border-t border-[var(--app-border)]"
              :style="{ top: `${offsetTop(minute)}px` }"
            />

            <!-- 班次底（工作时段） -->
            <div
              v-for="(segment, index) in segmentsOf(staff.id)"
              :key="index"
              class="absolute left-0 right-0 bg-[var(--app-bg-hover)]"
              :style="segmentStyle(segment)"
            />

            <!-- 预约块 -->
            <button
              v-for="booking in bookingsOf(staff.id)"
              :key="booking.id"
              type="button"
              class="absolute left-1 right-1 cursor-pointer overflow-hidden rounded-4px border-l-[3px] bg-[var(--app-bg-card)] px-1.5 py-1 text-left text-11.5px shadow-[var(--app-shadow)] transition-[filter] hover:brightness-95"
              :class="isDeadStatus(booking.status) ? 'opacity-60' : ''"
              :style="blockStyle(booking)"
              :title="booking.bookingNo"
              @click="emit('select-booking', booking.id)"
            >
              <div class="truncate font-600">
                {{ shopTimeOf(booking.startAt) }} {{ booking.customerName }}
              </div>
              <div
                class="truncate text-[var(--app-text-muted)]"
                :class="isDeadStatus(booking.status) ? 'line-through' : ''"
              >
                {{ statusLabel(booking.status) }} ·
                {{ centsToYuanText(booking.payableAmount) }}
              </div>
            </button>

            <!-- 当前时刻 -->
            <div
              v-if="isToday"
              class="pointer-events-none absolute left-0 right-0 border-t-2 border-[var(--lew-color-error)]"
              :style="{ top: `${offsetTop(nowMinutes)}px` }"
            />
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
