<script setup lang="ts">
import {
  computed,
  onBeforeUnmount,
  onMounted,
  reactive,
  ref,
  watch,
} from 'vue';
import { useRoute } from 'vue-router';
import { Bot, GripHorizontal, Maximize, Minimize, X } from 'lucide-vue-next';
import AiChatPage from '~/views/ai/index.vue';

/**
 * AI 操作助手弹出面板：整块「蓝紫渐变 + 网格」背板，中间浮一张大圆角对话卡。
 *
 * 内容复用 views/ai/index.vue；Esc / 点击背板 / 右上角关闭。
 * 卡片可拖拽顶部把手改尺寸（也提供全屏），把尺寸记在 localStorage，
 * 下次打开还是用户调过的大小。
 */
const props = defineProps<{
  visible: boolean;
}>();

const emit = defineEmits<{
  (e: 'update:visible', value: boolean): void;
}>();

const route = useRoute();
const fullscreen = ref(false);

const SIZE_KEY = 'ai-panel-size';
/** 桌面端默认留白：设计稿约 200px/2560 ≈ 7.8vw，这里取 11vw 兼顾 1366 宽的笔记本 */
const DEFAULT_INSET = 'min(11vw, 168px)';
/** 拖动把手时距背板边缘的最小留白 */
const MIN_GAP = 16;

/** 卡片四边留白（存 localStorage 的是 px 数值，null = 用上面的 CSS 表达式） */
const insets = reactive<{
  left: number | null;
  right: number | null;
  top: number | null;
  bottom: number | null;
}>({ left: null, right: null, top: null, bottom: null });

function loadInsets() {
  try {
    const saved = JSON.parse(localStorage.getItem(SIZE_KEY) ?? 'null');
    if (
      saved &&
      ['left', 'right', 'top', 'bottom'].every(
        (key) => typeof saved[key] === 'number',
      )
    ) {
      Object.assign(insets, saved);
    }
  } catch {
    // 脏数据直接忽略，用默认尺寸
  }
}

loadInsets();

const cardStyle = computed(() => {
  if (fullscreen.value) return { inset: '0px', borderRadius: '0px' };
  const fallback = (value: number | null, css: string) =>
    value === null ? css : `${value}px`;
  return {
    left: fallback(insets.left, DEFAULT_INSET),
    right: fallback(insets.right, DEFAULT_INSET),
    top: fallback(insets.top, `min(11vh, 104px)`),
    bottom: fallback(insets.bottom, `min(11vh, 104px)`),
    borderRadius: '24px',
  };
});

// ---------- 拖拽改尺寸（顶部把手：同时调左右与上下留白，保持卡片居中） ----------

const dragging = ref(false);
const cardEl = ref<HTMLElement | null>(null);
let start = {
  x: 0,
  y: 0,
  left: 0,
  right: 0,
  top: 0,
  bottom: 0,
  width: 0,
  height: 0,
};

/** 把 CSS 表达式（vw/vh）折算成当前像素，作为拖拽起点 */
function currentPixelInsets() {
  const rect = cardEl.value?.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  return {
    left: insets.left ?? rect?.left ?? vw * 0.11,
    right: insets.right ?? (rect ? vw - rect.right : vw * 0.11),
    top: insets.top ?? rect?.top ?? vh * 0.11,
    bottom: insets.bottom ?? (rect ? vh - rect.bottom : vh * 0.11),
    width: rect?.width ?? vw * 0.78,
    height: rect?.height ?? vh * 0.78,
  };
}

function startDrag(event: PointerEvent) {
  if (fullscreen.value) return;
  event.preventDefault();
  const base = currentPixelInsets();
  Object.assign(insets, {
    left: base.left,
    right: base.right,
    top: base.top,
    bottom: base.bottom,
  });
  start = { x: event.clientX, y: event.clientY, ...base };
  dragging.value = true;
  window.addEventListener('pointermove', onDragMove);
  window.addEventListener('pointerup', stopDrag);
}

function onDragMove(event: PointerEvent) {
  if (!dragging.value) return;
  const dx = event.clientX - start.x;
  const dy = event.clientY - start.y;
  // 对称收缩：左右（上下）各收同样的量，卡片始终居中
  const maxHorizontal = Math.max(0, (start.width - 420) / 2);
  const maxVertical = Math.max(0, (start.height - 320) / 2);
  const clamp = (value: number, max: number) =>
    Math.max(-max, Math.min(max, value));
  insets.left = start.left + clamp(dx, maxHorizontal);
  insets.right = start.right - clamp(dx, maxHorizontal);
  insets.top = Math.max(MIN_GAP, start.top + clamp(dy, maxVertical));
  insets.bottom = Math.max(MIN_GAP, start.bottom - clamp(dy, maxVertical));
}

function stopDrag() {
  if (!dragging.value) return;
  dragging.value = false;
  window.removeEventListener('pointermove', onDragMove);
  window.removeEventListener('pointerup', stopDrag);
  try {
    localStorage.setItem(SIZE_KEY, JSON.stringify(insets));
  } catch {
    // 隐私模式下写入会抛错，忽略即可（尺寸不持久化而已）
  }
}

function resetSize() {
  insets.left = null;
  insets.right = null;
  insets.top = null;
  insets.bottom = null;
  try {
    localStorage.removeItem(SIZE_KEY);
  } catch {
    // 同上
  }
}

// ---------- 开关与快捷键 ----------

function close() {
  emit('update:visible', false);
}

// 每次重新打开时恢复为非全屏
watch(
  () => props.visible,
  (v) => {
    if (!v) fullscreen.value = false;
  },
);

// 路由切换时关闭面板（避免面板叠在其它整页之上）
watch(
  () => route.path,
  () => {
    if (props.visible) close();
  },
);

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && props.visible) close();
}

onMounted(() => window.addEventListener('keydown', onKeydown));
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown);
  window.removeEventListener('pointermove', onDragMove);
  window.removeEventListener('pointerup', stopDrag);
});
</script>

<template>
  <Teleport to="body">
    <!-- 背板：蓝紫渐变 + 微妙网格，本身就是「AI 产品」的科技感来源 -->
    <Transition name="fade">
      <div
        v-if="props.visible"
        class="ai-backdrop fixed inset-0 z-1200"
        @click="close"
      >
        <div class="ai-grid absolute inset-0" />
      </div>
    </Transition>

    <Transition name="rise">
      <section
        v-if="props.visible"
        ref="cardEl"
        class="ai-card fixed z-1201 flex flex-col overflow-hidden"
        :class="dragging ? 'select-none' : ''"
        :style="cardStyle"
      >
        <!-- 卡片自己的浅色工具条（背板已负责质感，这里保持干净） -->
        <div
          class="ai-panel-toolbar flex items-center gap-2 h-11 shrink-0 pl-4 pr-2 border-b border-[var(--app-border)] bg-[var(--app-bg-card)]"
        >
          <span
            class="flex items-center justify-center w-6 h-6 rounded-lg ai-gradient"
          >
            <Bot :size="14" color="#fff" />
          </span>
          <span class="text-14px font-700">AI 操作助手</span>
          <button
            type="button"
            class="ai-drag-handle flex items-center justify-center gap-1 h-6 px-3 ml-2 rounded-full cursor-grab text-11px text-white/85 hover:text-white active:cursor-grabbing"
            :class="fullscreen ? 'invisible' : ''"
            title="拖动调整窗口大小（双击恢复默认）"
            @pointerdown="startDrag"
            @dblclick="resetSize"
          >
            <GripHorizontal :size="13" />
            拖动调整大小
          </button>
          <div class="ml-auto flex items-center gap-1">
            <button
              type="button"
              class="flex items-center justify-center w-8 h-8 rounded-lg text-[var(--app-text-muted)] transition-colors hover:bg-[var(--app-bg-hover)] hover:text-[var(--app-text-primary)]"
              :title="fullscreen ? '退出全屏' : '全屏'"
              :aria-label="fullscreen ? '退出全屏' : '全屏'"
              @click="fullscreen = !fullscreen"
            >
              <Maximize v-if="!fullscreen" :size="16" />
              <Minimize v-else :size="16" />
            </button>
            <button
              type="button"
              class="flex items-center justify-center w-8 h-8 rounded-lg text-[var(--app-text-muted)] transition-colors hover:bg-[var(--app-bg-hover)] hover:text-[var(--app-text-primary)]"
              title="关闭（Esc）"
              aria-label="关闭"
              @click="close"
            >
              <X :size="17" />
            </button>
          </div>
        </div>

        <!-- 面板内容：复用 AI 操作页 -->
        <div class="flex-1 min-h-0 overflow-hidden">
          <AiChatPage />
        </div>
      </section>
    </Transition>
  </Teleport>
</template>

<style scoped>
/* 卡片：大圆角 + 柔和阴影（不是贴边的方盒子） */
.ai-card {
  background: var(--app-bg-card);
  box-shadow:
    0 24px 64px rgb(23 20 60 / 32%),
    0 2px 8px rgb(23 20 60 / 12%);
  transition:
    left 0.26s cubic-bezier(0.22, 1, 0.36, 1),
    right 0.26s cubic-bezier(0.22, 1, 0.36, 1),
    top 0.26s cubic-bezier(0.22, 1, 0.36, 1),
    bottom 0.26s cubic-bezier(0.22, 1, 0.36, 1),
    border-radius 0.26s ease;
}

/* 拖拽中不动画，否则手柄跟不上指针 */
.ai-card.select-none {
  transition: border-radius 0.26s ease;
}

/* 拖拽把手：半透明主题色胶囊，压在工具条上不抢标题 */
.ai-drag-handle {
  background: color-mix(in srgb, var(--ai-accent) 78%, transparent);
  border: none;
  touch-action: none;
}

.lew-dark .ai-drag-handle {
  background: color-mix(in srgb, var(--ai-accent) 55%, transparent);
}

/* ---------- 面板动画 ---------- */
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.22s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

.rise-enter-active,
.rise-leave-active {
  transition:
    opacity 0.24s ease,
    transform 0.3s cubic-bezier(0.22, 1, 0.36, 1);
}
.rise-enter-from,
.rise-leave-to {
  opacity: 0;
  transform: translateY(18px) scale(0.985);
}

@media (prefers-reduced-motion: reduce) {
  .ai-card,
  .rise-enter-active,
  .rise-leave-active {
    transition: none;
  }
}
</style>
