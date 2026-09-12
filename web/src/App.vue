<script setup lang="ts">
import ImageViewer from '~/components/ImageViewer.vue';
</script>

<template>
  <RouterView />
  <!--
    全局图片查看器：**整个后台唯一实例**。
    任何页面用 `openImagePreview(urls, index, title)` 就能弹出同一套交互
    （缩放 / 拖拽 / 缩略图切换），不要在页面里再摆一个自己的预览弹窗。
  -->
  <ImageViewer />
</template>
