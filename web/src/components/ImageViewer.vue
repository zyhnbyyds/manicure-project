<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { ChevronLeft, ChevronRight, Minus, Plus, X } from 'lucide-vue-next';

/**
 * 图片查看器（弹层）：**多图切换 + 滚轮缩放 + 拖拽平移**。
 *
 * 为什么要自己写：项目原先用 `window.open` / `<a target="_blank">` 预览，
 * 会跳出后台去开一个新标签页（丢掉上下文、手机上更难受）；
 * 而 lew-ui 自带的图片预览支持分组切换、**但不支持缩放**。
 *
 * 交互：
 * - 点击遮罩 / 右上角 × / `Esc` 关闭；
 * - 左右按钮 / `←` `→` 切换（`images` 多于一张时才显示计数器）；
 * - **滚轮缩放**（0.25× ~ 5×）、按住拖拽平移、双击复位；
 * - 缩放归零时自动回到「适应窗口」的初始状态。
 */
const props = withDefaults(
  defineProps<{
    visible: boolean;
    images: string[];
    /** 打开时定位到第几张（从 0 开始） */
    startIndex?: number;
  }>(),
  { startIndex: 0 },
);

const emit = defineEmits<{ 'update:visible': [value: boolean] }>();

const index = ref(0);
const scale = ref(1);
const offsetX = ref(0);
const offsetY = ref(0);
const dragging = ref(false);

const total = computed(() => props.images.length);
const current = computed(() => props.images[index.value] ?? '');
const canZoom = computed(() => total.value > 0);

const MIN_SCALE = 0.25;
const MAX_SCALE = 5;
/** 单步缩放倍数（按钮与滚轮共用） */
const STEP = 0.2;

function resetView() {
  scale.value = 1;
  offsetX.value = 0;
  offsetY.value = 0;
}

function close() {
  emit('update:visible', false);
}

function go(delta: number) {
  if (total.value === 0) return;
  index.value = (index.value + delta + total.value) % total.value;
  resetView();
}

function zoomBy(factor: number) {
  const next = scale.value * factor;
  scale.value = Math.min(MAX_SCALE, Math.max(MIN_SCALE, Number(next.toFixed(2))));
  // 缩回 1× 时顺手把平移复位，避免「看着没放大却偏到一边」
  if (scale.value === 1) {
    offsetX.value = 0;
    offsetY.value = 0;
  }
}

/** 滚轮缩放：用倍数而不是加法，手感在大小图之间更一致 */
function onWheel(event: WheelEvent) {
  if (!canZoom.value) return;
  event.preventDefault();
  zoomBy(event.deltaY < 0 ? 1 + STEP : 1 - STEP);
}

let dragStart: { x: number; y: number; ox: number; oy: number } | null = null;

function onPointerDown(event: PointerEvent) {
  if (scale.value <= 1) return; // 没放大就不拖，避免和「点击关闭」打架
  dragging.value = true;
  dragStart = {
    x: event.clientX,
    y: event.clientY,
    ox: offsetX.value,
    oy: offsetY.value,
  };
  (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
}

function onPointerMove(event: PointerEvent) {
  if (!dragging.value || !dragStart) return;
  offsetX.value = dragStart.ox + (event.clientX - dragStart.x);
  offsetY.value = dragStart.oy + (event.clientY - dragStart.y);
}

function onPointerUp() {
  dragging.value = false;
  dragStart = null;
}

function onKeydown(event: KeyboardEvent) {
  if (!props.visible) return;
  if (event.key === 'Escape') close();
  else if (event.key === 'ArrowLeft') go(-1);
  else if (event.key === 'ArrowRight') go(1);
}

watch(
  () => props.visible,
  (visible) => {
    if (visible) {
      index.value = Math.min(
        Math.max(props.startIndex ?? 0, 0),
        Math.max(props.images.length - 1, 0),
      );
      resetView();
      window.addEventListener('keydown', onKeydown);
    } else {
      window.removeEventListener('keydown', onKeydown);
    }
  },
);

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown);
});
</script>

<template>
  <Teleport to="body">
    <div
      v-if="visible"
      class="fixed inset-0 z-[3000] flex flex-col items-center justify-center bg-black/80"
      @click.self="close"
    >
      <!-- 工具条 -->
      <div class="flex w-full max-w-90vw items-center justify-between px-4 py-2 text-white">
        <span class="text-13px">
          <template v-if="total > 1">{{ index + 1 }} / {{ total }}</template>
        </span>
        <div class="flex items-center gap-1">
          <button
            class="rounded px-2 py-1 hover:bg-white/15"
            title="缩小"
            @click="zoomBy(1 - STEP)"
          >
            <Minus :size="16" />
          </button>
          <span class="w-12 text-center text-12px">{{ Math.round(scale * 100) }}%</span>
          <button
            class="rounded px-2 py-1 hover:bg-white/15"
            title="放大"
            @click="zoomBy(1 + STEP)"
          >
            <Plus :size="16" />
          </button>
          <button
            class="ml-2 rounded px-2 py-1 hover:bg-white/15"
            title="关闭（Esc）"
            @click="close"
          >
            <X :size="18" />
          </button>
        </div>
      </div>

      <!-- 图片区 -->
      <div
        class="relative flex max-h-[calc(100vh-120px)] w-full max-w-90vw flex-1 items-center justify-center overflow-hidden"
        @wheel="onWheel"
      >
        <button
          v-if="total > 1"
          class="absolute left-2 z-10 rounded-full bg-black/40 p-2 text-white hover:bg-black/60"
          title="上一张（←）"
          @click.stop="go(-1)"
        >
          <ChevronLeft :size="22" />
        </button>

        <img
          v-if="current"
          :src="current"
          alt="预览"
          class="max-h-full max-w-full select-none object-contain"
          :class="dragging ? 'cursor-grabbing' : scale > 1 ? 'cursor-grab' : 'cursor-zoom-in'"
          :style="{
            transform: `translate(${offsetX}px, ${offsetY}px) scale(${scale})`,
            transition: dragging ? 'none' : 'transform 0.12s ease-out',
          }"
          draggable="false"
          @pointerdown="onPointerDown"
          @pointermove="onPointerMove"
          @pointerup="onPointerUp"
          @pointercancel="onPointerUp"
          @dblclick="resetView"
        />

        <button
          v-if="total > 1"
          class="absolute right-2 z-10 rounded-full bg-black/40 p-2 text-white hover:bg-black/60"
          title="下一张（→）"
          @click.stop="go(1)"
        >
          <ChevronRight :size="22" />
        </button>
      </div>

      <p class="py-2 text-12px text-white/70">
        滚轮缩放 · 按住拖拽 · 双击复位<template v-if="total > 1"> · ← → 切换</template>
      </p>
    </div>
  </Teleport>
</template>
