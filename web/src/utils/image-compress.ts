/**
 * 上传前的**浏览器端预压缩**（与后端 `src/modules/files/image-compress.ts` 同口径）。
 *
 * ## 为什么要在前端也压一遍
 *
 * 后端压缩是**口径兜底**（客户端可以绕过），但它省不了流量：弱网下用户仍要先把
 * 3~5MB 的原图传完，服务端才开始压。前端先压一遍，弱网下用户少等几十秒。
 *
 * ## 三条规矩
 *
 * 1. **越压越大就放弃**：canvas 的 PNG 编码器明显不如专业工具，重编码常见「体积翻倍」。
 *    所以每次尝试的结果都必须**比原文件小**才会被采用，否则原样交给后端；
 * 2. **不认识的格式直接透传**：`svg`（矢量）、`gif`（canvas 只会取首帧，动图会变静图）、
 *    以及非图片（pdf/zip）一律不碰；
 * 3. **失败不影响上传**：解码失败（旧浏览器 / 陌生编码）时原样返回，把这张图交给后端 ——
 *    「传得上去」比「一定压到 1MB」重要。
 */

import { IMAGE_COMPRESS_TARGET_BYTES } from './upload-limits';

/** 会走预压缩的 MIME（与后端 `COMPRESSIBLE_EXTENSIONS` 对齐） */
const COMPRESSIBLE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

/** 最长边上限阶梯：先按 1920 压，压不动再降到 1280 */
const DIMENSION_LADDER = [1920, 1280];

/** 有损质量阶梯（PNG 是无损格式，`toBlob` 的质量参数对 PNG 无效） */
const QUALITY_LADDER = [0.82, 0.7, 0.6, 0.5];

/**
 * 图片上传前预压缩：能压到 1MB 以下就压，否则原样返回。
 *
 * 返回的一定是可以直接 `FormData.append` 的 `File`（失败时就是入参本身）。
 */
export async function compressImageFile(file: File): Promise<File> {
  if (file.size <= IMAGE_COMPRESS_TARGET_BYTES) return file;
  if (!COMPRESSIBLE_TYPES.includes(file.type)) return file;

  let bitmap: ImageBitmap;
  try {
    // imageOrientation: 'from-image' = 把 EXIF 方向**应用到位图上**。
    // 重编码不会写回 EXIF，不转正的话竖拍照片会整体横过来。
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    return file;
  }
  try {
    return (await shrink(file, bitmap)) ?? file;
  } finally {
    bitmap.close();
  }
}

/** 按「尺寸 × 质量」阶梯逐个试，返回第一个 ≤1MB 且比原图小的结果；都不行返回 null */
async function shrink(file: File, bitmap: ImageBitmap): Promise<File | null> {
  const longest = Math.max(bitmap.width, bitmap.height);
  const qualities = file.type === 'image/png' ? [undefined] : QUALITY_LADDER;
  let smallest: Blob | null = null;
  for (const dimension of DIMENSION_LADDER) {
    const scale = Math.min(1, dimension / longest);
    // PNG 只能靠缩放压（质量参数无效），尺寸没变时重编码纯属浪费 —— 还会越压越大
    if (file.type === 'image/png' && scale >= 1) continue;
    for (const quality of qualities) {
      const blob = await render(bitmap, scale, quality, file.type);
      if (!blob) return null;
      if (!smallest || blob.size < smallest.size) smallest = blob;
      if (blob.size <= IMAGE_COMPRESS_TARGET_BYTES) return toFile(blob, file);
    }
  }
  // 压不到目标：只要比原图小就交上去（后端还会再兜一层）
  return smallest && smallest.size < file.size ? toFile(smallest, file) : null;
}

/** 解码好的位图 → 缩放绘制 → 按原格式编码 */
async function render(
  bitmap: ImageBitmap,
  scale: number,
  quality: number | undefined,
  type: string,
): Promise<Blob | null> {
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.drawImage(bitmap, 0, 0, width, height);
  return new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, type, quality);
  });
}

/** 保留原文件名与时间戳（后端会用它当 `original_name`） */
function toFile(blob: Blob, source: File): File {
  return new File([blob], source.name, {
    type: blob.type || source.type,
    lastModified: source.lastModified,
  });
}
