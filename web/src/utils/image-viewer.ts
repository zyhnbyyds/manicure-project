/**
 * 图片查看器的**纯逻辑**（不碰 DOM / Vue，可直接单测）。
 *
 * 语义约定（组件与调用方都按这套来，别各写一套）：
 *
 * - `scale = 1` 表示「**适应窗口**」，不是「原图像素 100%」。后台的图动辄 2000px+，
 *   真按 1:1 打开，一屏只能看到一只手指；
 * - 缩放围绕**指针位置**而不是视口中心 —— 这是「手感」的关键，
 *   按中心缩放时，想看清角落里那根睫毛得缩完再拖三次；
 * - 平移一律夹在「图片边缘不出视口」的范围内，避免把图甩到屏幕外面找不回来。
 */

export interface PreviewImage {
  url: string;
  /** 顶部标题用的名字；缺省时由 `previewImageName` 从地址里推 */
  name?: string;
}

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

/** 最小缩放：1 = 适应窗口 */
export const MIN_SCALE = 1;
/** 最大缩放：再放大就只剩马赛克了 */
export const MAX_SCALE = 8;
/** 单步缩放倍数（按钮 / 滚轮 / 键盘共用） */
export const ZOOM_STEP = 0.25;
/** 双击放大到的倍数 */
export const DOUBLE_CLICK_SCALE = 2.5;
/** 位移小于这个像素数才算「点击」，否则算「拖拽」（决定松手后要不要关掉弹层） */
export const CLICK_SLOP = 5;

/** 把 `string | PreviewImage` 混着传的入参统一成对象数组，并丢掉空地址 */
export function normalizePreviewImages(
  input: (string | PreviewImage)[] | null | undefined,
): PreviewImage[] {
  return (input ?? [])
    .map((item) => (typeof item === 'string' ? { url: item } : item))
    .map((item) => ({
      url: (item?.url ?? '').trim(),
      ...(item?.name ? { name: item.name } : {}),
    }))
    .filter((item) => item.url.length > 0);
}

/** 夹到 `[0, total - 1]`；空集 / 非数字一律回 0（调用方不用先判空） */
export function clampIndex(index: number, total: number): number {
  if (!Number.isFinite(total) || total <= 0) return 0;
  if (!Number.isFinite(index)) return 0;
  return Math.min(Math.max(Math.trunc(index), 0), total - 1);
}

/** 环形下标：`-1` 从第 0 张回绕到最后一张 */
export function wrapIndex(index: number, delta: number, total: number): number {
  if (!Number.isFinite(total) || total <= 0) return 0;
  const from = clampIndex(index, total);
  const step = Number.isFinite(delta) ? Math.trunc(delta) : 0;
  return (((from + step) % total) + total) % total;
}

/** 夹到 `[min, max]`，并抹掉浮点尾巴（`0.30000000000000004` → `0.3`） */
export function clampScale(
  scale: number,
  min: number = MIN_SCALE,
  max: number = MAX_SCALE,
): number {
  if (!Number.isFinite(scale)) return min;
  return Number(Math.min(Math.max(scale, min), max).toFixed(3));
}

/**
 * 以 `anchor` 为不动点缩放，返回缩放后的平移量。
 *
 * 推导：屏幕坐标 `s = offset + scale * u`（`u` 是图像局部坐标），
 * 放大 `factor` 倍后要让 `s` 不变 ⇒ `offset' = offset * factor + anchor * (1 - factor)`。
 * `anchor` 是**相对图像中心**的像素坐标（也是 `transform-origin: center` 的坐标系）。
 */
export function zoomAround(
  offset: Point,
  factor: number,
  anchor: Point,
): Point {
  return {
    x: offset.x * factor + anchor.x * (1 - factor),
    y: offset.y * factor + anchor.y * (1 - factor),
  };
}

/**
 * 把平移夹在边界内。
 *
 * `rendered` 是**缩放后**的图片尺寸，`viewport` 是可视区尺寸；
 * 图片比视口小的那个方向直接归零（保持居中，不允许拖出一条空白边）。
 */
export function clampPan(offset: Point, rendered: Size, viewport: Size): Point {
  const maxX = Math.max(0, (rendered.width - viewport.width) / 2);
  const maxY = Math.max(0, (rendered.height - viewport.height) / 2);
  // `+ 0` 是为了把 `-0` 归一成 `0`：`-0` 会原样拼进 style 变成 `translate(-0px)`，
  // 而且 `Object.is(-0, 0) === false`，测试里也难缠
  const axis = (value: number, max: number) =>
    Math.min(Math.max(Number.isFinite(value) ? value : 0, -max), max) + 0;
  return { x: axis(offset.x, maxX), y: axis(offset.y, maxY) };
}

/** 从地址里取一个像文件名的尾段（`/a/b/photo.png?x=1` → `photo.png`） */
function tailFileName(url: string): string {
  const path = url.split('#')[0]?.split('?')[0] ?? '';
  const tail = path.split('/').filter(Boolean).pop() ?? '';
  if (!tail) return '';
  try {
    return decodeURIComponent(tail);
  } catch {
    // 地址里有非法的 `%` 转义：原样返回，别为了个标题把预览搞崩
    return tail;
  }
}

/**
 * 顶部标题。
 *
 * 优先用调用方给的名字；否则**只在尾段像个文件名（带扩展名）时**才用它 ——
 * 项目里的预览地址长这样：`/api/v1/files/10/download?inline=1`，
 * 尾段是 `download`，拿来当标题只会让人以为是「下载」。
 */
export function previewImageName(
  image: PreviewImage | undefined,
  index: number,
  total: number,
): string {
  const name = image?.name?.trim();
  if (name) return name;
  const tail = tailFileName(image?.url ?? '');
  if (tail && tail.includes('.')) return tail;
  if (total > 1) return `第 ${clampIndex(index, total) + 1} / ${total} 张`;
  return '图片预览';
}

/** 滚轮 / 触控板横向滑动的方向判定：`+1` 下一张、`-1` 上一张、`0` 不切换 */
export function wheelPaging(deltaX: number, deltaY: number): number {
  if (Math.abs(deltaX) <= Math.abs(deltaY)) return 0;
  return deltaX > 0 ? 1 : -1;
}
