/**
 * 让 `LewUpload` 的缩略图点击后打开**全局图片查看器**。
 *
 * ## 为什么需要这一层
 *
 * lew-ui 2.8.2 **没有**内置的图片预览：`preview-group-key` 只是个没人消费的属性
 * （`lew-ui/dist/index.js` 与 `index.css` 里都搜不到 preview 相关实现），
 * 所以上传后的缩略图**点了没有任何反应**，用户只能靠页面另外摆一条「大图预览」入口。
 *
 * 这里在容器上挂一个**捕获阶段**的代理监听：
 *
 * - 只在命中缩略图（`.lew-upload-file-image`）时才接管，删除 / 重传按钮不受影响；
 * - 用捕获 + `stopPropagation` 是为了**将来 lew-ui 补上自带预览时不会两套弹层一起开**；
 * - 用类名匹配有版本风险，所以匹配不到时**静默不接管**（点了没反应 = 现状，不会报错）。
 *
 * 用法（页面里一行）：
 *
 * ```ts
 * const uploadHostRef = ref<HTMLElement>();
 * useUploadImagePreview(uploadHostRef, () => formImages.value, () => form.value.name);
 * ```
 */
import { onBeforeUnmount, watch } from 'vue';
import type { Ref } from 'vue';
import { openImagePreview } from '~/composables/useImagePreview';
import { stripDisplayImageUrl } from '~/utils/image-url';

/** 缩略图元素上的类名（lew-ui 2.8.2；升级 lew-ui 后要复核） */
const THUMB_SELECTOR = '.lew-upload-file-image';
/** 单个文件项（用来兜底算下标） */
const ITEM_SELECTOR = '.lew-upload-file-item';

export function useUploadImagePreview(
  container: Ref<HTMLElement | null | undefined>,
  resolveImages: () => string[],
  resolveTitle: () => string = () => '',
): void {
  let bound: HTMLElement | null = null;

  /** 点击的缩略图对应第几张：优先按地址匹配，匹配不上再按 DOM 顺序兜底 */
  function indexOfThumb(host: HTMLElement, thumb: Element, images: string[]) {
    const src = stripDisplayImageUrl(
      thumb.querySelector('img')?.getAttribute('src') ?? '',
    );
    if (src) {
      const hit = images.findIndex((url) => stripDisplayImageUrl(url) === src);
      if (hit >= 0) return hit;
    }
    const item = thumb.closest(ITEM_SELECTOR);
    const position = item
      ? Array.from(host.querySelectorAll(ITEM_SELECTOR)).indexOf(item)
      : 0;
    return Math.min(Math.max(position, 0), images.length - 1);
  }

  function onClick(event: MouseEvent) {
    const host = container.value;
    const target = event.target as HTMLElement | null;
    const thumb = target?.closest?.(THUMB_SELECTOR);
    if (!host || !thumb) return;
    const images = resolveImages();
    if (!images.length) return;
    event.preventDefault();
    event.stopPropagation();
    openImagePreview(images, indexOfThumb(host, thumb, images), resolveTitle());
  }

  function bind(element: HTMLElement | null) {
    if (bound === element) return;
    bound?.removeEventListener('click', onClick, true);
    bound = element;
    bound?.addEventListener('click', onClick, true);
  }

  watch(container, (element) => bind(element ?? null), {
    immediate: true,
    flush: 'post',
  });

  onBeforeUnmount(() => bind(null));
}
