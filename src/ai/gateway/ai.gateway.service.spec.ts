import { describe, expect, it, vi } from 'vitest';
import { aiSessions } from '../../database/schema/index';
import { AiGatewayService } from './ai.gateway.service';

/**
 * 会话生命周期（列表过滤 / 软删）的单元测试。
 *
 * 只测**这一段**：`sendMessage` 要拉起 Agent，属于集成范畴，这里不覆盖。
 * 关注点是两件事：
 * 1. `listSessions` 必须过滤掉 `status=closed`（否则「删掉的会话刷新又回来」）；
 * 2. `deleteSession` 是软删（set status=closed），不是物理删除 —— 消息与审计要留。
 *
 * 过滤条件在单元测试里挖不到 SQL（Drizzle 的 `and()` 是不透明对象），
 * 所以用**链式参数捕获**断言「where 收到了两个条件、其中一个带 status 列」，
 * 真正的 SQL 由集成测试兜底。
 */

type SessionRow = {
  id: number;
  userId: number;
  title: string;
  status: 'active' | 'closed';
};

/** Drizzle 条件对象上能读到的公共字段（列名 / 值），够断言「筛了哪一列」 */
type ConditionLike = { name?: string; value?: unknown };

function mockDb(session: SessionRow | null) {
  const set = vi.fn().mockReturnValue({
    where: vi.fn().mockResolvedValue([{ affectedRows: 1 }]),
  });
  const orderBy = vi.fn().mockResolvedValue([]);
  const where = vi.fn().mockReturnValue({
    limit: vi.fn().mockResolvedValue(session ? [session] : []),
    orderBy,
  });
  return {
    set,
    where,
    orderBy,
    db: {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({ where }),
      }),
      update: vi.fn().mockReturnValue({ set }),
    },
  };
}

function buildService(db: ReturnType<typeof mockDb>) {
  return new AiGatewayService(
    { db: db.db } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
}

/** 列出捕获到的 where 条件（含 and(...) 的 queryChunks 展开） */
function flattenConditions(condition: unknown): ConditionLike[] {
  if (!condition || typeof condition !== 'object') return [];
  const node = condition as { queryChunks?: unknown[] } & ConditionLike;
  if (Array.isArray(node.queryChunks)) {
    return node.queryChunks.flatMap((chunk) => flattenConditions(chunk));
  }
  return [node];
}

const ACTIVE: SessionRow = {
  id: 7,
  userId: 1,
  title: '查看今日门店营收概况',
  status: 'active',
};

describe('AiGatewayService 会话生命周期', () => {
  it('listSessions 同时按用户与 status=active 过滤', async () => {
    const mock = mockDb(ACTIVE);
    const service = buildService(mock);
    await service.listSessions(1);

    const conditions = flattenConditions(mock.where.mock.calls[0]![0]);
    const columns = conditions.map((c) => c.name);
    expect(columns).toContain(aiSessions.userId.name);
    expect(columns).toContain(aiSessions.status.name);
    expect(conditions.map((c) => c.value)).toContain('active');
    expect(mock.orderBy).toHaveBeenCalledTimes(1);
  });

  it('deleteSession 软删：set status=closed 且保留原行', async () => {
    const mock = mockDb(ACTIVE);
    const service = buildService(mock);
    const result = await service.deleteSession(ACTIVE.id, ACTIVE.userId);
    expect(result).toEqual({ id: ACTIVE.id, status: 'closed' });
    expect(mock.db.update).toHaveBeenCalledTimes(1);
    const patch = mock.set.mock.calls[0]![0] as { status: string };
    expect(patch.status).toBe('closed');
  });

  it('deleteSession 幂等：已 closed 的会话不再更新', async () => {
    const mock = mockDb({ ...ACTIVE, status: 'closed' });
    const service = buildService(mock);
    const result = await service.deleteSession(ACTIVE.id, ACTIVE.userId);
    expect(result).toEqual({ id: ACTIVE.id, status: 'closed' });
    expect(mock.db.update).not.toHaveBeenCalled();
  });

  it('deleteSession 对不存在的会话抛 404', async () => {
    const mock = mockDb(null);
    const service = buildService(mock);
    await expect(service.deleteSession(999, 1)).rejects.toThrow('会话不存在');
    expect(mock.db.update).not.toHaveBeenCalled();
  });
});
