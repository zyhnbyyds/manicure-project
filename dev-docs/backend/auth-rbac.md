---
title: 鉴权 · RBAC · 数据权限
---

# 鉴权 · RBAC · 数据权限

本站有**两个互不通用**的 token 域：后台 `sys_user` 域与小程序 `app_` 域。后台走 RBAC + 数据权限；app 域**不接 RBAC**，只有「本人数据」。

## 一、双 JWT 域

| 维度     | 后台域                                       | app 域（`/api/v1/app/**`）        |
| -------- | -------------------------------------------- | --------------------------------- |
| 身份主体 | `sys_user`                                   | `app_wx_user`（openid 唯一）      |
| 签发     | `AuthService.issueTokens()`                  | `AppAuthService.login()`          |
| 守卫     | `AccessTokenGuard`（`APP_GUARD`，默认全局）  | `AppAccessTokenGuard`（路由级）   |
| payload  | `sub` / `username` / `permissions` / `roles` | `sub` / `openid` / `scope: 'app'` |
| RBAC     | 有（权限点字符串）                           | **无**                            |
| 刷新令牌 | 有（`sys_refresh_token`，一次性轮换）        | 无（重登即换新 token）            |

### 双向拒绝是怎么实现的

两个守卫**共用** `JWT_ACCESS_SECRET` / `JWT_ISSUER` / `JWT_AUDIENCE`，靠 **payload 形态**区分，而不是靠两把秘钥：

```ts
// src/modules/app/auth/app-access-token.guard.ts（精简）
const { payload } = await jwtVerify(
  token,
  new TextEncoder().encode(config.jwt.JWT_ACCESS_SECRET),
  {
    issuer: config.jwt.JWT_ISSUER,
    audience: config.jwt.JWT_AUDIENCE,
  },
);
if (payload.scope !== 'app') throw new UnauthorizedException(); // 后台 token → 401
const id = Number(payload.sub);
if (!Number.isSafeInteger(id) || typeof payload.openid !== 'string')
  throw new UnauthorizedException();
request.appUser = { id, openid: payload.openid };
```

反向由 `AccessTokenGuard` 天然完成——它要求 `typeof payload.username === 'string'`，而 app token **故意不含 `username`**：

```ts
// src/common/auth/access-token.guard.ts（精简）
const id = Number(payload.sub);
if (!Number.isSafeInteger(id) || typeof payload.username !== 'string')
  throw new UnauthorizedException();
request.user = { id, username: payload.username, permissions, roles };
```

::: danger 不要为了「顺手」改这两个守卫
改任何一侧的 payload 契约都要同时确认另一侧仍然拒绝。这正是「app token 能打后台接口」这类越权事故的唯一防线。
:::

### app Controller 必须标 `@Public()`

根模块注册的全局 `AccessTokenGuard` **先于**路由级守卫执行。因此 `src/modules/app/**` 的 Controller 全部标 `@Public()` 跳过后台守卫，再由 `AppAccessTokenGuard` 做真正的鉴权：

```ts
@Public()
@Controller('app/catalog')
@UseGuards(AppAccessTokenGuard)
export class AppCatalogController {
  /* … */
}
```

## 二、登录流程（后台域）

```
POST /api/v1/auth/login  { username, password }
  └─ AuthService.login()
       1. 查 sys_user（deleted_at IS NULL）+ status='active'
       2. Bun.password.verify(password, user.password_hash)   // argon2id
       3. 失败 → 写 sys_login_log(status='failure') → 401「用户名或密码错误」
       4. 成功 → 写 sys_login_log、回填 login_at / login_ip
       5. issueTokens()：签名 access + refresh，落 sys_refresh_token
       6. OnlineService.track()：Redis 写在线会话（TTL = refresh TTL）
```

密码哈希（`src/common/password/password.service.ts`）：

```ts
export function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password, { algorithm: 'argon2id' });
}
export function verifyPassword(
  password: string,
  hash: string,
): Promise<boolean> {
  return Bun.password.verify(password, hash);
}
```

### access / refresh 双 token

`JWT_ACCESS_TTL` 默认 `15m`，`JWT_REFRESH_TTL` 默认 `7d`（`src/config/app-config.service.ts`）。两者都用 `jose` 的 `SignJWT` 签 HS256，带 `issuer` / `audience`：

```ts
private async sign(payload, secret, expiresIn) {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setIssuer(this.config.jwt.JWT_ISSUER)
    .setAudience(this.config.jwt.JWT_AUDIENCE)
    .setExpirationTime(expiresIn)
    .sign(new TextEncoder().encode(secret));
}
```

**access token 带权限快照**（`permissions` + `roles`），所以授权改动要等下一次刷新/重登才生效——这是刻意的取舍：守卫不再每次请求查库。

### refresh token 的存储与轮换

- 表：**`sys_refresh_token`**（drizzle 变量 `refreshTokens`）。
- 存的是 **`token_hash`**（`sha256`），不是明文。
- **一次性轮换**：`AuthService.refresh()` 校验通过后立刻把旧行置 `revoked_at`，再签发一对新 token。

```ts
// refresh 的轮换：先吊销旧的，再签发新的
await db
  .update(refreshTokens)
  .set({ revokedAt: new Date() })
  .where(eq(refreshTokens.id, stored.id));
return this.issueTokens(user.id, user.username);
```

- refresh token payload 里带 **`jti: randomUUID()`**：

```ts
const refreshToken = await this.sign(
  { sub: claims.sub, jti: randomUUID() },
  this.config.jwt.JWT_REFRESH_SECRET,
  this.config.jwt.JWT_REFRESH_TTL,
);
```

::: warning 为什么必须有 `jti`
HS256 + `iat` 只有秒级精度：同一用户**同一秒内连续登录**会签出**完全相同**的 refresh token，`sys_refresh_token.token_hash` 的唯一索引直接冲突。这是踩过的坑。
:::

### 前端 401 自动刷新

web 侧在 `web/src/request.ts`：401 → 调 `/auth/refresh` → 重放原请求一次；`/auth/login`、`/auth/refresh`、`/auth/register` 在 `NO_REFRESH_URLS` 里，不参与自动刷新。

`refreshOnce()` 做了三件防护：**并发去重**（`let refreshing: Promise<string> | null`）、**从 localStorage 重读最新 refresh token**（多标签页下内存态可能已被别的标签页轮换掉）、**轮换竞态重试**。

### 登出与强制下线

| 动作     | 接口                                 | 实现                                                                                                   |
| -------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| 登出     | `POST /auth/logout`                  | `AuthService.logout()`：吊销该 refresh token 行 + `OnlineService.remove(userId)`                       |
| 强制下线 | `OnlineForceLogoutTool` / 在线用户页 | `OnlineService.forceLogout(userId)`：删在线会话 + 把该用户**全部**未吊销 refresh token 置 `revoked_at` |

```ts
// src/modules/monitor/online/online.service.ts
async forceLogout(userId: number): Promise<void> {
  await this.remove(userId);
  await this.database.db.update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));
}
```

::: tip 强制下线不是「立即踢掉」
access token 是无状态的，强制下线**只让 refresh 失效**。对方手上的 access token 在 `JWT_ACCESS_TTL`（默认 15 分钟）内仍然可用。要更短窗口就调小 `JWT_ACCESS_TTL`。
:::

清理任务：`cleanExpiredRefreshTokens` handler 删除 `expires_at < now` 或已吊销的行。

## 三、RBAC 模型

```
sys_user ──< sys_user_role >── sys_role
                                  │
                                  └──< sys_role_menu >── sys_menu（type: M/C/F）
sys_role ──< sys_role_dept >── sys_dept（data_scope='custom' 时生效）
```

| 表              | drizzle 变量 | 要点                                                                                                |
| --------------- | ------------ | --------------------------------------------------------------------------------------------------- |
| `sys_user`      | `users`      | `dept_id`、`status`、`password_hash`                                                                |
| `sys_role`      | `roles`      | `role_key` 唯一、`data_scope`、`is_system`                                                          |
| `sys_menu`      | `menus`      | `type` ∈ `M`(目录) / `C`(页面) / `F`(按钮)、`permission` 唯一、`visible` / `cacheable` / `external` |
| `sys_user_role` | `userRoles`  | 联合主键                                                                                            |
| `sys_role_menu` | `roleMenus`  | 联合主键                                                                                            |
| `sys_role_dept` | `roleDepts`  | `data_scope='custom'` 时的部门白名单                                                                |

### 权限点命名规范

- 各段**全小写、不用驼峰**：`biz:serviceitem:list`（对齐既有 `monitor:loginlog:list`）。
- 三段式：`域:资源:动作`。资源段是「模块英文名的紧密小写」（`serviceitem` / `memberlevel` / `rechargeplan` / `cardtype`）。
- **列表权限同时是页面的 `list` 权限**；动作权限平级追加（`create` / `update` / `delete` / `arrive` / `complete` / `noshow` / `cancel` / `adjust` / `manageall`）。
- 超级管理员用通配 `*:*:*`（`roles.is_system = true` 或 `role_key = 'admin'` 时由 `AuthService.getClaims()` 直接下发）。

```ts
// src/modules/auth/auth.service.ts（getClaims 精简）
const isSuperAdmin = assignments.some(
  (item) => item.isSystem || item.key === 'admin',
);
const resolved = isSuperAdmin
  ? ['*:*:*']
  : permissions.flatMap((item) => (item.permission ? [item.permission] : []));
```

`AccessTokenGuard` 判定时也认通配：

```ts
!required.some(
  (permission) =>
    request.user?.permissions.includes(permission) ||
    request.user?.permissions.includes('*:*:*'),
);
```

### 菜单 seed 驱动前端路由

1. `src/database/seed/menus.ts` 声明全部菜单树与权限点（类型 `BizPageSeed`：`name` / `title` / `path` / `component` / `icon` / `permission` / `permissions[]`）。
2. 用户登录后前端调 `GET /api/v1/system/menus/routes`（`MenusController.routes()` → `MenusService.routes(userId)`），返回**只含 `M` / `C` 且 `status='active'`** 的树。
3. 前端据 `component` 动态生成路由，据 `permission` 做按钮级 `v-permission`。

```ts
// src/modules/system/menus/menus.service.ts（精简）
const isSuperAdmin = assignments.some((item) => item.isSystem);
const conditions = [
  isNull(menus.deletedAt),
  eq(menus.status, 'active'),
  inArray(menus.type, ['M', 'C']),
];
// 非超管：innerJoin sys_role_menu，只返回被授权的菜单
return buildTree(dedupeById(rows)).map(toRouteNode);
```

按钮级权限的用法（web）：

```vue
<LewButton v-permission="'biz:serviceitem:create'">新增</LewButton>
```

::: warning 菜单可见性 ≠ 接口可达性
`routes` 只影响前端**画不画**这个菜单；真正的拦截在 `AccessTokenGuard` 的 `@RequirePermissions`。给角色勾了菜单但漏勾某个动作权限，页面能打开、按钮点了 401。
:::

### 新增一个页面要同步哪些 seed 条目

在 `src/database/seed/menus.ts` 里补**一条 `BIZ_PAGES` 记录**（它就是那一页的全部 seed）：

| 要填的字段      | 说明                                                                                                                                 |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `name`          | 菜单唯一 name，子菜单与按钮的 `parentKey` 都指向它                                                                                   |
| `title`         | 中文页名                                                                                                                             |
| `path`          | 路由 path（如 `/biz/service-items`），**必须与前端路由一致**                                                                         |
| `component`     | 组件路径（如 `biz/service-items/index`），**必须与 `web/src/views/` 下的实际文件一致**                                               |
| `icon`          | 图标名                                                                                                                               |
| `permission`    | 该页 `list` 权限点；**留空则该页对「有菜单授权」的账号直接可见**                                                                     |
| `permissions[]` | 该页挂的按钮权限：`{ resource: 'biz:xxx', actions: ['create','update',…] }`，每个 action 会展开成 `biz:xxx:action` 的 `F` 类型菜单行 |

然后：

```bash
bun run db:seed:menus      # 幂等：按 name 查已有行 → 有则改、无则插
```

对应的前端侧还要落两件事（不在 seed 里）：`web/src/views/<component>.vue` 文件、`web/src/api/biz/*.ts` 接口封装。若该页需要按钮权限，Vue 里用 `v-permission="'biz:xxx:yyy'"`。

## 四、数据权限（data scope）

实现在 `src/common/data-scope/data-scope.ts`，解析规则（对齐若依）：

```
超管（*:*:*）或无任何角色 → { kind: 'all' }
任一角色 data_scope='all'  → { kind: 'all' }
否则取并集（宽松优先）：
  custom           → sys_role_dept 里该角色勾选的部门
  dept             → 本人 sys_user.dept_id
  dept_and_children→ 本人部门 + 其所有下级（按 sys_dept.ancestors 路径匹配）
  没有任何部门范围   → { kind: 'self' }
```

```ts
// src/common/data-scope/data-scope.ts（精简）
const scopes = roleRows.map((row) => row.dataScope);
if (scopes.includes('all')) return { kind: 'all' };
const needDeptScope = scopes.some(
  (s) => s === 'custom' || s === 'dept' || s === 'dept_and_children',
);
if (!needDeptScope) return { kind: 'self' };
// …收集 ids 后
return { kind: 'deptIds', ids: [...new Set(ids)] };
```

### 在查询里怎么生效

以预约列表为例（`src/modules/biz/booking/bookings.service.ts`）。**先判「是否受美甲师身份限制」，否则回落到通用数据权限**：

```ts
private async resolveScope(actor: RequestActor): Promise<BookingScope> {
  const staff = await this.staffs.findByUserId(actor.id);
  if (staff && !this.hasPermission(actor, 'biz:booking:manageall'))
    return { kind: 'staff', staffId: staff.id };
  const scope = await resolveDataScope(this.database.db, actor);
  if (scope.kind === 'deptIds') return { kind: 'deptIds', ids: scope.ids };
  return { kind: scope.kind };
}

private async scopeConditions(scope: BookingScope, actor: RequestActor): Promise<SQL[]> {
  if (scope.kind === 'staff') return [eq(bizBookings.staffId, scope.staffId)];
  if (scope.kind === 'self') return [eq(bizBookings.createdBy, actor.id)];
  if (scope.kind === 'deptIds') {
    if (!scope.ids.length) return [sql`1 = 0`];        // 空范围 → 查不到任何数据
    return [inArray(bizBookings.createdBy,
      this.database.db.select({ id: users.id }).from(users).where(inArray(users.deptId, scope.ids)))];
  }
  return [];
}
```

详情接口另外用 `assertBookingVisible()` 逐单判定，不满足抛 **403**。

### 绕过方式与禁忌

| 方式                             | 说明                                      | 允许？                                |
| -------------------------------- | ----------------------------------------- | ------------------------------------- |
| `biz:booking:manageall`          | 显式权限点，绕过美甲师自身限制            | 允许，但要审慎授予                    |
| `*:*:*` 超管                     | `getClaims()` 下发                        | 只给 `admin` 角色                     |
| 不传 `actor` 调 `findOne(id)`    | 签名里 `actor?` 可选                      | **仅限 app 域**（改用「本人」硬限定） |
| 在 app 域复用 `resolveDataScope` | app 域没有 `sys_user`，套上去得到错的范围 | **禁止**（代码注释已明确）            |

::: danger app 域的数据边界
小程序端**不接 RBAC**，所有查询强制 `customer_id = 当前绑定顾客`。`BookingsService.findForCustomer()` 刻意**不区分 403**——查不到就是 404，否则会泄露「这个 id 存在、只是不属于你」。
:::

## 五、公开端点白名单

`@Public()` 跳过全局 `AccessTokenGuard` 的位置如下（全量）：

| 端点                                                            | 安全补偿                                                |
| --------------------------------------------------------------- | ------------------------------------------------------- |
| `POST /auth/login`、`POST /auth/register`、`POST /auth/refresh` | 密码校验 / refresh token 哈希比对 + jwtVerify           |
| `POST /biz/payments/notify/wxpay`                               | 微信支付 V3 **验签**（用 `rawBody` 原样报文）+ 幂等     |
| `POST /biz/payments/notify/alipay`                              | 支付宝 RSA 验签 + `app_id` 比对 + 幂等                  |
| `GET /api/v1/app/**`（app 域全部）                              | `AppAccessTokenGuard`（除登录与回调）                   |
| `POST /app/payments/wxpay/jsapi` 回调类                         | 同微信验签                                              |
| `GET /health`                                                   | 无状态探针                                              |
| `GET /files/:id/download`                                       | 见 `src/modules/files/files.controller.ts` 的路由级校验 |

回调的写法（`src/modules/biz/payment/payments/payments.controller.ts`）：

```ts
@Post('notify/wxpay')
@Public()
@ApiOperation({ summary: '微信支付回调（公开端点，自行验签 + 幂等）' })
async notifyWxpay(@Req() request: NotifyRequest, @Res() reply: FastifyReply) {
  const result = await this.payments.handleNotify('wxpay_native', {
    headers: request.headers,
    body: request.body,
    rawBody: request.rawBody,     // ← 必须原样报文
  });
  reply.status(result.statusCode).header('content-type', 'application/json; charset=utf-8').send(result.body);
}
```

::: danger 公开端点三条铁律

1. **必须有验签**：`@Public()` 只表示「跳过 access token」，不表示「不需要证明身份」。回调的真伪由**渠道签名**保证。
2. **必须幂等**：回调会重复投递。落地靠条件更新 + 唯一键，重复回调返回渠道要求的应答体而不重复记账。
3. **不要给公开端点加 RBAC 依赖**：它们跑在 `request.user` 为空的前提下，任何读 `request.user.id` 的代码都会炸。

限流方面：全局 `max: 100 / 1 minute`；app 域登录另收紧（见 [小程序 app 域实现](/backend/app-domain)）。
:::

## 延伸阅读

- [后端分层与请求链路](/backend/) —— 守卫/拦截器在链路中的位置
- [小程序 app 域实现](/backend/app-domain) —— app 域登录与手机号绑定
- [权限点与菜单清单](/appendix/permissions) —— 全量权限点
