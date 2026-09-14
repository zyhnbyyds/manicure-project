---
title: 挂账与应收
---

# 挂账与应收

本页覆盖**挂账下单、额度占用、销账、账龄与逾期**，以及「挂账不计营收、销账才计入」这条报表口径在代码里的真实体现。

- 代码位置：
  - `src/modules/biz/credit/credit-accounts/credit-accounts.service.ts`（270 行，只管主体档案）
  - `src/modules/biz/credit/receivables/receivables.service.ts`（814 行，**额度占用与销账的唯一实现**）
  - 预约侧资金状态：`src/modules/biz/booking/booking-settlement.service.ts`
- 表：`biz_credit_account`（`schema/index.ts:1562`）、`biz_receivable`（1592）、`biz_receivable_payment`（1636）
- 定时任务：`markOverdueReceivables`（cron `0 10 1 * * *`，每日 01:10）
- 报表：`GET /biz/reports/receivables`（见 [报表与提成核算](/backend/reports)）

## 挂账主体

```ts
// src/database/schema/index.ts:1562
/** 挂账主体：额度 0 = 不限，settle_day 0 = 不定期 */
export const bizCreditAccounts = mysqlTable('biz_credit_account', {
  id: int('id', { unsigned: true }).autoincrement().primaryKey(),
  name: varchar('name', { length: 50 }).notNull(),
  type: mysqlEnum('type', ['customer', 'company', 'staff']).notNull(),
  customerId: int('customer_id', { unsigned: true }),
  contact: varchar('contact', { length: 50 }),
  phone: varchar('phone', { length: 20 }),
  creditLimit: int('credit_limit', { unsigned: true }).default(0).notNull(),
  usedAmount: int('used_amount', { unsigned: true }).default(0).notNull(),
  settleDay: tinyint('settle_day', { unsigned: true }).default(0).notNull(),
  status: mysqlEnum('status', ['active', 'disabled']).default('active').notNull(),
  remark: varchar('remark', { length: 500 }),
  ...auditColumns,
}, (table) => [
  uniqueIndex('uq_credit_account_name').on(table.name),
  index('idx_credit_account_type').on(table.type, table.status),
  ...
]);
```

| 字段          | 口径                                                                                                   |
| ------------- | ------------------------------------------------------------------------------------------------------ |
| `type`        | `customer`（顾客）/ `company`（公司）/ `staff`（员工）                                                 |
| `creditLimit` | 额度（分），**0 = 不限**；`normalizeCreditLimit()` 把非法值回落 0                                      |
| `usedAmount`  | 已挂未结金额（分），**只由 `ReceivablesService` 在应收单事务内条件更新**                               |
| `settleDay`   | 月结日 **1..28**；**0 = 不定期**；`normalizeSettleDay()` 夹到 `[0, 28]`                                |
| `name`        | 全局唯一（`uq_credit_account_name`），**不过滤软删** —— 服务层的 `assertNameUnique()` 也按这个口径校验 |

默认值来自 `BIZ_CONFIG_DEFAULTS`：`biz.credit.defaultLimit = 0`（不限）、`biz.credit.defaultSettleDay = 5`。

### 接口与权限

| 接口                              | 权限点              | 说明                                   |
| --------------------------------- | ------------------- | -------------------------------------- |
| `GET /biz/credit-accounts`        | `biz:credit:list`   | 列表带 `outstandingAmount`（已挂未结） |
| `POST /biz/credit-accounts`       | `biz:credit:create` |                                        |
| `PATCH /biz/credit-accounts/:id`  | `biz:credit:update` |                                        |
| `DELETE /biz/credit-accounts/:id` | `biz:credit:delete` | 软删；**有未结应收时 409**             |

两条保护：

```ts
// src/modules/biz/credit/credit-accounts/credit-accounts.service.ts:156
if (patch.creditLimit !== undefined) {
  const limit = normalizeCreditLimit(patch.creditLimit);
  if (limit !== 0 && limit < row.usedAmount)
    throw new ConflictException(
      `挂账额度不能小于已挂账金额 ¥${formatYuan(row.usedAmount)}`,
    );
  patch.creditLimit = limit;
}
```

```ts
// src/modules/biz/credit/credit-accounts/credit-accounts.service.ts:178
async remove(id: number, actorId: number) {
  const [unsettled] = await tx.select({ id: bizReceivables.id }).from(bizReceivables)
    .where(and(eq(bizReceivables.creditAccountId, id),
               inArray(bizReceivables.status, OUTSTANDING_RECEIVABLE_STATUSES),   // open/partial/overdue
               isNull(bizReceivables.deletedAt))).limit(1);
  if (unsettled) throw new ConflictException('该主体存在未结应收，不能删除');
  ...
}
```

`outstandingAmount` 的聚合口径（与报表一致）：

```ts
// src/modules/biz/credit/credit-accounts/credit-accounts.service.ts:238
sql<string>`COALESCE(SUM(CAST(${bizReceivables.amount} AS SIGNED) - CAST(${bizReceivables.settledAmount} AS SIGNED)), 0)`;
```

## 下单挂账

### 不写支付单

```ts
// src/modules/biz/payment/payments/payments.service.ts:267
if (draft.channel === 'credit')
  throw new BadRequestException('挂账请使用 creditAccountId');
```

`PaymentsService.createInTx()` **拒绝** `channel='credit'`：挂账不是收付动作，走 `CreditPort.createFromBooking()` 生成应收单。

### 额度校验与占用

```ts
// src/modules/biz/credit/receivables/receivables.service.ts:184
override async createFromBooking(tx: BizTx, input: {...}) {
  const amount = normalizeAmount(input.amount);
  const account = await this.assertCreditAvailable(tx, input.creditAccountId, amount);
  // 顾客挂账校验：主体绑定了顾客时，只能给该顾客挂账
  if (account.customerId !== null && account.customerId !== input.customerId)
    throw new ConflictException('该挂账主体不属于此顾客');
  await this.customers.requireById(input.customerId, tx);

  const dueDate = resolveDueDate(account.settleDay, shopToday(timeZone));
  const [inserted] = await tx.insert(bizReceivables).values({
    receivableNo: temporaryDocNo(),      // 先占位，拿到 insertId 后回填 A{yyyyMMdd}{id}
    creditAccountId: account.id, bookingId: input.bookingId, customerId: input.customerId,
    amount, settledAmount: 0, dueDate, status: 'open', ...
  });
  const receivableNo = buildDocNo('A', receivableId, timeZone);

  // 占用额度：条件更新是并发闸门（超额时 affectedRows = 0）
  const claimed = await tx.update(bizCreditAccounts)
    .set({ usedAmount: sql`${bizCreditAccounts.usedAmount} + ${amount}` })
    .where(and(
      eq(bizCreditAccounts.id, account.id),
      eq(bizCreditAccounts.status, 'active'),
      isNull(bizCreditAccounts.deletedAt),
      sql`(${bizCreditAccounts.creditLimit} = 0 OR ${bizCreditAccounts.usedAmount} + ${amount} <= ${bizCreditAccounts.creditLimit})`,
    ));
  if (!claimed[0].affectedRows) throw new ConflictException('挂账额度不足或已被其它单据占用，请刷新后重试');
}
```

::: warning 超额拦截有**两层**，但真正的闸门是第二层
`assertCreditAvailable()`（`receivables.service.ts:258`）只做**只读校验**并给友好文案：

```ts
if (row.creditLimit !== 0 && row.usedAmount + requested > row.creditLimit) {
  const remaining = Math.max(row.creditLimit - row.usedAmount, 0);
  throw new ConflictException(`超出挂账额度，剩余 ¥${formatYuan(remaining)}`);
}
```

真正的并发闸门是上面那句 `UPDATE ... WHERE creditLimit = 0 OR used_amount + x <= credit_limit` —— 注释写明：「不锁行：真正的闸门是条件更新」。**不要把这两层合并成一层读-判断-写。**
:::

### 账期计算

```ts
// src/modules/biz/credit/receivables/receivables.service.ts:737
/** 账期：`settle_day` 1..28 → 挂账日之后第一个结算日；0 → 不定期（NULL） */
export function resolveDueDate(
  settleDay: number,
  today: string,
): string | null {
  if (!Number.isFinite(settleDay) || settleDay <= 0) return null;
  const day = Math.min(Math.max(Math.trunc(settleDay), 1), 28);
  const dayOfMonth = Number(today.slice(8, 10));
  const sameMonth = day > dayOfMonth; // 「之后第一个」：当月结算日还没到才取当月
  const targetYear = sameMonth || month < 12 ? year : year + 1;
  const targetMonth = sameMonth ? month : (month % 12) + 1;
  return `${targetYear}-${pad2(targetMonth)}-${pad2(day)}`;
}
```

`settle_day = 5`、挂账日 `2026-09-11` → `due_date = 2026-10-05`；挂账日 `2026-09-03` → `2026-09-05`。

### 预约侧资金状态

挂账后预约的 `pay_status` 由 `BookingSettlementService.recalc()` 判定：

```ts
// src/modules/biz/booking/booking-settlement.service.ts:93
let payStatus: PayStatus;
if (paidAmount > 0 && refundAmount >= paidAmount) payStatus = 'refunded';
else if (paidAmount >= booking.payableAmount) payStatus = 'paid';
else if (booking.creditAccountId !== null)
  payStatus = 'credit'; // 优先于 partial
else if (paidAmount > 0) payStatus = 'partial';
else payStatus = 'unpaid';
```

::: tip 挂账可与混合支付叠加
「现金 2000 + 挂账 8000」时 `paidAmount = 2000 > 0`、`dueAmount = 8000 > 0`、`creditAccountId != null` → `pay_status = 'credit'`（不是 `partial`）。收银台的挂账队列正是按这个状态筛的。
:::

预约上**不存**单一 `pay_channel`，只存 `pay_channel_summary`（`summarizeChannels()`：去重后按字母序拼接，如 `balance,cash`）—— 混合支付无法用单值表达。

## 销账

### 接口

```ts
// src/modules/biz/credit/receivables/receivables.controller.ts:82
@Controller('biz/receivables')
  @Get('summary')          // biz:receivable:list
  @Get()                   // biz:receivable:list
  @Get(':id')              // biz:receivable:list
  @Post(':id/settle')      // biz:receivable:settle  ← 默认只给店长
  @Post(':id/cancel')      // biz:receivable:cancel
```

销账渠道（`SETTLE_CHANNELS`，与 `biz_receivable_payment.pay_channel` 枚举一致）：

```ts
export const SETTLE_CHANNELS = [
  'cash',
  'wechat_offline',
  'alipay_offline',
  'balance',
  'wxpay_native',
  'alipay_qr',
] as const;
```

注意**不含** `credit`（不能挂账销账）与 `card`（次卡不产生金额）。

### 多笔混合 + 不得超额 + 留痕

```ts
// src/modules/biz/credit/receivables/receivables.service.ts:291
async settle(receivableId: number, input: SettleInput): Promise<SettleResult> {
  const payments = normalizeSettlePayments(input.payments);     // 空数组直接 400
  const total = payments.reduce((sum, item) => sum + item.amount, 0);

  // ---- 渠道下单是网络 IO：**在事务外**先做完 ----
  const paymentDrafts: PaymentDraft[] = payments.map((payment) => ({ ..., purpose: 'credit_settle', ... }));
  const preparedOrders = draftCustomerId === null ? [] : await this.payments.prepareChannelOrders(paymentDrafts);

  return this.database.db.transaction(async (tx) => {
    // 逐笔落支付单 + 写销账记录
    for (const [index, payment] of payments.entries()) {
      const outcome = await this.payments.createInTx(tx, { ...draft, customerId, channelOrder: preparedOrders[index] ?? undefined }, input.actorId);
      await tx.insert(bizReceivablePayments).values({ receivableId, amount: payment.amount, payChannel: payment.channel, paymentId: outcome.paymentId, paidAt: new Date(), ... });
    }
    // 闸门：`settled_amount + x <= amount`
    ...
  });
}
```

**销账闸门**：

```ts
// src/modules/biz/credit/receivables/receivables.service.ts:410
const updated = await tx
  .update(bizReceivables)
  .set({
    settledAmount: sql`${bizReceivables.settledAmount} + ${total}`,
    status: sql`IF(${bizReceivables.settledAmount} >= ${bizReceivables.amount}, 'settled', 'partial')`,
    settledAt: sql`IF(${bizReceivables.settledAmount} >= ${bizReceivables.amount}, NOW(), ${bizReceivables.settledAt})`,
    updatedBy: input.actorId,
  })
  .where(
    and(
      eq(bizReceivables.id, receivableId),
      inArray(bizReceivables.status, OUTSTANDING_RECEIVABLE_STATUSES),
      isNull(bizReceivables.deletedAt),
      sql`${bizReceivables.settledAmount} + ${total} <= ${bizReceivables.amount}`,
    ),
  );
if (!updated[0].affectedRows)
  throw new ConflictException('应收单已被其它销账操作更新，请刷新后重试');
```

::: danger `status` 里为什么写 `settledAmount >= amount` 而不是 `+ ${total}`
代码注释给了完整解释：MySQL 的 `SET` **从左到右求值**，后面的赋值能看到前面已更新的列值；drizzle 按表定义顺序生成 `SET`（`settled_amount` 在 `status` 之前），所以这里读到的是**加完之后**的值。写成 `settled_amount + x >= amount` 会**重复累加 x**，导致提前置 `settled`。已按真实 MySQL 验证。
:::

**额度回减**（用 `GREATEST` 兜底，无符号列绝不出现负数）：

```ts
await tx
  .update(bizCreditAccounts)
  .set({
    usedAmount: sql`GREATEST(CAST(${bizCreditAccounts.usedAmount} AS SIGNED) - ${total}, 0)`,
  })
  .where(eq(bizCreditAccounts.id, receivable.creditAccountId));
```

**销账后才累计消费与积分**：

```ts
// src/modules/biz/credit/receivables/receivables.service.ts:456
// 只按「本次**已成功**的实收合计」累计一次：在线渠道此时是 pending，
// 积分要等渠道回调成功后才计（「积分跟着钱走」，§15.3）。
const receivedNow = settled.filter((item) => item.status === 'success').reduce((sum, item) => sum + item.amount, 0);
if (receivedNow > 0) {
  await this.members.recordConsumption(tx, { customerId, paidAmount: receivedNow, bookingId: receivable.bookingId, ... });
}
```

注意：**在线渠道销账时支付单是 `pending`**，`receivedNow` 只算线下 / 储值部分；线上那笔的积分由支付回调的 `deliver()` 负责。这样不会重复累计。

### 部分销账

- 每次 `settle` 都写一条 `biz_receivable_payment`（**只追加**），一笔应收可以多次还款；
- 状态自动在 `open` / `partial` / `settled` 之间流转；
- 每次销账都调 `settlements.recalc(tx, bookingId)`，让预约的 `paid_amount` 跟上已成功的支付单（注释：「部分销账也要让预约的 paid_amount 跟上」）。

### 作废

`POST /biz/receivables/:id/cancel`（权限 `biz:receivable:cancel`，**必填原因**）：

- 仅 `settled_amount = 0` 且状态 ∈ `open` / `overdue` 可作废；
- 条件更新（`WHERE id=? AND settled_amount=0 AND status IN ('open','overdue')`）当闸门；
- 同一事务内：回减 `used_amount`（`GREATEST` 兜底）、把预约的 `credit_account_id` 置 `null`、再 `recalc()` 把资金状态从 `credit` 拉回真实值（无实收 → `unpaid`）。

```ts
// src/modules/biz/credit/receivables/receivables.service.ts:534
// 主体没了：预约不能再挂在它名下；再让唯一重算入口把资金状态从
// `credit` 拉回真实值（无实收 → unpaid），避免台账与预约资金状态不一致。
if (receivable.bookingId !== null) {
  await tx
    .update(bizBookings)
    .set({ creditAccountId: null })
    .where(eq(bizBookings.id, receivable.bookingId));
  await this.settlements.recalc(tx, receivable.bookingId);
}
```

## 账龄与逾期

### 逾期标记

```ts
// src/modules/biz/credit/receivables/receivables.service.ts:547
/** 定时任务用（每日 01:10）：置逾期，幂等且不碰钱 */
override async markOverdue(): Promise<{ overdue: number }> {
  const today = shopToday(await this.timeZone());
  const result = await this.database.db.update(bizReceivables)
    .set({ status: 'overdue' })
    .where(and(
      inArray(bizReceivables.status, ['open', 'partial']),
      isNotNull(bizReceivables.dueDate),
      lt(bizReceivables.dueDate, today),
      isNull(bizReceivables.deletedAt),
    ));
  return { overdue: result[0].affectedRows };
}
```

::: info 部分还款但未结清的单也会被标逾期
注意 `partial` 也会被标记为 `overdue`（部分还款但已过到期日，仍然是逾期），`settled` / `cancelled` 不动。
:::

### 账龄口径

`GET /biz/receivables/summary`（`ReceivablesService.summary()`）：

```
账龄基准日 base = due_date ?? (created_at 的店内本地日)
账龄 age = max(daysBetween(base, today), 0)          // 未到期（差值为负）归入 0-30 档
分档：age <= 30 → age0to30；age <= 60 → age31to60；否则 age60plus
逾期金额 overdueAmount：due_date !== null 且 due_date < today（与列表 overdue=true 同一口径）
```

数据量小，直接**内存聚合**（口径与明细一致）。返回行的金额字段是**未结余额**（`amount − settled_amount`），另有 `totalAmount` / `settledAmount` / `openCount`。

### 报表里的账龄

`GET /biz/reports/receivables`（`reports.service.ts:1023`）口径**相同但有两点差异**：

- 若传了 `dateFrom` / `dateTo`，按 `biz_receivable.created_at` 落在店内本地日区间内过滤；
- 主体集合取**全部未软删主体**（含零余额主体），方便与 `/biz/receivables/summary` 交叉核对。

```ts
const agingDays = row.dueDate
  ? Math.max(daysBetween(row.dueDate, asOf), 0)
  : Math.max(daysBetween(createdDay, asOf), 0);
const isOverdue =
  row.dueDate !== null && row.dueDate !== undefined && row.dueDate < asOf;
```

## 报表口径：挂账不计营收，销账才计入

这条规则不需要额外的"排除逻辑" —— 它**天然成立**，因为：

1. **挂账下单不写 `biz_payment`**（`createFromBooking` 只写 `biz_receivable`）；
2. **营收 = Σ 成功支付单 `received_amount`**（`reports.service.ts` 的 `paymentRows()`）；
3. 销账时落 `purpose='credit_settle'` 的支付单 → 那一刻才进入营收。

代码里的直接体现：

```ts
// src/modules/biz/reports/analytics/reports.service.ts:242
/** 计入「实收」的支付单状态（§15.7 不变量 4：毛收入不扣退款） */
const PAID_PAYMENT_STATUSES = [
  'success',
  'partial_refunded',
  'refunded',
] as const;
```

```ts
// src/modules/biz/reports/analytics/reports.service.ts:730（营收报表按渠道拆列）
row.gross += payment.receivedAmount;
if (payment.purpose === 'credit_settle') row.creditSettled += payment.receivedAmount;
if (payment.channel === 'cash') row.cash += payment.receivedAmount;
else if (...) ...
```

`RevenueReportRow` 里 `creditSettled` 是**单列**的：既计入 `gross` / `net`，又能单独看出「其中多少来自销账」，方便手工复核。

::: danger 常见错误：把挂账金额算进营收

- ❌ 用 `SUM(biz_booking.payable_amount)` 当营收 → 应付 ≠ 实收（有定金、挂账、退款）；
- ❌ 用 `SUM(biz_booking.paid_amount)` 当营收 → `paid_amount` 是**预约维度**的派生冗余，混了充值 / 购卡类无预约的收款；
- ❌ 挂账时也写一张 `biz_payment` → 会让 `paid_amount` 虚高、营收口径错乱，同时 `pay_status` 也判不出 `credit`。
  :::

**应收余额**口径（`OUTSTANDING_RECEIVABLE_STATUSES = ['open', 'partial', 'overdue']`）：

```
应收余额 = Σ (amount − settled_amount) where status in ('open','partial','overdue')
```

## 相关页面

- 支付单与回调：[收银与支付通道接入](/backend/payment)
- 退款与对账：[退款判责与对账](/backend/refund-reconcile)
- 报表全部口径：[报表与提成核算](/backend/reports)
- 应收台账前端页：[后台页面与权限点清单](/frontend/pages)
