/**
 * 全局图片预览：**整个后台共用一个查看器实例**。
 *
 * 为什么做成单例而不是每个页面自己 `<ImageViewer v-model:visible>`：
 * 之前服务项目页自己持有一份 `visible / images / index`，其它页面要预览就得再抄一遍；
 * 结果同一件事有两种做法（有的页面 `window.open` 跳新标签、有的页面自己写弹窗、
 * 有的页面直接用 lew-ui 不能缩放的预览），**操作逻辑割裂**。
 *
 * 现在的用法只有一句：
 *
 * ```ts
 * openImagePreview(serviceItem.images, 0, serviceItem.name);
 * ```
 *
 * 组件实例挂在 `App.vue` 上（全局唯一），本模块只负责「开 / 关 / 数据集」。
 */
import { reactive } from 'vue';
import { clampIndex, normalizePreviewImages } from '~/utils/image-viewer';
import type { PreviewImage } from '~/utils/image-viewer';

/** 调用方可以只给地址，也可以给 `{ url, name }`（`name` 会显示在顶部） */
export type ImagePreviewInput = (string | PreviewImage)[] | null | undefined;

interface ImagePreviewState {
  visible: boolean;
  images: PreviewImage[];
  index: number;
  /** 图集标题（如「纯色美甲」）；留空则顶部只显示第几张 */
  title: string;
}

/** 模块级单例：所有页面共享同一份状态 */
const state = reactive<ImagePreviewState>({
  visible: false,
  images: [],
  index: 0,
  title: '',
});

/**
 * 打开查看器。
 *
 * - `images` 空集时**什么都不做**（调用方不用自己判空，避免弹出一个空壳）；
 * - `startIndex` 越界会被夹回区间；
 * - 重复打开会**替换**数据集并复位缩放。
 */
export function openImagePreview(
  images: ImagePreviewInput,
  startIndex = 0,
  title = '',
): void {
  const list = normalizePreviewImages(images);
  if (!list.length) return;
  state.images = list;
  state.index = clampIndex(startIndex, list.length);
  state.title = title;
  state.visible = true;
}

export function closeImagePreview(): void {
  state.visible = false;
}

/** 组件侧用（读状态）；业务代码只需 `openImagePreview` */
export function useImagePreview() {
  return { state, open: openImagePreview, close: closeImagePreview };
}
