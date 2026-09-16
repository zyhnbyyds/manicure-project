import { describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { writeFile } from 'node:fs/promises';
import {
  NotFoundException,
  BadRequestException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { FilesService, __decodeFilenameForTest } from './files.service';

vi.mock('node:fs', () => ({
  createReadStream: vi.fn().mockReturnValue('stream-object'),
}));

vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('node:crypto', () => ({
  randomUUID: vi.fn().mockReturnValue('abc-def-ghi'),
}));

function buildChain(offsetResult: unknown = []) {
  const offsetMock = vi.fn().mockResolvedValue(offsetResult);
  // limit returns a thenable that also has .offset() for chaining
  const limitImpl = () =>
    Object.assign(Promise.resolve([]), { offset: offsetMock });

  const chain: any = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockImplementation(limitImpl),
    offset: offsetMock,
  };
  return chain;
}

function buildDb(offsetResult?: unknown) {
  const chain = buildChain(offsetResult);
  return {
    db: {
      select: vi.fn().mockReturnValue(chain),
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockResolvedValue([{ insertId: 15 }]),
      }),
      delete: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ affectedRows: 1 }]),
      }),
    },
    chain,
  };
}

function buildConfig() {
  return {
    uploadDir: 'uploads',
    apiPrefix: 'api/v1',
  };
}

function mockMultipartFile(overrides = {}) {
  return {
    filename: 'test.png',
    mimetype: 'image/png',
    toBuffer: vi.fn().mockResolvedValue(Buffer.from('fake-image-data')),
    ...overrides,
  };
}

describe('FilesService', () => {
  describe('list', () => {
    it('returns paginated files', async () => {
      const { db } = buildDb([
        {
          id: 1,
          name: 'abc.png',
          originalName: 'test.png',
          path: '/uploads/abc.png',
          mime: 'image/png',
          ext: '.png',
          size: 100,
          createdBy: null,
          createdAt: new Date(),
        },
      ]);
      const service = new FilesService({ db } as any, buildConfig() as any);
      const result = await service.list(1, 20);
      expect(result.items).toHaveLength(1);
      expect(result.items[0]).toHaveProperty('url');
    });
  });

  describe('detail', () => {
    it('returns file detail', async () => {
      const { db, chain } = buildDb([]);
      chain.limit.mockImplementation(() =>
        Object.assign(
          Promise.resolve([
            {
              id: 1,
              name: 'abc.png',
              originalName: 'test.png',
              path: '/uploads/abc.png',
              mime: 'image/png',
              ext: '.png',
              size: 100,
              createdBy: null,
              createdAt: new Date(),
            },
          ]),
          { offset: chain.offset },
        ),
      );
      const service = new FilesService({ db } as any, buildConfig() as any);
      const result = await service.detail(1);
      expect(result.originalName).toBe('test.png');
    });
  });

  describe('save', () => {
    it('saves an uploaded file', async () => {
      const { db } = buildDb();
      const file = mockMultipartFile();
      const service = new FilesService({ db } as any, buildConfig() as any);
      const result = await service.save(file as any, 1);
      expect(result).toHaveProperty('id', 15);
      expect(result).toHaveProperty('url');
    });

    it('throws BadRequestException for disallowed extension', async () => {
      const { db } = buildDb();
      const file = mockMultipartFile({ filename: 'evil.exe' });
      const service = new FilesService({ db } as any, buildConfig() as any);
      await expect(service.save(file as any, 1)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('throws BadRequestException for empty file', async () => {
      const { db } = buildDb();
      const file = mockMultipartFile({
        toBuffer: vi.fn().mockResolvedValue(Buffer.from([])),
      });
      const service = new FilesService({ db } as any, buildConfig() as any);
      await expect(service.save(file as any, 1)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('throws PayloadTooLargeException for oversized file', async () => {
      const { db } = buildDb();
      const file = mockMultipartFile({
        // 上限是 5MB（见 MAX_FILE_SIZE）：用例取「刚好超一点」，别真分配 50MB
        toBuffer: vi.fn().mockResolvedValue(Buffer.alloc(6 * 1024 * 1024)),
      });
      const service = new FilesService({ db } as any, buildConfig() as any);
      await expect(service.save(file as any, 1)).rejects.toThrow(
        PayloadTooLargeException,
      );
    });

    it('handles undefined actor id', async () => {
      const { db } = buildDb();
      const file = mockMultipartFile({ filename: 'doc.pdf' });
      const service = new FilesService({ db } as any, buildConfig() as any);
      const result = await service.save(file as any, undefined);
      expect(result).toHaveProperty('id', 15);
    });

    it('preserves Chinese filenames (decodes latin1 mojibake)', async () => {
      const { db } = buildDb();
      // 模拟 busboy 对中文 UTF-8 字节按 latin1 误解码后得到的乱码字符串
      const mojibake = Buffer.from('报告.pdf', 'utf8').toString('latin1');
      const file = mockMultipartFile({ filename: mojibake });
      const service = new FilesService({ db } as any, buildConfig() as any);
      const result = await service.save(file as any, 1);
      expect(result.originalName).toBe('报告.pdf');
    });

    it('keeps Chinese chars while stripping path separators', async () => {
      const { db } = buildDb();
      const file = mockMultipartFile({ filename: '../../目录/报表 2024.xlsx' });
      const service = new FilesService({ db } as any, buildConfig() as any);
      const result = await service.save(file as any, 1);
      expect(result.originalName).toBe('报表 2024.xlsx');
    });

    it('compresses images over 1MB and stores the compressed size', async () => {
      const big = await makeBigJpeg();
      const { db } = buildDb();
      const file = mockMultipartFile({
        filename: 'photo.jpg',
        mimetype: 'image/jpeg',
        toBuffer: vi.fn().mockResolvedValue(big),
      });
      const service = new FilesService({ db } as any, buildConfig() as any);
      const result = await service.save(file as any, 1);

      expect(result.compressed).toBe(true);
      // originalSize 是上传时的大小（前端用它提示「已从 2.4MB 压到 200KB」）
      expect(result.originalSize).toBe(big.length);
      expect(result.size).toBeLessThanOrEqual(1024 * 1024);
      // 落盘的必须是压缩后的那份 —— 「只改返回值、磁盘照写原图」是最容易犯的错
      // （注意：`bun test` 没有实现 `vi.mocked`，这里直接读 mock 上的 calls）
      const calls = (
        writeFile as unknown as { mock: { calls: [string, Buffer][] } }
      ).mock.calls;
      const written = calls.at(-1)?.[1];
      expect(written?.length).toBe(result.size);
    }, 60_000);

    it('keeps the original bytes when compress is disabled', async () => {
      const big = await makeBigJpeg();
      const { db } = buildDb();
      const file = mockMultipartFile({
        filename: 'poster.jpg',
        mimetype: 'image/jpeg',
        toBuffer: vi.fn().mockResolvedValue(big),
      });
      const service = new FilesService({ db } as any, buildConfig() as any);
      const result = await service.save(file as any, 1, { compress: false });

      expect(result.compressed).toBe(false);
      expect(result.size).toBe(big.length);
      expect(result.originalSize).toBe(big.length);
    }, 60_000);
  });

  describe('open', () => {
    it('returns file stream', async () => {
      const { db, chain } = buildDb([]);
      chain.limit.mockImplementation(() =>
        Object.assign(
          Promise.resolve([
            {
              id: 1,
              name: 'abc.png',
              originalName: 'test.png',
              path: '/uploads/abc.png',
              mime: 'image/png',
              ext: '.png',
              size: 100,
              createdBy: null,
              createdAt: new Date(),
            },
          ]),
          { offset: chain.offset },
        ),
      );
      const service = new FilesService({ db } as any, buildConfig() as any);
      const result = await service.open(1);
      expect(result).toHaveProperty('stream');
      expect(result.mime).toBe('image/png');
    });
  });

  describe('remove', () => {
    it('deletes file from db and disk', async () => {
      const { db, chain } = buildDb([]);
      chain.limit.mockImplementation(() =>
        Object.assign(
          Promise.resolve([
            {
              id: 1,
              name: 'abc.png',
              originalName: 'test.png',
              path: '/uploads/abc.png',
              mime: 'image/png',
              ext: '.png',
              size: 100,
              createdBy: null,
              createdAt: new Date(),
            },
          ]),
          { offset: chain.offset },
        ),
      );
      const service = new FilesService({ db } as any, buildConfig() as any);
      await expect(service.remove(1)).resolves.toBeUndefined();
    });

    it('throws NotFoundException', async () => {
      const { db, chain } = buildDb([]);
      chain.limit.mockImplementation(() =>
        Object.assign(Promise.resolve([]), { offset: chain.offset }),
      );
      const service = new FilesService({ db } as any, buildConfig() as any);
      await expect(service.remove(999)).rejects.toThrow(NotFoundException);
    });
  });
});

/**
 * 造一张 >1MB 的真实 JPEG。
 *
 * 压缩是这次改动的主角，**必须用真图测**：`Buffer.from('fake-image-data')` 这类假字节
 * 大小不到 1MB，压缩分支（>1MB 才进）根本走不到，断言压缩结果就成了自欺。
 *
 * 图的内容用「平滑渐变 + 每 4×4 块一点扰动」：纯渐变压完只剩几十 KB（原图自己就不到 1MB），
 * 纯噪声又几乎压不动（验不了「压到 1MB 以下」）。与 `image-compress.spec.ts` 同款，只是小一号。
 */
async function makeBigJpeg(): Promise<Buffer> {
  const width = 3200;
  const height = 2400;
  const raw = Buffer.allocUnsafe(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      raw[i] = Math.floor((x * 255) / width);
      raw[i + 1] = Math.floor((y * 255) / height);
      raw[i + 2] = Math.floor(((x + y) * 255) / (width + height));
    }
  }
  let seed = 7 >>> 0;
  for (let y = 0; y < height; y += 4) {
    for (let x = 0; x < width; x += 4) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const delta = ((seed >>> 28) & 0x0f) - 8;
      for (let dy = 0; dy < 4 && y + dy < height; dy++) {
        for (let dx = 0; dx < 4 && x + dx < width; dx++) {
          const i = ((y + dy) * width + x + dx) * 3;
          for (let c = 0; c < 3; c++)
            raw[i + c] = Math.min(255, Math.max(0, raw[i + c]! + delta));
        }
      }
    }
  }
  return sharp(raw, { raw: { width, height, channels: 3 } })
    .jpeg({ quality: 98, mozjpeg: true })
    .toBuffer();
}

/**
 * multipart 文件名编码。
 *
 * 这里的用例都是**实测出来的**，不是构造的：
 * 用真实上传链路（FormData + Bun）传中文名时，`奶茶色猫眼.jpg` 被写成了 `v6r__.jpg`。
 */
describe('decodeFilename（multipart 中文名）', () => {
  const decode = __decodeFilenameForTest;

  it('busboy 按 latin1 误解码的 UTF-8 名 → 还原成中文', () => {
    // '微信图片.png' 的 UTF-8 字节被 latin1 逐字节解码后的样子
    const mojibake = Buffer.from('微信图片.png', 'utf8').toString('latin1');
    expect(mojibake).not.toBe('微信图片.png');
    expect(decode(mojibake)).toBe('微信图片.png');
  });

  it('**已经是正确中文名时不能被"修"坏**（回归：奶茶色猫眼 → v6r__.jpg）', () => {
    // 这五个字的低字节恰好拼成合法 UTF-8（v6r+<），所以「无条件转一次」既不报错、也拦不住
    expect(decode('奶茶色猫眼.jpg')).toBe('奶茶色猫眼.jpg');
    expect(decode('法式裸粉渐变.jpg')).toBe('法式裸粉渐变.jpg');
    expect(decode('手绘小雏菊.jpg')).toBe('手绘小雏菊.jpg');
    expect(decode('莫兰迪撞色.jpg')).toBe('莫兰迪撞色.jpg');
    expect(decode('金属镜面玫瑰金.jpg')).toBe('金属镜面玫瑰金.jpg');
  });

  it('纯 ASCII 名原样返回', () => {
    expect(decode('nail-01.jpg')).toBe('nail-01.jpg');
    expect(decode('a b_c-d.png')).toBe('a b_c-d.png');
  });

  it('看着像 latin1 高位字符、但重解会出替换符的，保持原样（兜底仍生效）', () => {
    // 单独一个 'é'(U+00E9)：按 latin1 回编码是 0xE9，不是合法 UTF-8 → 会出 U+FFFD → 保持原样
    expect(decode('café.jpg')).toBe('café.jpg');
  });
});
