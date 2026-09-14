/**
 * 图集（多图）的通用规则：归一化 + 张数上限。
 *
 * 为什么单独抽一份：服务项目图集（9 张）与门店图集（5 张）都要同一套
 * 「去空白 → 去重 → 保顺序 → 按上限截断」，各写一份迟早分叉。
 *
 * **上限由调用方显式传**：各处的业务上限本来就不同，写死一个数只会让
 * 「前端 `limit: 5`、后端截断到 9」这类不一致悄悄发生。zod schema 里的 `.max()`、
 * 前端表单的 `limit`、这里的 `limit` 三处必须同源。
 */

/** 默认上限（服务项目图集用 9；门店用 5，各自显式传） */
export const DEFAULT_GALLERY_LIMIT = 9;

/**
 * 归一化图集：去空白、去重、保持顺序、截断到上限。
 *
 * 空数组一律归一成 `null` —— 库里只允许「NULL」或「非空数组」两种形态，
 * 免得 `[]` 与 `null` 两种「没有图」的写法在前后端各判一次。
 *
 * **顺序即展示顺序**（不去排序）：运营拖出来的第一张就是封面。
 */
export function normalizeImages(
  images: string[] | null | undefined,
  limit: number = DEFAULT_GALLERY_LIMIT,
): string[] | null {
  if (!images?.length) return null;
  const cleaned = [...new Set(images.map((url) => url.trim()).filter(Boolean))];
  return cleaned.length ? cleaned.slice(0, limit) : null;
}
