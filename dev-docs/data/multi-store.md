---
title: 多店（连锁直营）改造现状
---

# 多店（连锁直营）改造现状

> 口径来源：用户 2026-09-13 决策「**连锁直营模式**」+「每个门店店长只可以看到自己门店的订单预约等信息，
> 超级管理员可以看到所有预约信息，也可以按照门店去筛选查询对应的各种信息」。
>
> 假设（**未经确认，改起来最贵**）：**会员资产全店通兑** —— 储值余额 / 积分 / 次卡 / 券全店通用，
> 但「这笔钱/这次服务发生在哪家店」必须落在单据上。若实际要「按店独立资产」，见文末「阶段 2」。

## 一句话现状

**阶段 0 / 1 / 1.5 / 1.6 / 1.7 / 1.8 已完成**：门店是实体、单据带门店、按账号的门店范围过滤与筛选、
门店管理页与用户门店授权、**顶栏门店切换器（列表筛选与写入落店一起走）**、
**报表按店（营收 / 单量 / 项目 / 美甲师 / 应收 / 次卡核销）**都已生效；
**小程序选店、支付多商户号尚未做**（见「还没做」）。

## 已落地

### 阶段 0：门店成为实体（commit `404932d`）

- 新表 `sys_store`：编码（唯一）/ 名称与英文副标题 / 电话 / 地址 / 营业时间 / 经纬度 /
  公告 / 时区（先留空）/ 状态 / 排序 / `is_default`。
- 门店信息原本散在 `sys_config` 的 `biz.shop.*` 里（一个 `config_key` 只能存一份值 = 单店假设）。
- 迁移把现存单店配置落成一条「默认门店」；seed 只补空字段（**不覆盖运营改过的值**）。
- `GET /app/shop` 改读门店表，字段为空回落 `biz.shop.*`；返回里多了 `storeId` / `storeCode`。
- 服务层三条规则：**第一条门店自动成为默认**、**默认唯一**（事务清旧+置新）、**默认门店不可删**。

### 阶段 1：单据带门店 + 门店范围（本次）

| 表                       | 新列                     | 继承口径                                                                             |
| ------------------------ | ------------------------ | ------------------------------------------------------------------------------------ |
| `biz_booking`            | `store_id` NOT NULL + FK | 建单时定：请求显式 `storeId` → 账号当前门店 → 默认门店                               |
| `biz_booking_recurrence` | `store_id` NOT NULL + FK | 规则建的时候定；**生成出来的预约继承规则**（生成任务没有操作人）                     |
| `biz_payment`            | `store_id` NOT NULL + FK | **跟单据走**：有 `bookingId` 继承预约；充值等无单据场景用 `draft.storeId` 或默认门店 |
| `biz_refund`             | `store_id` NOT NULL + FK | 跟随原支付单（钱收在哪家店就退在哪家店）                                             |
| `biz_receivable`         | `store_id` NOT NULL + FK | 有 `bookingId` 继承预约，否则默认门店                                                |
| `sys_user_store`         | 账号 ↔ 可见门店          | 迁移把现存账号全部绑到默认门店（保持升级前后行为一致）                               |

**范围与筛选**（`src/common/data-scope/store-scope.ts`）：

```ts
resolveStoreScope(db, actor, requestedStoreId?)   // 范围 + 当前门店 + 切换器选中的门店
requireCurrentStoreId(db, actor, requestedStoreId?) // 写入用，拿不到就 403
storeConditions(column, context, requestedStoreId?) // 列表 where 片段（含切换器选中的门店）
listVisibleStores(db, actor)                       // 我可见的门店（GET /stores/mine 用）
```

> 阶段 1.7 起 `storeConditions` 第一个业务参数从 `scope` 换成整个 `StoreContext` ——
> 它要同时看「范围」和「切换器选中的门店」，只传 `scope` 就得每个调用点自己判一次（迟早漏）。

| 账号                                | 看到什么             | 能筛选吗                                     |
| ----------------------------------- | -------------------- | -------------------------------------------- |
| 超管（`*:*:*`）/ `system:store:all` | 全部门店             | 能，`?storeId=N`                             |
| 分到门店的普通账号                  | 只有分给它的门店     | 只能在可见范围内筛（筛别的店 → 403）         |
| 没分到门店的普通账号                | 什么业务数据都看不到 | —— 请求直接 **403 + 明确原因**（不是空列表） |

**为什么这样而不是塞进 JWT**：与 `resolveDataScope` 同一取舍 —— 权限/门店调整后**立刻生效**，
不必等用户重新登录换 token。

### 阶段 1.5：能真正用起来的管理端（本次）

- **门店管理页** `web/src/views/system/stores/index.vue`（`/system/stores`）：列表 + 新增/编辑 +
  设为默认（星标）+ 软删；权限点 `system:store:list|create|update|delete`，
  `system:store:all` 是**数据范围开关**（拥有它 = 看得到全部门店并可筛选）。
  菜单与权限点写进 `seed/menus.ts`（页面 + 4 个按钮 + 用户管理的「设置可见门店」按钮）。
- **用户 → 门店授权**：`GET/PUT /system/users/:id/stores`（整体替换，空数组 = 取消全部），
  权限点 `system:user:store`；用户列表新增「可见门店」列（一次查询避免 N+1），
  未分配时**红色提示「未分配（看不到业务数据）」**而不是 `-`（那是新店长账号什么都看不到的常见原因）。
  授权弹窗先等门店选项就绪再打开 —— lew-ui 多选会把 `options` 快照进内部状态，
  选项晚到会让回填的已选项不显示。

### 阶段 1.6：收款 / 退款 / 应收列表也能按门店筛

- 三个列表（`/biz/payments`、`/biz/refunds`、`/biz/receivables`）加 `?storeId=`，
  并传操作人给 service：**店长只看本店**、超管可筛任意门店、筛别家 403 ——
  与预约列表**同一套 `resolveStoreScope` / `storeConditions` 口径**，不是各写一份。
- `storeConditions(column, scope, requestedStoreId?)` 已按「传入列」通用化，
  所以再接别的单据表（次卡核销、资产流水）只是加一行 where。
- 覆盖：`b9-store-scope` 增 1 例（该文件 6 例全绿）——真实链路建两笔现金收款（A/B 店各一），
  验店长只见本店、超管两笔都在且可按门店筛、店长筛别家 403、应收列表同口径不报错。

### 阶段 1.7：门店切换器（web 顶栏）

「当前门店」做成**请求级上下文**，而不是各页面各拼一遍 `?storeId=`：

```
顶栏切换器 → pinia storeScope.activeStoreId（持久化 localStorage）
           → request.ts 拦截器统一发请求头 x-store-id
           → AccessTokenGuard 解析进 request.user.storeId
           → resolveStoreScope：显式传参 → actor.storeId → 默认门店
             ├─ 列表：storeConditions 按它筛选
             └─ 写入：requireCurrentStoreId 按它落店
```

- **为什么走请求头而不是每个接口加参数**：门店是横切的 —— 列表要按它筛、新建单据要按它落店。
  逐个接口拼 `storeId` 迟早漏一个，而漏的那一个就是「在 B 店建单落到 A 店」这种最难查的脏数据。
  改在拦截器一处，77 个调用点**一行没动**。
- **为什么还是不复用 JWT**：与 `resolveDataScope` 同一取舍 —— 切门店/改授权立刻生效，
  不用等重新登录换 token；服务端每次都按 `sys_user_store` 复核，头本身不是权限。
- **可见性复核**：头里的门店不可见时**静默忽略**（回落到「没选」），因为那不是用户的显式请求，
  常见于「授权刚被收回」「换台机器还留着上次的选择」；显式 `?storeId=` 不可见仍然 403。
- `GET /stores/mine`（登录即可，**不要求** `system:store:list`：店长也要看得到自己门店的名字）
  返回 `{ scope: all|stores|none, activeStoreId, stores[] }`；未分配门店时返回 `scope: 'none'` +
  顶栏常驻「未分配门店」提示，而不是每翻一页弹一次错误框。
- **单店期无感**：切换器只在可见门店 > 1 时渲染，库里只有一家店时顶栏不会多出这个控件。
- 刷新后的跟随：`useTable` 监听 `activeStoreId` 自动重载（35 个列表页零改动），
  收银台队列单独接了一次（它不是 `useTable`）。切「全部门店」时不发这个头，口径回到升级前。

### 阶段 1.8：报表按店（+ 会员资产的口径边界）

报表接口接上**同一套门店上下文**（显式 `?storeId=` → 切换器 `x-store-id` 头 → 可见范围）：

- **能按店**：营收 / 退款 / 单量 / 客单价 / 新客回头客 / 项目排行 / 美甲师（单量、分摊营收、提成、评分）/
  应收账龄 / 次卡核销。提成记录（`biz_commission_record`）与评价（`biz_review`）自己没 `store_id`，
  靠 `booking_id` 顺到预约门店 —— 这两处是子查询，而且**不筛门店时不加条件**
  （不写成 `inArray(bookingId, 全部预约 id)`：等价，但白跑一次全表子查询）。
- **恒为全店口径**：储值充退 / 期末结存 / 积分 / 新增会员 / 次卡发售 —— 这些表根本没有门店列
  （余额是全店通兑的一个池子），按店切分只会得出「A 店余额」这种不存在的概念。
  前端在概览卡片打「全店」标签、会员页签顶部给一句说明 —— **口径不标注比数字算错更坑**。
- **店长不传参数也只统计本店**：这是数据权限，不是筛选。`b10-report-store` 把这条钉住了 ——
  店长（绑 B）不带 `storeId` 请求 `/reports/overview`，营收只算 B；显式筛别家 → 403。

顺带修了报表页三个**既有**问题（不修的话「按店」根本看不出来）：

1. 前端概览按**扁平键名**读后端的**分组结构** → 一个数字都显示不出来（`reportScalars` 现在递归展平，
   标量与明细行统一用 `revenue.net` / `buckets.0-30` 这种点号路径）；
2. 「会员」页签被配成 summary 模式，而后端返回的是**数组** → 永远显示「没有数据」（改为表格）；
3. `LewTabs` 的 `@change` 在 lew-ui 2.8.2 里**恒不触发**（内部先把本地值同步成新值、再比较旧新值），
   所以会出现「页签高亮切了、内容没变」—— 改用 `v-model` + `watch` 驱动。

## 还没做（按建议顺序）

1. **会员资产按店**：报表里「储值充退 / 结存 / 积分 / 新增会员 / 次卡发售」仍是**全店口径**，
   因为 `biz_member_transaction` / `biz_customer` / `biz_member_card` 都没有门店列（资产全店通兑）。
   要让它们也按店，得先给这些表补 `store_id`（写入点十几个，且「资产是否通兑」这个前提要先确认）——
   即文末「阶段 2」的前置。
2. **小程序选店**：`GET /app/shops`（列表）+ 下单带 `storeId`；现在小程序全程用默认门店。
3. **支付多商户号**：现在是单商户号（`WXPAY_*` / `ALIPAY_*` 各一套）。加盟 / 独立结算才需要多套。
4. **门店维度的其它视图**：工作台、统计卡这类非列表视图目前不跟着切换器走
   （`useTable` / 收银台队列 / 报表页已接）。新增业务视图时记得判一次 `activeStoreId`。

## 阶段 2（若要「资产不通兑」才需要）

- 资产表拆「按店账户」：`biz_member_card` / `biz_member_transaction` / `biz_customer_coupon` 加 `store_id`，
  余额/积分从 `biz_customer` 拆到按店的余额表；
- 唯一键改造：`uq_customer_phone` → `(store_id, phone)`、`member_no` / `card_no` / 单号加门店段；
- 跨店识别同一个顾客（手机号 + 跨店合并视图）会变成一个新问题：**这通常不是直营连锁想要的**。

## 踩过的坑（改这块别再犯）

1. **给非空表加 NOT NULL 列**：drizzle 直接 `ADD ... NOT NULL` → MySQL 补隐式 0（不存在的门店 id）→
   加外键必失败。必须**三步走**：加可空列 → 回填 → `MODIFY ... NOT NULL`（见阶段 1 的两条迁移）。
2. **测试里直插单据的 SQL** 也要带 `store_id`（NOT NULL）；已用
   `(SELECT id FROM sys_store WHERE is_default = 1 LIMIT 1)` 统一补上。
3. **`sys_user_store` 的外键少了 ON DELETE CASCADE**：drizzle snapshot 认为有、SQL 里没生成，
   此后 `db:generate` 只说「No schema changes」—— 这种漂移只能显式补一条迁移修
   （`20260913182200_user_store_fk_cascade`）。判断 schema 与库是否一致**要查
   `information_schema.REFERENTIAL_CONSTRAINTS`，不要信 snapshot**。
4. **有外键的关联表在 `defineRelations` 里同时声明双向关系**会让 drizzle 抛
   `Cannot read properties of undefined (reading 'through')`；`sys_user_store` 因此**不注册关系**，
   业务代码用普通 join（与 `biz_customer_address` / `biz_customer_favorite` 同处理）。
5. **`LewDropdown` 的勾选标记写在 option 上，不是组件上**：lew-ui 的 `LewContextMenu` 用
   `options.some(o => o.checkable)` 决定要不要渲染勾选列，**dropdown 自己的 `checkable` prop
   不参与这段逻辑**。只给 option 写 `checked: true` 会「菜单能打开、但看不出当前选中哪项」——
   每个 option 都得带 `checkable: true`（门店切换器已踩，见 `AppHeader.vue` 的 `storeOption()`）。
6. **`bun run format`（`oxfmt --write .`）是**整仓库**行为**：当前仓库里大量文件与新版 oxfmt 的
   排布规则不一致（主要是「多余折行」会被合成一行），跑一次会顺带改掉上百个无关文件。
   只改自己要交付的文件（`oxfmt --write <path>`），或者跑完后用
   `git checkout -- <无关文件>` 把它们退回去 —— 否则功能提交里会混进一大片格式化噪音。
