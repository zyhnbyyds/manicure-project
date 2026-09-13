<script setup lang="ts">
import { computed } from 'vue';
import { LoaderCircle } from 'lucide-vue-next';

/**
 * 通用加载占位组件。
 *
 * 三种形态，按「内容会不会被销毁」区分：
 * - `skeleton` 骨架屏：首屏用。加载中隐藏内容、由骨架撑开高度；
 * - `spinner`  居中转圈：首屏用，适合高度不固定的区域；
 * - `overlay`  半透明遮罩：**刷新 / 局部重载**用。内容始终挂载（`v-show` 而非 `v-if`），
 *   图表实例、输入框焦点、滚动位置都不会因为「加载一下」被重建。
 *
 * 用法：
 * ```vue
 * <AppLoading :loading="loading" variant="skeleton" shape="card" :rows="4" min-height="180px">
 *   <MyList />
 * </AppLoading>
 * ```
 *
 * 布局注意：根节点是 `relative` 的**真实盒子**，内容的包裹层是 `display: contents`，
 * 所以外面给的 flex / grid 布局类会**直接作用到插槽内容**上（中间不会多一层盒子）。
 * 反过来说：如果插槽内容是若干「靠外层 flex gap 排版」的行内元素，
 * 记得把布局类给到 `<AppLoading>` 自己（`class="flex flex-col gap-2"`），
 * 否则它们会退化成同一段行内文本。
 */
const props = withDefaults(
  defineProps<{
    /** 是否加载中 */
    loading?: boolean;
    /** 占位形态，见组件说明 */
    variant?: 'skeleton' | 'spinner' | 'overlay';
    /** 骨架形状：line = 文本行；card = 卡片块 */
    shape?: 'line' | 'card';
    /** 骨架行数 / 卡片块数 */
    rows?: number;
    /** 文案（spinner / overlay 变体；overlay 缺省为「加载中…」） */
    text?: string;
    size?: 'small' | 'medium' | 'large';
    /** 占位区最小高度，如 `180px`（首屏骨架高度不够时用） */
    minHeight?: string;
    /** 转圈对齐：start = 左对齐（放在一行文字里时用） */
    align?: 'center' | 'start';
  }>(),
  {
    loading: false,
    variant: 'spinner',
    shape: 'line',
    rows: 3,
    size: 'medium',
    align: 'center',
  },
);

/** 只有 skeleton / spinner 会在加载中替换内容；overlay 保留内容 */
const showPlaceholder = computed(
  () => props.loading && props.variant !== 'overlay',
);

/** 骨架文本行宽度：循环取用，避免每行一样长显得假 */
const LINE_WIDTHS = ['100%', '92%', '78%', '88%', '70%', '96%'];

const SPINNER_SIZES = { small: 14, medium: 18, large: 22 } as const;
const TEXT_SIZES = {
  small: 'text-12px',
  medium: 'text-12.5px',
  large: 'text-13.5px',
} as const;

const spinnerSize = computed(() => SPINNER_SIZES[props.size]);
const textClass = computed(() => TEXT_SIZES[props.size]);

function rowClass(_index: number) {
  return props.shape === 'card' ? 'h-56px rounded-10px' : 'h-12px rounded-6px';
}

function rowStyle(index: number) {
  return props.shape === 'line'
    ? { width: LINE_WIDTHS[index % LINE_WIDTHS.length] }
    : undefined;
}
</script>

<template>
  <div class="relative">
    <!-- 首屏占位：加载中由它撑开高度；离场时脱离文档流（.app-swap-leave-active），和内容交叉淡入 -->
    <Transition name="app-swap">
      <div
        v-if="showPlaceholder"
        class="flex min-w-0 flex-col gap-2.5"
        :style="minHeight ? { minHeight } : undefined"
      >
        <template v-if="variant === 'skeleton'">
          <div
            v-for="i in rows"
            :key="i"
            class="app-skeleton shrink-0"
            :class="rowClass(i - 1)"
            :style="rowStyle(i - 1)"
          />
        </template>
        <div
          v-else
          class="flex flex-1 items-center gap-2 text-[var(--app-text-muted)]"
          :class="[textClass, align === 'center' ? 'justify-center' : '']"
          :style="minHeight ? { minHeight } : undefined"
        >
          <LoaderCircle
            :size="spinnerSize"
            class="animate-spin text-[var(--lew-color-primary)]"
          />
          <span v-if="text">{{ text }}</span>
        </div>
      </div>
    </Transition>

    <!-- 内容：v-show 保持挂载；包裹层 display:contents，不打断外层布局 -->
    <div v-show="!showPlaceholder" class="contents">
      <slot />
    </div>

    <!-- 刷新遮罩：盖住旧内容但不销毁它 -->
    <Transition name="app-fade">
      <div
        v-if="loading && variant === 'overlay'"
        class="absolute inset-0 z-1 flex items-center justify-center rounded-[inherit] bg-[color-mix(in_srgb,var(--app-bg-card)_62%,transparent)]"
      >
        <span
          class="flex items-center gap-1.5 rounded-full border border-[var(--app-border)] bg-[var(--app-bg-card)] px-2.5 py-1 text-12.5px text-[var(--app-text-secondary)] shadow-[var(--app-shadow)]"
        >
          <LoaderCircle
            :size="14"
            class="animate-spin text-[var(--lew-color-primary)]"
          />
          {{ text || '加载中…' }}
        </span>
      </div>
    </Transition>
  </div>
</template>
