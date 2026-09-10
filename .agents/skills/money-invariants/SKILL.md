---
name: money-invariants
description: 资金相关写入的红线：金额事实的唯一来源、条件更新模板（余额/次数/积分/销账/退款/回调）、全局锁顺序、只追加与冲正、对账等式。任何涉及钱、余额、积分、次卡、应收的写入都必须先加载本技能。
whenToUse: 写任何改动余额 / 积分 / 次卡次数 / 支付单 / 退款单 / 应收的代码；评审他人资金代码；排查账实不符。
metadata:
  version: '1.0.0'
  spec: docs/superpowers/specs/2026-09-11-nail-salon-booking-design.md
  sections: §6.5 / §6.6 / §15.7 / §17
---

# 资金红线（违反任一条都是生产事故）

## 1. 金额事实只有两个来源

`biz_payment`（收付）与 `biz_refund`（退款）。预约上的金额字段**全部是派生冗余**：

```
paid_amount    = Σ biz_payment(status ∈ success/partial_refunded/refunded).received_amount
refund_amount  = Σ biz_refund(status = success).actual_amount
due_amount     = max(payable_amount − paid_amount, 0)
净营收         = paid_amount − refund_amount
```

**唯一写入方**是 `BookingSettlementService.recalc(bookingId)`；任何接口、任务、脚本都**不准**直接 UPDATE
这些字段。

## 2. 全局锁顺序（跨表事务必须遵守，防死锁 1213）

```
biz_staff → biz_customer → biz_payment → biz_member_card   （同类多行按 id 升序）
```

## 3. 条件更新是唯一的幂等闸门（不要"读出来再判断"）

```sql
-- 余额（本金/赠送分开判，余额永不为负）
UPDATE biz_customer SET balance_bonus = balance_bonus - :b, balance_principal = balance_principal - :p
 WHERE id = :id AND balance_bonus >= :b AND balance_principal >= :p;

-- 次卡核销
UPDATE biz_member_card SET used_times = used_times + 1,
       status = IF(used_times + 1 >= total_times, 'used_up', 'active')
 WHERE id = :id AND status = 'active' AND used_times < total_times;

-- 积分（抵扣 / 兑换）
UPDATE biz_customer SET points = points - :p WHERE id = :id AND points >= :p;

-- 支付回调落地（重复回调必须自然放弃）
UPDATE biz_payment SET status='success', transaction_id=:txn, paid_at=:channelTime, callback_at=NOW()
 WHERE out_trade_no = :outTradeNo AND status = 'pending';

-- 退款执行（只执行一次）
UPDATE biz_refund SET status='success', channel_refund_id=:id, refunded_at=:now
 WHERE id = :id AND status = 'approved';

-- 销账不得超额
UPDATE biz_receivable
   SET settled_amount = settled_amount + :x,
       status = IF(settled_amount + :x >= amount, 'settled', 'partial')
 WHERE id = :id AND settled_amount + :x <= amount;
```

`affectedRows = 0` → 抛 409 或直接返回"已处理"（回调场景），**不要**改成读-判断-写。

## 4. 只追加 + 冲正

- `biz_member_transaction` / `biz_payment_log` / `biz_receivable_payment` / `biz_commission_record` /
  `sys_notice_log` 只插入，不更新不删除。
- 纠错一律**反向流水**：`reversal_of` 指向原流水，`remark` 写原因；原记录保持不动。
- 支付单/退款单作废用状态（`closed` / `failed` / `rejected`），不物理删。

## 5. 定时任务不碰钱

定时任务只改状态与等级（关单、置逾期、次卡到期、等级重算、通知重试、周期生成）。
**任何**改余额 / 积分 / 金额的任务都是设计错误。

## 6. 对账等式（必须随时成立）

```
SUM(balance_delta_principal) = biz_customer.balance_principal
SUM(balance_delta_bonus)     = biz_customer.balance_bonus
SUM(points_delta)            = biz_customer.points
```

不一致 → 用 `recount` 修复并记录原因，**禁止手改字段**。

## 7. 事务边界

- **收款与建单同事务**：「先收款后异步建单」「先建单后补收款」都是禁止的。
- 回调处理：验签 → 校验金额与 `out_trade_no` → 条件更新 → **同事务**完成"发货"
  （recalc + 会员流水 + 积分 + 等级 + 通知记录）→ **3 秒内应答渠道**；通知等重活放事务后。
- 退款：审批通过后才执行；成功后同事务回写 `refund_amount`、按比例回减 `total_spent` 与积分、
  冲销提成（§20.3）。

## 8. 安全校验

- 回调**必须验签**；金额与订单不一致 → 写 `biz_payment_log(event='callback_invalid')` 并**拒绝**，
  绝不按回调金额改账。
- 所有金额由**服务端重算**，前端传来的金额只用于展示与二次确认。
- 折扣率 / 赠送比例 / 积分抵扣上限都必须夹取配置上限（`*_permille`）。

## 自检清单（提交资金代码前逐条过）

- [ ] 所有扣减都是条件更新，没有"读-算-写"
- [ ] 锁顺序符合 §6.6，事务内一律 `tx`
- [ ] 派生字段只由 `recalc` / 会员账务 service 写
- [ ] 新增写入只插不改；纠错走反向流水
- [ ] 幂等：同一请求重放 N 次结果一致（写集成测试）
- [ ] 并发：同一会员并发扣减不会变负（写集成测试）
- [ ] 不涉钱的定时任务真的没碰钱
