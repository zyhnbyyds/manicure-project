<script setup lang="ts">
import { useId } from 'vue';

/**
 * AI 星标：欢迎页的主视觉（渐变底 + 圆角星形 + 内高光）。
 *
 * 为什么自绘 SVG 而不是 lucide 的 `Sparkles` / `Star`：
 * 设计稿要的是「胖圆角五角星 + 蓝紫渐变 + 内部高光」，lucide 只给单色描边路径，
 * 圆角与渐变都表达不出来。
 *
 * 圆角实现：`stroke-width` 足够粗 + `stroke-linejoin="round"`，
 * 描边把尖角包圆、且与填充同色 —— 比手写 rounded-star 路径好维护。
 *
 * 渐变 id 用 `useId()` 生成：同一文档里重复 id 只会命中第一个定义，
 * 多实例（欢迎页 + 未来别处复用）会串色。
 */
withDefaults(defineProps<{ size?: number }>(), { size: 72 });

const uid = useId();
const fillId = `ai-star-fill-${uid}`;
const glossId = `ai-star-gloss-${uid}`;

/** 同一份路径画三遍：填充 + 同色粗描边（圆角）+ 内高光 */
const STAR_PATH =
  'M12 2.6l2.94 5.96 6.58.96-4.76 4.64 1.12 6.55L12 17.62l-5.88 3.09 1.12-6.55-4.76-4.64 6.58-.96z';
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
        <stop offset="0%" stop-color="#6d8bff" />
        <stop offset="55%" stop-color="#7c5cf8" />
        <stop offset="100%" stop-color="#a78bfa" />
      </linearGradient>
      <radialGradient :id="glossId" cx="0.3" cy="0.22" r="0.6">
        <stop offset="0%" stop-color="#fff" stop-opacity="0.45" />
        <stop offset="60%" stop-color="#fff" stop-opacity="0.08" />
        <stop offset="100%" stop-color="#fff" stop-opacity="0" />
      </radialGradient>
    </defs>
    <!--
      画两层、**顺序不能反**：
      1. 先画「内高光 + 同色粗描边」——描边负责把尖角包圆；
      2. 再把主渐变填上去盖住描边的内半边，只留下圆角轮廓。
      反过来（先填充再叠高光）高光会把星形描一圈白边，看着像空心星星。
    -->
    <path
      :d="STAR_PATH"
      :fill="`url(#${glossId})`"
      :stroke="`url(#${fillId})`"
      stroke-width="3.4"
      stroke-linejoin="round"
    />
    <path :d="STAR_PATH" :fill="`url(#${fillId})`" />
  </svg>
</template>
