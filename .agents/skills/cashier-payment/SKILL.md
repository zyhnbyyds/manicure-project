---
name: cashier-payment
description: 收银与支付：微信 Native 扫码/支付宝当面付、线下收款记账、定金与尾款、混合支付、回调验签与幂等、主动查单与关单、退款按服务阶段分流（开始前无理由全退 / 开始后店长手动）+ 额度预留与失败重试、渠道对账差异。写收银台、支付接口、退款、对账相关代码时加载。
whenToUse: 实现/修改 /biz/payments、/biz/refunds、/biz/payment-diffs、收银台；处理回调、尾款补收、退款执行与重试、对账差异。
metadata:
  version: '1.0.0'
  spec: project-design/superpowers/specs/2026-09-11-nail-salon-booking-design.md
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

## 待收款队列（§10.5）

队列 = 按资金状态分组 `payStatus=unpaid|partial|credit`，**并且必须带 `collectable=true`**。

- 已取消 / 爽约是**服务侧终态，双状态机不同步**：`cancel` 只改 `status`，`pay_status` 原样保留。
  收了 3000 定金再取消的单仍是 `partial` + `due_amount=7000`，光按 `payStatus` 筛会把它当待收款列出来。
- 服务端一份常量 `UNSETTLEABLE_BOOKING_STATUSES = ['cancelled','no_show']` 管两处：
  列表 `collectable` 过滤 + `applySettlement` 闸门（命中 409「已取消 / 爽约的预约不能结算」）。
- **列表排掉只是 UI 友好，闸门始终在服务端** —— 不要在前端把「能不能收」做成业务判断。
- 预约列表页（`biz:booking:list` 那个页面）**不要传** `collectable`：它必须能查历史取消单。
- 取消后仍有实收的钱，走「退款」，不是收银台的事（取消响应里的 `warning` 就是这么提示的）。

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

## 退款：按服务阶段分流（无理由全退 / 店长手动）

| 步骤       | 接口                                                                              | 权限                                                                       |
| ---------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 试算       | `POST /biz/refunds/preview { bookingId }`                                         | `biz:refund:apply`                                                         |
| 申请并执行 | `POST /biz/refunds { paymentId/bookingId, actualAmount?, mode, reason, liable? }` | 服务开始前 `biz:refund:apply`；服务开始后 `biz:refund:approve`（**店长**） |
| 重试执行   | `POST /biz/refunds/:id/approve`                                                   | `biz:refund:approve`                                                       |
| 驳回       | `POST /biz/refunds/:id/reject`（必填原因）                                        | `biz:refund:approve`                                                       |

- **阶段判定**（`resolveRefundStage(startAt, now)`）：只看当前时间与 `biz_booking.start_at`
  —— `now < start_at` → `before_start`；**否则** → `in_service`（含已完成）。**不看预约状态**。
  没有 `start_at`（如直接按 `paymentId` 退）一律按 `before_start`。
- `before_start`：**无理由全额退**。金额由服务端锁定为该支付单剩余可退（忽略前端传值）、
  `liable` 强制 `store`、**建单即执行**（不落 `pending`、不走审批队列）。
- `in_service`：必须带 `biz:refund:approve`（否则 403）；**必须手动填 `actualAmount`**
  （未填 400、≤0 400、超过剩余可退 400），`liable` 可选（默认 `store`）。
- 阶段落库到 `biz_refund.refund_stage`；新流程 `deduct_amount` 恒 0、`policy_id` 恒 null
  —— 老的 `hours_before` 判责规则**降级为参考**，只在 `preview.policySuggestAmount` 里出现。
- `apply` 内部直接调 `approve()` 执行，资金顺序**只有一份**：
  抢占执行权 → **先占额度（条件更新）** → 打渠道 → 同事务落地（回写 `refund_amount`、
  回减 `total_spent` 与积分、冲销提成）。渠道失败 → 释放额度 + 标 `failed`，
  该单可用 `approve` 重试（商户退款单号 = `refund_no`，渠道侧天然幂等）。
- `pending` 只在「执行中被中断」这类历史/异常数据里出现；`approve` / `reject` 保留，
  现在主要用于 `failed` 单重试与历史 `pending` 单收尾。
- 去向 `mode`：`original` 原路退回（在线支付强制原路，非在线渠道 400）/ `cash` 现金退 / `balance` 退入储值余额。
- **储值退款**：只退实付本金（`balance_principal`），同一套执行链路（见 `membership`）。

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
- 退款阶段：服务开始前申请 → `refund_stage='before_start'`、全额、`executed=true`（传小额也全额）；
  服务开始后无 `biz:refund:approve` → 403、未填金额 → 400、超额 → 400；店长填写后成功
- 渠道失败 → `failed` + 额度释放，`approve` 重试成功；`approve` 重复调用返回"已处理"
- 对账：构造两类差异 → 落库、可标记处理、重跑不重复
- 队列：收了定金的单被取消后**不进** `collectable=true` 队列，但不带该参数仍能查到、直接结算仍 409
- 沙箱或真实小额各跑通一次正向支付 + 一次退款

## 常见坑

- 回调里做重活（发通知、跑报表）导致应答超时 → 渠道重试风暴。重活放事务后。
- 把回调当"可信输入"直接改账 → 必须验签 + 校验金额。
- 退款金额用前端传值落库 → 服务开始前必须服务端锁定全额，服务开始后必须夹取到剩余可退之内。
- **队列只按 `payStatus` 筛** → 已取消 / 爽约的单（`pay_status` 不会变）混进待收款，店员点进去只会 409。队列必须带 `collectable=true`。
