import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { MySql2Database } from 'drizzle-orm/mysql2';
import {
  departments,
  roleDepts,
  roles,
  users,
  type relations,
} from '../../database/schema/index';

/**
 * 请求头里的「当前门店」（后台顶栏的门店切换器）。
 *
 * 刻意**不放 JWT**：与 `resolveDataScope` 同一取舍 —— 切门店后立刻生效，
 * 不用等重新登录换 token；同时后端仍然要按 `sys_user_store` 复核可见性，
 * 所以这个头只是「用户想在哪家店干活」的意图，不是权限。
 */
export const STORE_HEADER = 'x-store-id';

/** 当前请求操作人（来自 JWT claims，与 AccessTokenGuard 设置的 request.user 一致） */
export type RequestActor = {
  id: number;
  roles: string[];
  permissions: string[];
  /**
   * 当前门店（来自 `x-store-id` 头，见 `STORE_HEADER`）。
   * 非法/未传 = undefined；可见性由 `resolveStoreScope` 复核。
   */
  storeId?: number | undefined;
};

/** 解析后的数据权限范围 */
export type DataScopeFilter =
  | { kind: 'all' }
  | { kind: 'self' }
  | { kind: 'deptIds'; ids: number[] };

type Schema = typeof relations;

/**
 * 解析操作人对某张表的数据权限范围（对齐若依规则）：
 * - 超级管理员（*:*:*）或未分配角色 → 全部数据
 * - 任一角色为 all → 全部数据
 * - 否则按角色取并集（宽松优先）：custom 的 role_dept 部门 ∪ 本人部门（dept）
 *   ∪ 本人部门及以下（dept_and_children）；存在部门范围 → deptIds；否则 → self
 */
export async function resolveDataScope(
  db: MySql2Database<Schema>,
  actor: RequestActor,
): Promise<DataScopeFilter> {
  if (actor.permissions.includes('*:*:*') || actor.roles.length === 0) {
    return { kind: 'all' };
  }

  const roleRows = await db
    .select({ id: roles.id, dataScope: roles.dataScope })
    .from(roles)
    .where(and(inArray(roles.key, actor.roles), isNull(roles.deletedAt)));

  const scopes = roleRows.map((row) => row.dataScope);
  if (scopes.includes('all')) return { kind: 'all' };

  const needDeptScope = scopes.some(
    (scope) =>
      scope === 'custom' || scope === 'dept' || scope === 'dept_and_children',
  );
  if (!needDeptScope) return { kind: 'self' };

  const ids: number[] = [];

  // 自定义数据范围：角色勾选的部门
  const customRoleIds = roleRows
    .filter((row) => row.dataScope === 'custom')
    .map((row) => row.id);
  if (customRoleIds.length) {
    const deptRows = await db
      .select({ deptId: roleDepts.deptId })
      .from(roleDepts)
      .where(inArray(roleDepts.roleId, customRoleIds));
    ids.push(...deptRows.map((row) => row.deptId));
  }

  // 本部门 / 本部门及以下：当前用户所属部门 + 其下级
  const needOwnDept = scopes.some(
    (scope) => scope === 'dept' || scope === 'dept_and_children',
  );
  if (needOwnDept) {
    const [me] = await db
      .select({ deptId: users.deptId })
      .from(users)
      .where(eq(users.id, actor.id))
      .limit(1);
    if (me?.deptId != null) {
      ids.push(me.deptId);
      if (scopes.includes('dept_and_children')) {
        ids.push(...(await descendantIds(db, me.deptId)));
      }
    }
  }

  return { kind: 'deptIds', ids: [...new Set(ids)] };
}

/** 查询某个部门的所有下级部门 id（利用 ancestors 祖先路径，不含自身） */
async function descendantIds(
  db: MySql2Database<Schema>,
  rootId: number,
): Promise<number[]> {
  const rows = await db
    .select({ id: departments.id, ancestors: departments.ancestors })
    .from(departments)
    .where(isNull(departments.deletedAt));
  const needle = String(rootId);
  return rows
    .filter((row) => row.ancestors.split(',').includes(needle))
    .map((row) => row.id);
}
