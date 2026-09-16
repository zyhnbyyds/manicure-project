import { afterEach, describe, expect, it } from 'vitest';
import { compressImageFile } from './image-compress';
import { IMAGE_COMPRESS_TARGET_BYTES } from './upload-limits';

/**
 * 浏览器端预压缩的回归测试。
 *
 * Bun 里没有 DOM（`createImageBitmap` / `document.createElement('canvas')` 都不存在），
 * 所以这里**搭一套假 DOM**：真的画布编码结果无法在这里断言，但这条链路上真正容易写错的是
 * 「什么时候采用压缩结果」—— 而那部分是纯逻辑，用假 `toBlob` 就能钉住。
 *
 * 守住的核心规则：**结果必须比原文件小才会被采用**。
 * canvas 的 PNG 编码器明显不如专业工具，重编码常常「越压越大」——
 * 漏了这条判断，用户传 900KB 的图会被「优化」成 1.4MB。
 */

const originalDocument = Reflect.get(globalThis, 'document');
const originalCreateImageBitmap = Reflect.get(globalThis, 'createImageBitmap');

/** 装一套假 DOM：`bytesOf` 决定「这个尺寸 + 质量会产出多少字节」 */
function installFakeDom(
  bytesOf: (width: number, height: number, quality?: number) => number,
): { renders: { width: number; height: number; quality?: number }[] } {
  const renders: { width: number; height: number; quality?: number }[] = [];
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({ drawImage: () => undefined }),
    toBlob(
      callback: (blob: Blob | null) => void,
      type?: string,
      quality?: number,
    ) {
      renders.push({ width: canvas.width, height: canvas.height, quality });
      callback(
        new Blob(
          [new Uint8Array(bytesOf(canvas.width, canvas.height, quality))],
          { type },
        ),
      );
    },
  };
  Reflect.set(globalThis, 'createImageBitmap', async () => ({
    width: 4000,
    height: 3000,
    close: () => undefined,
  }));
  Reflect.set(globalThis, 'document', { createElement: () => canvas });
  return { renders };
}

/** 假位图（4000×3000）对应的「压缩前」文件 */
function sourceFile(
  bytes: number,
  name = 'photo.jpg',
  type = 'image/jpeg',
): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

afterEach(() => {
  if (originalDocument === undefined)
    Reflect.deleteProperty(globalThis, 'document');
  else Reflect.set(globalThis, 'document', originalDocument);
  if (originalCreateImageBitmap === undefined)
    Reflect.deleteProperty(globalThis, 'createImageBitmap');
  else Reflect.set(globalThis, 'createImageBitmap', originalCreateImageBitmap);
});

describe('compressImageFile', () => {
  it('已经 ≤1MB 的文件原样返回（不做有损重编码）', async () => {
    installFakeDom(() => 1);
    const file = sourceFile(300 * 1024);
    expect(await compressImageFile(file)).toBe(file);
  });

  it('非位图一律透传（pdf / svg / gif）', async () => {
    const { renders } = installFakeDom(() => 1);
    for (const [name, type] of [
      ['doc.pdf', 'application/pdf'],
      ['icon.svg', 'image/svg+xml'],
      ['anim.gif', 'image/gif'],
    ] as const) {
      const file = sourceFile(2 * 1024 * 1024, name, type);
      expect(await compressImageFile(file)).toBe(file);
    }
    // 连解码都不该尝试
    expect(renders).toHaveLength(0);
  });

  it('大图压到目标以下，并保留原文件名与类型', async () => {
    installFakeDom(() => 400 * 1024);
    const file = sourceFile(3 * 1024 * 1024, '自拍.jpg', 'image/jpeg');

    const compressed = await compressImageFile(file);

    expect(compressed).not.toBe(file);
    expect(compressed.size).toBe(400 * 1024);
    expect(compressed.size).toBeLessThanOrEqual(IMAGE_COMPRESS_TARGET_BYTES);
    expect(compressed.name).toBe('自拍.jpg');
    expect(compressed.type).toBe('image/jpeg');
  });

  it('越压越大时放弃压缩，原样上传', async () => {
    // 最典型的形态：PNG 重编码后比原图还大
    installFakeDom(() => 3 * 1024 * 1024);
    const file = sourceFile(900 * 1024, 'shot.png', 'image/png');
    expect(await compressImageFile(file)).toBe(file);
  });

  it('解码失败（旧浏览器 / 陌生编码）时不阻断上传', async () => {
    Reflect.set(globalThis, 'createImageBitmap', async () => {
      throw new Error('unsupported');
    });
    const file = sourceFile(3 * 1024 * 1024);
    expect(await compressImageFile(file)).toBe(file);
  });

  it('PNG 在同一尺寸下只编码一次（质量参数对 PNG 无效）', async () => {
    const { renders } = installFakeDom(() => 2 * 1024 * 1024);
    const file = sourceFile(2 * 1024 * 1024, 'shot.png', 'image/png');

    await compressImageFile(file);

    // 原图 4000px → 1920、1280 两档，各一次；不因质量阶梯（4 档）白跑 8 次
    expect(renders).toHaveLength(2);
    expect(renders.map((r) => r.quality)).toEqual([undefined, undefined]);
  });

  it('JPEG 逐档降质量，命中目标即停', async () => {
    let call = 0;
    installFakeDom(() => (++call >= 3 ? 500 * 1024 : 2 * 1024 * 1024));
    const file = sourceFile(3 * 1024 * 1024);

    const compressed = await compressImageFile(file);

    expect(compressed.size).toBe(500 * 1024);
    expect(call).toBe(3);
  });
});
