import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/mysql2';
import mysql from 'mysql2/promise';
import { hashPassword } from '../../common/password/password.service';
import { roles, userRoles, users } from '../schema/index';
import { seedBiz } from './biz.js';
import { seedMenus } from './menus.js';

async function seed(): Promise<void> {
  const url = Bun.env.DATABASE_URL;
  const password = Bun.env.SEED_ADMIN_PASSWORD;
  if (!url || !password)
    throw new Error('DATABASE_URL and SEED_ADMIN_PASSWORD are required');
  const pool = mysql.createPool(url);
  const db = drizzle({ client: pool });
  await db
    .insert(roles)
    .values({ name: '超级管理员', key: 'admin', isSystem: true })
    .onDuplicateKeyUpdate({ set: { name: '超级管理员' } });
  // 普通用户角色：注册用户默认分配
  await db
    .insert(roles)
    .values({ name: '普通用户', key: 'user' })
    .onDuplicateKeyUpdate({ set: { name: '普通用户' } });
  const [role] = await db
    .select()
    .from(roles)
    .where(eq(roles.key, 'admin'))
    .limit(1);
  if (!role) throw new Error('Failed to initialize administrator role');
  const hash = await hashPassword(password);
  await db
    .insert(users)
    .values({ username: 'admin', displayName: '管理员', passwordHash: hash })
    .onDuplicateKeyUpdate({ set: { passwordHash: hash, status: 'active' } });
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.username, 'admin'))
    .limit(1);
  if (!user) throw new Error('Failed to initialize administrator user');
  await db
    .insert(userRoles)
    .values({ userId: user.id, roleId: role.id })
    .onDuplicateKeyUpdate({ set: { roleId: role.id } });

  // 管理员就绪后再灌菜单 / 权限点与业务初始数据（两者都幂等），最后统一收连接池
  await seedMenus(pool);
  await seedBiz(pool);

  await pool.end();
}

void seed();
