/**
 * `useTable` 的分页请求参数：**`pageSize` 绝不能 +1**。
 *
 * 守的是一个真实事故（2026-09-16 用户报「操作日志点到第 4 页是空的」）：
 * 曾经为了「多取一条判有没有下一页」而传 `pageSize + 1`，可后端的
 * `offset` 就是 `(page - 1) * pageSize` —— 用的正是这个被 +1 的值，于是第 N 页的起点
 * 整体后移 `N - 1` 条：**翻页会漏数据，最后一页还会越界变空**。
 *
 * 实测（操作日志 32 条、每页 10 条）：
 * `page=4&pageSize=10` → 2 条；`page=4&pageSize=11` → **0 条**。注意**偏差只出现在后几页**，
 * 所以「第 1 页正常」不能证明它对 —— 这个用例直接把请求参数钉死。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 两个前置补丁，都是为了在纯 node（bun test）里跑得起来：
 *
 * 1. `lew-ui` 在**模块顶层**就引用了 `ResizeObserver`（`props: { resizeObserver: { type: ResizeObserver } }`），
 *    node 里没有这个全局对象 —— 一旦它被任何链路 import 进来就整个文件炸掉；
 * 2. mock 用**相对路径**（而不是 `~/request`）：`vi.mock` 按解析后的模块 id 匹配，
 *    实测写 `~` 前缀时没能拦住真实模块。
 */
(globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver ??=
  class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
vi.mock('../request', () => ({ get: vi.fn() }));
vi.mock('../store/store-scope', () => ({
  useStoreScopeStore: () => ({ activeStoreId: null }),
}));

// 动态 import：确保上面两个 mock 已经注册（`vi.mock` 虽会提升，但这里更显式）
const { get } = await import('../request');
const { useTable } = await import('./useTable');

const getMock = get as unknown as ReturnType<typeof vi.fn>;

function rows(count: number, startId = 1) {
  return Array.from({ length: count }, (_, i) => ({ id: startId + i }));
}

describe('useTable 分页请求', () => {
  beforeEach(() => {
    getMock.mockReset();
  });

  it('pageSize 原样传（不能 +1，否则后端 offset 错位、末页会空）', async () => {
    getMock.mockResolvedValue({
      items: rows(2, 31),
      total: 32,
      page: 4,
      pageSize: 10,
    });
    const table = useTable<{ id: number }>({ url: '/x', defaultPageSize: 10 });

    await table.fetchPage(4);

    expect(getMock).toHaveBeenCalledWith('/x', { page: 4, pageSize: 10 });
  });

  it('total 取后端真值，hasMore 由它推导（末页为 false）', async () => {
    getMock.mockResolvedValue({
      items: rows(2, 31),
      total: 32,
      page: 4,
      pageSize: 10,
    });
    const table = useTable<{ id: number }>({ url: '/x', defaultPageSize: 10 });

    await table.fetchPage(4);

    expect(table.total.value).toBe(32);
    // (4-1)*10 + 2 = 32，正好到底
    expect(table.hasMore.value).toBe(false);
  });

  it('中间页仍判得出还有下一页', async () => {
    getMock.mockResolvedValue({
      items: rows(10, 21),
      total: 32,
      page: 3,
      pageSize: 10,
    });
    const table = useTable<{ id: number }>({ url: '/x', defaultPageSize: 10 });

    await table.fetchPage(3);

    // (3-1)*10 + 10 = 30 < 32
    expect(table.hasMore.value).toBe(true);
  });

  it('后端没给 total（老接口）时退回「满页即可能还有下一页」', async () => {
    getMock.mockResolvedValue({
      items: rows(10),
      page: 1,
      pageSize: 10,
    });
    const table = useTable<{ id: number }>({ url: '/x', defaultPageSize: 10 });

    await table.fetchPage(1);

    expect(table.total.value).toBe(10);
    expect(table.hasMore.value).toBe(true);
  });
});
