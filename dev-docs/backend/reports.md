---
title: 报表与提成核算
---

# 报表与提成核算

本页覆盖**报表指标口径、营业日切分、查询实现与性能**，以及**提成规则优先级、计提基数、结算冻结与冲销**。

- 代码位置：
  - `src/modules/biz/reports/analytics/reports.service.ts`（1499 行，6 张报表 + CSV 导出）
  - `src/modules/biz/reports/analytics/reports.controller.ts`（`/biz/reports`）
  - `src/modules/biz/reports/commission/commission.service.ts`（799 行）
  - `src/modules/biz/reports/commission/commission.controller.ts`
- 报表**只读**：`ReportsService` 不写任何表。

## 营收口径

### 唯一的公式

```
毛收入 gross  = Σ biz_payment.received_amount     WHERE status ∈ ('success','partial_refunded','refunded')
退款   refund = Σ biz_refund.actual_amount        WHERE status = 'success'
净营收 net    = gross − refund
```

```ts
// src/modules/biz/reports/analytics/reports.service.ts:242
/** 计入「实收」的支付单状态（§15.7 不变量 4：毛收入不扣退款） */
const PAID_PAYMENT_STATUSES = [
  'success',
  'partial_refunded',
  'refunded',
] as const;
```

::: warning 三个最容易写错的地方

1. `partial_refunded` / `refunded` **必须计入毛收入** —— 否则退款后单子会从营收里"消失"，毛收入和退款两个数都对不上；
2. **不要**用 `SUM(biz_booking.payable_amount)`：应付 ≠ 实收（有定金、挂账、退款、积分抵扣）；
3. **不要**用 `SUM(biz_booking.paid_amount)`：那是**预约维度**的派生冗余，漏掉充值 / 购卡这类无预约的收款。
   :::

### 营业日切分

**禁止 `DATE(created_at)` 这类 UTC 截断**。统一走 `src/modules/biz/common/shop-time.ts`：

| 函数                                            | 作用                                                     |
| ----------------------------------------------- | -------------------------------------------------------- |
| `shopDayRange(billDate, timezone)`              | 店内本地日 → 绝对时刻区间 `{ start, end }`（UTC `Date`） |
| `localDateRange(column, from, to, timezone)`    | 生成可拼进 `WHERE` 的区间条件                            |
| `shopDateOf(value, timezone)`                   | 把某一行的时刻映射到它真正落在的**店内本地日**           |
| `shopToday(timezone)` / `addLocalDays(date, n)` | 今天 / 加减本地日                                        |
| `listLocalDates(from, to)`                      | 本地日序列（用于零填充分桶）                             |

**每种实体的营业日锚点**（很重要，跨夜单子算哪一天全靠它）：

| 实体     | 锚点                                                                   | 代码                                                                              |
| -------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| 支付单   | `paid_at ?? created_at`                                                | `revenueOf()` 里 `this.localDay(payment.paidAt ?? payment.createdAt, q.timeZone)` |
| 退款单   | `refunded_at ?? created_at`                                            | `this.localDay(refund.refundedAt ?? refund.createdAt, q.timeZone)`                |
| 预约单   | `start_at`（**服务开始那一天**）                                       | `bookingRows()` 的 `this.dayRange(bizBookings.startAt, q)`                        |
| 会员流水 | `created_at`                                                           | `memberTransactionRows()` 的 `this.dayRange(bizMemberTransactions.createdAt, q)`  |
| 次卡核销 | 优先**关联预约的 `start_at`**；无关联预约（散客核销）回落 `created_at` | `cardLogRows()`                                                                   |
| 应收单   | `created_at`（报表侧）/ `due_date`（账龄侧）                           | `receivablesOf()`                                                                 |

```ts
// src/modules/biz/reports/analytics/reports.service.ts:1426
/**
 * 次卡核销记录（只追加）。
 * 优先按「关联预约的营业日」判定区间（与项目排行同一锚点），
 * 没有关联预约的核销（散客核销）回落到核销发生时间。
 */
// 实现：leftJoin biz_booking，WHERE (bookingId IS NULL AND created_at 在区间) OR
//      (booking.status='completed' AND start_at 在区间)
```

**跨夜怎么算**：营业日锚在**预约的 `start_at`**，而不是支付时间或完成时间。所以 23:00 开始、次日 01:00 结束的单子算在**开始那天**；跨夜连单的分账口径由这个锚点唯一决定。

> 若门店营业到凌晨需要按「营业结束时间」切日，改的是 `shop-time.ts` 的 `shopDayRange()`，**不是**各个报表的锚点。目前 `biz.booking.timezone` 默认 `Asia/Shanghai`（`DEFAULT_SHOP_TIMEZONE`），切日就是自然日 00:00–24:00。

### 分桶（day / week / month）

```ts
// src/modules/biz/reports/analytics/reports.service.ts:294
function periodOf(date: string, granularity: ReportGranularity): string {
  if (granularity === 'week') return isoWeek(date); // ISO 8601 周，周一为首日，如 2026-W37
  if (granularity === 'month') return date.slice(0, 7); // 2026-09
  return date;
}
```

`buildPeriods()` 会**零填充**区间内全部分桶 —— 图表与手工核对都有稳定的行序（没有数据的期间也会出现一行 0）。

## 报表清单与指标口径

6 个只读接口，全部 `biz:report:view`：

| 接口                           | 内容                                         |
| ------------------------------ | -------------------------------------------- |
| `GET /biz/reports/overview`    | 概览（营收 + 预约 + 客户 + 会员 4 组）       |
| `GET /biz/reports/revenue`     | 按 period 的营收明细（含渠道拆列）           |
| `GET /biz/reports/services`    | 项目排行（含次卡核销单列）                   |
| `GET /biz/reports/staffs`      | 美甲师业绩（含提成与评分）                   |
| `GET /biz/reports/members`     | 会员报表（充值 / 结存 / 积分 / 次卡）        |
| `GET /biz/reports/receivables` | 应收账龄（见 [挂账与应收](/backend/credit)） |
| `GET /biz/reports/export`      | CSV 导出，`biz:report:export`                |

### 门店维度（连锁直营）

报表与业务列表**共用同一套门店上下文**（`resolveStoreScope`，见 [system-tables](/data/system-tables)）：

| 优先级 | 来源                         | 效果                                                                         |
| ------ | ---------------------------- | ---------------------------------------------------------------------------- |
| 1      | 显式 `?storeId=`             | 只看这家店；不可见 → **403**                                                 |
| 2      | 顶栏切换器的 `x-store-id` 头 | 同上（不可见则静默忽略，当没传）                                             |
| 3      | 都没传                       | 超管 = **全部门店合并**；店长 = **自己可见的门店**（这是数据权限，不是筛选） |

**能按店的指标**（表有 `store_id`，或能顺 `booking_id` 归属）：

营收 / 退款 / 单量 / 客单价 / 新客回头客 / 项目排行 / 美甲师（单量、分摊营收、提成、评分）/
应收账龄 / **次卡核销**（挂在预约上的按预约门店；散客核销没有门店可判 → 按店时落空，宁少不多）。

**恒为全店口径的指标**（表里没有 `store_id`，余额是全店通兑的一个池子）：

| 指标                | 为什么                                                  |
| ------------------- | ------------------------------------------------------- |
| 储值充退 / 期末结存 | `biz_member_transaction` 无门店列（充值流水也不挂预约） |
| 积分发放 / 抵扣     | 同上                                                    |
| 新增会员            | `biz_customer` 无门店列（顾客/手机号全店唯一）          |
| 次卡发售            | `biz_member_card` 无门店列                              |

这不是漏做，而是**口径选择**：给这些数字按店切分只会得到「A 店余额」这种不存在的概念。
前端因此必须显式标注（概览卡片的「全店」标签、会员页签顶部的说明），
否则店长会以为「切到本店后这些数字也是本店的」。若真要按店看充值金额，
用营收报表的 `purpose=recharge` 那一档（支付单带门店）。

### overview

| 指标                                             | 口径                                                 | 实现位置                             | 数字例子                            |
| ------------------------------------------------ | ---------------------------------------------------- | ------------------------------------ | ----------------------------------- |
| `revenue.gross`                                  | Σ 成功支付 `received_amount`                         | `overviewOf()` 559 行                | 现金 10000 + 微信 20000 = **30000** |
| `revenue.refund`                                 | Σ 成功退款 `actual_amount`                           | 同                                   | 退 5000 → **5000**                  |
| `revenue.net`                                    | `gross − refund`                                     | 566 行                               | **25000**                           |
| `revenue.count`                                  | `status='completed'` 的预约数                        | 564 行                               | **2**                               |
| `revenue.avgTicket`                              | `floor(net / count)`（**向下取整**）                 | 576 行                               | `floor(25000/2)` = **12500**        |
| `bookings.total`                                 | 区间内预约总数（含取消 / 爽约）                      | 579 行                               |                                     |
| `bookings.completed` / `cancelled` / `noShow`    | 按 `status` 分别计数                                 | 580–585 行                           |                                     |
| `bookings.pending`                               | `status ∈ ('pending','confirmed','arrived')`         | `PENDING_BOOKING_STATUSES`（249 行） |                                     |
| `customers.newCustomers`                         | **首次 `completed` 的 `start_at` 落在区间内** = 新客 | `customerTotalsOf()` 642 行          |                                     |
| `customers.returning`                            | 区间内完成但首次完成不在区间内                       | 同                                   |                                     |
| `customers.memberNew`                            | `biz_customer.member_since` 落在区间内               | 680 行                               |                                     |
| `member.rechargePrincipal` / `rechargeBonus`     | Σ 流水 `type='recharge'` 的 `balance_delta_*`        | `memberTotalsOf()` 607 行            |                                     |
| `member.balancePrincipalEnd` / `balanceBonusEnd` | **截至区间结束（不含）**的全部流水增量和             | 622 行                               |                                     |
| `member.pointsIssued`                            | Σ `type='points_earn'` 且 `points_delta > 0`         | 612 行                               |                                     |
| `member.pointsSpent`                             | Σ (`points_spend` + `points_redeem`) 的 `            | points_delta                         | `                                   | 615 行 |     |
| `member.cardUsedTimes`                           | Σ 核销次数（`use` 为 +，`revert` 为 −）              | `netCardTimes()` 1479 行             |                                     |
| `member.cardIssued`                              | `biz_member_card` 按 `purchased_at` 落在区间内的行数 | `cardIssuedCount()` 1461 行          |                                     |

::: tip 期末结存用的是「流水累加」而不是读当前字段

```ts
// reports.service.ts:621
// 期末结存 = 截至区间结束（不含）的全部流水增量和（§15.7 不变量 2 对账等式）
const [balance] = await this.database.db
  .select({
    principal: sum(bizMemberTransactions.balanceDeltaPrincipal),
    bonus: sum(bizMemberTransactions.balanceDeltaBonus),
  })
  .from(bizMemberTransactions)
  .where(lt(bizMemberTransactions.createdAt, this.rangeEnd(q)));
```

这样**历史区间的报表可以复现**（读当前字段只能得到"现在"的余额）。
:::

### revenue

每行一个 period，字段：`period` / `gross` / `refund` / `net` / `cash` / `wechat` / `alipay` / `balance` / `creditSettled` / `count`。

渠道归并规则（`revenueOf()` 732–744 行）：

| 列              | 命中的 `channel`                                                   |
| --------------- | ------------------------------------------------------------------ |
| `cash`          | `cash`                                                             |
| `wechat`        | `wxpay_native` + `wechat_offline`                                  |
| `alipay`        | `alipay_qr` + `alipay_offline`                                     |
| `balance`       | `balance`                                                          |
| `creditSettled` | `purpose === 'credit_settle'`（**与渠道正交**，销账实收单列）      |
| —               | `card` 不计入任何金额列（实收为 0），但计入 `count` 那边的完成单量 |

查询入参支持把 `channel` 传成聚合标签 `wechat` / `alipay`，由 `channelsOf()` 展开：

```ts
// src/modules/biz/reports/analytics/reports.service.ts:100
export function channelsOf(channel: ReportChannel): PaymentChannelValue[] {
  if (channel === 'wechat') return ['wxpay_native', 'wechat_offline'];
  if (channel === 'alipay') return ['alipay_qr', 'alipay_offline'];
  return [channel];
}
```

### services（项目排行）

| 字段        | 口径                                                                                                                                                   |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `times`     | 该项目出现在已完成预约明细里的次数                                                                                                                     |
| `amount`    | **净营收按项目原价占比分摊**：`apportion(booking.paid_amount − booking.refund_amount, item.price, booking.original_price)`，**向下取整**，差额留在单头 |
| `cardTimes` | 次卡核销次数（`use` 为 +，`revert` 为 −，最后 `max(0)`）—— **单列，金额 0 但计次数**                                                                   |
| `cardRatio` | `floor(cardTimes × 1000 / times)`，千分比                                                                                                              |

```ts
// src/modules/biz/reports/analytics/reports.service.ts:272
/** 按占比向下取整分摊（少算不多算，差额留在单头，可手工复核） */
function apportion(total: number, part: number, whole: number): number {
  if (total <= 0 || whole <= 0) return 0;
  return Math.min(Math.floor((total * part) / whole), total);
}
```

数字例子：预约 `original_price = 10000`、`paid_amount = 8000`、`refund_amount = 0`，含两个项目 4000 + 6000 → 项目 1 分摊 `floor(8000×4000/10000) = 3200`，项目 2 分摊 `floor(8000×6000/10000) = 4800`，合计 8000（**正好对上，因为两处都向下取整且合计除得尽**；除不尽时合计会小于单头，差额就是手工核对的依据）。

排序：`amount` 降序 → `times` 降序 → `serviceItemId` 升序。

### staffs（美甲师业绩）

| 字段                       | 口径                                                                                      |
| -------------------------- | ----------------------------------------------------------------------------------------- |
| `bookings`                 | 该美甲师在区间内 `completed` 的预约数（锚点 `start_at`）                                  |
| `amount`                   | `Σ (booking.paid_amount − booking.refund_amount)`（**净营收分摊**）                       |
| `commission`               | Σ `biz_commission_record.amount`，`status ∈ ('accrued','settled')`（**`reversed` 不计**） |
| `avgScore` / `reviewCount` | 只统计 `status='published'` 且未软删的评价；`avgScore = round(total/count × 100)/100`     |

传了 `staffId` 时**即使零业绩也会给出一行**（方便前端渲染）。

### members

按 period 输出：`newMembers` / `recharge` / `bonus` / `balanceEnd` / `pointsIssued` / `pointsSpent` / `cardUsed`。

`balanceEnd` 是**从区间期初余额起按本地日累计**（`openingBalanceRows()` + `balanceDeltaRows()`），桶内取最后一天的值，最后 `Math.max(..., 0)`。

### 导出

```ts
// src/modules/biz/reports/analytics/reports.service.ts:257
export const MAX_EXPORT_ROWS = 10_000;
```

```ts
if (rows.length > MAX_EXPORT_ROWS)
  throw new BadRequestException(
    `导出行数 ${rows.length} 超过 ${MAX_EXPORT_ROWS} 行，请缩小时间范围；` +
      '大文件异步导出任务本期未实现（TODO：复用 jobs + 文件模块，完成后通知中心提示下载）',
  );
```

- CSV 带 **UTF-8 BOM**（`\uFEFF`），行尾 `\r\n`，Excel 直接可开；
- 响应头由 controller 设置：`Content-Type: text/csv; charset=utf-8` + `Content-Disposition: attachment; filename*=UTF-8''<urlencoded>`；
- 前端 `web/src/api/biz/reports.ts` 的 `exportReport()` 走 axios 拿 blob（`window.open` 带不上 `Authorization` 头）。

::: warning 大文件异步导出是 TODO，不是已实现
`reports.controller.ts:218` 明确标了 `TODO（本期不做）：超过 1 万行的异步导出`。目前超过上限**直接 400**。
:::

## 查询实现与性能

### 写法：拉明细 + 内存聚合

报表的绝大部分聚合**不是 SQL `GROUP BY`**，而是：

1. 一条 `SELECT`（带 `WHERE` 过滤 + 子查询过滤）拉出区间内的**明细行**；
2. 在 Node 侧用 `Map` / `reduce` 聚合；
3. `buildPeriods()` 先建好零填充的桶，再把明细累加进去。

```ts
// src/modules/biz/reports/analytics/reports.service.ts:706
const rows = new Map<string, RevenueReportRow>();
for (const period of buildPeriods(q.dateFrom, q.dateTo, q.granularity))
  rows.set(period, { period, gross: 0, refund: 0, net: 0, cash: 0, wechat: 0, alipay: 0, balance: 0, creditSettled: 0, count: 0 });
for (const payment of payments) { const row = rows.get(periodOf(this.localDay(...), q.granularity)); if (!row) continue; row.gross += payment.receivedAmount; ... }
```

真正下推到 SQL 的聚合只有这几处：

| 位置                                  | SQL 聚合                                                                |
| ------------------------------------- | ----------------------------------------------------------------------- |
| `memberTotalsOf()` 622 行             | `SUM(balance_delta_principal)` / `SUM(balance_delta_bonus)`（期末结存） |
| `openingBalanceRows()` 1403 行        | 同上，截至区间开始                                                      |
| `cardIssuedCount()` 1461 行           | `COUNT()`                                                               |
| `customerTotalsOf()` 653 行           | `MIN(start_at) GROUP BY customer_id`（首次完成时间）                    |
| `staffsOf()` 839 行                   | `SUM(biz_commission_record.amount) GROUP BY staff_id`                   |
| `receivablesOf()` / `credit-accounts` | `SUM(amount − settled_amount) GROUP BY credit_account_id`               |

**没有按日预聚合表**。报表直接打明细表，靠索引 + 日期区间收敛数据量。

### 索引依赖

| 表                       | 用到的索引                                                                               |
| ------------------------ | ---------------------------------------------------------------------------------------- |
| `biz_payment`            | `idx_payment_status(status, created_at)`；`paid_at` 无独立索引，范围过滤走 `status` 前缀 |
| `biz_refund`             | `idx_refund_status(status, created_at)`                                                  |
| `biz_booking`            | 主键 + `start_at` 范围（无 `start_at` 索引，见下方注意）                                 |
| `biz_member_transaction` | `idx_txn_type_created(type, created_at)`；期末结存按 `created_at <` 扫                   |
| `biz_member_card_log`    | 关联预约走 `booking_id`；无索引时按 `created_at` 扫                                      |
| `biz_commission_record`  | `staff_id` / `period` 过滤（见提成章节的索引注释）                                       |
| `biz_receivable`         | `idx_receivable_due(status, due_date)`                                                   |

::: warning 改口径 / 加维度前先想清楚

- 报表每次请求都重新拉全区间明细，**时间区间越大、内存与耗时越高**。加维度（比如按项目 + 美甲师二维）会让明细行数乘性增长。
- 想把聚合下推到 SQL 时，**必须先确认口径一致**：`paid_at ?? created_at` 这类"回落"逻辑在 SQL 里写要额外注意索引使用。
- 若数据量继续增长，正确做法是**按日预聚合**（营业日锚点已在 `shopDateOf()` 里固定），而不是给明细表加更多索引。
  :::

## 提成

### 规则与优先级

`biz_commission_rule`：

| 字段                                  | 含义                                                        |
| ------------------------------------- | ----------------------------------------------------------- |
| `scope`                               | `staff` / `category` / `service_item`                       |
| `target_id` / `staff_id` / `category` | 按 scope 取用（`assertRuleValid()` 校验必填）               |
| `permille`                            | 千分比（0~1000），与 `fixed_amount` **可同时存在**          |
| `fixed_amount`                        | 固定额（分）                                                |
| `base`                                | `paid`（默认，实收）/ `payable`（应付）/ `original`（原价） |
| `effective_from` / `effective_to`     | 生效区间（店内本地日）                                      |
| `sort` / `status`                     |                                                             |

**优先级** `service_item > category > staff`，同维度取 `sort` 最小、再 `id` 最小的一条：

```ts
// src/modules/biz/reports/commission/commission.service.ts:127
const SCOPE_ORDER: CommissionScope[] = ['service_item', 'category', 'staff'];

// commission.service.ts:770
export function pickRule(
  rules,
  staffId,
  serviceItemId,
  category,
): CommissionRuleRow | null {
  for (const scope of SCOPE_ORDER) {
    const matched = rules.find((rule) => {
      if (rule.scope !== scope) return false;
      if (scope === 'service_item') return rule.targetId === serviceItemId;
      if (scope === 'category')
        return category !== null && rule.category === category;
      return rule.staffId === staffId;
    });
    if (matched) return matched;
  }
  return null;
}
```

候选规则先按「生效区间命中营业日 + `status='active'`」过滤，再 `sort` 升序 / `id` 升序排列：

```ts
// commission.service.ts:212
const rules = await tx
  .select()
  .from(bizCommissionRules)
  .where(
    and(
      eq(bizCommissionRules.status, 'active'),
      isNull(bizCommissionRules.deletedAt),
      lte(bizCommissionRules.effectiveFrom, businessDay),
      or(
        isNull(bizCommissionRules.effectiveTo),
        gte(bizCommissionRules.effectiveTo, businessDay),
      ),
    ),
  );
const ordered = [...rules].sort((a, b) => a.sort - b.sort || a.id - b.id);
```

**生效区间按营业日命中**：`businessDay = shopDateOf(booking.startAt, timeZone)` —— 跨夜单子按**开始那天**算规则。

### 计提基数

```ts
// src/modules/biz/reports/commission/commission.service.ts:790
/** 计提基数：`paid` 实收（默认，防挂账提前计提）/ `payable` 应付 / `original` 原价 */
export function baseOf(base, itemPrice, booking): number {
  if (base === 'original') return Math.max(itemPrice, 0);
  if (base === 'payable')
    return apportion(booking.payableAmount, itemPrice, booking.originalPrice);
  return apportion(booking.paidAmount, itemPrice, booking.originalPrice);
}
```

- 默认 `paid`（实收），**防止挂账提前计提**；
- 按**项目原价占比**分摊到明细，**向下取整**（`apportion()`，与项目排行同一个函数）；
- 金额：`commissionOf(baseAmount, permille, fixedAmount) = permilleOf(baseAmount, permille) + fixedAmount`（`money.ts:188`）。

数字例子：分类规则 100‰（10%）+ 美甲师固定 500 分；预约 `paid_amount = 8000`、`original_price = 10000`；某项目 `price = 4000` → 基数 `floor(8000×4000/10000) = 3200` → 提成 `floor(3200×100/1000) + 500 = 320 + 500 = 820` 分。

### 计提时点

```ts
// src/modules/biz/reports/commission/commission.service.ts:191
// 只在 completed 时计提；其它状态直接返回 0（不改动、不抛错，避免拖垮预约主流程）
if (!booking || booking.status !== 'completed')
  return { records: 0, amount: 0 };
```

- **逐 `biz_booking_item` 计提**（一单多项目 → 多条记录）；
- `period = shopDateOf(new Date(), timeZone).slice(0,7).replace('-','')` → `yyyyMM`，取的是**计提时点**的店内月份，不是预约月份；
- **幂等闸门**：同一 `booking_item_id` 已有 `status != 'reversed'` 的记录就跳过，读时用 `FOR UPDATE`；预约行也在事务内 `.for('update')` 锁住，并发调用被串行化：

```ts
const [existing] = await tx
  .select({ id: bizCommissionRecords.id })
  .from(bizCommissionRecords)
  .where(
    and(
      eq(bizCommissionRecords.bookingItemId, item.id),
      ne(bizCommissionRecords.status, 'reversed'),
    ),
  )
  .limit(1)
  .for('update');
if (existing) continue;

const rule = pickRule(
  ordered,
  booking.staffId,
  item.serviceItemId,
  categories.get(item.serviceItemId) ?? null,
);
// 未命中规则 → 不提成（不要猜默认比例）
if (!rule) continue;
```

::: danger 「未命中规则 → 不提成」，报表要单列
代码里**没有默认比例**。如果某个项目既没有项目规则、也没有分类规则、也没有美甲师规则，这一项**一分钱都不提**。运营侧要能看到"未配置规则"的单量，否则会以为系统算漏了。

**注意**：目前 `StaffReportRow` 只有 `bookings` / `amount` / `commission` / `avgScore` / `reviewCount`，**没有**「未配置规则单量」字段 —— 这是口径与实现的一处缺口，需要人工按「完成单量 × 应有提成」比对。
:::

### 补提：本期未做

::: warning 代码里明确标了 TODO

```ts
// commission.service.ts:168
* TODO（本期未做）：§20.3 的「尾款收清后补提差额」——当前口径是
* 「同一 booking_item 已计提即跳过」，补提需要按已收比例差额再插入一条记录；
* 等 B1 完成流程确认后补。
```

所以**当前行为**是：`completed` 那一刻按当时的 `paid_amount` 计提一次，之后补收尾款**不会**补提。报表里 `commission` 会低于"按最终实收应得"的金额。
:::

### 冲销

退款 / 取消时由 `RefundsService.executeRefund()` 调 `commission.reverseForBooking(tx, bookingId, reason, actorId)`：

```ts
// src/modules/biz/reports/commission/commission.service.ts:319
const result = await tx
  .update(bizCommissionRecords)
  .set({ status: 'reversed', remark: truncate(`冲销：${reason}`, 200) })
  .where(
    and(
      inArray(bizCommissionRecords.id, accruedIds),
      eq(bizCommissionRecords.status, 'accrued'),
    ),
  );
```

- **只动 `accrued`**：`settled` 的记录不动，但会 `logger.warn` 留痕（人工跟进）；
- 记录**不删**，只改 `status`；
- 单笔冲销 `POST /biz/commission-records/:id/reverse`（权限 `biz:commission:settle`，**必填原因**），条件更新当闸门，非 `accrued` 一律 409。

::: warning 「已结算期间的冲销进下一期为负数」本期未实现

```ts
// commission.service.ts:285
* 但会记一条 warning 便于人工跟进（§20.3 的「进下一期为负数」本期未实现，见交付说明）。
```

所以：**上一期已结算的提成，现在发生退款，账面上不会自动扣回**。只能靠人工在下期调整。这是当前已知缺口。
:::

### 结算冻结

`POST /biz/commission-settle { period }`（权限 `biz:commission:settle`）：

```ts
// src/modules/biz/reports/commission/commission.service.ts:353
/*
 * 这里**不加** `FOR UPDATE`：`(period, status)` 没有前缀索引，锁读会扫全表并把
 * 大量无关行锁住。改为「普通读拿 id → 条件更新当闸门」——
 * 并发结算时后提交的那个 `affectedRows < ids.length`，直接 409 回滚，不会重复结算。
 */
const rows = await tx
  .select({ id, amount })
  .from(bizCommissionRecords)
  .where(
    and(
      eq(bizCommissionRecords.period, period),
      eq(bizCommissionRecords.status, 'accrued'),
    ),
  );
if (!rows.length)
  throw new BadRequestException(
    `期间 ${period} 没有待结算（accrued）的计提记录`,
  );

const batch = buildSettleBatch(period, sequence); // S{yyyyMM}{seq}，seq = 该期间已有批次最大序号 + 1
const updated = await tx
  .update(bizCommissionRecords)
  .set({ status: 'settled', settledAt: new Date(), settleBatch: batch })
  .where(
    and(
      inArray(bizCommissionRecords.id, ids),
      eq(bizCommissionRecords.status, 'accrued'),
    ),
  );
if (affected !== ids.length)
  throw new ConflictException('结算期间有并发变更，请重试');
```

**结算的含义与不可逆性**：

- `accrued` → `settled` + `settled_at` + `settle_batch`；
- **结算后不可修改，只能冲销**；而冲销又只能动 `accrued` —— 所以**已结算的记录在系统里是不可逆的**；
- 批次号形如 `S202609001`（正则 `^S\d{6}(\d{3,})$`）；
- 结算不进操作日志表（记录表无 `updated_by` 列），改为 `logger.log` 显式留一条审计痕迹：

```ts
this.logger.log(
  `提成结算：期间 ${period}，批次 ${result.batch}，${result.count} 条，合计 ${result.amount} 分（操作人=${actorId}）`,
);
```

### 美甲师侧接口

`CommissionService.listByStaff()` / `summarizeByStaff()` 供小程序工作台使用（`GET /app/staff/performance`），返回 `{ accrued, settled, reversed }` 三个汇总 + 逐单明细（上限 `STAFF_COMMISSION_LIMIT`）。

## 退款 / 挂账 / 次卡在三处的处理差异

这是最容易算错的地方，一张表说清：

| 场景                  | 营收报表                                                                          | 提成                                                                                  | 会员账务                                                            |
| --------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| **在线/现金收款成功** | `gross += received_amount`                                                        | `completed` 时按 `base` 计提                                                          | `recordConsumption()` 加 `total_spent` + 积分                       |
| **退款（`success`）** | `refund += actual_amount`；`net = gross − refund`                                 | `reverseForBooking()` 只冲销 `accrued`；已 `settled` 的**不动**（warn）               | `reverseConsumption()` 回减 `total_spent` + 积分（不足写 `adjust`） |
| **挂账下单**          | **不计营收**（没有支付单）                                                        | 若预约已 `completed`，`paid` 基数为 0 → **计提 0**（不会提前计提）                    | **不产生积分**（积分跟着钱走）                                      |
| **挂账销账**          | `creditSettled` 列 + 计入 `gross`（支付单 `purpose='credit_settle'`）             | **不会补提**（补提本期未做）                                                          | 已成功部分 `recordConsumption()`；线上 pending 部分等回调           |
| **次卡核销**          | 金额列全 0，但 `cardUsedTimes` / `cardTimes` **单列计次**；`count` 仍计入完成单量 | `base='paid'` → 分摊到该项目的实收为 0 → **计提 0**；若规则用 `original` 则按原价计提 | `card_use` 是**零变动流水**（不动余额与积分）                       |
| **部分退款**          | 支付单 `partial_refunded` 仍在 `PAID_PAYMENT_STATUSES` 里（毛收入不扣）           | 按整单冲销该预约的 `accrued` 记录                                                     | 按退款金额比例回减                                                  |

::: danger 三个真实会算错的点

1. **提成按原价计提（`base='original'`）** → 退款时会多发工资。默认必须 `paid`。
2. **次卡核销的提成**：默认基数 `paid` 下折算为 0。若门店希望核销也给提成，必须显式配 `base='original'` 或 `base='payable'` 的规则 —— **系统不会替你猜**。
3. **挂账销账后提成不补** → 门店要自己决定是否在 `accrued` 记录上手改（目前无此入口）或等下期用别的规则补偿。
   :::

## 相关页面

- 支付与退款如何写账：[收银与支付通道接入](/backend/payment)、[退款判责与对账](/backend/refund-reconcile)
- 会员流水的写入方：[会员 · 储值 · 次卡 · 积分](/backend/membership)
- 应收账龄报表：[挂账与应收](/backend/credit)
- 报表页与图表实现：[后台前端（Vue 3）](/frontend/)
