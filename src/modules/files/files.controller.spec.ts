import { describe, expect, it, vi } from 'vitest';
import { FilesController } from './files.controller';
import type { FilesService } from './files.service';

function mockService(): Partial<FilesService> {
  return {
    list: vi.fn().mockResolvedValue({ items: [], page: 1, pageSize: 20 }),
    detail: vi.fn().mockResolvedValue({
      id: 1,
      name: 'abc.png',
      originalName: 'test.png',
      url: '/api/v1/files/1/download',
      mime: 'image/png',
      ext: '.png',
      size: 100,
      createdAt: new Date(),
    }),
    save: vi.fn().mockResolvedValue({
      id: 1,
      name: 'abc.png',
      originalName: 'test.png',
      url: '/api/v1/files/1/download',
      mime: 'image/png',
      ext: '.png',
      size: 100,
      createdAt: new Date(),
    }),
    open: vi.fn().mockResolvedValue({
      stream: 'stream',
      mime: 'image/png',
      originalName: 'test.png',
    }),
    remove: vi.fn().mockResolvedValue(undefined),
  };
}

function mockRequest(file: any = undefined) {
  return {
    file: vi.fn().mockResolvedValue(file),
    user: { id: 1 },
  };
}

function mockReply() {
  return {
    header: vi.fn(),
    send: vi.fn(),
  };
}

describe('FilesController', () => {
  it('upload saves a file', async () => {
    const s = mockService();
    const c = new FilesController(s as FilesService);
    const req = mockRequest({
      filename: 'test.png',
      mimetype: 'image/png',
      toBuffer: vi.fn(),
    });
    await c.upload(req as any);
    expect(s.save).toHaveBeenCalled();
  });

  it('upload throws when no file', async () => {
    const s = mockService();
    const c = new FilesController(s as FilesService);
    const req = mockRequest(undefined);
    await expect(c.upload(req as any)).rejects.toThrow();
  });

  it('list returns files', async () => {
    const s = mockService();
    const c = new FilesController(s as FilesService);
    await c.list('1', '20');
    expect(s.list).toHaveBeenCalledWith(1, 20);
  });

  it('download streams a file', async () => {
    const s = mockService();
    const c = new FilesController(s as FilesService);
    const reply = mockReply();
    await c.download(1, reply as any);
    expect(reply.header).toHaveBeenCalledWith('Content-Type', 'image/png');
    expect(reply.send).toHaveBeenCalledWith('stream');
  });

  it('download 允许跨源嵌入：必须覆盖 helmet 的 CORP same-origin', async () => {
    // 不覆盖的话，小程序 `<image>` / 异源后台 `<img>` 会被 Chromium 静默拦掉（图能 200 但页面空白）。
    // 把这一行删掉，本用例立刻变红 —— 这是这个坑唯一的自动化护栏。
    const s = mockService();
    const c = new FilesController(s as FilesService);
    const reply = mockReply();
    await c.download(1, reply as any);
    expect(reply.header).toHaveBeenCalledWith(
      'Cross-Origin-Resource-Policy',
      'cross-origin',
    );
  });

  it('download 支持 inline=1 内联展示', async () => {
    const s = mockService();
    const c = new FilesController(s as FilesService);
    const reply = mockReply();
    await c.download(1, reply as any, '1');
    expect(reply.header).toHaveBeenCalledWith('Content-Disposition', 'inline');
  });

  it('detail returns file metadata', async () => {
    const s = mockService();
    const c = new FilesController(s as FilesService);
    const r = await c.detail(1);
    expect(r).toHaveProperty('originalName', 'test.png');
  });

  it('remove deletes a file', async () => {
    const s = mockService();
    const c = new FilesController(s as FilesService);
    await c.remove(1);
    expect(s.remove).toHaveBeenCalledWith(1);
  });
});
