import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, count, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { hashPassword } from '../../../common/password/password.service';
import { DatabaseService } from '../../../database/database.service';
import { readCount } from '../../biz/common/query';
import {
  departments,
  roles,
  sysStores,
  sysUserStores,
  userRoles,
  users,
} from '../../../database/schema/index';
import {
  resolveDataScope,
  type RequestActor,
} from '../../../common/data-scope/data-scope';

export type CreateUserInput = {
  username: string;
  displayName: string;
  password: string;
  email?: string | undefined;
  phone?: string | undefined;
  deptId?: number | undefined;
  roleIds?: number[] | undefined;
};
export type UpdateUserInput = {
  displayName?: string | undefined;
  email?: string | null | undefined;
  phone?: string | null | undefined;
  deptId?: number | null | undefined;
  status?: 'active' | 'disabled' | undefined;
  password?: string | undefined;
  roleIds?: number[] | undefined;
};
export type UserListOptions = {
  status?: 'active' | 'disabled' | undefined;
  deptId?: number | undefined;
  /** 传入操作人时按数据权限过滤列表（若依数据范围） */
  actor?: RequestActor | undefined;
};

@Injectable()
export class UsersService {
  constructor(private readonly database: DatabaseService) {}
  async list(page: number, pageSize: number, options: UserListOptions = {}) {
    const conditions: (
      | ReturnType<typeof isNull>
      | ReturnType<typeof eq>
      | ReturnType<typeof inArray>
      | ReturnType<typeof sql>
    )[] = [isNull(users.deletedAt)];
    if (options.status === 'active' || options.status === 'disabled') {
      conditions.push(eq(users.status, options.status));
    }
    if (options.deptId !== undefined) {
      conditions.push(eq(users.deptId, options.deptId));
    }
    if (options.actor) {
      const scope = await resolveDataScope(this.database.db, options.actor);
      if (scope.kind === 'self') {
        conditions.push(eq(users.id, options.actor.id));
      } else if (scope.kind === 'deptIds') {
        conditions.push(
          scope.ids.length ? inArray(users.deptId, scope.ids) : sql`1 = 0`,
        );
      }
    }
    const where = and(...conditions);
    const [items, counted] = await Promise.all([
      this.database.db
        .select({
          id: users.id,
          username: users.username,
          displayName: users.displayName,
          email: users.email,
          phone: users.phone,
          status: users.status,
          deptId: users.deptId,
          deptName: departments.name,
          avatar: users.avatar,
          createdAt: users.createdAt,
          loginAt: users.loginAt,
        })
        .from(users)
        .leftJoin(departments, eq(users.deptId, departments.id))
        .where(where)
        .orderBy(desc(users.id))
        .limit(pageSize)
        .offset((page - 1) * pageSize),
      // total 与 items 用同一套 from/join/where（少一个 join 就可能因为 where 引用它而报错）
      this.database.db
        .select({ value: count() })
        .from(users)
        .leftJoin(departments, eq(users.deptId, departments.id))
        .where(where),
    ]);
    const roleMap = await this.fetchRoleMap(items.map((item) => item.id));
    const storeMap = await this.fetchStoreMap(items.map((item) => item.id));
    return {
      items: items.map((item) => ({
        ...item,
        roleIds: roleMap.get(item.id)?.map((r) => r.id) ?? [],
        roleNames: roleMap.get(item.id)?.map((r) => r.name) ?? [],
        /**
         * 可见门店（连锁直营）。列表里带上名字，前端「门店」列不用再逐行查一次；
         * 空数组 = 这个账号看不到任何门店的业务数据（超管除外）。
         */
        stores: storeMap.get(item.id) ?? [],
      })),
      total: readCount(counted),
      page,
      pageSize,
    };
  }

  /** 某账号的可见门店 id（授权弹窗回填用） */
  async listStores(userId: number): Promise<number[]> {
    await this.requireUser(userId);
    const rows = await this.database.db
      .select({ storeId: sysUserStores.storeId })
      .from(sysUserStores)
      .where(eq(sysUserStores.userId, userId));
    return rows.map((row) => row.storeId).sort((a, b) => a - b);
  }

  /**
   * 全量替换某账号的可见门店。
   *
   * 与角色授权同款：**先删后增**（授权界面就是一个多选，语义是「最终是这几家」）。
   * 只校验门店存在且未停用 —— 给账号授权门店是总部行为，不检查操作人自己有没有这家店
   * （否则就没人能给新店授权了；接口本身的权限点 `system:user:store` 才是闸门）。
   */
  async replaceStores(userId: number, storeIds: number[]): Promise<void> {
    await this.requireUser(userId);
    const unique = [...new Set(storeIds)];
    if (unique.length) {
      const valid = await this.database.db
        .select({ id: sysStores.id })
        .from(sysStores)
        .where(
          and(
            inArray(sysStores.id, unique),
            eq(sysStores.status, 'active'),
            isNull(sysStores.deletedAt),
          ),
        );
      const validIds = new Set(valid.map((row) => row.id));
      const missing = unique.filter((id) => !validIds.has(id));
      if (missing.length)
        throw new NotFoundException(
          `门店不存在或已停用：${missing.join(', ')}`,
        );
    }
    await this.database.db.transaction(async (tx) => {
      await tx.delete(sysUserStores).where(eq(sysUserStores.userId, userId));
      if (unique.length) {
        await tx
          .insert(sysUserStores)
          .values(unique.map((storeId) => ({ userId, storeId })));
      }
    });
  }

  private async requireUser(userId: number): Promise<void> {
    const [row] = await this.database.db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, userId), isNull(users.deletedAt)))
      .limit(1);
    if (!row) throw new NotFoundException('用户不存在');
  }
  async create(input: CreateUserInput, actorId: number) {
    const [existing] = await this.database.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.username, input.username))
      .limit(1);
    if (existing) throw new ConflictException('用户名已存在');
    const passwordHash = await hashPassword(input.password);
    const { password: _password, roleIds = [], ...fields } = input;
    const result = await this.database.db.insert(users).values({
      ...withoutUndefined(fields),
      passwordHash,
      createdBy: actorId,
      updatedBy: actorId,
    });
    const userId = Number(result[0].insertId);
    if (roleIds.length) await this.assignRoles(userId, roleIds);
    return { id: userId };
  }
  async update(id: number, input: UpdateUserInput, actorId: number) {
    const { password, roleIds, ...rest } = input;
    const patch: Record<string, unknown> = { ...withoutUndefined(rest) };
    if (password) {
      patch.passwordHash = await hashPassword(password);
      patch.passwordChangedAt = new Date();
    }
    if (roleIds) await this.replaceRoles(id, roleIds);
    const result = await this.database.db
      .update(users)
      .set({ ...patch, updatedBy: actorId })
      .where(and(eq(users.id, id), isNull(users.deletedAt)));
    if (!result[0].affectedRows) throw new NotFoundException('用户不存在');
    return { id, success: true };
  }
  async remove(id: number, actorId: number) {
    const result = await this.database.db
      .update(users)
      .set({ deletedAt: new Date(), updatedBy: actorId })
      .where(and(eq(users.id, id), isNull(users.deletedAt)));
    if (!result[0].affectedRows) throw new NotFoundException('用户不存在');
  }
  async assignRole(userId: number, roleId: number) {
    await this.assignRoles(userId, [roleId]);
  }

  /** 查询一批用户的可见门店（id + name），一次查询避免 N+1 */
  private async fetchStoreMap(
    userIds: number[],
  ): Promise<Map<number, { id: number; name: string }[]>> {
    if (!userIds.length) return new Map();
    const rows = await this.database.db
      .select({
        userId: sysUserStores.userId,
        id: sysStores.id,
        name: sysStores.name,
      })
      .from(sysUserStores)
      .innerJoin(sysStores, eq(sysUserStores.storeId, sysStores.id))
      .where(
        and(
          inArray(sysUserStores.userId, userIds),
          isNull(sysStores.deletedAt),
        ),
      );
    const map = new Map<number, { id: number; name: string }[]>();
    for (const row of rows) {
      const list = map.get(row.userId) ?? [];
      list.push({ id: row.id, name: row.name });
      map.set(row.userId, list);
    }
    return map;
  }

  /** 查询一批用户的所有角色（id + name） */
  private async fetchRoleMap(
    userIds: number[],
  ): Promise<Map<number, { id: number; name: string }[]>> {
    if (!userIds.length) return new Map();
    const rows = await this.database.db
      .select({ userId: userRoles.userId, id: roles.id, name: roles.name })
      .from(userRoles)
      .innerJoin(roles, eq(userRoles.roleId, roles.id))
      .where(and(inArray(userRoles.userId, userIds), isNull(roles.deletedAt)));
    const map = new Map<number, { id: number; name: string }[]>();
    for (const row of rows) {
      const list = map.get(row.userId) ?? [];
      list.push({ id: row.id, name: row.name });
      map.set(row.userId, list);
    }
    return map;
  }

  /** 为单个用户分配多个角色（已存在的跳过，校验角色存在） */
  private async assignRoles(userId: number, roleIds: number[]): Promise<void> {
    if (!roleIds.length) return;
    const existing = await this.database.db
      .select({ roleId: userRoles.roleId })
      .from(userRoles)
      .where(eq(userRoles.userId, userId));
    const existingSet = new Set(existing.map((r) => r.roleId));
    const toAdd = [...new Set(roleIds)].filter((id) => !existingSet.has(id));
    if (!toAdd.length) return;
    const validRoles = await this.database.db
      .select({ id: roles.id })
      .from(roles)
      .where(and(inArray(roles.id, toAdd), isNull(roles.deletedAt)));
    const validIds = new Set(validRoles.map((r) => r.id));
    const values = toAdd
      .filter((id) => validIds.has(id))
      .map((roleId) => ({ userId, roleId }));
    if (values.length) {
      await this.database.db.insert(userRoles).values(values);
    }
  }

  /** 全量替换用户角色（先删后增） */
  private async replaceRoles(userId: number, roleIds: number[]): Promise<void> {
    await this.database.db
      .delete(userRoles)
      .where(eq(userRoles.userId, userId));
    if (roleIds.length) await this.assignRoles(userId, roleIds);
  }
}
function withoutUndefined<T extends object>(
  value: T,
): { [K in keyof T]: Exclude<T[K], undefined> } {
  return Object.fromEntries(
    Object.entries(value).filter(([, field]) => field !== undefined),
  ) as { [K in keyof T]: Exclude<T[K], undefined> };
}
