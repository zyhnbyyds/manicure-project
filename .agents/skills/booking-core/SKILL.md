---
name: booking-core
description: 预约主链路：可约时段算法（班次−预约−缓冲，对称 gap）、冲突检测与 FOR UPDATE 锁、服务状态机与资金状态机、创建/改期/取消/结算的九步流程与幂等。改预约接口、算可约时段、排查撞单/超订时加载。
whenToUse: 实现或修改 available-slots / 创建预约 / 改期 / 状态流转 / settle；排查"为什么这个时段不可约""为什么会超订""尾款对不上"。
metadata:
  version: '1.0.0'
  spec: docs/superpowers/specs/2026-09-11-nail-salon-booking-design.md
  sections: §5 / §6.1~§6.4 / §7 / §9.5 / §12 B1
---

# 预约核心

## 可约时段算法（§5.2）

```
D = Σ 项目时长；B = max(项目缓冲)
[dayStart, dayEnd) = shopDayRange(date)          // 唯一允许的日界转换

1) 班次：当天 off 例外 → 空；custom 例外 → 用 custom 段；否则用周模板该 weekday 的段
1.5) 美甲师可做项目校验（staff_service_item 空 = 可做全部，否则必须覆盖）→ 否则 reason=staff_cannot_do
2) 已有预约：status IN ('pending','confirmed','arrived') AND deleted_at IS NULL
             AND start_at < dayEnd AND end_at > dayStart     // 范围条件，别用 DATE()
3) 枚举 t：网格以 dayStart 为基准按 step 递增；t + D <= segEnd
   提前期：admin 用 adminMinLeadMinutes（默认 0），miniapp 用 minLeadMinutes（默认 60）
   冲突判据（与录入顺序无关的对称写法）：
       gap = max(B, b.buffer_minutes)
       conflict = t < b.end_at + gap && b.start_at < t + D + gap
```

- 输出是 `{ slots: [{startAt,endAt}], reason? }`，时间是**带 +08:00 偏移的 ISO8601**。
- `end_at` **不含缓冲**；缓冲单独快照在 `buffer_minutes`。比较时**只加一次** `gap`。
  （历史坑：v1.0 把缓冲写进 `end_at` 又再加 `B`，导致双重计入且前后不对称。）

## 冲突检测与锁（§6.2，两条硬约束）

1. **`FOR UPDATE` 必须是事务内第一条语句**。MySQL RR 下一致性读快照在第一条普通 `SELECT` 时建立；
   若拿锁前先普通查询，等锁期间别人提交的单子会落在快照外，复检"看不见"→ 照样超订。
   更稳：**冲突复检查询也带 `.for('update')`**（当前读永远看最新已提交版本）。
2. 事务内一切读写用 `tx`，**不要** `this.database.db`。

锁的对象是 `biz_staff` 该行（粒度刚好：同美甲师串行、不同美甲师互不阻塞，且不依赖可选的 Redis）。
改期 / 改美甲师 / 改项目 / 确认，凡改变 `start_at`/`end_at`/`staff_id`/项目组合的，都走同一套「锁 + 复检」。

## 状态机

**服务状态（§7.1~7.3）**：`pending → confirmed → arrived → completed`；`pending/confirmed → cancelled`；
`confirmed → no_show`。终态：`completed` / `cancelled` / `no_show`。流转用**独立动作端点**
（`/arrive`、`/complete`、`/no-show`、`/cancel`），每个动作独立权限点。

**资金状态（§7.4）**：`unpaid → partial → paid`；退款后 `refunded`；挂账 `credit`。
支付单状态机：`pending → success | closed | failed`，`success → partial_refunded → refunded`。
退款单：`pending → approved → success`（或 `rejected` / `failed`）。

## 创建预约九步（§9.5，顺序不可调换）

1. Zod 校验入参
2. **前置校验全部在事务外**：顾客/美甲师/项目存在且启用、`serviceItemIds` 去重 1..3、
   美甲师可做这些项目、提前期、改价权限与原因
3. 算 `D` / `B` 与全部金额（§5.7：等级折扣 → 积分抵扣 → 改价 → payable → deposit）
4. 校验 `startAt` 落在 `stepMinutes` 网格（否则 400）、在班次内、`startAt + D` 不超出班次
5. 开事务 → **第一条语句**锁美甲师行 `FOR UPDATE`
6. 冲突检测（对称 gap 判据，查询带 `FOR UPDATE`）
7. 写 `biz_booking` + `biz_booking_item`（拿 `insertId`），回填 `bookingNo`
8. 收款（见 `cashier-payment`）：锁会员行 → 校验余额/次卡/积分 → 条件更新扣减 →
   写 `biz_payment` / `biz_member_transaction` → `BookingSettlementService.recalc()`
9. 提交事务 → **提交后**才发通知（通知失败不回滚业务）

> 第 2 步必须在事务外：任何在 `FOR UPDATE` 之前的普通 `SELECT` 都会建立 RR 快照，让第 6 步复检失效。

## 幂等与派生数据

- 状态流转用条件更新：`UPDATE ... WHERE id=? AND status='arrived'`，`affectedRows=0` 视为已处理。
- `visit_count` / `last_visit_at` 只在**状态真正变更**时累加，定时任务与手动「完成」不会双计。
- 金额字段一律 `recalc()`，别在业务里手算累加。

## 验收要点（§12 B1）

- 并发 10 个同一美甲师同时段创建 → **恰好 1 成功**
- 缓冲只计一次；同一对预约换个录入顺序结果一致
- 时区：本地日 `2026-09-11` 的时段落在 `[2026-09-10T16:00Z, 2026-09-11T16:00Z)`；进程 `TZ` 变化不影响结果
- `startAt` 不在网格 → 400；跨班次边界 → 拒绝；非法流转 → 拒绝
- `booking_no` 并发无重复

## 常见坑

- 用 `DATE(start_at) = :date` 查当天 → 索引失效；必须用范围条件。
- 把 `end_at` 当"含缓冲"用 → 与 §5.3 冲突。
- 忘记 `deleted_at IS NULL` → 软删的单子仍占时段。
- 客服侧「为什么不可约」没有 `reason` → 前端无法解释，必须返回 `reason`。
