<script setup lang="ts">
/**
 * 全局图片查看器（**单例**，实例挂在 `App.vue` 上）。
 *
 * 打开方式只有一句（见 `~/composables/useImagePreview`）：
 * `openImagePreview(images, startIndex, title)`。
 *
 * 为什么不用现成的：
 * - `window.open` / `<a target="_blank">` 会跳出后台开新标签，丢掉上下文；
 * - lew-ui 2.8.2 **根本没有**图片预览（`preview-group-key` 只是个没人消费的属性，
 *   上传后的缩略图点了没有任何反应），更谈不上缩放 —— 所以只能自己写一套，
 *   并且挂成全局单例，任何页面共用同一个实例与同一套手感。
 *
 * 交互约定（桌面 + 触屏一套逻辑，不做两套）：
 * - 点击图片以外的空白、右上角 ×、`Esc` 关闭；
 * - `←` `→` / 左右按钮 / 底部缩略图切换，`Home` `End` 跳首尾；触控板横向滑动也能翻页；
 * - **围绕指针缩放**：滚轮 / 双指捏合 / `+` `-` 按钮；双击在「适应窗口 ↔ 2.5×」间切换；
 * - 放大后按住拖拽平移，且**拖不出边界**；`0` 或工具栏「适应」复位；
 * - 切图保留缩放复位，拖拽超过阈值就**不**触发关闭（避免「拖完一松手弹层没了」）。
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import {
  ChevronLeft,
  ChevronRight,
  ImageOff,
  Images,
  Maximize2,
  Minus,
  Plus,
  X,
} from 'lucide-vue-next';
import { LewTextTrim } from 'lew-ui';
import { useImagePreview } from '~/composables/useImagePreview';
import {
  CLICK_SLOP,
  DOUBLE_CLICK_SCALE,
  MIN_SCALE,
  ZOOM_STEP,
  clampPan,
  clampScale,
  previewImageName,
  wheelPaging,
  wrapIndex,
  zoomAround,
} from '~/utils/image-viewer';
import type { Point, Size } from '~/utils/image-viewer';

const { state, close } = useImagePreview();

const stageRef = ref<HTMLElement | null>(null);
const imageRef = ref<HTMLImageElement | null>(null);
const thumbStripRef = ref<HTMLElement | null>(null);

const scale = ref(MIN_SCALE);
const pan = ref<Point>({ x: 0, y: 0 });
const dragging = ref(false);
const loading = ref(true);
const failed = ref(false);
const showThumbs = ref(true);
/** 切换方向：决定入场动画从哪边滑进来 */
const direction = ref(1);
/** 重新加载用的计数（只用来拼一个变地址，破掉浏览器的失败缓存） */
const retryToken = ref(0);

/** 多指（捏合）与拖拽的临时状态：不进 `ref`，免得每次 move 都触发渲染 */
const pointers = new Map<number, Point>();
let dragStart: { x: number; y: number; panX: number; panY: number } | null =
  null;
let pinchDistance = 0;
/** 本次按下的最大位移：用来区分「点击」与「拖拽」 */
let moved = 0;

const total = computed(() => state.images.length);
const current = computed(() => state.images[state.index]);
const imageName = computed(() =>
  previewImageName(current.value, state.index, total.value),
);
/** 顶部主标题：图集名（服务项目名等）优先 */
const heading = computed(() => state.title || imageName.value);
const subheading = computed(() => {
  const parts: string[] = [];
  if (total.value > 1)
    parts.push(`第 ${state.index + 1} / 共 ${total.value} 张`);
  if (state.title) parts.push(imageName.value);
  parts.push(`缩放 ${Math.round(scale.value * 100)}%`);
  return parts.join(' · ');
});
const transitionName = computed(() =>
  direction.value >= 0 ? 'iv-next' : 'iv-prev',
);

/** 重新加载时换个地址（不然浏览器会直接吐缓存里的失败结果） */
const imageSrc = computed(() => {
  const url = current.value?.url ?? '';
  if (!retryToken.value) return url;
  const hashAt = url.indexOf('#');
  const base = hashAt === -1 ? url : url.slice(0, hashAt);
  const hash = hashAt === -1 ? '' : url.slice(hashAt);
  return `${base}${base.includes('?') ? '&' : '?'}_r=${retryToken.value}${hash}`;
});

const frameStyle = computed(() => ({
  transform: `translate3d(${pan.value.x}px, ${pan.value.y}px, 0) scale(${scale.value})`,
  transition: dragging.value ? 'none' : undefined,
}));

const stageCursor = computed(() => {
  if (scale.value <= MIN_SCALE) return 'cursor-zoom-in';
  return dragging.value ? 'cursor-grabbing' : 'cursor-grab';
});

// ---------- 尺寸与缩放 ----------
function viewportSize(): Size {
  const stage = stageRef.value;
  return { width: stage?.clientWidth ?? 0, height: stage?.clientHeight ?? 0 };
}

/** 图片**缩放后**的实际尺寸；`offsetWidth` 不受 transform 影响，正是布局尺寸 */
function renderedSize(nextScale: number): Size {
  const image = imageRef.value;
  if (!image?.offsetWidth) return { width: 0, height: 0 };
  return {
    width: image.offsetWidth * nextScale,
    height: image.offsetHeight * nextScale,
  };
}

function resetView() {
  scale.value = MIN_SCALE;
  pan.value = { x: 0, y: 0 };
}

/** 把 `clientX/clientY` 换算成相对**图片中心**的坐标（= transform-origin） */
function anchorOf(clientX: number, clientY: number): Point {
  const box = (imageRef.value ?? stageRef.value)?.getBoundingClientRect();
  if (!box) return { x: 0, y: 0 };
  return {
    x: clientX - box.left - box.width / 2,
    y: clientY - box.top - box.height / 2,
  };
}

/** 围绕锚点缩放，并立刻按新尺寸夹一次平移 */
function applyZoom(factor: number, anchor: Point) {
  const next = clampScale(scale.value * factor);
  // 被 MIN/MAX 夹过之后的**实际**倍数才是锚点公式的输入
  const applied = next / scale.value;
  if (!Number.isFinite(applied) || Math.abs(applied - 1) < 1e-6) return;
  const moved0 = zoomAround(pan.value, applied, anchor);
  scale.value = next;
  pan.value = clampPan(moved0, renderedSize(next), viewportSize());
}

function zoomByStep(directionSign: number) {
  applyZoom(directionSign > 0 ? 1 + ZOOM_STEP : 1 - ZOOM_STEP, { x: 0, y: 0 });
}

// ---------- 切换 ----------
function scrollThumbIntoView() {
  const strip = thumbStripRef.value;
  strip?.querySelector<HTMLElement>('.iv-thumb.is-active')?.scrollIntoView({
    behavior: 'smooth',
    block: 'nearest',
    inline: 'center',
  });
}

/** 预取左右两张，翻页时不再看到加载圈 */
function preloadNeighbors() {
  if (total.value <= 1) return;
  for (const delta of [1, -1]) {
    const url = state.images[wrapIndex(state.index, delta, total.value)]?.url;
    if (!url) continue;
    const image = new Image();
    image.decoding = 'async';
    image.src = url;
  }
}

function go(delta: number) {
  if (total.value <= 1) return;
  direction.value = delta >= 0 ? 1 : -1;
  state.index = wrapIndex(state.index, delta, total.value);
}

function select(index: number) {
  if (index === state.index) return;
  direction.value = index > state.index ? 1 : -1;
  state.index = index;
}

function retry() {
  retryToken.value += 1;
  loading.value = true;
  failed.value = false;
}

function onImageLoad() {
  loading.value = false;
  failed.value = false;
}

function onImageError() {
  loading.value = false;
  failed.value = true;
}

// ---------- 指针：拖拽 / 捏合 ----------
function distanceOfPointers(): number {
  const [a, b] = [...pointers.values()];
  if (!a || !b) return 0;
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function midpointAnchor(): Point {
  const [a, b] = [...pointers.values()];
  if (!a || !b) return { x: 0, y: 0 };
  return anchorOf((a.x + b.x) / 2, (a.y + b.y) / 2);
}

function onPointerDown(event: PointerEvent) {
  if (event.pointerType === 'mouse' && event.button !== 0) return;
  // 点在翻页按钮上：交给 click，别把指针捕获抢走（否则按钮可能点不动）
  if ((event.target as HTMLElement | null)?.closest('button')) return;
  const stage = event.currentTarget as HTMLElement;
  try {
    stage.setPointerCapture(event.pointerId);
  } catch {
    // 某些环境（旧 Safari / 合成事件）不支持捕获，退化成普通事件流即可
  }
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

  if (pointers.size >= 2) {
    // 进入捏合：放弃单指拖拽
    dragStart = null;
    dragging.value = false;
    pinchDistance = distanceOfPointers();
    moved = CLICK_SLOP + 1; // 多指操作不该被判成「点击关闭」
    return;
  }

  moved = 0;
  dragStart = {
    x: event.clientX,
    y: event.clientY,
    panX: pan.value.x,
    panY: pan.value.y,
  };
  dragging.value = scale.value > MIN_SCALE;
}

function onPointerMove(event: PointerEvent) {
  if (!pointers.has(event.pointerId)) return;
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

  if (pointers.size >= 2) {
    const distance = distanceOfPointers();
    if (pinchDistance > 0 && distance > 0) {
      applyZoom(distance / pinchDistance, midpointAnchor());
      pinchDistance = distance;
    }
    return;
  }

  if (!dragStart) return;
  const dx = event.clientX - dragStart.x;
  const dy = event.clientY - dragStart.y;
  moved = Math.max(moved, Math.hypot(dx, dy));
  if (scale.value <= MIN_SCALE) return; // 没放大就不平移
  pan.value = clampPan(
    { x: dragStart.panX + dx, y: dragStart.panY + dy },
    renderedSize(scale.value),
    viewportSize(),
  );
}

function onPointerUp(event: PointerEvent) {
  pointers.delete(event.pointerId);
  if (pointers.size < 2) pinchDistance = 0;
  if (pointers.size === 0) {
    dragging.value = false;
    dragStart = null;
  }
  const stage = event.currentTarget as HTMLElement | undefined;
  try {
    if (stage?.hasPointerCapture?.(event.pointerId))
      stage.releasePointerCapture(event.pointerId);
  } catch {
    // 同上：捕获失败时无需释放
  }
}

// ---------- 滚轮 / 双击 ----------
function onWheel(event: WheelEvent) {
  if (!total.value) return;
  // 触控板「两指横扫」当翻页用；纵向滚动才是缩放
  const page = wheelPaging(event.deltaX, event.deltaY);
  if (page && scale.value <= MIN_SCALE) {
    go(page);
    return;
  }
  applyZoom(
    event.deltaY < 0 ? 1 + ZOOM_STEP : 1 - ZOOM_STEP,
    anchorOf(event.clientX, event.clientY),
  );
}

/** 缩略图条上的滚轮转成横向滚动（竖向滚轮在这里不该改变缩放） */
function onThumbWheel(event: WheelEvent) {
  event.preventDefault();
  event.stopPropagation();
  const strip = thumbStripRef.value;
  if (strip) strip.scrollLeft += event.deltaY + event.deltaX;
}

function onDoubleClick(event: MouseEvent) {
  event.preventDefault();
  if (scale.value > MIN_SCALE) resetView();
  else applyZoom(DOUBLE_CLICK_SCALE, anchorOf(event.clientX, event.clientY));
}

/** 点空白关闭：点在图片 / 按钮 / 失败卡片上都不算空白；拖拽结束那一下也不算 */
function onBackdropClick(event: MouseEvent) {
  if (moved > CLICK_SLOP) return;
  const target = event.target as HTMLElement | null;
  if (target?.closest('button, img, .iv-keep-open')) return;
  close();
}

// ---------- 键盘 ----------
function onKeydown(event: KeyboardEvent) {
  if (!state.visible) return;
  const target = event.target as HTMLElement | null;
  if (target?.isContentEditable) return;

  // 捕获阶段就掐断：lew-ui 的 `LewModal` 也监听 Esc（内部 z-index 管理器 +
  // `closeByEsc`，只关它自己认定的「栈顶弹窗」），而查看器**不在它的登记表里** ——
  // 不拦的话，在编辑弹窗里按 Esc 会把底下的弹窗一起关掉（未保存的表单直接丢）。
  // 顺带也避免 ← → / Home / End 去操作被盖住的表格与分页。
  const swallow = () => event.stopPropagation();

  switch (event.key) {
    case 'Escape':
      swallow();
      close();
      break;
    case 'ArrowLeft':
      swallow();
      event.preventDefault();
      go(-1);
      break;
    case 'ArrowRight':
      swallow();
      event.preventDefault();
      go(1);
      break;
    case 'Home':
      swallow();
      event.preventDefault();
      select(0);
      break;
    case 'End':
      swallow();
      event.preventDefault();
      select(total.value - 1);
      break;
    case '+':
    case '=':
      swallow();
      event.preventDefault();
      zoomByStep(1);
      break;
    case '-':
    case '_':
      swallow();
      event.preventDefault();
      zoomByStep(-1);
      break;
    case '0':
      swallow();
      event.preventDefault();
      resetView();
      break;
    default:
      break;
  }
}

// ---------- 生命周期：锁滚动 / 换图复位 ----------
let restoreOverflow = '';

function lockPageScroll() {
  restoreOverflow = document.body.style.overflow;
  document.body.style.overflow = 'hidden';
}

function unlockPageScroll() {
  document.body.style.overflow = restoreOverflow;
}

function clearPointers() {
  pointers.clear();
  dragStart = null;
  pinchDistance = 0;
  moved = 0;
  dragging.value = false;
}

/** 切图 / 换图集 / 重新打开时的共同复位动作（三处调用，只写一遍） */
function resetForNewImage() {
  resetView();
  retryToken.value = 0;
  loading.value = true;
  failed.value = false;
  preloadNeighbors();
  void nextTick(() => scrollThumbIntoView());
}

watch(
  () => state.visible,
  (visible) => {
    if (visible) {
      showThumbs.value = true;
      lockPageScroll();
      window.addEventListener('keydown', onKeydown, true);
      resetForNewImage();
    } else {
      unlockPageScroll();
      window.removeEventListener('keydown', onKeydown, true);
      clearPointers();
    }
  },
);

watch(() => state.index, resetForNewImage);

/** 已经开着的时候又调了一次 `openImagePreview`（换了一组图、下标没变）也要复位 */
watch(
  () => state.images,
  () => {
    if (state.visible) resetForNewImage();
  },
);

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown, true);
  unlockPageScroll();
});
</script>

<template>
  <Teleport to="body">
    <Transition name="iv-overlay">
      <div
        v-if="state.visible"
        class="fixed inset-0 z-[3000] flex select-none flex-col bg-[#2D221E]/92 text-[#FBF5F0] backdrop-blur-2px"
        role="dialog"
        aria-modal="true"
        aria-label="图片预览"
        @wheel.prevent="onWheel"
      >
        <!-- 顶栏 -->
        <header
          class="flex shrink-0 items-center justify-between gap-4 px-4 py-3"
        >
          <div class="min-w-0">
            <LewTextTrim class="text-13.5px font-600" :text="heading" />
            <LewTextTrim
              class="mt-0.5 text-11.5px text-[#FBF5F0]/50"
              :text="subheading"
            />
          </div>
          <div class="flex shrink-0 items-center gap-2">
            <button
              class="iv-btn"
              :disabled="scale <= MIN_SCALE"
              title="适应窗口（0）"
              @click="resetView()"
            >
              <Maximize2 :size="15" />
              <span class="hidden sm:inline">适应</span>
            </button>
            <div class="iv-btn !gap-0 !px-1">
              <button
                class="iv-icon-btn"
                title="缩小（-）"
                @click="zoomByStep(-1)"
              >
                <Minus :size="15" />
              </button>
              <span class="w-42px text-center text-11.5px tabular-nums">
                {{ Math.round(scale * 100) }}%
              </span>
              <button
                class="iv-icon-btn"
                title="放大（+）"
                @click="zoomByStep(1)"
              >
                <Plus :size="15" />
              </button>
            </div>
            <button
              v-if="total > 1"
              class="iv-btn"
              :class="{ 'is-on': showThumbs }"
              :title="showThumbs ? '隐藏缩略图' : '显示缩略图'"
              @click="showThumbs = !showThumbs"
            >
              <Images :size="15" />
            </button>
            <button class="iv-btn" title="关闭（Esc）" @click="close()">
              <X :size="16" />
            </button>
          </div>
        </header>

        <!-- 图片区 -->
        <main
          ref="stageRef"
          class="relative min-h-0 flex-1 overflow-hidden"
          :class="stageCursor"
          @click="onBackdropClick"
          @pointerdown="onPointerDown"
          @pointermove="onPointerMove"
          @pointerup="onPointerUp"
          @pointercancel="onPointerUp"
          @dblclick="onDoubleClick"
        >
          <div class="iv-frame" :style="frameStyle">
            <Transition :name="transitionName" mode="out-in">
              <img
                v-if="!failed"
                :key="state.index"
                ref="imageRef"
                :src="imageSrc"
                :alt="imageName"
                class="iv-image"
                draggable="false"
                @load="onImageLoad"
                @error="onImageError"
              />
              <div
                v-else
                :key="`failed-${state.index}`"
                class="iv-keep-open flex max-w-460px flex-col items-center gap-3 rounded-12px border border-[#FBF5F0]/12 bg-[#FBF5F0]/6 px-8 py-7 text-center"
              >
                <ImageOff :size="28" class="opacity-70" />
                <p class="m-0 text-13px">图片加载失败</p>
                <p class="m-0 break-all text-11.5px text-[#FBF5F0]/50">
                  {{ current?.url }}
                </p>
                <button class="iv-btn" @click="retry()">重新加载</button>
              </div>
            </Transition>
          </div>

          <button
            v-if="total > 1"
            class="iv-nav left-3"
            title="上一张（←）"
            @click="go(-1)"
          >
            <ChevronLeft :size="22" />
          </button>
          <button
            v-if="total > 1"
            class="iv-nav right-3"
            title="下一张（→）"
            @click="go(1)"
          >
            <ChevronRight :size="22" />
          </button>

          <div
            v-if="loading && !failed"
            class="pointer-events-none absolute inset-0 flex items-center justify-center"
          >
            <span
              class="h-8 w-8 animate-spin rounded-full border-2 border-[#FBF5F0]/20 border-t-[#FBF5F0]"
            />
          </div>
        </main>

        <!-- 底部缩略图 + 提示 -->
        <footer class="shrink-0 px-4 pb-3 pt-1">
          <Transition name="iv-thumbs">
            <div
              v-if="showThumbs && total > 1"
              ref="thumbStripRef"
              class="iv-strip"
              @wheel="onThumbWheel"
            >
              <button
                v-for="(image, i) in state.images"
                :key="`${i}-${image.url}`"
                class="iv-thumb"
                :class="{ 'is-active': i === state.index }"
                :title="previewImageName(image, i, total)"
                @click="select(i)"
              >
                <img
                  :src="image.url"
                  :alt="previewImageName(image, i, total)"
                  loading="lazy"
                  decoding="async"
                  draggable="false"
                />
                <span class="iv-thumb-index">{{ i + 1 }}</span>
              </button>
            </div>
          </Transition>
          <p class="m-0 mt-1 text-center text-11.5px text-[#FBF5F0]/40">
            滚轮 / 双指缩放 · 拖拽平移 · 双击复位 · ← → 切换 · Esc 关闭
          </p>
        </footer>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
/* 弹层淡入 + 内容轻微放大上浮（对齐全站的 `--app-transition` 手感） */
.iv-overlay-enter-active,
.iv-overlay-leave-active {
  transition: opacity 0.24s cubic-bezier(0.2, 0.9, 0.4, 1);
}

.iv-overlay-enter-from,
.iv-overlay-leave-to {
  opacity: 0;
}

.iv-overlay-enter-active main,
.iv-overlay-leave-active main {
  transition:
    transform 0.28s cubic-bezier(0.2, 0.9, 0.4, 1),
    opacity 0.24s ease;
}

.iv-overlay-enter-from main {
  opacity: 0;
  transform: scale(0.94) translateY(12px);
}

.iv-overlay-leave-to main {
  opacity: 0;
  transform: scale(0.97);
}

/* 图片区：外层负责缩放平移，内层图片只做「换图」动画，
   两者分开是为了避免 transition 的 transform 与内联 transform 互相覆盖 */
.iv-frame {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  will-change: transform;
  transition: transform 0.15s cubic-bezier(0.2, 0.9, 0.4, 1);
}

.iv-image {
  display: block;
  max-width: 100%;
  max-height: 100%;
  border-radius: 10px;
  object-fit: contain;
  box-shadow: 0 18px 48px rgb(0 0 0 / 45%);
}

.iv-next-enter-active,
.iv-prev-enter-active {
  transition:
    opacity 0.2s cubic-bezier(0.2, 0.9, 0.4, 1),
    transform 0.24s cubic-bezier(0.2, 0.9, 0.4, 1);
}

.iv-next-leave-active,
.iv-prev-leave-active {
  transition:
    opacity 0.14s ease-in,
    transform 0.18s ease-in;
}

.iv-next-enter-from,
.iv-prev-leave-to {
  opacity: 0;
  transform: translateX(28px) scale(0.98);
}

.iv-prev-enter-from,
.iv-next-leave-to {
  opacity: 0;
  transform: translateX(-28px) scale(0.98);
}

/* 左右翻页按钮 */
.iv-nav {
  position: absolute;
  z-index: 10;
  top: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  margin-top: -20px;
  color: #fbf5f0;
  cursor: pointer;
  background: rgb(45 34 30 / 55%);
  border: 1px solid rgb(251 245 240 / 14%);
  border-radius: 999px;
  transition:
    background var(--app-transition),
    transform var(--app-transition);
}

.iv-nav:hover {
  background: rgb(180 95 107 / 85%);
  transform: scale(1.06);
}

/* 工具栏按钮 */
.iv-btn {
  display: inline-flex;
  gap: 4px;
  align-items: center;
  justify-content: center;
  height: 30px;
  padding: 0 10px;
  color: #fbf5f0;
  cursor: pointer;
  background: rgb(251 245 240 / 6%);
  border: 1px solid rgb(251 245 240 / 14%);
  border-radius: 8px;
  transition:
    background var(--app-transition),
    border-color var(--app-transition),
    opacity var(--app-transition);
}

.iv-btn:hover:not(:disabled) {
  background: rgb(251 245 240 / 16%);
}

.iv-btn:disabled {
  cursor: default;
  opacity: 0.4;
}

.iv-btn.is-on {
  background: rgb(180 95 107 / 26%);
  border-color: rgb(180 95 107 / 90%);
}

.iv-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  color: inherit;
  cursor: pointer;
  background: transparent;
  border: 0;
  border-radius: 6px;
  transition: background var(--app-transition);
}

.iv-icon-btn:hover {
  background: rgb(251 245 240 / 14%);
}

/* 底部缩略图条 */
.iv-strip {
  display: flex;
  gap: 8px;
  justify-content: center;
  justify-content: safe center;
  padding: 6px 2px 2px;
  overflow-x: auto;
  scrollbar-width: thin;
}

.iv-thumb {
  position: relative;
  flex: 0 0 auto;
  width: 56px;
  height: 56px;
  padding: 0;
  overflow: hidden;
  cursor: pointer;
  background: rgb(251 245 240 / 6%);
  border: 2px solid transparent;
  border-radius: 8px;
  opacity: 0.55;
  transition:
    opacity var(--app-transition),
    border-color var(--app-transition),
    transform var(--app-transition);
}

.iv-thumb:hover {
  opacity: 0.9;
  transform: translateY(-2px);
}

.iv-thumb.is-active {
  border-color: #b45f6b;
  box-shadow: 0 0 0 2px rgb(180 95 107 / 35%);
  opacity: 1;
}

.iv-thumb img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.iv-thumb-index {
  position: absolute;
  right: 3px;
  bottom: 2px;
  padding: 1px 3px;
  font-size: 10px;
  line-height: 1.3;
  color: rgb(251 245 240 / 85%);
  background: rgb(45 34 30 / 65%);
  border-radius: 4px;
}

.iv-thumbs-enter-active,
.iv-thumbs-leave-active {
  transition:
    opacity 0.2s cubic-bezier(0.2, 0.9, 0.4, 1),
    transform 0.2s cubic-bezier(0.2, 0.9, 0.4, 1);
}

.iv-thumbs-enter-from,
.iv-thumbs-leave-to {
  opacity: 0;
  transform: translateY(10px);
}

@media (prefers-reduced-motion: reduce) {
  .iv-frame,
  .iv-next-enter-active,
  .iv-prev-enter-active,
  .iv-overlay-enter-active {
    transition: none;
  }
}
</style>
