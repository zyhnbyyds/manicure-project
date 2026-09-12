import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { GlobalExceptionFilter } from './global-exception.filter';

function buildHost() {
  const send = vi.fn();
  const status = vi.fn().mockReturnValue({ send });
  return {
    host: {
      switchToHttp: vi.fn().mockReturnValue({
        getResponse: vi.fn().mockReturnValue({ status }),
        // Fastify 会把 request-id 头（或自生成的 id）放进 request.id
        getRequest: vi.fn().mockReturnValue({ id: 'req-test-1' }),
      }),
    } as any,
    status,
    send,
  };
}

describe('GlobalExceptionFilter', () => {
  it('converts ZodError to 400 with field messages', () => {
    const filter = new GlobalExceptionFilter();
    const { host, status, send } = buildHost();
    const schema = z.object({ name: z.string().min(1) });
    const error = schema.safeParse({ name: '' }).error!;

    filter.catch(error, host);

    expect(status).toHaveBeenCalledWith(400);
    const body = send.mock.calls[0]![0];
    expect(body.statusCode).toBe(400);
    expect(Array.isArray(body.message)).toBe(true);
    expect(body.message[0]).toContain('名称');
    expect(body.message[0]).toContain('不能为空');
  });

  it('**异常响应带上请求号**（前后端说的是同一个号，排障才对得上）', () => {
    const filter = new GlobalExceptionFilter();
    const { host, send } = buildHost();

    filter.catch(new BadRequestException('key 已存在'), host);

    expect(send.mock.calls[0]![0]).toMatchObject({ requestId: 'req-test-1' });
  });
  it('passes HttpException through with its status', () => {
    const filter = new GlobalExceptionFilter();
    const { host, status, send } = buildHost();

    filter.catch(new BadRequestException('key 已存在'), host);

    expect(status).toHaveBeenCalledWith(400);
    expect(send).toHaveBeenCalled();
  });

  it('把 Fastify 插件的 4xx 透传出去（限流 429 不能降级成 500）', () => {
    const filter = new GlobalExceptionFilter();
    const { host, status, send } = buildHost();
    // @fastify/rate-limit 超限就是这么抛的：普通 Error + statusCode = 429
    const rateLimited: Error & { statusCode?: number } = new Error(
      'Rate limit exceeded, retry in 1 minute',
    );
    rateLimited.statusCode = 429;

    filter.catch(rateLimited, host);

    expect(status).toHaveBeenCalledWith(429);
    const body = send.mock.calls[0]![0];
    expect(body.statusCode).toBe(429);
    expect(body.message).toBe('请求过于频繁，请稍后再试');
  });

  it('插件给的 statusCode 是 5xx 时仍按未知异常兜底 500（不让它决定失败语义）', () => {
    const filter = new GlobalExceptionFilter();
    const { host, status, send } = buildHost();
    const pluginError: Error & { statusCode?: number } = new Error(
      'upstream broke',
    );
    pluginError.statusCode = 502;

    filter.catch(pluginError, host);

    expect(status).toHaveBeenCalledWith(500);
    expect(send.mock.calls[0]![0].message).toBe('服务器内部错误，请稍后重试');
  });

  it('falls back to 500 with a friendly message for unknown errors', () => {
    const filter = new GlobalExceptionFilter();
    const { host, status, send } = buildHost();

    filter.catch(new Error('boom'), host);

    expect(status).toHaveBeenCalledWith(500);
    const body = send.mock.calls[0]![0];
    expect(body.message).toBe('服务器内部错误，请稍后重试');
  });
});
