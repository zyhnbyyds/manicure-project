---
name: data-model
description: 61 张表的分组清单、命名与索引约定、软删与物理删豁免、Drizzle 迁移流程与派生字段口径。新增/修改表、生成迁移、设计索引、排查唯一索引与软删冲突时加载本技能。
whenToUse: 建表或改表、跑 db:generate/db:migrate、加索引、处理唯一约束、弄清楚某张表归哪个模块时。
metadata:
  version: '1.1.0'
  spec: project-design/superpowers/specs/2026-09-11-nail-salon-booking-design.md
  sections: §3 / §4.1~§4.6
---

# 数据模型与迁移

## 表分组（共 66 张，全部在 `src/database/schema/index.ts`）

> ⚠️ **数量与分组以 schema 文件为准**：历史上这里的清单是 32 张（spec §4.1 的早期设计），
> 现状是 **66 张 = 业务 `biz_*` 34 / 系统 `sys_*` 22 / AI `ai_*` 7 / 小程序身份 `app_*` 3**。
> 逐张字段表见开发者文档 `dev-docs/data/business-tables.md` 与 `dev-docs/data/system-tables.md`。
> 下面按功能分组列出 **biz_* 业务表 34 张**（`sys_*` / `ai_*` / `app_*` 见上面的文档）：

**A. 基础数据（6）**
`biz_service_item`、`biz_staff`、`biz_staff_service_item`、`biz_customer`（兼会员档案）、
`biz_staff_weekly_shift`、`biz_staff_schedule_override`

**B. 预约（3）**
`biz_booking`、`biz_booking_item`、`biz_booking_recurrence`

**C. 会员与资产（13）**
`biz_member_level`、`biz_recharge_plan`、`biz_member_card_type`、`biz_member_card_type_item`、
`biz_member_card`、`biz_member_card_log`、`biz_member_transaction`、
`biz_points_goods`、`biz_points_redeem`、`biz_coupon_template`、`biz_customer_coupon`、`biz_customer_address`、`biz_customer_favorite`

**D. 支付与账务（8）**
`biz_payment`、`biz_payment_log`、`biz_payment_diff`、`biz_refund`、`biz_refund_policy`、
`biz_credit_account`、`biz_receivable`、`biz_receivable_payment`

**E. 运营与提成（4）**
`biz_review`、`biz_commission_rule`、`biz_commission_record`、`biz_feedback`

> 💡 会员没有「账户表」：余额（本金/赠送）、积分、累计消费等**存在 `biz_customer` 上**，
> `biz_member_transaction` 是只追加的资产流水（余额/积分/储值的每一次变动都留痕）。
> `biz_coupon_template` / `biz_customer_coupon` 定义在 `schema/index.ts` **文件末尾**
> （晚于 `sys_notice_*`，且在 `defineRelations()` 之后），按位置扫文件很容易漏；
> 这两张表目前**未注册进 relations**，`db.query.*` 关系查询用不了。
> 通知模板/日志是 `sys_notice_template` / `sys_notice_log`，属系统表而非业务表。

## 命名与结构约定

- 表名 `snake_case`；业务表 `biz_` 前缀；小程序身份表 `app_` 前缀；Drizzle 变量 `camelCase`。
- 业务表一律套 `auditColumns`（`createdAt`/`updatedAt`/`deletedAt`/`createdBy`/`updatedBy`），**软删**。
- 外键显式命名：`fk_<表简称>_<目标>`（如 `fk_booking_item_booking`）；索引 `idx_*`，唯一索引 `uq_*`。
- 单号类字段一律「主键回填」：`B{yyyyMMdd}{id}`、`P{...}`、`R{...}`、`A{...}`、`C{...}`、`X{...}`、`M{...}`，
  各带 `uq_*` UNIQUE；**不要**用"查当日最大号 +1"（跨美甲师并发必然重号）。

## 软删豁免（§3 已声明，改表时别漏）

| 表                            | 行为                               |
| ----------------------------- | ---------------------------------- |
| `biz_staff_weekly_shift`      | 物理删（PUT 整体替换：先删后插）   |
| `biz_staff_schedule_override` | 物理删（DELETE 接口）              |
| `biz_member_card_type_item`   | 物理删（随卡种整体替换）           |
| `biz_staff_service_item`      | 物理删（随美甲师项目配置整体替换） |
| `biz_booking_item`            | 从属子表，**不套** `auditColumns`  |

## 只追加表（只有 `created_at` / `created_by`，无 update/delete）

`biz_payment_log`、`biz_member_card_log`、`biz_member_transaction`、`biz_receivable_payment`、
`biz_commission_record`、`biz_points_redeem`、`sys_notice_log`。
**接口层不允许出现更新或删除这些表的写入**（代码评审项）。

## 两个经典坑（已踩过，别重犯）

1. **软删 + 唯一索引**：软删行仍占着唯一键。查重时**不要过滤 `deletedAt`**（对齐 `UsersService.create`
   校验 `username` 的既有写法），命中软删记录走「恢复 / 提示」而不是让它撞 1062。
   **不能**用 `(phone, deleted_at)` 组合唯一索引绕开——MySQL 把多个 NULL 视为互不相同，等于没有约束。
2. **唯一索引允许 NULL 重复**：`uq_customer_phone` / `uq_customer_member_no` 靠这个特性容纳"无手机号散客"。

## 派生字段（禁止手工 UPDATE，只能由服务重算）

| 字段                                                                                       | 唯一写入方                                   |
| ------------------------------------------------------------------------------------------ | -------------------------------------------- |
| `biz_booking.paid_amount` / `due_amount` / `pay_status` / `pay_channel_summary`            | `BookingSettlementService.recalc(bookingId)` |
| `biz_customer.total_spent` / `points` / `balance_principal` / `balance_bonus` / `level_id` | 会员账务 service（同事务写流水）             |
| `biz_member_card.used_times` / `status`                                                    | 核销 service（条件更新）                     |
| `biz_credit_account.used_amount`                                                           | 挂账 / 销账 service                          |
| `biz_receivable.settled_amount` / `status`                                                 | 销账 service（条件更新）                     |
| `biz_service_item.image`（封面）                                                           | `ServiceItemsService.imagesPatch`（= `images[0]`） |

> `biz_service_item` 是「图集 + 派生封面」两个字段：`images` json 是唯一事实来源，
> `image` 只是给列表页 / 小程序目录省一次解析的派生缓存，写入接口**不接受** `image`。
> 同类需求（多图）优先照这个范式做，不要建关联表 —— 图片只做展示，不参与查询与引用完整性。

对账修复入口：`POST /biz/customers/:id/recount`、`/biz/members/:id/recount`、预约与应收的同名 recount。

## 迁移流程

```bash
# 1) 改 src/database/schema/index.ts（表 + defineRelations）
# 2) 生成迁移（不要手写 SQL）
bun run db:generate
# 3) 执行
bun run db:migrate
```

- schema 是**单文件**，新增表要同时导出并加入 `defineRelations`，否则关系查询不可用。
- 加字段一律**可空或带默认值**（表已上线后再加 NOT NULL 会让迁移失败）。
- 金额字段用 `int unsigned`（分）；折扣率/提成比例用千分比整数；比例类上限用 `*_permille`。
- json 列要写 `$type<T>()` 带上类型（如 `json('images').$type<string[]>()`），
  否则读出来是 `unknown`，调用方到处要 cast；可空列的类型里**不要**再手写 `| null`，
  `notNull` 与否由 select 推断时自动叠加。
- 生成迁移后**可以**在 `migration.sql` 里追加数据回填语句（`--> statement-breakpoint` 分隔），
  但只能在**尚未执行**之前追加 —— drizzle 按文件内容算 hash 记入 `drizzle` 表，执行后再改会导致重复执行。
  例：加 `images` 时补 `UPDATE ... SET images = JSON_ARRAY(image) WHERE image IS NOT NULL AND images IS NULL`，
  免得历史单图在改版后从界面上消失。

## 检查清单

- [ ] 新表命名、`auditColumns`、`biz_`/`app_` 前缀正确
- [ ] 外键命名 `fk_*` 且 `ON DELETE` 语义正确（主数据 RESTRICT / 子表 CASCADE / 可选关联 SET NULL）
- [ ] 单号字段有 `uq_*`
- [ ] 查询会命中的索引已建（尤其 `(staff_id, start_at, end_at)`、`(pay_status, start_at)`）
- [ ] 只追加表没有 `updatedAt` / `deletedAt`
- [ ] 派生字段没有被任何 controller 直接 UPDATE
