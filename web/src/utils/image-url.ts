/**
 * 图片地址的「显示态」归一化。
 *
 * ## 为什么需要它
 *
 * lew-ui 的 `LewUpload` 判断「这个 url 能不能当图片渲染」用的是
 * （见 `lew-ui/dist/index.js` 里那条正则）：
 *
 * ```js
 * /\.(?:jpg|jpeg|png|webp|bmp|gif|svg|tiff|ico|heif|jfif|pjpeg|pjp|avif)$/i.test(url)
 * ```
 *
 * —— **要求 url 以图片扩展名结尾**。而项目的预览地址是
 * `/api/v1/files/:id/download?inline=1`（`filePreviewUrl` 的产物），
 * 不以扩展名结尾 ⇒ 判定失败 ⇒ 组件渲染成默认的**文件图标**。
 * 这就是「编辑服务项目时图片反显看不到」的真正原因。
 *
 * ## 做法
 *
 * 给**显示用**的地址补一个无害的查询参数（`__img=.png`，让字符串以 `.png` 结尾）；
 * 提交前用 `stripDisplayImageUrl` 剥掉，**库里存的仍是干净的原始地址**——
 * 否则每编辑保存一次，地址就会多长一截。
 */

/** 与 lew-ui 保持同一套扩展名（改了要一起改） */
const IMAGE_EXT_RE =
  /\.(?:jpg|jpeg|png|webp|bmp|gif|svg|tiff|ico|heif|jfif|pjpeg|pjp|avif)$/i;

/** 追加的标记（末尾必须是图片扩展名，才能骗过上面那条正则） */
const MARK = '__img=.png';
const MARK_RE = /[?&]__img=\.png(?=#|$)/;

/**
 * 已带扩展名的地址原样返回；否则补一个标记后缀供渲染。
 *
 * `data:` / `blob:` 一律不动 —— 往它们后面拼查询串会**直接弄坏地址**
 * （这类地址本来也不进库）。
 */
export function toDisplayImageUrl(url: string): string {
  if (!url || IMAGE_EXT_RE.test(url)) return url;
  if (/^(?:data|blob):/i.test(url)) return url;
  // 锚点要留在最后，别把参数拼到 `#` 后面去
  const hashAt = url.indexOf('#');
  const base = hashAt === -1 ? url : url.slice(0, hashAt);
  const hash = hashAt === -1 ? '' : url.slice(hashAt);
  return `${base}${base.includes('?') ? '&' : '?'}${MARK}${hash}`;
}

/** 提交前剥掉显示标记，保证入库的是原始地址 */
export function stripDisplayImageUrl(url: string): string {
  return url.replace(MARK_RE, '');
}

/** 一批地址的批量版本（列表/图集常用） */
export function toDisplayImageUrls(
  urls: string[] | null | undefined,
): string[] {
  return (urls ?? []).map(toDisplayImageUrl);
}

export function stripDisplayImageUrls(
  urls: string[] | null | undefined,
): string[] {
  return (urls ?? []).map(stripDisplayImageUrl);
}
