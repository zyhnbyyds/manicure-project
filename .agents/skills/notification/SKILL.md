---
name: notification
description: 通知模块：短信 + 站内消息的模板（code + 变量校验）、触发点与默认渠道、事务后发送失败不回滚、SmsProvider 抽象与未配置降级、失败重试与站内 inbox。写通知模板、发送逻辑、排查"顾客没收到短信"时加载。
whenToUse: 实现或修改 sys_notice_template / sys_notice_log、短信通道、站内消息、提醒任务（次日提醒、次卡到期、应收逾期）。
metadata:
  version: '1.0.0'
  spec: docs/superpowers/specs/2026-09-11-nail-salon-booking-design.md
  sections: §4.6 / §8.1 / §9.11 / §19 / §12 B5
---

# 通知（短信 + 站内消息）

## 数据

| 表                    | 要点                                                                                                                                                                                                                                              |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sys_notice_template` | `code` 唯一、`channel`(sms/site/both)、`title`、`content`（含 `{变量}`）、`variables`(json)、`status`                                                                                                                                             |
| `sys_notice_log`      | 只追加：`channel`、`recipient_type`(customer/user)、`recipient_id`、`phone`、`content`（**渲染后最终内容**）、`status`(pending/success/failed/skipped)、`provider`、`provider_msg_id`、`error`、`retry_count`、`sent_at`、`read_at`、`booking_id` |

站内消息也存在 `sys_notice_log`（`channel='site'`），**未读 = `read_at IS NULL`**，不另建表。

## 内置模板（seed 初始化）

`booking_created` / `booking_remind` / `booking_changed` / `booking_cancelled` / `booking_noshow` /
`recharge_success` / `card_expiring` / `receivable_overdue`

模板内容里的 `{变量}` 必须在 `variables` 中声明，保存时校验（未声明 → 拒绝）。

## 触发点与默认渠道（§19.2）

| 事件                       | 默认渠道              | 备注                       |
| -------------------------- | --------------------- | -------------------------- |
| 创建预约（含周期单）       | 站内                  | 短信需白名单开启           |
| 改期 / 取消 / 爽约         | 站内                  |                            |
| 次日预约提醒（18:00 任务） | 站内（短信可选）      | 最高频也最贵，默认不开短信 |
| 充值 / 购卡 / 退款成功     | 站内 + 短信           | 涉及金额，建议开短信       |
| 次卡即将到期（前 7 天）    | 站内                  |                            |
| 应收逾期                   | 站内（给店员 / 店长） | 收件人是后台用户           |
| 周期预约冲突 / 生成失败    | 站内（给店员）        | 便于人工补单               |

**两条铁律**：

1. 通知在**业务事务提交之后**发送；发送失败**不回滚业务**（写 `sys_notice_log` 后进重试）。
2. 通知失败**绝不能**让主流程（下单、收款、退款）报错。

## 发送与降级（§19.3）

- `SmsProvider` 抽象（阿里云 / 腾讯云二选一），`SMS_ACCESS_KEY_ID` / `SMS_ACCESS_KEY_SECRET` /
  `SMS_SIGN_NAME` 走环境变量。
- **未配置短信 → `status='skipped'`（原因：未配置）**，不重试、不报错；开发环境无需真实账号。
- 发送失败 → `status='failed'`；`retryFailedNotices` 每 5 分钟重试，上限 `biz.notice.retryLimit`（默认 3）。
- 总开关 `biz.notice.smsEnabled` 默认 **false**：先跑站内，确认模板无误再开短信。
- 短信模板需向通道报备，日志保留渲染后内容以便举证。

## 接口与权限

| 接口                                                        | 权限                  |
| ----------------------------------------------------------- | --------------------- |
| `GET/POST/PATCH/DELETE /biz/notice-templates`               | `biz:notice:template` |
| `GET /biz/notice-logs`、`GET /biz/notice-logs/:id`          | `biz:notice:log`      |
| `POST /biz/notice-logs/:id/resend`、`POST /biz/notice/send` | `biz:notice:send`     |
| `GET /biz/notice/inbox`、`POST /biz/notice/inbox/read`      | 登录即可              |

## 验收（§12 B5）

- 模板引用未声明变量 → 保存被拒
- 短信未配置时不阻塞业务，日志记 `failed`/`skipped` 且原因清晰
- 重试任务把失败记录重试至多 3 次后不再重试
- 站内消息未读 / 已读状态正确；顶栏未读数 = `read_at IS NULL` 的条数

## 常见坑

- 在事务里发短信（第三方调用）→ 事务被拖长甚至回滚业务。
- 把"订阅消息"当短信发 → 订阅消息必须由小程序客户端授权，本期**不做**，`channel` 只留位。
- 站内消息另建一张表 → 直接复用 `sys_notice_log(channel='site')`。
- 忘记记录渲染后的内容，模板改版后无法举证。
