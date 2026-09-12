---
title: 预约主链路实现
---

# 预约主链路实现

预约是本站的核心：**时段占用**（会超订）、**状态流转**（不可逆）、**资金**（会算错）三者叠加在同一条链路上。本页把这条链路讲透。

核心文件：

| 文件 | 职责 |
| --- | --- |
| `src/modules/biz/booking/bookings.service.ts` | 创建 / 改期 / 状态流转 / 结算（1891 行，主逻辑） |
| `src/modules/biz/booking/slots.service.ts` | 可约时段、冲突检测、锁、网格与班次校验 |
| `src/modules/biz/booking/booking-settlement.service.ts` | **资金字段唯一重算入口** `recalc()` |
| `src/modules/biz/common/ports.ts` | 端口（`BookingPort` / `SlotPort` / `SettlementPort` …）+ 状态枚举 |
| `src/modules/biz/common/money.ts` | 算价 `quoteBooking()` / 定金 `calcDepositAmount()` / `sumDuration()` / `maxBuffer()` |
| `src/modules/biz/base-data/service-items/` | 项目时长 `duration_minutes` 与缓冲 `buffer_minutes` 的来源 |

## 一、可约时段算法

### 公式

```
D = Σ 各项目时长           （sumDuration）
B = max(各项目缓冲)         （maxBuffer）
[dayStart, dayEnd) = shopDayRange(date)      ← 唯一允许的日界转换
```

1. **取班次**：`SchedulePort.resolveShifts(staffId, date)` → `{ off, segments }`。`off` 直接空结果。
2. **美甲师可做项目校验**：`staff_service_item` 空集合 = 可做全部；否则必须覆盖全部所选项目，否则 `reason='staff_cannot_do'`。
3. **取当天已有预约**：`status IN ('pending','confirmed','arrived') AND deleted_at IS NULL AND start_at < dayEnd AND end_at > dayStart`。
4. **枚举候选起点**：网格以**店内本地日 00:00** 为基准按 `stepMinutes`（默认 15）递增；`t + D <= segEnd`。
5. **提前期**：`channel='admin'` 用 `adminMinLeadMinutes`（默认 0），`channel='miniapp'` 用 `minLeadMinutes`（默认 60）。
6. **冲突判据（对称写法）**：

```
gap = max(B, b.buffer_minutes)
conflict = t < b.end_at + gap  &&  b.start_at < t + D + gap
```

真实实现（`src/modules/biz/booking/slots.service.ts`）：外层遍历 `segments`，网格起点 `firstGrid = dayStart + ceil(max(segStart − dayStart, 0) / stepMs) * stepMs`；内层 `for (let t = firstGrid; ; t += stepMs)`，命中 `t + durationMs > segEnd` 就 break、`t < earliest` 就 continue、`t > latest` 也 break；冲突判据就是上面的对称写法：

```ts
const conflict = existing.some((row) => {
  const gap = Math.max(bufferMinutes, row.bufferMinutes) * MINUTE_MS;
  return t < row.endAt.getTime() + gap && row.startAt.getTime() < t + durationMs + gap;
});
if (conflict) continue;
slots.push({
  startAt: formatShopDateTime(new Date(t), timeZone),
  endAt: formatShopDateTime(new Date(t + durationMs), timeZone),
});
```

### 返回值与 `reason`

`{ slots: [{ startAt, endAt }], reason?, durationMinutes, bufferMinutes }`，时间是**带偏移的 ISO8601**（如 `2026-09-11T10:00:00+08:00`）。

| `reason` | 含义 |
| --- | --- |
| `staff_cannot_do` | 美甲师不能做所选项目 |
| `out_of_window` | 超出 `biz.booking.maxAdvanceDays`（默认 30 天） |
| `off` | 当天有 `off` 请假例外 |
| `no_shift` | 没有任何班次段 |
| `fully_booked` | 有班次但全部被占 |

后端**必须返回 `reason`**，否则客服侧无法向顾客解释「为什么这天不能约」。

### 具体数字例子

设定：`stepMinutes=15`、`depositPermille=300`、时区 `Asia/Shanghai`。

- 项目：**90 分钟 / 缓冲 15 分钟** → `D = 90`，`B = 15`
- 美甲师周模板（周一）三个班次：`10:00–12:00`、`13:00–20:00`、`20:00–22:00`
- 当天已有预约：`11:00–11:30`（`buffer_minutes = 0`），`14:00–15:00`（`buffer_minutes = 30`）

**第一个班次 `10:00–12:00`**：起点需 `t + 90 <= 12:00`，故 `t ∈ {10:00, 10:15, 10:30}`。

- `10:00`：与 `11:00–11:30` 比，`gap = max(15, 0) = 15`。判据 `10:00 < 11:00+15min`（成立）且 `11:00 < 10:00+90min+15min = 11:45`（成立）→ **冲突**。
- `10:15`：`11:00 < 10:15+105min = 12:00` → 成立；`10:15 < 11:15` → 成立 → **冲突**。
- `10:30`：`10:30 < 11:15` 成立，`11:00 < 10:30+105min = 12:15` 成立 → **冲突**。

→ 第一个班次**全部不可约**（正确的：10:00 开始的 90 分钟服务要到 11:30 结束，与已有预约完全重叠；即使 10:30 开始也会在 11:00 撞上）。

**第二个班次 `13:00–20:00`**：

- `13:00`：与 `14:00–15:00`（`buffer_minutes=30`）比，`gap = max(15, 30) = 30`。判据 `13:00 < 15:00+30min = 15:30` 成立，且 `14:00 < 13:00+90min+30min = 15:00` 成立 → **冲突**。
- `13:15`、`13:30`：同理冲突（`14:00 < 13:30+120min = 15:30`）。
- `13:45`：`14:00 < 13:45+120min = 15:45` 成立 → **冲突**。
- …直到 `t` 满足 `t >= 14:00 + 30min + ...`：需要 `t + D + gap <= ` 或 `t >= 15:00 + 30min = 15:30`。
  - `15:30`：`15:30 < 15:30` 不成立（严格小于）→ **通过**。`15:30 + 90 = 17:00 <= 20:00` ✓

→ 第二个班次第一个可用起点是 **15:30**，随后 `15:45`、`16:00` … `18:30`（`18:30 + 90 = 20:00`）全部可用。

**第三个班次 `20:00–22:00`**：`20:00 + 90 = 21:30 <= 22:00` ✓，`20:00–21:30` 与 `21:15–22:45`（越界）→ 只有 `20:00` 与 `20:15` 等少数起点可用。

::: warning 缓冲只加一次
`end_at` **不含缓冲**，缓冲单独快照在 `booking.buffer_minutes`。比较时只加一次 `gap`。历史坑：v1.0 把缓冲写进 `end_at` 又再加 `B`，导致双重计入且前后不对称。
:::

## 二、冲突检测与锁

### 硬约束 1：`FOR UPDATE` 必须是事务内第一条语句

```ts
// src/modules/biz/booking/slots.service.ts
async lockStaffRow(tx: BizTx, staffId: number): Promise<void> {
  const [row] = await tx
    .select({ id: bizStaffs.id })
    .from(bizStaffs)
    .where(eq(bizStaffs.id, staffId))
    .for('update')
    .limit(1);
  if (!row) throw new BadRequestException('美甲师不存在');
}
```

MySQL 默认 **REPEATABLE READ** 下，一致性读快照在事务里**第一条普通 SELECT** 时建立。若在拿锁之前先普通查过一次，等锁期间别人提交的单子会落在快照之外，第 6 步复检会「看不见」它，**照样超订**。

### 硬约束 2：冲突复检查询也带 `FOR UPDATE`

`findConflicts()` 的 SQL 只做**粗筛**：`staff_id = ?` + 状态在 `ACTIVE_BOOKING_STATUS` + `deleted_at IS NULL` + `start_at < end + 1 天` + `end_at > start − 1 天`，并且 `.for('update')`（**当前读，永远看最新已提交版本**）。精确判据在内存里做：`rows.filter(排除 excludeBookingId)` 后按上面的对称 `gap` 公式逐条比。

> SQL 里的 ±1 天是**粗筛**：`gap = max(本单缓冲, 对方缓冲)` 依赖行内数据，写不进 SQL，所以精确判据在内存里做。单美甲师单日预约 < 20 条，代价可忽略。

### 锁粒度与锁顺序

- **锁的对象是 `biz_staff` 的那一行**，粒度刚刚好：同美甲师串行、不同美甲师互不阻塞，且不依赖可选的 Redis。
- **改期可能换美甲师**，所以要锁新旧两个 id，并且**按 id 升序加锁**防死锁：

```ts
// src/modules/biz/booking/bookings.service.ts 的 update()
const staffIds = [...new Set([staffId, current.staffId])].sort((a, b) => a - b);
await tx.select({ id: bizStaffs.id }).from(bizStaffs)
  .where(inArray(bizStaffs.id, staffIds))
  .orderBy(asc(bizStaffs.id))
  .for('update');
```

- 收银结算（不改时段）不锁美甲师，锁顺序是 `customer → payment`。
- **事务内一切读写必须用 `tx`**，不要用 `this.database.db`（`src/modules/biz/common/tx.ts` 的注释就是这条）。

### 并发抢单时的表现

`tests/integration/b1-booking.int.spec.ts` 的 `B1 并发与单号（§6.2）`：

| 用例（行号） | 断言 |
| --- | --- |
| `并发 10 个同一美甲师同时段创建 → 恰好 1 个成功`（L227） | 10 个并发，恰好 1 个成功 |
| `并发创建的单号唯一且格式为 B{yyyyMMdd}{id}`（L246） | 单号无重复 |
| `同一时段已有预约 → 第二次创建 409`（L213） | 第二个请求 **409「该时段已被占用，请重新选择」** |
| `对称性：先录 A 再录 B 与先录 B 再录 A，可约结果一致`（L183） | 缓冲只计一次且顺序无关 |

行为总结：**谁先拿到 `biz_staff` 行锁谁成功**；后到者等到锁释放后执行第 6 步复检，`findConflicts()` 返回非空 → `assertNoConflict()` 抛 `ConflictException('该时段已被占用，请重新选择')`。

## 三、两套状态机

### 服务状态机

`src/modules/biz/booking/bookings.service.ts` 里的 `TRANSITIONS` 表是**唯一事实来源**：

```ts
const TRANSITIONS = {
  confirm: ['pending'],
  arrive:  ['confirmed'],
  complete:['arrived'],
  'no-show': ['confirmed'],
  cancel:  ['pending', 'confirmed'],
} as const satisfies Record<string, readonly BookingStatus[]>;
```

```
                     ┌──────────── cancel ────────────┐
                     ▼                                │
  pending ──confirm──► confirmed ──arrive──► arrived ──complete──► completed   (终态)
                          │  │
                    cancel│  └──no-show──► no_show                        (终态)
                          ▼
                      cancelled                                            (终态)
```

| 动作 | 端点 | 权限点 |
| --- | --- | --- |
| confirm | `POST /biz/bookings/:id/confirm` | `biz:booking:update` |
| arrive | `POST /biz/bookings/:id/arrive` | `biz:booking:arrive` |
| complete | `POST /biz/bookings/:id/complete` | `biz:booking:complete` |
| no-show | `POST /biz/bookings/:id/no-show` | `biz:booking:noshow` |
| cancel | `POST /biz/bookings/:id/cancel` | `biz:booking:cancel` |

**每个动作是独立端点、独立权限点**，不做「一个 PATCH 改 status」。非法流转统一由条件更新兜底：

```ts
// transition()：条件更新 + affectedRows 闸门
const affected = await this.database.db.update(bizBookings)
  .set({ status: target, updatedBy: actorId, ...extra })
  .where(and(eq(bizBookings.id, id), inArray(bizBookings.status, [...allowed]), isNull(bizBookings.deletedAt)));
if (!affected[0].affectedRows) {
  const [exists] = await this.database.db.select({ status: bizBookings.status }) /* … */;
  if (!exists) throw new NotFoundException('预约不存在');       // 404
  throw new ConflictException(`当前状态（${exists.status}）不允许该操作`);  // 409
}
```

真实报错：`completed → arrived` 会得到 **409「当前状态（completed）不允许该操作」**（`tests/integration/b1-booking.int.spec.ts` L320）。

爽约/取消**必须填原因**，否则 400（`爽约必须填写原因` / `取消必须填写原因`）。

### 资金状态机

`pay_status` 的合法取值：`unpaid` / `partial` / `paid` / `refunded` / `credit`。

**唯一的写入者是 `BookingSettlementService.recalc()`**：

```
paid_amount   = Σ 成功支付单的 received_amount            （毛收入，不扣退款）
refund_amount = Σ 成功退款单的 actual_amount
due_amount    = max(payable_amount − paid_amount, 0)
净营收        = paid_amount − refund_amount
```

判定优先级（顺序有意义）：

```ts
if (paidAmount > 0 && refundAmount >= paidAmount) payStatus = 'refunded';
else if (paidAmount >= booking.payableAmount)     payStatus = 'paid';    // 应付 0（次卡）也落 paid
else if (booking.creditAccountId !== null)         payStatus = 'credit';  // 必须优先于 partial
else if (paidAmount > 0)                           payStatus = 'partial';
else                                               payStatus = 'unpaid';
```

::: danger 退款后的支付单也要计入 `paid_amount`
`COUNTED_PAYMENT_STATUS = ['success','partial_refunded','refunded']`（`booking-settlement.service.ts` 顶部）。若只认 `success`，退款后 `paid_amount` 会被清零、`due_amount` 变回全额、`pay_status` 退回 `unpaid`，**列表与报表口径全错**。这是真实踩过的坑。
:::

支付单自身状态机、退款单状态机见 [收银与支付通道接入](/backend/payment) 与 [退款判责与对账](/backend/refund-reconcile)。

## 四、创建预约：实际是九步（顺序不可调换）

`BookingsService.create()` 的注释直接标了 `§9.5 九步`，代码里的分步注释是真实的：

| 步骤 | 做什么 | 事务边界 |
| --- | --- | --- |
| **1** | Zod 校验入参（Controller 里的 `createSchema.parse(body)`） | 事务外 |
| **2** | 前置校验**全部在事务外**：顾客/美甲师存在且启用、`serviceItemIds` 去重且 1~3 个、美甲师可做这些项目、提前期、改价权限与原因 | 事务外 |
| **3** | 算 `D`/`B` 与全部金额（等级折扣 → 券 → 积分抵扣 → 改价 → 应付 → 定金） | 事务外 |
| **4** | 校验 `startAt` 落在 `stepMinutes` 网格、在班次内、`startAt + D` 不超班次 | 事务外 |
| **4.5** | 顾客同时段重叠**软检查**（`findCustomerOverlaps`，`force=true` 可覆盖） | 事务外 |
| **4.6** | **渠道下单是网络 IO，必须在事务外先做完**（`payments.prepareChannelOrders()`） | 事务外 |
| **5** | 开事务 → **第一条语句**锁美甲师行 `FOR UPDATE` | 事务 |
| **6** | 冲突复检（查询带 `FOR UPDATE`） | 事务 |
| **7** | 写 `biz_booking`（先 `tempDocNo()` 占位）→ 拿 `insertId` → `buildDocNo('B', id, tz)` 回填 `booking_no` → 写 `biz_booking_item` | 事务 |
| **8** | 收款：扣积分 → 逐笔 `payments.createInTx` → 挂账 `credit.createFromBooking` → `settlement.recalc()` → 记录消费 | 事务 |
| **9** | 提交事务 → **提交后**才发通知（`notices.send(...).catch(() => undefined)`） | 事务外 |

> **步骤 2 为什么必须在事务外**：任何在 `FOR UPDATE` 之前的普通 `SELECT` 都会建立 RR 快照，让第 6 步复检失效。

小程序自助下单 `createForCustomer()` **共用同一套九步**，三处差异：

1. 落 `channel='miniapp'` + `status='pending'`（后台代录直接 `confirmed`）；
2. **不收款**（JSAPI 支付 P2 才做），订单保持 `unpaid`；传 `memberCardId` 则整单次卡当场核销（`payable = 0`）；
3. **无改价、无 `force`、无挂账** —— 这三样是后台能力。

### 改期流程（`PATCH /biz/booking/:id`）

1. `findOne(id, actor)` + 状态必须 `pending`/`confirmed`，否则 409「仅待确认 / 已确认的预约可改期」
2. 解析新的 `staffId` / `startAt` / `serviceItemIds`（缺省沿用现值），重算 `D`/`B`
3. 网格对齐 + 班次包含校验（在事务外）
4. 改价权限校验（`assertAdjustAllowed`）
5. 用**当下的** `level_discount_permille` 与已用积分重算 quote
6. 顾客同时段软检查（`excludeBookingId: id`，`force` 可覆盖）
7. 事务：**按 id 升序锁新旧美甲师** → `assertNoConflict(excludeBookingId: id)` → `UPDATE biz_booking` → **删除并重建** `biz_booking_item` → `settlement.recalc()`
8. 事务后：若 `paid_amount > 新的 payable`，返回 `warning` 提示走退款单（**不做差额补收**）

### 取消流程

1. 原因必填，否则 400
2. `transition(id, 'cancelled', 'cancel', actor.id, { cancelReason, cancelledAt })` —— 条件更新，`affectedRows=0` → 409
3. 状态**真的变了**才冲销提成：`commissions.reverseForBooking(tx, id, reason, actor.id)`（包在事务里，`.catch(() => undefined)` 吞错）
4. 返回 `warning`：`paid_amount > 0` 时提示「该预约有实收，请到「退款审批」发起退款（系统不会自动退）」

### 完成流程（`runComplete`）

后台与小程序**共用**这一个实现（`actorId` 可为 `null`）：

1. 事务内 `lockBooking(tx, id)` → `assertTransition(status, 'complete')`
2. 条件更新 `status='completed', finished_at=now WHERE id=? AND status='arrived'`
3. `affectedRows=0` → 直接返回 `{ changed: false }`（**别人已改过，统计不双计**）
4. `customers.onBookingCompleted(tx, customerId)` 累加到店统计
5. `commissions.accrueForBooking(tx, id, actorId)` 计提提成
6. 事务后发 `booking_completed` 站内/短信通知
7. 返回 `warning`：`pay_status !== 'paid'` 时提示「尾款未结清，请到收银台催收」

小程序侧另加**时间护栏**：`start_at > now` 时 `BadRequestException('服务尚未开始，不能提前标记完成')`（防止提前刷提成）。

### 结算流程（`POST /biz/booking/:id/settle`，权限 `biz:payment:create`）

1. `findOne` + `cancelled`/`no_show` 直接 409「已取消 / 爽约的预约不能结算」
2. 积分**只能增加**：`requestedPoints < previousPoints` → 400「结算时只能增加积分抵扣，不能减少（减少需走冲正流程）」
3. 重算 quote；`dueAmount = max(payable − paid, 0)`；`inputTotal > dueAmount` → 400「收款金额超过待收尾款」
4. **渠道下单在事务外**（`prepareChannelOrders`）
5. 事务：锁会员账户 `members.lockAccount(tx, customerId)` → 补扣增量积分 → `UPDATE biz_booking`（`points_discount_amount` / `payable_amount`）→ 逐笔 `payments.createInTx` → 挂账 → `recalc()` → 记录消费
6. 返回 `{ ...settlement, payableAmount, payments }`

## 五、幂等

### 真正的幂等机制

**没有请求级幂等键字段**（`biz_booking` 上没有 `idempotency_key` 之类列）。幂等靠以下四层：

| 层 | 机制 | 真实字段 / 写法 |
| --- | --- | --- |
| 状态流转 | **条件更新 + `affectedRows` 闸门** | `UPDATE … WHERE id=? AND status='arrived'`；`affectedRows=0` 视为已处理，直接 `{ changed: false }` |
| 周期预约 | **唯一索引** | `uq_booking_recurrence_start` on `(recurrence_id, start_at)` —— 重复生成直接撞唯一键 |
| 支付单 | **唯一索引** | `uq_payment_no`、`uq_payment_out_trade_no`（渠道单号） |
| 通知提醒 | **业务去重查询** | `sendBookingReminders` 先查当天是否已有同 `(booking_id, template_code='booking_remind')` 的日志 |

```ts
// runComplete 的幂等闸门
const affected = await tx.update(bizBookings)
  .set({ status: 'completed', finishedAt: new Date(), updatedBy: actorId })
  .where(and(eq(bizBookings.id, id), eq(bizBookings.status, 'arrived'), isNull(bizBookings.deletedAt)));
if (!affected[0].affectedRows) return null;      // 别人已经改过，统计不双计
```

::: warning 创建预约本身**不幂等**
同一个 `POST /biz/bookings` 连发两次会**建两张单**（一笔是误录）。真正的重复保护是：
- 顾客同时段软检查 → 409「该顾客此时段已有预约，确认重复录入请带 force=true」；
- 美甲师时段硬冲突 → 409。
前端提交按钮必须在请求期间禁用；不要指望后端去重。
:::

`visit_count` / `last_visit_at` **只在状态真正变更时累加**，所以定时任务与手动「完成」不会双计。

### 单号生成

```ts
bookingNo: tempDocNo(),                                   // 插入时的临时占位（唯一）
const bookingId = Number(inserted[0].insertId);
const bookingNo = buildDocNo('B', bookingId, tz, new Date());  // B{yyyyMMdd}{id}
await tx.update(bizBookings).set({ bookingNo }).where(eq(bizBookings.id, bookingId));
```

先插占位再回填，保证 `uq_booking_no` 不冲突。格式 `B{yyyyMMdd}{id}`（`src/modules/biz/common/doc-no.ts`）。

## 六、改期 / 取消对钱的影响

| 已发生的收款 | 改期（新应付变低） | 取消 |
| --- | --- | --- |
| 定金 | **不自动退**；返回 `warning` 提示去退款审批发起退款 | **不自动退**；同样提示 |
| 尾款 | 同上，差额不退（**不做差额补收**） | 不自动退 |
| 次卡核销 | `member_card_id` 保留；`useCard` 时 `payable = 0`，改期只改时长/时段。撤销核销走 `member-cards` 的撤销接口 | 不退次数（如需退卡走退卡流程） |
| 挂账 | `credit_account_id` 保留；`pay_status` 由 `recalc()` 判为 `credit` | 已生成的 `biz_receivable` 需在挂账页作废 |
| 积分抵扣 | 改期重算 `points_used`；结算时**只能增加**积分抵扣 | 积分回补走冲正流程，不自动回补 |
| 提成 | — | 状态真变时 `reverseForBooking()` 冲销 |

::: danger 三条资金红线
1. **任何接口都不许自己写 `paid_amount` / `due_amount` / `pay_status` / `refund_amount` / `settled_at`**，一律 `settlement.recalc(tx, bookingId)`。
2. **改期不做差额补收**：`paid > 新 payable` 时只返回 `warning`，差额必须走退款审批。理由：补收要走渠道回调，而差额可能来自优惠叠加，语义无法自动判定。
3. **取消不回滚资金**：取消只改服务状态与冲销提成，退款/积分回补/次卡退回都由独立流程处理。
:::

## 七、关联的 `biz_*` 表与关键字段

定义在 `src/database/schema/index.ts`（drizzle 变量 → 真实表名）：

| drizzle 变量 | 表名 | 与预约主链路相关的关键字段 |
| --- | --- | --- |
| `bizBookings` | `biz_booking` | `booking_no`(uq) / `customer_id` / `staff_id` / `start_at` / `end_at`(不含缓冲) / `duration_minutes` / `buffer_minutes` / `original_price` / `level_discount_permille` / `level_discount_amount` / `coupon_id` / `coupon_discount_amount` / `points_discount_amount` / `adjust_amount` / `adjust_reason` / `payable_amount` / `deposit_amount` / `paid_amount` / `due_amount` / `pay_status` / `pay_channel_summary` / `settled_at` / `credit_account_id` / `recurrence_id` / `member_card_id` / `refund_amount` / `refunded_at` / `status` / `channel`(`admin`\|`miniapp`) / `customer_name` / `customer_phone` / `cancel_reason` / `confirmed_at` / `arrived_at` / `finished_at` / `cancelled_at` + `auditColumns` |
| `bizBookingItems` | `biz_booking_item` | `booking_id` / `service_item_id` / `name`(快照) / `duration_minutes`(快照) / `price`(快照) / `sort`；**不套 `auditColumns`**（从属子表豁免） |
| `bizStaffs` | `biz_staff` | 冲突锁的对象：`SELECT … FOR UPDATE` 锁这一行 |
| `bizStaffWeeklyShifts` | `biz_staff_weekly_shift` | 周模板，可约时段取班次用（**物理删表**） |
| `bizStaffScheduleOverrides` | `biz_staff_schedule_override` | 日期例外 `off`/`custom`（**物理删表**） |
| `bizServiceItems` | `biz_service_item` | `duration_minutes` → `D`；`buffer_minutes` → `B` |
| `bizStaffServiceItems` | `biz_staff_service_item` | 美甲师可做项目；空集合 = 可做全部 |
| `bizPayments` | `biz_payment` | `purpose`(`deposit`\|`final`\|`recharge`\|`card_buy`\|`credit_settle`) / `channel` / `amount` / `received_amount` / `status` / `out_trade_no`(uq) |
| `bizRefunds` | `biz_refund` | `actual_amount` 计入 `refund_amount` |
| `bizCustomers` | `biz_customer` | `level_id` / `points` / `balance_principal` / `balance_bonus` / `visit_count` / `last_visit_at` |
| `bizMemberCards` | `biz_member_card` | 次卡核销（`member_card_id`） |
| `bizCreditAccounts` / `bizReceivables` | `biz_credit_account` / `biz_receivable` | 挂账主体与应收单（`pay_status='credit'` 的对应物） |
| `bizBookingRecurrences` | `biz_booking_recurrence` | 周期规则；`uq_booking_recurrence_start` 是生成幂等的关键 |
| `bizCommissionRecords` | `biz_commission_record` | 完成时计提、取消时冲销 |

关键索引：`idx_booking_staff_time(staff_id, start_at, end_at)` 支撑冲突查询与可约时段；`idx_booking_status_start` / `idx_booking_status_end` 支撑定时任务。

::: warning 查询当天预约必须用范围条件
`WHERE staff_id=? AND start_at >= dayStart AND start_at < dayEnd`（或 `start_at < dayEnd AND end_at > dayStart`）。**不要写 `DATE(start_at) = :date`** —— 既破坏上面这些索引，又会被 UTC 存储坑掉 8 小时。
:::

## 延伸阅读

- [排班与可约时段算法](/backend/scheduling) —— 班次从哪来、主数据变更的冲突保护
- [收银与支付通道接入](/backend/payment) —— `createInTx` / 回调验签 / 定金尾款
- [退款判责与对账](/backend/refund-reconcile) —— `refund_amount` 与净营收
- [会员 · 储值 · 次卡 · 积分](/backend/membership) —— 算价输入与积分抵扣上限
- [挂账与应收](/backend/credit) —— `pay_status='credit'` 的后续
