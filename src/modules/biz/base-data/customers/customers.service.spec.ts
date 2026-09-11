import { ConflictException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { CustomersService } from './customers.service.js';

type Row = Record<string, unknown>;

function chainFor(result: unknown) {
  const make = (): Record<string, unknown> => {
    const node = Promise.resolve(result) as unknown as Record<string, unknown>;
    node.from = make;
    node.where = make;
    node.orderBy = make;
    node.limit = make;
    node.offset = make;
    return node;
  };
  return make();
}

function createHarness(
  options: { selectResults?: unknown[][]; affectedRows?: number } = {},
) {
  const queue = [...(options.selectResults ?? [])];
  const select = vi.fn(() => chainFor(queue.shift() ?? []));
  const updateWhere = vi
    .fn()
    .mockResolvedValue([{ affectedRows: options.affectedRows ?? 1 }]);
  const updateSet = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set: updateSet }));
  const service = new CustomersService(
    { db: { select, update } } as never,
    { booking: vi.fn() } as never,
  );
  return { service, select, updateSet };
}

const customer = (overrides: Row = {}): Row => ({
  id: 9,
  name: '旧顾客',
  phone: '13800000009',
  deletedAt: new Date('2026-09-11T00:00:00.000Z'),
  ...overrides,
});

describe('CustomersService.restore（§4.3 恢复软删顾客）', () => {
  it('目标不存在 → NotFoundException', async () => {
    const h = createHarness({ selectResults: [[]] });
    await expect(h.service.restore(404, 7)).rejects.toThrow(NotFoundException);
  });

  it('已经在用 → 幂等成功，不发 update', async () => {
    const h = createHarness({
      selectResults: [[customer({ deletedAt: null })]],
    });
    await expect(h.service.restore(9, 7)).resolves.toBeUndefined();
    expect(h.updateSet).not.toHaveBeenCalled();
  });

  it('已删除 → 清 deletedAt 并记录 updatedBy', async () => {
    const h = createHarness({ selectResults: [[customer()]] });
    await h.service.restore(9, 7);
    expect(h.updateSet).toHaveBeenCalledWith({
      deletedAt: null,
      updatedBy: 7,
    });
  });

  it('恢复前发现手机号被在用顾客占用 → ConflictException，不恢复', async () => {
    const h = createHarness({
      selectResults: [[customer()], [{ id: 10, name: '新顾客' }]],
    });
    await expect(h.service.restore(9, 7)).rejects.toThrow(ConflictException);
    expect(h.updateSet).not.toHaveBeenCalled();
  });

  it('软删顾客可以用 status=deleted 列表筛出', async () => {
    const h = createHarness({ selectResults: [[customer()]] });
    await expect(h.service.list(1, 20, { status: 'deleted' })).resolves.toEqual(
      {
        items: [customer()],
        page: 1,
        pageSize: 20,
      },
    );
    expect(h.select).toHaveBeenCalledTimes(1);
  });

  it('默认列表仍只返回在用顾客', async () => {
    const h = createHarness({
      selectResults: [[customer({ deletedAt: null })]],
    });
    await expect(h.service.list(1, 20, {})).resolves.toEqual({
      items: [customer({ deletedAt: null })],
      page: 1,
      pageSize: 20,
    });
  });
});
