import { describe, expect, it, vi } from 'vitest';
import { CustomersController } from './customers.controller';

function createHarness() {
  const customers = {
    list: vi.fn().mockResolvedValue({ items: [], page: 1, pageSize: 20 }),
    findOne: vi.fn(),
    listBookings: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    recount: vi.fn(),
    restore: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn(),
  };
  return { controller: new CustomersController(customers as never), customers };
}

const actor = { user: { id: 7 } };

describe('CustomersController.restore / list status', () => {
  it('restore 透传顾客 id 与操作人', async () => {
    const h = createHarness();
    await h.controller.restore(9, actor);
    expect(h.customers.restore).toHaveBeenCalledWith(9, 7);
  });

  it('list 透传 status=deleted', async () => {
    const h = createHarness();
    await h.controller.list(
      '2',
      '50',
      '旧顾客',
      undefined,
      undefined,
      'deleted',
    );
    expect(h.customers.list).toHaveBeenCalledWith(2, 50, {
      keyword: '旧顾客',
      status: 'deleted',
    });
  });

  it('list 非法 status 回落 active 默认口径', async () => {
    const h = createHarness();
    await h.controller.list(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'trash',
    );
    expect(h.customers.list).toHaveBeenCalledWith(1, 20, {});
  });
});
