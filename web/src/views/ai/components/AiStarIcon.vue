<script setup lang="ts">
import { useId } from 'vue';

/**
 * AI 星芒：AI 模块的统一标识（欢迎页主视觉 / 面板与标题栏的小图标）。
 *
 * 为什么是「四角星芒」而不是五角星、也不是机器人头：
 * 五角星在 UI 语汇里是「收藏 / 评分」，机器人头在 14~16px 下细节全糊成一团；
 * 四角星芒是 AI 类产品的通用符号，一份路径从 14px 到 80px 都干净。
 * （小尺寸场景直接用 lucide 的 `Sparkles`，描边风格能跟项目其余图标统一。）
 *
 * 渐变 id 用 `useId()` 生成：同一文档里重复 id 只会命中第一个定义，多实例会串色。
 * 颜色走 `--ai-accent-soft-*`（图标专用的亮一档色标），`stop-color` 作为 CSS 属性
 * 支持 `var()`，暗色模式自动跟随。
 */
withDefaults(defineProps<{ size?: number }>(), { size: 72 });

const uid = useId();
const fillId = `ai-star-fill-${uid}`;

/** 四角星芒：四段二次贝塞尔，控制点朝对角内收 → 弧线内凹的四角星 */
const STAR_PATH = 'M12 2Q15 9 22 12Q15 15 12 22Q9 15 2 12Q9 9 12 2Z';
</script>

<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    aria-hidden="true"
  >
    <defs>
      <linearGradient :id="fillId" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" style="stop-color: var(--ai-accent-soft-1)" />
        <stop offset="100%" style="stop-color: var(--ai-accent-soft-2)" />
      </linearGradient>
    </defs>
    <path :d="STAR_PATH" :fill="`url(#${fillId})`" />
  </svg>
</template>
