---
name: cashier-payment
description: 收银与支付：微信 Native 扫码/支付宝当面付、线下收款记账、定金与尾款、混合支付、回调验签与幂等、主动查单与关单、退款判责与申请审批分离、渠道对账差异。写收银台、支付接口、退款、对账相关代码时加载。
whenToUse: 实现/修改 /biz/payments、/biz/refunds、/biz/payment-diffs、收银台；处理回调、尾款补收、退款审批、对账差异。
metadata:
  version: '1.0.0'
  spec: docs/superpowers/specs/2026-09-11-nail-salon-booking-design.md
  sections: §4.5 / §5.8 / §7.4 / §9.8 / §17 / §12 B3
---

# 收银与支付

## 通道矩阵（§17.1）

| 通道                                | 含义                                                  | 是否需要通道对接 |
| ----------------------------------- | ----------------------------------------------------- | ---------------- |
| `wxpay_native` / `alipay_qr`        | 在线扫码（顾客扫店家码），生成 `code_url`，5 分钟失效 | ✅ 需商户号/证书 |
| `cash`                              | 现金，只记账（`received_amount` 可大于 `amount`）     | ❌               |
| `wechat_offline` / `alipay_offline` | 店家自己的收款码，只记账                              | ❌               |
| `balance`                           | 储值余额（走会员流水）                                | ❌               |
| `card`                              | 次卡核销（不产生金额）                                | ❌               |
| `credit`                            | 挂账（生成应收单，见 `credit-receivable`）            | ❌               |
| `wxpay_jsapi`                       | 小程序内支付，**本期只留契约**                        | P2               |

> 本期只有 Native 扫码：不做小程序 UI 也能收钱。通道未配置时接口返回「通道未启用」，其它方式照常可用。

## 定金 / 尾款 / 混合支付（§5.8、§17.2）

```
下单   payMode=full    → 应收 = payable_amount
       payMode=deposit → 应收 = min(depositAmount, payable_amount)，其余成为 due_amount
收款   payments[] 支持多笔（混合），逐笔建 biz_payment
       → 全部成功后 BookingSettlementService.recalc()：
         paid_amount / due_amount / pay_status / pay_channel_summary
结清   due_amount = 0 → pay_status='paid'，写 settled_at
补收   POST /biz/bookings/:id/settle（到店后、完成前后均可，直到结清）
```

- 定金不得超过应付（超出 400）；尾款**不阻断** `complete`，但响应要带 `warning: '尾款未结清'`。
- 挂账可与混合支付叠加（`balance` 2000 + `credit` 8000）。
- 预约上**不存**单一 `pay_channel`，只存 `pay_channel_summary`（混合支付无法用单值表达）。

## 在线支付两步 + 回调（§17.3）

```
1) POST /biz/payments → 事务内建 biz_payment(pending, out_trade_no, expire_at=+5min)
   → 渠道统一下单 → code_url → 写 biz_payment_log(create) → 返回二维码
2) 收银台轮询 GET /biz/payments/:id/status
3) 回调 POST /biz/payments/notify/{channel}（公开端点，不进 AccessTokenGuard）
   验签 → 校验金额 == payment.amount、out_trade_no 存在
        → 条件更新 status='success'（幂等闸门）
        → 同一事务发货：recalc + 会员流水 + 积分 + 等级 + 通知记录(pending)
        → 3 秒内应答渠道
4) 兜底：queryPendingPayments 每 2 分钟主动查单；closeExpiredPayments 每分钟关超时单
```

- 金额不一致 → 写 `biz_payment_log(event='callback_invalid')` 并**拒绝**，绝不按回调金额改账。
- 同一预约重新收款要**新建**支付单，旧 `pending` 先关单（`out_trade_no` 全局唯一）。
- 密钥走环境变量：`WXPAY_MCHID` / `WXPAY_SERIAL_NO` / `WXPAY_PRIVATE_KEY` / `WXPAY_API_V3_KEY`、
  `ALIPAY_APP_ID` / `ALIPAY_PRIVATE_KEY` / `ALIPAY_PUBLIC_KEY`。

## 退款：判责 + 申请/审批分离（§17.4）

| 步骤       | 接口                                                                        | 权限                                 |
| ---------- | --------------------------------------------------------------------------- | ------------------------------------ |
| 试算       | `POST /biz/refunds/preview { bookingId }`                                   | `biz:refund:apply`                   |
| 申请       | `POST /biz/refunds { paymentId/bookingId, amount?, mode, reason, liable? }` | `biz:refund:apply`                   |
| 审批并执行 | `POST /biz/refunds/:id/approve`                                             | `biz:refund:approve`（**只给店长**） |
| 驳回       | `POST /biz/refunds/:id/reject`（必填原因）                                  | `biz:refund:approve`                 |

- 命中规则：`hours_before ≤ 实际提前小时数` 中最大的那条；都不命中 → 全退。
  默认档位：≥24h 全退 / 24h~2h 退 50% / <2h 或爽约不退。
- 规则只给**建议**：`liable=customer` 按规则扣减；`liable=store` / 不可抗力 → 全退；金额可改但必须填原因。
- 去向 `mode`：`original` 原路退回（在线支付强制原路）/ `cash` 现金退 / `balance` 退入储值余额。
- 执行用条件更新保证**只退一次**（`WHERE id=? AND status='approved'`）；
  成功后同事务回写 `biz_booking.refund_amount`、回减 `total_spent` 与积分、冲销提成。
- **储值退款**：只退实付本金（`balance_principal`），同一套审批流程（见 `membership`）。

## 对账（§17.5）

- `reconcilePayments` 每日 6:30 拉前一日渠道账单，按 `transaction_id` / `out_trade_no` 逐笔比对。
- 四类差异写 `biz_payment_diff`：系统缺单 / 渠道缺单 / 金额不一致 / 状态不一致；
  唯一键 `(bill_date, channel, transaction_id, diff_type)` 保证可重入。
- 差异必须人工处理并填备注（`resolved` / `ignored`），**不允许静默忽略**；不自动改账。

## 验收（§12 B3）

- 定金 3000 → `partial`、`due_amount` 正确；`settle` 收清 → `paid` + `settled_at`
- 应付 10000，`balance` 4000 + `cash` 6000 → 2 张支付单、`paid`、`pay_channel_summary='balance,cash'`
- 同一回调重放 3 次 → 只生效 1 次；**金额不一致的回调被拒**并留证
- 5 分钟未支付 → `closed`；关单后回调到达不影响账
- 判责：30h 前取消全退、1h 前取消扣 50%；审批通过后重复调用返回"已处理"
- 对账：构造两类差异 → 落库、可标记处理、重跑不重复
- 沙箱或真实小额各跑通一次正向支付 + 一次退款

## 常见坑

- 回调里做重活（发通知、跑报表）导致应答超时 → 渠道重试风暴。重活放事务后。
- 把回调当"可信输入"直接改账 → 必须验签 + 校验金额。
- 退款金额用前端传值落库 → 必须服务端按支付单已退金额夹取。
