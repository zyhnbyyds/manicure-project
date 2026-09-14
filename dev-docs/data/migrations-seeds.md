---
title: 迁移 · 种子数据 · 派生口径
---

# 迁移 · 种子数据 · 派生口径

本页是全站的**口径引用源**：迁移怎么走、种子灌了什么、金额/时间/营收/冗余字段怎么算。
口径一旦在这里写定，其它章节引用本页，不另立一套。

## 一、迁移流程

### 标准动作序列

```bash
# 1) 改 schema（唯一改动入口）
#    src/database/schema/index.ts：新增/修改 mysqlTable + 在 defineRelations 注册
# 2) 由 schema 生成迁移（不要手写 SQL）
bun run db:generate      # → drizzle-kit generate
# 3) 检查生成的 src/database/migrations/<时间戳>_<随机名>/migration.sql
# 4) 执行
bun run db:migrate       # → bun src/database/migrate.ts
```

| 命令                  | 实现                          | 说明                                             |
| --------------------- | ----------------------------- | ------------------------------------------------ |
| `bun run db:generate` | `drizzle-kit generate`        | 按 schema 与快照的差异生成 SQL + `snapshot.json` |
| `bun run db:migrate`  | `bun src/database/migrate.ts` | 用 `drizzle-orm/mysql2/migrator` 按顺序执行      |
| `bun run db:studio`   | `drizzle-kit studio`          | 可视化查看                                       |

### `drizzle.config.ts` 关键配置

```ts
export default defineConfig({
  dialect: 'mysql', // 固定 MySQL，不用 PG 语法
  schema: './src/database/schema/index.ts', // 单文件 schema
  out: './src/database/migrations', // 迁移输出目录
  dbCredentials: { url: process.env.DATABASE_URL ?? '' }, // 凭据只从环境变量来
  strict: true,
  verbose: true,
});
```

- **凭据来源**：`process.env.DATABASE_URL`（`.env` / `.env.development` / `.env.test` / `.env.prod`），
  配置里**不写死**任何连接串。
- `src/database/migrate.ts` 用 `migrate(db, { migrationsFolder: './src/database/migrations' })`，
  与 `out` 保持一致；`DATABASE_URL` 缺失直接抛错退出。
- drizzle 在执行过的迁移上记 **hash**（`drizzle` 表）。因此：

::: danger 迁移执行后不要再改那个 `migration.sql`
已执行的文件改了 hash，drizzle 会认为「有未执行的迁移」而**重复执行**。
需要补数据回填语句，只能在**尚未执行之前**追加，用 `--> statement-breakpoint` 分隔。
:::

### 迁移演进脉络（15 个迁移，61 张表）

| 迁移目录                                    | 内容                                                                                                                                                            | 建表数 |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `20260903075025_wild_ben_grimm`             | 系统底座：`sys_config`、`sys_dept`、`sys_user`、`sys_role`、`sys_menu`、三张关联表、`sys_dict_*`、`sys_post`、`sys_refresh_token`、日志、`sys_job*`、`sys_file` | 18     |
| `20260907071434_lying_darkhawk`             | AI 会话底座：`ai_session`、`ai_message`、`ai_audit_log`                                                                                                         | 3      |
| `20260907090247_free_wonder_man`            | AI 审批闸门：`ai_action_intent`、`ai_approval`                                                                                                                  | 2      |
| `20260907104710_purple_speedball`           | AI 任务时间线：`ai_task`、`ai_task_step`                                                                                                                        | 2      |
| `20260907110721_flippant_corsair`           | `ai_action_intent` 补 `task_id` / `task_step_id` 与外键（审批纳入任务时间线）                                                                                   | 0      |
| `20260910135835_remove_dept_leader_user_id` | **删列**：`sys_dept.leader_user_id`                                                                                                                             | 0      |
| `20260910174724_nebulous_lester`            | 美甲业务主体一次性落地：`app_wx_user` + 30 张 `biz_*` + `sys_notice_template` / `sys_notice_log`                                                                | 32     |
| `20260911033025_magical_snowbird`           | `biz_service_item` 加 `images` json，**并手工追加数据回填**（`image` → `JSON_ARRAY(image)`）                                                                    | 0      |
| `20260911055121_clear_warhawk`              | `app_wx_user` 加 `staff_id` / `staff_status` / `staff_requested_at` / `staff_decided_at` / `staff_decided_by` + `idx_wx_staff` + 外键                           | 0      |
| `20260911080757_wakeful_hellfire_club`      | `biz_payment.channel` 枚举扩值（加 `wxpay_jsapi` 等）                                                                                                           | 0      |
| `20260911081512_kind_mephistopheles`        | `app_wx_user` 加 `staff_reject_reason`                                                                                                                          | 0      |
| `20260911105208_chunky_scrambler`           | `app_wx_subscribe_grant`                                                                                                                                        | 1      |
| `20260911124052_bored_valkyrie`             | `app_wx_user_bind_log`                                                                                                                                          | 1      |
| `20260912004347_tidy_human_cannonball`      | 优惠券：`biz_coupon_template`、`biz_customer_coupon`                                                                                                            | 2      |
| `20260912005048_wise_tomas`                 | `biz_booking` 加 `coupon_id` / `coupon_discount_amount`                                                                                                         | 0      |

合计建表 18+3+2+2+32+1+1+2 = **61** ✓

::: warning 迁移里有一条手工 DML
`20260911033025_magical_snowbird` 除了 `ADD COLUMN` 还有一条手写
`UPDATE biz_service_item SET images = JSON_ARRAY(image) WHERE image IS NOT NULL AND images IS NULL`。
这是**允许的例外**（数据回填），但注意它是一个「只在该迁移执行前追加」的例子：
换成 drizzle-kit 重新生成不会产生这条 DML，快照会被覆盖掉。加数据回填请一次写对。
:::

### 改 schema 的常见冲突与处理

| 场景                                   | 正确做法                                                                                                                                                                                                                                       |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **多人并行加表**                       | 各改各的 schema 行，但**迁移文件串行生成**：`git pull` → `bun run db:generate` → 提交；不要两个人同时 generate 后各推一个分支，否则两条迁移的 snapshot 会互相对不上（表现为生成出一堆「莫名 ALTER」）。冲突时以最新 snapshot 为准重新 generate |
| **加非空列**                           | 已上线的表**不要**直接 `ADD COLUMN ... NOT NULL`。要么可空、要么带默认值。确实必须非空：先加可空列 → 数据回填 → 再单独一条迁移改 NOT NULL                                                                                                      |
| **迁移与已有数据不兼容**               | 例如加唯一索引时表里已有重复值：先出**清洗 DML**（去重 / 补值）再建索引；清洗语句追加在同一条迁移里、索引之前，用 `--> statement-breakpoint` 分隔                                                                                              |
| **改唯一索引**                         | MySQL 不会自动处理历史软删行占键的问题。改之前先确认存量数据（尤其 `biz_customer.phone`、单号列），必要时先 `restore` / 清洗                                                                                                                   |
| **改列类型或枚举**                     | `mysqlEnum` 加值会生成 `MODIFY COLUMN`；**减少**取值要先确认表里没有该值的数据，否则会被截断成空串                                                                                                                                             |
| **删列**                               | 像 `20260910135835_remove_dept_leader_user_id` 一样单开一条小迁移，**不要**和功能迁移混在一起，回滚时好定位                                                                                                                                    |
| **改了表结构但忘了 `defineRelations`** | 迁移会正常生成（关系不影响 DDL），但 `db.query.*` 用不了；schema 单文件改动务必同时注册关系                                                                                                                                                    |

::: danger `auditColumns` 的默认值括号坑（真实踩过）
`drizzle-orm 1.0.0-rc` 会把 `.default(sql\`CURRENT_TIMESTAMP\`)`渲染成`DEFAULT (CURRENT_TIMESTAMP)`。MySQL 8.0.23 **建表时放行**，但随后任何**重建表**的语句
（`CREATE INDEX`/ 某些`ALTER`）会报 `Invalid default value for 'created_at'`。

处理：手工把生成的 `DEFAULT (CURRENT_TIMESTAMP)` 去掉括号。
`drizzle-kit generate` 不会因此认为有漂移（快照里存的是表达式，不是字面量），
所以这个手工改动是安全的。
:::

## 二、种子数据

### 五个脚本的职责与依赖顺序

```
db:seed  →  index.ts
              ├─ 内置角色（admin / user）+ 管理员账号 + 用户角色绑定
              ├─ seedMenus(pool)   ─┐
              ├─ seedBiz(pool)      ├─ 依赖 admin 角色已存在
              └─ seedNail(pool)    ─┘
                                  （可选、不在链上）seedDemo()
```

| 脚本            | 命令                    | 职责                                                                                                                    | 幂等策略                                                                   | 可重复执行 |
| --------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ---------- |
| `seed/index.ts` | `bun run db:seed`       | 内置角色 `admin`（`isSystem`）/ `user`、管理员账号（`SEED_ADMIN_PASSWORD`）、用户↔角色绑定，然后串联 menus → biz → nail | `ON DUPLICATE KEY UPDATE`（角色 key、用户名、用户角色唯一键）              | ✅         |
| `seed/menus.ts` | `bun run db:seed:menus` | 菜单树 + 权限点（`M`/`C`/`F`），并给 `admin` 角色**补齐**菜单授权                                                       | 按 `name` 查已有行 → 逐字段比对，值没变**不发 UPDATE**；角色授权只补缺失项 | ✅         |
| `seed/biz.ts`   | `bun run db:seed:biz`   | 配置类初始数据：`sys_config` 默认值、会员等级、退款判责规则、通知模板、定时任务                                         | 逐项按业务键判断，**已存在一律跳过**（不覆盖运营改过的值）                 | ✅         |
| `seed/nail.ts`  | `bun run db:seed:nail`  | 美甲基础资料：服务项目、美甲师、可做项目、周排班、卡种 + 卡种项目、充值方案、积分兑换品、挂账主体、提成规则             | 按 `name` / `nickname` / 组合键判断，跳过已存在                            | ✅         |
| `seed/demo.ts`  | `bun run db:seed:demo`  | **演示**顾客档案 8 条（`13700000001`~`08`）                                                                             | 按 `phone` 判断，已存在整行跳过                                            | ✅         |

依赖顺序不可调换：`menus` 依赖 `admin` 角色（`seedMenus` 里找不到 admin 会直接抛
`Admin role not found, run db:seed first`）；`nail` 的关联表（可做项目、卡种项目、周排班）
依赖前一步写入的项目 / 美甲师 / 卡种主键，脚本内部按「名称 → 主键」映射回填。

::: danger 生产环境绝不能跑 `seed/demo.ts`
它是**演示数据**，不是初始化数据。`db:seed` **不会**调用它，必须单独执行
`bun run db:seed:demo`。清理方式：

```sql
DELETE FROM biz_customer WHERE phone LIKE '137000000%';
```

更重要的红线：`demo.ts` **只写身份与档案字段，一个账务字段都不写**。
`points` / `points_total` / `balance_principal` / `balance_bonus` / `total_spent` /
`visit_count` / `last_visit_at` 全部留空 —— 它们由 `biz_member_transaction` 流水驱动，
seed 里直接赋值会让对账等式从第一天就是错的。想让演示会员有余额或积分，
**走正常业务接口**（充值 / 消费 / 积分兑换）。
:::

### seed 内容与代码的对应关系

| seed 出的数据                                                                                                                                                                         | 来源常量                                                                                                                                                                                                  | 落在哪张表                   | 幂等键                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | ---------------------------- |
| 业务默认配置（23 项）                                                                                                                                                                 | `BIZ_CONFIG_DEFAULTS`（`src/modules/biz/common/biz-config.service.ts`，**唯一事实来源**）                                                                                                                 | `sys_config`                 | `config_key`                 |
| 会员等级：银卡 1000‰ / 金卡 950‰（满 ¥500）/ 钻卡 880‰（满 ¥2000）                                                                                                                    | `MEMBER_LEVEL_SEEDS`                                                                                                                                                                                      | `biz_member_level`           | `name`                       |
| 退款规则：≥24h 全退 / 2~24h 退 50% / <2h 不退                                                                                                                                         | `REFUND_POLICY_SEEDS`                                                                                                                                                                                     | `biz_refund_policy`          | `name`                       |
| 通知模板 8 条（`booking_created`、`booking_remind`、`booking_cancelled`、`booking_completed`、`member_recharged`、`tail_payment_remind`、`recurrence_conflict`、`recurrence_failed`） | `NOTICE_TEMPLATE_SEEDS`（`src/database/seed/biz.ts`）                                                                                                                                                     | `sys_notice_template`        | `code`                       |
| 定时任务 11 条                                                                                                                                                                        | `JOB_SEEDS`                                                                                                                                                                                               | `sys_job`                    | `handler`                    |
| 服务项目 / 美甲师 / 周排班 / 卡种 / 充值方案 / 积分兑换品 / 挂账主体 / 提成规则                                                                                                       | `SERVICE_ITEM_SEEDS`、`STAFF_SEEDS`、`WEEKLY_SHIFT_SEEDS`、`CARD_TYPE_SEEDS`、`RECHARGE_PLAN_SEEDS`、`POINTS_GOODS_SEEDS`、`CREDIT_ACCOUNT_SEEDS`、`COMMISSION_RULE_SEEDS`（`src/database/seed/nail.ts`） | 对应 `biz_*` 表              | `name` / `nickname` / 组合键 |
| 菜单 + 权限点                                                                                                                                                                         | `MENU_SEEDS`（含 `BIZ_PAGES` 的 25 个页面）                                                                                                                                                               | `sys_menu` / `sys_role_menu` | `name`                       |

::: tip seed 会打印统计
四个脚本都会输出 `inserted` / `skipped` 计数，重复执行时 `inserted=0` 是正确的。
`seedJobs` 一律写 `concurrent: false`（防重入）；`seedCreditAccounts` 的
`used_amount` 一律从 `0` 起 —— 额度占用只能由应收单条件更新驱动。
:::

## 三、派生字段与计算口径

以下口径**写死在这里**，全站引用。

### 1. 金额：整数分 + 向下取整

**口径定义**

- 所有金额列单位为**分**，`int unsigned`；可为负的差额/流水用有符号 `int`。
- 比例用**千分比整数**（`1000` = 不打折），避免浮点误差。
- 取整方向**一律向下**（少收不多少），只有「金额 → 积分」是向上取整到整元。

**真实实现位置**：`src/modules/biz/common/money.ts`

```ts
export const CENTS_PER_YUAN = 100;

/** 千分比取整（向下）：permilleOf(10000, 950) === 9500 */
export function permilleOf(amount: number, permille: number): number {
  return Math.floor((amount * permille) / 1000);
}
```

**算价链路（`quoteBooking()`，顺序不可调换）**

```
original_price                 Σ 明细 price
  → level_discount_amount      floor(original × (1000 − permille) / 1000)
  → coupon_discount_amount     min(券面额, 折后金额)      ← 等级折扣之后
  → points_discount_amount     ≤ 折后金额 × maxPointsPermille‰   ← 券与积分二选一
  → adjust_amount              手动改价差额（可正可负）
  = payable_amount             max(..., 0)
```

**容易写错的示例**：给原价 ¥100（10000 分）、等级 95 折、`maxPointsPermille = 300` 的单子
用 30000 积分（汇率 100 积分 = 1 元）抵扣。

- 折后 `base4Points = 10000 − 500 = 9500`
- 抵扣上限 = `permilleOf(9500, 300) = 2850`（**不是** `permilleOf(10000, 300) = 3000`）
- 30000 积分可抵 30000 分 → 被夹到 **2850 分**
- `payable = 9500 − 2850 = 6650`

把上限按**原价**算，就会多抵 150 分。

### 2. 时间：UTC 存储 + `shopDayRange()`

**口径定义**

- 所有时刻列存 **UTC 绝对时刻**。
- 「店内本地日」是 `date` 字符串（`YYYY-MM-DD`），**不是时刻**。
- 唯一的换算入口是 `shopDayRange(date, tz)`，返回 `[start, end)` 半开区间。
- 默认时区 `Asia/Shanghai`，可被 `biz.booking.timezone` 覆盖。

**真实实现位置**：`src/modules/biz/common/shop-time.ts`

```ts
/** 店内本地日 [00:00, 次日 00:00) 对应的绝对时刻区间 */
export function shopDayRange(date: string, timeZone = DEFAULT_SHOP_TIMEZONE) {
  assertLocalDate(date); // 非法格式直接抛 RangeError，不静默回落
  return {
    start: shopLocalToUtc(date, '00:00:00', timeZone),
    end: shopLocalToUtc(addLocalDays(date, 1), '00:00:00', timeZone),
  };
}
```

**容易写错的示例**：筛「2026-09-11 这一天」的单子。

```ts
// ❌ 错：按 UTC 零点，整体偏 8 小时，会漏掉当天 00:00~08:00 的单、混进次日 00:00~08:00 的单
const start = new Date('2026-09-11');
const end = new Date('2026-09-12');

// ✅ 对：本地日 → 绝对区间
const { start, end } = shopDayRange('2026-09-11', timeZone);
where(gte(col, start), lt(col, end));
```

区间末端一律用 `lt`（闭开），不要用 `lte`。

### 3. 营业日切分

**口径定义**

- 报表的「一天」= **店内本地日 00:00 ~ 次日 00:00**，与 UTC 日界**不等价**。
- 归日字段：支付按 `paid_at`（为空时回落 `created_at`）、退款按 `refunded_at`
  （为空时回落 `created_at`）、预约单量按 `start_at`、次卡核销无关联预约时按核销发生时间。
- 默认报表区间 = 最近 **30** 个店内本地日（含当天）。
- 区间条件的实现统一走 `localDateRange()` / `rangeStart()` / `rangeEnd()`
  （`src/modules/biz/common/query.ts` + `reports.service.ts`）。

**真实实现位置**：`src/modules/biz/reports/analytics/reports.service.ts`（`rangeStart` / `rangeEnd`）

```ts
this.rangeStart(q) → shopDayRange(q.dateFrom, q.timeZone).start
this.rangeEnd(q)   → shopDayRange(addLocalDays(q.dateTo, 1), q.timeZone).start
```

注意 `rangeEnd` 用的是 **`dateTo + 1` 天的 00:00**，因为区间是闭开的。

**容易写错的示例**：把「昨天的营业额」实现成
`paid_at >= DATE_SUB(NOW(), INTERVAL 1 DAY)`。这是**滚动 24 小时**，不是营业日；
早上 9 点跑出来的数字会横跨昨天和前天，与门店对不上账。

### 4. 净营收 = 成功支付 − 成功退款；次卡核销单列

**口径定义**

```
毛收入 gross = Σ biz_payment.received_amount   WHERE status ∈ (success, partial_refunded, refunded)
退款   refund = Σ biz_refund.actual_amount      WHERE status = 'success'
净营收 net   = gross − refund
```

- 计入毛收入的支付单状态集合是 **`success` / `partial_refunded` / `refunded`** 三个，
  因为 `received_amount` 是**毛额**，退款只体现在 `refund` 上。
- **退款用 `actual_amount`（实退），不是 `amount`（申请额）** —— 判责扣款部分不算退款。
- **次卡核销单列**：次卡核销产生的支付单 `channel='card'`、实收 `0`，
  所以它**不进实收营收**，但按次数单独计数（`cardUsedTimes`、`cardRatio`‰）。
- 净营收按项目原价占比**分摊到明细**，向下取整，差额留在单头。

**真实实现位置**：`reports.service.ts` 的 `revenueOf()`（`net: row.gross - row.refund`）、
`PAID_PAYMENT_STATUSES` 常量、`netCardTimes()`、`apportion()`；
预约侧同口径见 `booking-settlement.service.ts` 的 `COUNTED_PAYMENT_STATUS`。

**容易写错的示例**：只按 `status='success'` 统计毛收入。
一旦发生退款，支付单会被改成 `partial_refunded` / `refunded`，
该单的 `received_amount` 就从统计里**凭空消失**，同时 `refund` 又减了一次 —— 净营收被减两遍。

### 5. 挂账不计营收、销账才计入

**口径定义**

- 下单挂账时**不写支付单**，预约 `pay_status` 直接落 `credit`；
- 销账时写一张 `purpose='credit_settle'` 的支付单，**此时才计入营收**
  （报表同时把它单独汇总到 `creditSettled` 列）。
- 因此「挂账不计营收」是**天然成立**的，报表**不需要**对挂账做特判。

**真实实现位置**：`receivables.service.ts`（销账时写 `biz_payment` +
`biz_receivable_payment`，并回减 `biz_credit_account.used_amount`）、
`reports.service.ts`（`purpose === 'credit_settle'` → `row.creditSettled`）、
`booking-settlement.service.ts`（`creditAccountId !== null` → `pay_status = 'credit'`）。

**容易写错的示例**：在报表里额外写一句「排除 `pay_status='credit'` 的预约」。
这会把「现金 + 挂账」混合支付的单子整单排除掉，现金那部分营收也一起丢了。
正确做法是**什么都不做**：没有支付单自然不计，销账落了支付单自然计入。

### 6. `total_spent` 等冗余字段的维护时机

**口径定义**

| 字段                                                                                                             | 何时加                                               | 何时减                                | 唯一写入方                         |
| ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------- | ---------------------------------- |
| `biz_customer.total_spent`                                                                                       | 收款成功（已收金额）                                 | 退款成功时**按比例回减**              | 会员账务 service                   |
| `biz_customer.points`                                                                                            | `points_earn` 流水                                   | `points_spend` / `points_redeem` 流水 | 会员账务 service                   |
| `biz_customer.points_total`                                                                                      | 累计发放，只增不减                                   | —                                     | 会员账务 service                   |
| `biz_customer.balance_principal` / `balance_bonus`                                                               | 充值 / 转入                                          | 消费扣减 / 退款                       | 会员账务 service                   |
| `biz_customer.level_id`                                                                                          | 定时任务 `recountMemberLevels` 按 `total_spent` 重算 | —                                     | 等级重算任务                       |
| `biz_customer.visit_count` / `last_visit_at`                                                                     | 预约 `completed` 时 +1                               | —                                     | `onBookingCompleted()` / `recount` |
| `biz_booking.paid_amount` / `refund_amount` / `due_amount` / `pay_status` / `pay_channel_summary` / `settled_at` | `BookingSettlementService.recalc()`                  | 同左                                  | 只有 `recalc()`                    |
| `biz_member_card.used_times` / `status`                                                                          | 核销条件更新                                         | 撤销核销条件更新                      | 次卡核销 service                   |
| `biz_credit_account.used_amount`                                                                                 | 挂账条件更新                                         | 销账条件更新                          | 挂账 / 销账 service                |
| `biz_receivable.settled_amount` / `status`                                                                       | 销账条件更新                                         | —                                     | 销账 service                       |

**对账等式（必须随时成立）**

```
SUM(balance_delta_principal) = biz_customer.balance_principal
SUM(balance_delta_bonus)     = biz_customer.balance_bonus
SUM(points_delta)            = biz_customer.points
paid_amount                  = Σ 成功支付单 received_amount
净营收                        = paid_amount − refund_amount
```

**真实实现位置**：`src/modules/biz/membership/member-accounts/member-accounts.service.ts`、
`src/modules/biz/booking/booking-settlement.service.ts`。
对账修复入口是 `recount` 接口，目前有 **3 个**：
`POST /biz/bookings/:id/recount`、`POST /biz/customers/:id/recount`、
`POST /biz/members/:id/recount`（需 `biz:member:recount` 权限点）。
**应收（`biz_receivable`）没有 recount 接口** —— 销账是条件更新，天然不会超账，
出现异常只能靠流水人工核对。

**容易写错的示例**：退款时把 `total_spent` 一次性减掉**整单金额**。
实际必须**按退款比例回减**（判责扣款那部分不退，`total_spent` 也不该减），
否则会员等级会因为一次部分退款而掉档。

::: danger 派生字段禁止手工 UPDATE
所有派生字段都有且只有一个写入方（上表右列）。接口、定时任务、脚本都**不准**直接 UPDATE。
定时任务只改状态与等级 —— **任何改余额 / 积分 / 金额的任务都是设计错误**。
:::

## 相关章节

- 表清单与整体约定：[/data/](/data/)
- 业务表详解：[/data/business-tables](/data/business-tables)
- 系统 / AI / 小程序身份表：[/data/system-tables](/data/system-tables)
- 报表口径与提成：[/backend/reports](/backend/reports)
- 资金红线与对账等式：[/quality/pitfalls](/quality/pitfalls)
- 测试与验收（含时区 / 并发用例）：[/quality/](/quality/)
