/**
 * `LewUpload` 表单值 ↔ 接口 url 数组 的互转。
 *
 * ## 为什么单独一个模块
 *
 * 「图片能不能显示」只看一件事：**url 结尾是不是图片扩展名**
 * （lew-ui 的判定正则，见 `./image-url`）。而这个值有**两条产出路径**：
 *
 * 1. 打开弹窗时的**反显**（库里存的 url → 表单值）；
 * 2. 刚上传成功时的**回填**（`uploadHelper` → `setFileItem`）。
 *
 * 之前只给路径 1 加了归一化，路径 2 直接塞了 `filePreviewUrl(id)` 的原始地址 ——
 * 于是「编辑时**原有**图片能看见，**新传**的图片是个文件图标」，
 * 新建时同理（新建没有反显，所以整个图集都看不见）。
 *
 * 现在两条路都必须经过本模块，配了单测（`upload-images.spec.ts`）钉住这个不变量。
 */
import type { LewUploadFileItem } from 'lew-ui';
import { stripDisplayImageUrl, toDisplayImageUrl } from './image-url';

/**
 * 已保存的 url 数组 → 上传组件表单值（**反显**路径）。
 *
 * `key` 用「下标 + 地址」：同一张图重复出现在图集里也不会撞 key。
 */
export function toUploadItems(
  urls: string[] | null | undefined,
): LewUploadFileItem[] {
  return (urls ?? []).map((url, index) => ({
    key: `saved-${index}-${url}`,
    name: `图片 ${index + 1}`,
    url: toDisplayImageUrl(url),
    status: 'complete' as const,
    percent: 100,
  }));
}

/**
 * 刚上传成功 → 回填给 `setFileItem` 的那一项（**上传**路径）。
 *
 * `url` 必须是**显示态**（`toDisplayImageUrl`），否则 lew-ui 会把它当普通文件、
 * 渲染成默认文件图标 —— 这正是「新传的图看不见」的原因。
 */
export function toUploadedItem(
  key: string,
  url: string,
  name?: string,
): LewUploadFileItem {
  return {
    key,
    ...(name ? { name } : {}),
    url: toDisplayImageUrl(url),
    status: 'complete',
    percent: 100,
  };
}

/**
 * 表单值 → 提交给接口的 url 数组。
 *
 * 只取上传成功的项（`pending` / `fail` / `wrong_size` 的半成品不该入库），
 * 并剥掉显示用的扩展名标记 —— 否则每保存一次，库里的地址就长一截。
 */
export function toImageUrls(
  items: LewUploadFileItem[] | null | undefined,
): string[] {
  return (items ?? [])
    .filter((item) => item.status === 'complete' || item.status === 'success')
    .map((item) => stripDisplayImageUrl(item.url ?? ''))
    .filter((url): url is string => Boolean(url));
}
