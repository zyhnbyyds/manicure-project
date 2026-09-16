import { Logger } from '@nestjs/common';
import sharp from 'sharp';

/**
 * 上传图片的**服务端压缩**（`POST /files/upload` 与 `POST /app/upload` 共用）。
 *
 * ## 为什么要压
 *
 * 手机直出照片 3~5MB，而业务真正需要的是「能看清」的那张：原图既撑爆 `uploads/` 磁盘，
 * 又让小程序在弱网下等十几秒。压缩放在**服务端**，是因为客户端压缩
 * （`web/src/utils/image-compress.ts`、小程序 `utils/upload.ts`）只省流量、**可被绕过**
 * （换个客户端 / 直接打接口就没有了）—— 服务端这道才是口径的唯一来源。
 *
 * ## 四条策略
 *
 * 1. **只压位图**：`.jpg/.jpeg/.png/.webp`。`svg` 是矢量（重编码没有意义、还可能被破坏），
 *    `gif` 是动图（sharp 处理会掉帧），非图片（pdf/zip…）本来就不该走图像管线；
 * 2. **不够大就不压**：≤1MB 直接原样落盘 —— 重编码必然有损，小图没必要付这个代价（也省 CPU）；
 * 3. **保格式**：输出 MIME 与扩展名不变。PNG 可能带透明通道，转 JPEG 会变黑底，
 *    所以不做「统一转 JPEG」这种看似省事的处理；
 * 4. **压不动就认输出来的**：坏图 / 极端图（如随机噪点）压不到 1MB 时，返回阶梯里最小的一张，
 *    只要比原图小就采用；连最小的一张都比原图大，则保留原图（落盘更大的文件没有任何意义）。
 *
 * ## 绝不阻断上传
 *
 * 压缩是**尽力而为**：sharp 抛错（损坏文件、不认识的编码）时记一条 warn 日志并返回原图 ——
 * 「这张图能传上去」比「一定压到 1MB」重要。
 */

/** 压缩目标：单张图片落盘不超过 1MB */
export const IMAGE_MAX_BYTES = 1024 * 1024;

/** 只有这些扩展名会走压缩（位图） */
const COMPRESSIBLE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

/**
 * 输出格式对应的标准 MIME。
 *
 * 压缩后以它为准，不沿用客户端上报的 `mimetype` —— 那个字段由客户端说了算
 * （实测有把 `.jpg` 报成 `image/pjpeg`、甚至 `application/octet-stream` 的），
 * 而我们输出什么格式是自己决定的。
 */
const OUTPUT_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

type EncodeStep = {
  /** 最长边上限（原图比它小就不缩放） */
  dimension: number;
  /** 有损质量；PNG 的无损轮没有它 */
  quality?: number;
  /** PNG 专用：量化到 256 色（保留 alpha），压缩率比无损高一个数量级 */
  palette?: boolean;
};

/**
 * JPEG / WebP 的尝试阶梯：先「只降质量」，再「降尺寸 + 降质量」。
 *
 * 最多 5 次编码：手机照片第 1 步（2048 长边 + q82）通常就落到 300~600KB，
 * 后面的档位是给「噪点多的夜景照」这类难压的图兜底。
 */
const RASTER_STEPS: EncodeStep[] = [
  { dimension: 2048, quality: 82 },
  { dimension: 2048, quality: 70 },
  { dimension: 1600, quality: 70 },
  { dimension: 1280, quality: 62 },
  { dimension: 1024, quality: 55 },
];

/**
 * PNG 的尝试阶梯：**无损优先**。
 *
 * 截图 / 线稿 / 纯色图用无损能压得很好且不损画质；无损压不动才量化调色板 ——
 * 量化是不可逆的画质损失（渐变会起色带），能不用就不用。
 */
const PNG_STEPS: EncodeStep[] = [
  { dimension: 2048 },
  { dimension: 1600 },
  { dimension: 1280 },
  { dimension: 1280, palette: true, quality: 80 },
  { dimension: 1024, palette: true, quality: 60 },
];

const logger = new Logger('ImageCompress');

export type ImageCompressResult = {
  /** 最终要落盘的字节（未压缩时就是原 buffer） */
  buffer: Buffer;
  /** 最终字节数（= 落盘 / 入库的 `size`） */
  size: number;
  /** 上传时的原始字节数 */
  originalSize: number;
  /** 是否真的压缩过（`false` = 原样保存） */
  compressed: boolean;
  /** 最终 MIME（未压缩时就是入参 `mime`） */
  mime: string;
};

/**
 * 把超过 1MB 的位图压到 1MB 以下；其他情况一律原样返回。
 *
 * @param ext 文件名扩展名（**小写、带点**），决定输出格式与是否值得压
 */
export async function compressImage(
  buffer: Buffer,
  mime: string,
  ext: string,
): Promise<ImageCompressResult> {
  const normalizedExt = ext.toLowerCase();
  const passthrough = (): ImageCompressResult => ({
    buffer,
    size: buffer.length,
    originalSize: buffer.length,
    compressed: false,
    mime,
  });

  if (!COMPRESSIBLE_EXTENSIONS.has(normalizedExt)) return passthrough();
  if (buffer.length <= IMAGE_MAX_BYTES) return passthrough();

  try {
    const encoded = await encodeUnderLimit(buffer, normalizedExt);
    if (!encoded || encoded.length >= buffer.length) return passthrough();
    return {
      buffer: encoded,
      size: encoded.length,
      originalSize: buffer.length,
      compressed: true,
      mime: OUTPUT_MIME[normalizedExt] ?? mime,
    };
  } catch (error) {
    logger.warn(
      `图片压缩失败，按原图保存（mime=${mime} size=${buffer.length}）：${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return passthrough();
  }
}

/** 按阶梯逐个试，返回第一个 ≤1MB 的结果；都不达标则返回其中最小的一张 */
async function encodeUnderLimit(
  buffer: Buffer,
  ext: string,
): Promise<Buffer | null> {
  // metadata 只为拿「最长边」用来决定要不要缩放（EXIF 旋转后宽高会互换，
  // 但取 max 不受影响）
  const meta = await sharp(buffer, { failOn: 'none' }).metadata();
  const longest = Math.max(meta.width ?? 0, meta.height ?? 0);
  const steps = ext === '.png' ? PNG_STEPS : RASTER_STEPS;
  let smallest: Buffer | null = null;
  for (const step of steps) {
    const encoded = await encode(buffer, ext, step, longest);
    if (!smallest || encoded.length < smallest.length) smallest = encoded;
    if (encoded.length <= IMAGE_MAX_BYTES) return encoded;
  }
  return smallest;
}

/** 单次编码：先按 EXIF 转正，再缩放，最后按格式编码 */
async function encode(
  buffer: Buffer,
  ext: string,
  step: EncodeStep,
  longest: number,
): Promise<Buffer> {
  // `rotate()` 不带参数 = 按 EXIF 转正。**必须调**：手机竖拍的照片靠 EXIF 标记方向，
  // 而下面的编码不写回 EXIF —— 不转正的话落盘的图会整体横过来。
  // `failOn: 'none'` 容忍轻微损坏的文件，能解出多少算多少（比直接失败更符合上传场景）。
  let pipeline = sharp(buffer, { failOn: 'none' }).rotate();
  if (longest > step.dimension) {
    pipeline = pipeline.resize({
      width: step.dimension,
      height: step.dimension,
      // fit: 'inside' + 同一上限 = 限制最长边（不拉伸、不放大）
      fit: 'inside',
      withoutEnlargement: true,
    });
  }
  if (ext === '.png') {
    return step.palette
      ? pipeline
          .png({
            compressionLevel: 9,
            effort: 7,
            palette: true,
            // palette 模式下 quality 表示「调色板量化质量」；兜个默认值绕开 optional 类型
            quality: step.quality ?? 60,
          })
          .toBuffer()
      : pipeline.png({ compressionLevel: 9, effort: 7 }).toBuffer();
  }
  if (ext === '.webp') {
    return pipeline.webp({ quality: step.quality ?? 60, effort: 4 }).toBuffer();
  }
  return pipeline
    .jpeg({ quality: step.quality ?? 60, mozjpeg: true })
    .toBuffer();
}
