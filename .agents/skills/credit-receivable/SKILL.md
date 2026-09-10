---
name: credit-receivable
description: 挂账与应收：挂账主体（顾客/公司/员工）、额度与账期、下单挂账（不写支付单、pay_status=credit）、销账不得超额、账龄与逾期标记、以及"挂账不计营收、销账才计入"的报表口径。写挂账/应收/销账相关代码时加载。
whenToUse: 实现或修改 /biz/credit-accounts、/biz/receivables 接口与台账页面；处理月结、销账、逾期、账龄。
metadata:
  version: '1.0.0'
  spec: docs/superpowers/specs/2026-09-11-nail-salon-booking-design.md
  sections: §4.5 / §9.9 / §18 / §15.7
---

# 挂账与应收

## 数据

| 表                       | 要点                                                                                                                 |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `biz_credit_account`     | `type`(customer/company/staff)、`credit_limit`（**0 = 不限**）、`used_amount`、`settle_day`（1..28，**0 = 不定期**） |
| `biz_receivable`         | `receivable_no=A{yyyyMMdd}{id}` 唯一、`amount`、`settled_amount`、`due_date`、`status`                               |
| `biz_receivable_payment` | 销账记录，只追加                                                                                                     |

## 挂账消费（§18.2）

- 收银时选 `channel=credit` + `creditAccountId` → 生成 `biz_receivable(open)`；
  **不写支付单**（挂账不是收付动作），预约 `pay_status='credit'` 并记 `credit_account_id`。
- 挂账前校验：`used_amount + 本次 ≤ credit_limit`（0 视为不限），超额 409 并提示剩余额度。
- 支持**部分挂账**：实收部分写支付单，未收部分写应收单（混合支付的一种）。
- 挂账**不产生积分**（积分跟着钱走）；销账时才累计。

## 销账与账龄（§18.3）

```
POST /biz/receivables/:id/settle { payments: [{ channel, amount, ... }] }
  → 写 biz_receivable_payment
  → 条件更新（不得超额）：
     UPDATE biz_receivable
        SET settled_amount = settled_amount + :x,
            status = IF(settled_amount + :x >= amount, 'settled', 'partial')
      WHERE id = :id AND settled_amount + :x <= amount
  → 回减 biz_credit_account.used_amount
  → 结清时回写预约 pay_status='paid' 并累计积分
```

- 账期：`due_date` = 挂账日之后第一个结算日；`settle_day=0` 时 `due_date` 为 NULL。
- `markOverdueReceivables`（每日 01:10）把 `open/partial` 且 `due_date < today` 置 `overdue`。
- 账龄分档：0-30 / 31-60 / 60+，汇总接口 `GET /biz/receivables/summary` 按主体输出。
- 作废：仅未销账时可 `cancel`（必填原因），同时回减 `used_amount`。

## 报表口径（§18.4，与 §15.7 不变量 6 一致）

- **挂账在下单时不计营收，销账成功时才计入**（与"净营收 = 成功支付 − 成功退款"对齐）。
- 应收余额 = `Σ (amount − settled_amount) where status in ('open','partial','overdue')`。

## 接口与权限

`biz:credit:list|create|update|delete`、`biz:receivable:list|settle|cancel`；
`receivable:settle`（销账）默认**只给店长**。

## 验收（§12 B4）

- 额度 5000 的主体挂 6000 → 被拒；挂 4000 → `used_amount=4000`
- 销账 1500 → 应收 `partial`、`used_amount=2500`；**超额销账被拒**（条件更新拦下）
- 到期日过后被标记 `overdue`，账龄汇总数字与明细对得上
- 销账后预约 `pay_status='paid'`、积分累计一次（重复提交不重复累计）

## 常见坑

- 挂账时也写一张 `biz_payment` → 会让 `paid_amount` 虚高、营收口径错乱。
- 销账用"读出来判断剩余" → 并发下会超额；必须条件更新。
- 忘记同步 `used_amount` → 额度形同虚设。
- 报表把挂账金额算进营收 → 与 §15.7 冲突（必须销账时才算）。
