---
title: 后台页面与权限点清单
---

# 后台页面与权限点清单

本页是**后台前端的全量页面清单 + 权限点对照表**，以及「新增一个后台页面」的完整步骤。

- 页面文件：`web/src/views/**/*.vue`（共 **47** 个 `.vue`：26 业务 + 17 基座页面 + 4 隐藏页）
- 菜单与权限点唯一事实来源：`src/database/seed/menus.ts`
- 路由生成逻辑：`web/src/store/permission.ts` + `web/src/router/guard.ts`（见 [后台前端（Vue 3）](/frontend/)）

::: tip 页面 = 菜单行 + `.vue` 文件，两者必须对上
菜单 seed 里的 `component` 字段（如 `biz/service-items/index`）由前端 `import.meta.glob('../views/**/*.vue')` 解析成 `../views/biz/service-items/index.vue`。**文件名 / 目录名不一致 → 路由注册成功但渲染 404 页**。
:::

## 业务页面（26）

顺序 = `BIZ_PAGES` 数组顺序 = 菜单 `sort`。

| #   | 菜单名                   | 路由路径                  | 页面文件                                         | 中文名称   | 页面权限点                 | 按钮权限点                                                                                                                |
| --- | ------------------------ | ------------------------- | ------------------------------------------------ | ---------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 1   | `biz_service_items`      | `/biz/service-items`      | `web/src/views/biz/service-items/index.vue`      | 服务项目   | `biz:serviceitem:list`     | `biz:serviceitem:create` / `:update` / `:delete`                                                                          |
| 2   | `biz_staffs`             | `/biz/staffs`             | `web/src/views/biz/staffs/index.vue`             | 美甲师     | `biz:staff:list`           | `biz:staff:create` / `:update` / `:delete` / `:items`                                                                     |
| 3   | `biz_app_staff_grants`   | `/biz/app-staff-grants`   | `web/src/views/biz/app-staff-grants/index.vue`   | 工作台授权 | `biz:staff:grant`          | 无（一个权限点管整页：列表 + 通过 + 驳回）                                                                                |
| 4   | `biz_schedules`          | `/biz/schedules`          | `web/src/views/biz/schedules/index.vue`          | 排班管理   | `biz:schedule:list`        | `biz:schedule:update`                                                                                                     |
| 5   | `biz_customers`          | `/biz/customers`          | `web/src/views/biz/customers/index.vue`          | 顾客档案   | `biz:customer:list`        | `biz:customer:create` / `:update` / `:delete`                                                                             |
| 6   | `biz_bookings`           | `/biz/bookings`           | `web/src/views/biz/bookings/index.vue`           | 预约管理   | `biz:booking:list`         | `biz:booking:create` / `:update` / `:cancel` / `:arrive` / `:complete` / `:noshow` / `:delete` / `:manageall` / `:adjust` |
| 7   | `biz_member_levels`      | `/biz/member-levels`      | `web/src/views/biz/member-levels/index.vue`      | 会员等级   | `biz:memberlevel:list`     | `biz:memberlevel:create` / `:update` / `:delete`                                                                          |
| 8   | `biz_recharge_plans`     | `/biz/recharge-plans`     | `web/src/views/biz/recharge-plans/index.vue`     | 充值方案   | `biz:rechargeplan:list`    | `biz:rechargeplan:create` / `:update` / `:delete`                                                                         |
| 9   | `biz_card_types`         | `/biz/card-types`         | `web/src/views/biz/card-types/index.vue`         | 次卡卡种   | `biz:cardtype:list`        | `biz:cardtype:create` / `:update` / `:delete`                                                                             |
| 10  | `biz_members`            | `/biz/members`            | `web/src/views/biz/members/index.vue`            | 会员管理   | `biz:member:list`          | `biz:member:update` / `:adjust` / `:recount` / `:recharge` / `:refund` / `:coupon`；`biz:card:issue` / `biz:card:use`     |
| 11  | `biz_member_cards`       | `/biz/member-cards`       | `web/src/views/biz/member-cards/index.vue`       | 会员次卡   | `biz:card:list`            | `biz:card:revoke` / `:refund`                                                                                             |
| 12  | `biz_cashier`            | `/biz/cashier`            | `web/src/views/biz/cashier/index.vue`            | 收银台     | **未单独设权限点**（见下） | `biz:payment:create` / `:close`；`biz:refund:apply`；`biz:receivable:settle`                                              |
| 13  | `biz_payments`           | `/biz/payments`           | `web/src/views/biz/payments/index.vue`           | 支付流水   | `biz:payment:list`         | `biz:payment:reconcile`                                                                                                   |
| 14  | `biz_refunds`            | `/biz/refunds`            | `web/src/views/biz/refunds/index.vue`            | 退款审批   | `biz:refund:list`          | `biz:refund:approve`                                                                                                      |
| 15  | `biz_payment_diffs`      | `/biz/payment-diffs`      | `web/src/views/biz/payment-diffs/index.vue`      | 支付对账   | **未单独设权限点**（见下） | 无（`biz:payment:reconcile` 已挂在「支付流水」下）                                                                        |
| 16  | `biz_credit_accounts`    | `/biz/credit-accounts`    | `web/src/views/biz/credit-accounts/index.vue`    | 挂账主体   | `biz:credit:list`          | `biz:credit:create` / `:update` / `:delete`                                                                               |
| 17  | `biz_receivables`        | `/biz/receivables`        | `web/src/views/biz/receivables/index.vue`        | 应收台账   | `biz:receivable:list`      | `biz:receivable:settle` / `:cancel`                                                                                       |
| 18  | `biz_points_goods`       | `/biz/points-goods`       | `web/src/views/biz/points-goods/index.vue`       | 积分兑换品 | `biz:pointsgoods:list`     | `biz:pointsgoods:create` / `:update` / `:delete`；`biz:points:redeem` / `:revert`                                         |
| 19  | `biz_coupons`            | `/biz/coupons`            | `web/src/views/biz/coupons/index.vue`            | 优惠券模板 | `biz:coupon:list`          | `biz:coupon:create` / `:update` / `:delete`                                                                               |
| 20  | `biz_reviews`            | `/biz/reviews`            | `web/src/views/biz/reviews/index.vue`            | 评价管理   | `biz:review:list`          | `biz:review:create` / `:reply` / `:hide` / `:delete`                                                                      |
| 21  | `biz_reports`            | `/biz/reports`            | `web/src/views/biz/reports/index.vue`            | 报表中心   | `biz:report:view`          | `biz:report:export`                                                                                                       |
| 22  | `biz_commission_rules`   | `/biz/commission-rules`   | `web/src/views/biz/commission-rules/index.vue`   | 提成规则   | **未单独设权限点**（见下） | `biz:commission:rule`                                                                                                     |
| 23  | `biz_commission_records` | `/biz/commission-records` | `web/src/views/biz/commission-records/index.vue` | 提成结算   | `biz:commission:list`      | `biz:commission:settle`                                                                                                   |
| 24  | `biz_recurrences`        | `/biz/recurrences`        | `web/src/views/biz/recurrences/index.vue`        | 周期预约   | `biz:recurrence:list`      | `biz:recurrence:create` / `:update` / `:delete`                                                                           |
| 25  | `biz_notice_templates`   | `/biz/notice-templates`   | `web/src/views/biz/notice-templates/index.vue`   | 通知模板   | `biz:notice:template`      | `biz:notice:send`（`biz:notice:template` 已作页面权限，按钮行被去重跳过）                                                 |
| 26  | `biz_notice_logs`        | `/biz/notice-logs`        | `web/src/views/biz/notice-logs/index.vue`        | 通知记录   | `biz:notice:log`           | 无                                                                                                                        |

### 三个「未单独设权限点」的页面是怎么回事

菜单 seed 的 `buildBizMenus()` 里有一个 `claimed` 集合：

```ts
// src/database/seed/menus.ts:372
// `sys_menu.permission` 有唯一索引（NULL 可重复），同一个权限点只能落在**一行**菜单上。
// 页面级 permission 先占位；若该权限点同时还要作为按钮挂在别的页面上（如
// `biz:payment:reconcile` 既是「支付对账」的入口，又挂在「支付流水」下），
// 页面行让位给按钮行——前端路由靠 role_menu 授权生成，不依赖页面 permission。
const claimed = new Set<string>();
```

具体后果：

| 页面                   | 原本声明的页面权限点    | 实际结果                                                                                                                                        |
| ---------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `biz_cashier`          | 故意留空                | `sys_menu.permission = NULL` —— 资金动作全部由三个按钮权限点控制（`biz:payment:create` / `close`、`biz:refund:apply`、`biz:receivable:settle`） |
| `biz_payment_diffs`    | `biz:payment:reconcile` | 该点已被 **`biz_payments` 的按钮行**占用 → 页面 permission 被清空、按钮行被跳过 → `NULL`                                                        |
| `biz_commission_rules` | 无（注释说明）          | 动作权限是 `biz:commission:rule`（唯一索引下不能与按钮重复）                                                                                    |

::: warning 页面 permission 为 NULL 的影响
前端路由**靠 `role_menu` 授权生成**，不读 `sys_menu.permission`。所以「有菜单授权」的账号就能看到并打开这些页面；页面内的按钮仍需各自的权限点。**安全边界在按钮与后端接口上，不在菜单行上**。
:::

## 基座页面（16 + 2 目录）

目录节点（`type: 'M'`）不生成页面，只作为侧边栏分组：`system`（系统管理，`sort: 2`）、`monitor`（系统监控，`sort: 3`）。`biz`（美甲预约，`sort: 8`）由 `buildBizMenus()` 自动生成。

| #   | 菜单名                   | 路由路径                  | 页面文件                                         | 中文名称             | 权限点                                                                         |
| --- | ------------------------ | ------------------------- | ------------------------------------------------ | -------------------- | ------------------------------------------------------------------------------ |
| 1   | `dashboard`              | `/dashboard`              | `web/src/views/dashboard/index.vue`              | 首页                 | **未单独设权限点**                                                             |
| 2   | `system_users`           | `/system/users`           | `web/src/views/system/users/index.vue`           | 用户管理             | `system:user:list`                                                             |
| 3   | `system_roles`           | `/system/roles`           | `web/src/views/system/roles/index.vue`           | 角色管理             | `system:role:list`                                                             |
| 4   | `system_menus`           | `/system/menus`           | `web/src/views/system/menus/index.vue`           | 菜单管理             | `system:menu:list`                                                             |
| 5   | `system_depts`           | `/system/depts`           | `web/src/views/system/depts/index.vue`           | 部门管理             | `system:dept:list`                                                             |
| 6   | `system_posts`           | `/system/posts`           | `web/src/views/system/posts/index.vue`           | 岗位管理             | `system:post:list`                                                             |
| 7   | `system_dicts`           | `/system/dicts`           | `web/src/views/system/dicts/index.vue`           | 字典管理             | `system:dict:list`                                                             |
| 8   | `system_configs`         | `/system/configs`         | `web/src/views/system/configs/index.vue`         | 参数配置             | `system:config:list`                                                           |
| 9   | `system_stores`          | `/system/stores`          | `web/src/views/system/stores/index.vue`          | 门店管理（连锁直营） | `system:store:list`（+ create/update/delete、`system:store:all` = 看全部门店） |
| 10  | `monitor_login_logs`     | `/monitor/login-logs`     | `web/src/views/monitor/login-logs/index.vue`     | 登录日志             | `monitor:loginlog:list`                                                        |
| 11  | `monitor_operation_logs` | `/monitor/operation-logs` | `web/src/views/monitor/operation-logs/index.vue` | 操作日志             | `monitor:operlog:list`                                                         |
| 12  | `monitor_online`         | `/monitor/online`         | `web/src/views/monitor/online/index.vue`         | 在线用户             | `monitor:online:list`                                                          |
| 12  | `monitor_cache`          | `/monitor/cache`          | `web/src/views/monitor/cache/index.vue`          | 缓存监控             | `monitor:cache:list`                                                           |
| 13  | `jobs`                   | `/jobs`                   | `web/src/views/jobs/index.vue`                   | 定时任务             | `system:job:list`                                                              |
| 14  | `files`                  | `/files`                  | `web/src/views/files/index.vue`                  | 文件管理             | `system:file:list`                                                             |
| 15  | `generator`              | `/generator`              | `web/src/views/generator/index.vue`              | 代码生成器           | `system:generator:list`                                                        |
| 16  | `ai`                     | `/ai`                     | `web/src/views/ai/index.vue`                     | AI 操作              | `ai:chat`                                                                      |

## 隐藏页（4）

这些页面**不在菜单里**，靠 `constantRoutes` 静态注册（`web/src/router/index.ts`）：

| 路由路径           | 页面文件                          | 中文名称   | 说明                                                          |
| ------------------ | --------------------------------- | ---------- | ------------------------------------------------------------- |
| `/login`           | `web/src/views/login/index.vue`   | 登录       | 白名单路由（`WHITE_LIST = ['/login']`）                       |
| `/profile`         | `web/src/views/profile/index.vue` | 个人中心   | `layout` 的静态子路由                                         |
| `/403`             | `web/src/views/error/403.vue`     | 无权限     |                                                               |
| `/:pathMatch(.*)*` | `web/src/views/error/404.vue`     | 页面不存在 | 兜底路由；动态路由的 `component` 解析失败时也 fallback 到这里 |

::: tip 详情页 / 抽屉不单独建路由
项目的做法是**列表页内用弹窗 / 抽屉**承载详情，例如「美甲师可做项目」放在 `biz/staffs` 详情抽屉里用多选项目组件维护（整体 `PUT`），不单独建页、不单独设权限点（用 `biz:staff:items`）。
:::

## 菜单与路由生成规则

### 三类节点

| `type` | 含义 | 前端处理                                             |
| ------ | ---- | ---------------------------------------------------- |
| `M`    | 目录 | 无 `component` → 只作布局容器；在侧边栏是分组标题    |
| `C`    | 页面 | 有 `component` / `path` → 生成路由                   |
| `F`    | 按钮 | **不生成路由**；`toRouteRecord()` 直接 `return null` |

```ts
// web/src/store/permission.ts:21
function toRouteRecord(node: RouteNode): RouteRecordRaw | null {
  if (node.type === 'F') return null;
  const children = node.children.map(toRouteRecord).filter(...);
  const isLeaf = children.length === 0;
  const component = resolveComponent(node.component);
  // 目录节点：无 component，仅作为布局容器
  if (!isLeaf && !component) return { path: node.path ?? `/${node.name}`, name: node.name, meta: {...}, children };
  ...
}
```

侧边栏由 `toSidebarItems()` 从同一棵树生成，过滤掉 `type === 'F'` 与 `meta.visible === false` 的节点。

### seed 的幂等策略

```ts
// src/database/seed/menus.ts:8
/**
 * 幂等策略：按 `name` 查已有行 → 有则改（改前逐字段比对，值没变不发 UPDATE）、无则插；
 * 重复执行不产生重复行；角色授权只补缺失项，不清掉运营已分配的其它菜单。
 */
```

- 菜单唯一键是 **`name`**（如 `biz_service_items`），不是 `path`；
- `upsertMenus()` 逐字段比对（`parentId` / `title` / `type` / `path` / `component` / `permission` / `icon` / `sort` / `visible` / `cacheable` / `external` / `status` / `deletedAt`），**值没变不发 UPDATE**；
- 按钮行的 `name` 由权限点推导：`permission.slice('biz:'.length).replace(/:/g, '_')` → `biz:payment:create` ⇒ `biz_payment_create`；
- `grantAdminMenus()` **只补缺失授权，不删已有授权**（不会清掉运营给其它角色分配的菜单）。

## 新增一个后台页面：完整清单

以「新增一个『储值流水』页面，路径 `/biz/balance-logs`，只读」为例。

### 第 1 步：建页面文件

新建 `web/src/views/biz/balance-logs/index.vue`。**目录名必须与菜单 `component` 前缀一致**（`biz/balance-logs/index`）。

```vue
<script setup lang="ts">
import type { LewTableColumn } from 'lew-ui';
// useTable 自动导入（vite.config.ts 的 AutoImport dirs 含 ./src/composables）
const { items, loading, currentPage, pageSize, total, search, handleChange } =
  useTable<BalanceLog>({ url: '/biz/member-transactions' });
</script>
```

### 第 2 步：加 API 模块

新建 `web/src/api/biz/balance-logs.ts`：

```ts
import type { PageResult } from '~/types/api';
import { get } from '~/request';

export interface BalanceLog {
  id: number;
  customerId: number;
  amount: number;
  createdAt: string;
}

export function listBalanceLogs(
  page = 1,
  pageSize = 20,
  query: Record<string, unknown> = {},
) {
  return get<PageResult<BalanceLog>>('/biz/member-transactions', {
    page,
    pageSize,
    ...query,
  });
}
```

（`web/src/api/biz/*.ts` 是每个业务域一个文件，命名与页面目录对应。）

### 第 3 步：加菜单 seed

在 `src/database/seed/menus.ts` 的 `BIZ_PAGES` 数组里追加一项。**位置决定菜单 `sort`**，`path` / `component` 必须与磁盘一致：

```ts
{
  name: 'biz_balance_logs',
  title: '储值流水',
  path: '/biz/balance-logs',
  component: 'biz/balance-logs/index',
  icon: 'cache',
  permission: 'biz:balance:list',
  permissions: [{ resource: 'biz:balance', actions: ['export'] }],
},
```

### 第 4 步：加权限点

权限点**不需要单独建表**：`sys_menu` 里每个 `F` 行就是一条权限点，`buildBizMenus()` 会自动展开：

```
permission: 'biz:balance:list'                          → 页面行（type: C）
{ resource: 'biz:balance', actions: ['export'] }        → 按钮行 `biz:balance:export`（type: F）
```

后端接口上也必须声明**同一个字符串**：

```ts
@Get()
@RequirePermissions('biz:balance:list')
list(@Query() raw: Record<string, unknown>) { ... }
```

::: danger 字符串必须逐字一致
`biz:balance:list` ≠ `biz:balance:lists` ≠ `bizBalance:list`。约定是**全小写、冒号分段、不用驼峰**。后端用 `RequirePermissions` 校验，前端用 `hasPermission` 校验，两边读的是同一个字符串。
:::

### 第 5 步：加按钮级 `v-permission`

```vue
<IconButton
  v-permission="'biz:balance:export'"
  title="导出"
  @click="handleExport"
/>
```

或用 `<IconButton permission="biz:balance:export" />`（`web/src/components/IconButton.vue` 内置了 `v-permission="permission"`）。

### 第 6 步：重新执行菜单 seed

```bash
bun run db:seed:menus
```

（脚本定义在根 `package.json`：`"db:seed:menus": "bun src/database/seed/menus.ts"`。）

::: warning 跑完 seed 还需要给角色授权
`grantAdminMenus()` 只给 **admin 角色**补新菜单。其它角色要去「角色管理」页面手工勾上新菜单（或直接改 `sys_role_menu`）。**菜单没授权 → 路由不会生成 → 直接输入 URL 会命中 404 兜底**。
:::

### 第 7 步：验收

- [ ] 菜单树新节点出现，侧边栏能点到；
- [ ] **刷新页面不丢当前路由**（`guard.ts` 重新注册动态路由后按 path 重解析）；
- [ ] 无该权限点的账号看不到按钮（`v-permission` 会移除元素）；
- [ ] 列表分页 / 筛选 / 空态正常（`useTable` 的 `hasMore` 估算生效）；
- [ ] 若页面有表单：`formOptions` 包了 `withPassThroughRule`，控制台无 `The schema does not contain the path: xxx`；
- [ ] 若页面有金额 / 时间：走 `yuan2fen` / `centsToYuan` 与 `formatDateTime`，抽查一笔跨日、一笔带折扣、一笔混合支付。

## 相关页面

- 前端技术栈与请求层 / 路由 / 列表模式：[后台前端（Vue 3）](/frontend/)
- 后端权限点实现：[鉴权 · RBAC · 数据权限](/backend/auth-rbac)
- 菜单与权限点速查：[权限点与菜单清单](/appendix/permissions)
