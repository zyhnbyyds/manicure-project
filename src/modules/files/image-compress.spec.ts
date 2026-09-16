import { beforeAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { IMAGE_MAX_BYTES, compressImage } from './image-compress';

/**
 * 这些用例**真的调 sharp**（不 mock）。
 *
 * 压缩是「算法行为」：mock 掉之后唯一还能断言的只剩「函数被调用过」，等于没测。
 * 代价是大图的编解码要几百毫秒，所以测试图在 `beforeAll` 里造一次共享，并放宽超时。
 *
 * 选图的讲究：**平滑渐变 + 每 4×4 块固定扰动**。纯渐变压完只剩几十 KB（原图就不到 1MB，
 * 压根不进压缩分支），纯噪声又几乎压不动（只能验「没压坏」，验不了「压到 1MB 以下」）。
 * 这种「有纹理但不碎」的图才会出现「原图 2MB+、压后 200KB」的典型落差。
 */

const WIDTH = 3200;
const HEIGHT = 2400;

const rawOptions = {
  raw: { width: WIDTH, height: HEIGHT, channels: 3 as const },
};

function texturedRgb(): Buffer {
  const buffer = Buffer.allocUnsafe(WIDTH * HEIGHT * 3);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const i = (y * WIDTH + x) * 3;
      buffer[i] = Math.floor((x * 255) / WIDTH);
      buffer[i + 1] = Math.floor((y * 255) / HEIGHT);
      buffer[i + 2] = Math.floor(((x + y) * 255) / (WIDTH + HEIGHT));
    }
  }
  let seed = 99 >>> 0;
  for (let y = 0; y < HEIGHT; y += 4) {
    for (let x = 0; x < WIDTH; x += 4) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const delta = ((seed >>> 28) & 0x0f) - 8;
      for (let dy = 0; dy < 4 && y + dy < HEIGHT; dy++) {
        for (let dx = 0; dx < 4 && x + dx < WIDTH; dx++) {
          const i = ((y + dy) * WIDTH + x + dx) * 3;
          for (let c = 0; c < 3; c++)
            buffer[i + c] = Math.min(255, Math.max(0, buffer[i + c]! + delta));
        }
      }
    }
  }
  return buffer;
}

let raw: Buffer;
let bigJpeg: Buffer;
let bigPng: Buffer;

beforeAll(async () => {
  raw = texturedRgb();
  bigJpeg = await sharp(raw, rawOptions)
    .jpeg({ quality: 98, mozjpeg: true })
    .toBuffer();
  bigPng = await sharp(raw, rawOptions).png({ compressionLevel: 9 }).toBuffer();
}, 60_000);

describe('compressImage 压缩位图', () => {
  it('超过 1MB 的 JPEG 被压到 1MB 以下，且仍是 JPEG', async () => {
    expect(bigJpeg.length).toBeGreaterThan(IMAGE_MAX_BYTES);

    const result = await compressImage(bigJpeg, 'image/jpeg', '.jpg');

    expect(result.compressed).toBe(true);
    expect(result.size).toBeLessThanOrEqual(IMAGE_MAX_BYTES);
    expect(result.size).toBeLessThan(bigJpeg.length);
    expect(result.buffer.length).toBe(result.size);
    // originalSize 是**上传时**的大小，用来给前端提示「已从 2.4MB 压到 200KB」
    expect(result.originalSize).toBe(bigJpeg.length);
    expect(result.mime).toBe('image/jpeg');
    // 保格式：不能为了好压就把 PNG 偷偷转成 JPEG
    expect((await sharp(result.buffer).metadata()).format).toBe('jpeg');
  }, 60_000);

  it('超过 1MB 的 PNG 保持 PNG（透明通道不能丢）', async () => {
    expect(bigPng.length).toBeGreaterThan(IMAGE_MAX_BYTES);

    const result = await compressImage(bigPng, 'image/png', '.png');

    expect(result.compressed).toBe(true);
    expect(result.size).toBeLessThanOrEqual(IMAGE_MAX_BYTES);
    expect(result.mime).toBe('image/png');
    expect((await sharp(result.buffer).metadata()).format).toBe('png');
  }, 60_000);

  it('带透明通道的 PNG 压完仍有 alpha', async () => {
    const rgba = Buffer.allocUnsafe(WIDTH * HEIGHT * 4);
    for (let i = 0; i < WIDTH * HEIGHT; i++) {
      rgba[i * 4] = raw[i * 3]!;
      rgba[i * 4 + 1] = raw[i * 3 + 1]!;
      rgba[i * 4 + 2] = raw[i * 3 + 2]!;
      // 左半不透明、右半半透明：量化调色板若丢掉 alpha，这里就能抓到
      rgba[i * 4 + 3] = i % WIDTH < WIDTH / 2 ? 255 : 128;
    }
    const withAlpha = await sharp(rgba, {
      raw: { width: WIDTH, height: HEIGHT, channels: 4 },
    })
      .png({ compressionLevel: 9 })
      .toBuffer();
    expect(withAlpha.length).toBeGreaterThan(IMAGE_MAX_BYTES);

    const result = await compressImage(withAlpha, 'image/png', '.png');

    expect(result.compressed).toBe(true);
    expect((await sharp(result.buffer).metadata()).hasAlpha).toBe(true);
  }, 60_000);

  it('按 EXIF 方向转正（不转的话竖拍照片会横过来）', async () => {
    // orientation 6 = 需要顺时针转 90° 才是正确方向；转正后宽高互换
    const portrait = await sharp(raw, rawOptions)
      .jpeg({ quality: 98, mozjpeg: true })
      .withMetadata({ orientation: 6 })
      .toBuffer();
    expect(portrait.length).toBeGreaterThan(IMAGE_MAX_BYTES);

    const result = await compressImage(portrait, 'image/jpeg', '.jpg');

    const meta = await sharp(result.buffer).metadata();
    expect(meta.width).toBeLessThan(meta.height!);
  }, 60_000);
});

describe('compressImage 原样返回的情况', () => {
  it('已经 ≤1MB 的图不重编码（返回同一个 buffer，不做有损处理）', async () => {
    const small = Buffer.from('tiny-image');
    const result = await compressImage(small, 'image/png', '.png');
    expect(result.compressed).toBe(false);
    expect(result.buffer).toBe(small);
    expect(result.size).toBe(small.length);
    expect(result.originalSize).toBe(small.length);
  });

  it('非位图一律透传（svg / gif / pdf）', async () => {
    const payload = Buffer.alloc(2 * 1024 * 1024, 1);
    for (const [mime, ext] of [
      ['image/svg+xml', '.svg'],
      ['image/gif', '.gif'],
      ['application/pdf', '.pdf'],
    ] as const) {
      const result = await compressImage(payload, mime, ext);
      expect(result.compressed).toBe(false);
      expect(result.buffer).toBe(payload);
      expect(result.mime).toBe(mime);
    }
  });

  it('解不开的图片不抛错，按原图保存（不阻断上传）', async () => {
    // 扩展名在压缩白名单里，内容却不是图片：sharp 会失败，此时必须兜住
    const broken = Buffer.alloc(2 * 1024 * 1024, 0x78);
    const result = await compressImage(broken, 'image/jpeg', '.jpg');
    expect(result.compressed).toBe(false);
    expect(result.buffer).toBe(broken);
    expect(result.size).toBe(broken.length);
  });
});
