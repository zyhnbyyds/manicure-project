# 多店（连锁直营）改造现状

> 口径来源：用户 2026-09-13 决策「**连锁直营模式**」+「每个门店店长只可以看到自己门店的订单预约等信息，
> 超级管理员可以看到所有预约信息，也可以按照门店去筛选查询对应的各种信息」。
>
> 假设（**未经确认，改起来最贵**）：**会员资产全店通兑** —— 储值余额 / 积分 / 次卡 / 券全店通用，
> 但「这笔钱/这次服务发生在哪家店」必须落在单据上。若实际要「按店独立资产」，见文末「阶段 2」。

## 一句话现状

**阶段 0 + 阶段 1 已完成**：门店是实体、单据带门店、按账号的门店范围过滤与筛选已生效；
**后台的门店管理页 / 门店切换器 / 用户门店分配界面、报表按店、小程序选店尚未做**（见「还没做」）。

## 已落地

### 阶段 0：门店成为实体（commit `404932d`）

- 新表 `sys_store`：编码（唯一）/ 名称与英文副标题 / 电话 / 地址 / 营业时间 / 经纬度 /
  公告 / 时区（先留空）/ 状态 / 排序 / `is_default`。
- 门店信息原本散在 `sys_config` 的 `biz.shop.*` 里（一个 `config_key` 只能存一份值 = 单店假设）。
- 迁移把现存单店配置落成一条「默认门店」；seed 只补空字段（**不覆盖运营改过的值**）。
- `GET /app/shop` 改读门店表，字段为空回落 `biz.shop.*`；返回里多了 `storeId` / `storeCode`。
- 服务层三条规则：**第一条门店自动成为默认**、**默认唯一**（事务清旧+置新）、**默认门店不可删**。

### 阶段 1：单据带门店 + 门店范围（本次）

| 表 | 新列 | 继承口径 |
| --- | --- | --- |
| `biz_booking` | `store_id` NOT NULL + FK | 建单时定：请求显式 `storeId` → 账号当前门店 → 默认门店 |
| `biz_booking_recurrence` | `store_id` NOT NULL + FK | 规则建的时候定；**生成出来的预约继承规则**（生成任务没有操作人） |
| `biz_payment` | `store_id` NOT NULL + FK | **跟单据走**：有 `bookingId` 继承预约；充值等无单据场景用 `draft.storeId` 或默认门店 |
| `biz_refund` | `store_id` NOT NULL + FK | 跟随原支付单（钱收在哪家店就退在哪家店） |
| `biz_receivable` | `store_id` NOT NULL + FK | 有 `bookingId` 继承预约，否则默认门店 |
| `sys_user_store` | 账号 ↔ 可见门店 | 迁移把现存账号全部绑到默认门店（保持升级前后行为一致） |

**范围与筛选**（`src/common/data-scope/store-scope.ts`）：

```ts
resolveStoreScope(db, actor, requestedStoreId?)   // 范围 + 当前门店
requireCurrentStoreId(db, actor, requestedStoreId?) // 写入用，拿不到就 403
storeConditions(scope, requestedStoreId)           // 列表 where 片段
```

| 账号 | 看到什么 | 能筛选吗 |
| --- | --- | --- |
| 超管（`*:*:*`）/ `system:store:all` | 全部门店 | 能，`?storeId=N` |
| 分到门店的普通账号 | 只有分给它的门店 | 只能在可见范围内筛（筛别的店 → 403） |
| 没分到门店的普通账号 | 什么业务数据都看不到 | —— 请求直接 **403 + 明确原因**（不是空列表） |

**为什么这样而不是塞进 JWT**：与 `resolveDataScope` 同一取舍 —— 权限/门店调整后**立刻生效**，
不必等用户重新登录换 token。

## 还没做（按建议顺序）

1. **后台「门店管理」页**（web）：`GET/POST/PATCH/DELETE /biz/stores` 已有，缺页面 + 菜单 seed
   （权限点 `system:store:*` 已在控制器上声明，但还没写进 `src/database/seed/menus.ts`，
   所以目前只有 admin 能用）。
2. **用户 → 门店分配界面**（web）：`sys_user_store` 只能手工写库；建议放在「用户管理」编辑弹窗里
   多选门店，或单独一个「门店授权」抽屉。
3. **门店切换器**（web 顶栏）：有了它，超管查各店数据不用手改 URL。切店后所有列表请求带 `?storeId=`。
4. **报表按店 + 合并**：目前报表口径（净营收、营业日）还是全局；应按门店拆分并支持合并视图。
5. **顾客档案 / 会员资产是否按店**：现在是**共享**（通兑假设）。若要「按店独立」，见下。
6. **小程序选店**：`GET /app/shops`（列表）+ 下单带 `storeId`；现在小程序全程用默认门店。
7. **支付多商户号**：现在是单商户号（`WXPAY_*` / `ALIPAY_*` 各一套）。加盟/独立结算才需要多套。

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
