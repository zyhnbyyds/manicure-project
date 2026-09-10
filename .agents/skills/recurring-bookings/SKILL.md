---
name: recurring-bookings
description: 周期预约：规则字段（每周几 + 开始时间 + 生效区间 + 滚动窗口）、批量生成的幂等游标与唯一约束、生成时跳过收款（unpaid）、冲突策略 skip/notify、以及"改规则不回溯已生成单据"。写周期预约规则、生成任务或排查重复生成时加载。
whenToUse: 实现或修改 /biz/recurrences、generated_until 滚动生成任务、周期单与排班/请假的交互。
metadata:
  version: '1.0.0'
  spec: docs/superpowers/specs/2026-09-11-nail-salon-booking-design.md
  sections: §4.6 / §5.9 / §9.11 / §21 / §12 B5
---

# 周期预约

## 规则字段（`biz_booking_recurrence`）

`customer_id` + `staff_id` + `service_item_ids`(json) + `weekday`(1..7) + `start_time` +
`duration_minutes` + `start_date` + `end_date`(可空) + `generate_days`(默认 30) +
`generated_until`(**幂等游标**) + `status`(active/paused/stopped) + `conflict_policy`(skip/notify)

同一顾客可有多个规则（每周三 + 每周六）；同一规则的 `(staff_id, weekday, start_time)` 重复时创建接口给 409，
避免同一时段生成两单。

## 生成算法（§5.9）

```
窗口 = [max(today, generated_until + 1), min(today + generate_days, end_date)]

对窗口内每个 weekday 匹配的日期：
    t = date + start_time（按 Asia/Shanghai 解释成绝对时刻）
    逐个走 §9.5 的校验：班次、美甲师可做项目、缓冲与冲突（对称 gap 判据）
    若撞已有未完成预约：
        conflict_policy='skip'   → 跳过 + 记通知日志
        conflict_policy='notify' → 照旧生成，标记"待人工处理"并通知店员
    否则：建单，**跳过收款**（默认 pay_status='unpaid'）
generated_until = 窗口右端
```

**幂等（必须）**：

- `generated_until` 游标 + `biz_booking` 上 `(recurrence_id, start_at)` 唯一约束，双保险；
- 任务重跑、并发跑都不产生重复单；
- 规则页提供「撤销本窗口生成的单」——**仅限未被收款的单**。

## 与其它模块的交互

- **收款策略**：周期单默认**不收预付款**（熟客、按期到店），到店结算；这是"创建即收款"的**唯一例外**，
  前端必须明确标识（避免收银台以为钱已收）。
- **排班 / 请假**：未来窗口若因 `off` 例外无班次 → 自然跳过；已生成的单按 §6.4 处理（提示改期）。
- **变更不回溯**：改规则（时间 / 项目 / 有效期）**只影响未来生成**；已生成的单要改必须逐单改
  （走 §6.3 的锁 + 复检）。

## 状态

| 状态      | 行为                                                |
| --------- | --------------------------------------------------- |
| `active`  | 按窗口滚动生成                                      |
| `paused`  | **不再生成，已生成的单不受影响**（可恢复）          |
| `stopped` | 终态；软删规则时把已生成预约的 `recurrence_id` 置空 |

## 接口与权限

`GET/POST/PATCH /biz/recurrences`、`POST /biz/recurrences/:id/pause|resume|stop`、
`DELETE /biz/recurrences/:id`、`GET /biz/recurrences/:id/bookings`；
权限点 `biz:recurrence:list|create|update|delete`。
创建时**立即生成第一个窗口**并返回生成成功 / 冲突数。

## 验收（§12 B5）

- 「每周三 15:00，未来 4 周」→ 恰好 4 单，且都回指 `recurrence_id`
- 任务重跑不产生重复单（唯一约束 + 游标）
- 撞已有预约时按 `conflict_policy` 跳过或标记并通知
- 暂停后不再生成，**已生成的单不受影响**；「撤销本窗口」只对未收款的单生效

## 常见坑

- 用"今天 + N 天"直接算窗口而不看 `generated_until` → 补跑历史时重复生成。
- 生成时顺手收款 → 周期单默认 `unpaid`，不要把线上的收款逻辑套进来。
- 改规则时连带更新已生成的单据 → 违反"不回溯"，会让顾客已确认的时间被悄悄改掉。
- period 类 date 与 `time` 组合忘走 `shopDayRange` / 本地时区解释 → 整体偏 8 小时。
