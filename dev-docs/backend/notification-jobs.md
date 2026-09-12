---
title: 通知与定时任务
---

# 通知与定时任务

两块内容在实现上强耦合：**通知的重试、次日提醒都是定时任务**。本页先讲通知，再列全部定时任务。

实现文件：

| 文件 | 职责 |
| --- | --- |
| `src/modules/biz/operations/notices/notices.service.ts` | 模板校验、渲染、渠道降级、日志、inbox、重试、次日提醒（1117 行） |
| `src/modules/biz/operations/notices/sms/sms.provider.ts` | `SmsProvider` 抽象 + `AliyunSmsProvider` |
| `src/modules/biz/operations/notices/notices.controller.ts` | `@Controller('biz')` 下的模板 / 日志 / inbox 端点 |
| `src/modules/jobs/jobs.service.ts` | 定时任务注册表与调度（handler Map 模式） |
| `src/modules/jobs/jobs.controller.ts` | 任务 CRUD、手动执行、任务日志 |
| `src/database/seed/biz.ts` | 模板 seed（8 条）与任务 seed（11 条，含 cron） |
| `src/database/schema/index.ts` | `sys_notice_template` / `sys_notice_log` / `sys_job` / `sys_job_log` |

## 一、通知

### 模板模型

表 `sys_notice_template`（drizzle 变量 `sysNoticeTemplates`）：

| 列 | 说明 |
| --- | --- |
| `code` | 唯一（`uq_notice_template_code`），如 `booking_created` |
| `name` | 中文名 |
| `channel` | `sms` / `site` / `both`（默认 `both`） |
| `title` | 标题（站内消息用） |
| `content` | 正文，含 `{变量}` 占位符 |
| `variables` | json：声明可用变量（`[{ name, label }]`） |
| `status` | `active` / `disabled` |
| `remark` + `auditColumns` | — |

**保存时强制校验**：正文/标题里出现的 `{变量}` 必须在 `variables` 中声明，否则 400。

```ts
// src/modules/biz/operations/notices/notices.service.ts
assertTemplateVariables(template: { content: string; title?: string | null; variables?: unknown }): void {
  const declared = new Set(declaredVariableNames(template.variables));
  const used = new Set<string>();
  for (const text of [template.content, template.title ?? '']) {
    for (const match of text.matchAll(VARIABLE_PATTERN)) {         // /\{([A-Za-z_][A-Za-z0-9_]*)\}/g
      if (match[1]) used.add(match[1]);
    }
  }
  const missing = [...used].filter((name) => !declared.has(name));
  if (missing.length)
    throw new BadRequestException(`模板变量未在 variables 中声明：${missing.map((n) => `{${n}}`).join('、')}`);
}
```

`declaredVariableNames()` 宽容地接受三种 `variables` 形态：字符串数组、对象数组（取 `name`/`key`/`code`/`variable`）、纯对象映射。

**渲染**时缺失变量渲染成空串并收集 warning，残留的任意 `{…}` 一律剔除：

```ts
const rendered = text.replace(VARIABLE_PATTERN, (_match, name: string) => {
  const value = input.variables[name];
  if (value === undefined) { warnings.push(`变量 {${name}} 未提供，已渲染为空字符串`); return ''; }
  return String(value);
});
return rendered.replace(LEFTOVER_PATTERN, '');   // /\{[^{}]*\}/g
```

模板**不存在或已停用**时不报错，降级为站内原始变量通知（`【code】k=v；…`）并记一条 warning。

### seed 里的内置模板（真实 8 条）

`src/database/seed/biz.ts` 的 `NOTICE_TEMPLATE_SEEDS`：

| code | channel | 用途 |
| --- | --- | --- |
| `booking_created` | `both` | 预约成功（创建后） |
| `booking_remind` | `both` | 次日到店提醒（`sendBookingReminders` 任务） |
| `booking_cancelled` | `both` | 预约取消 / 美甲师请假导致取消 |
| `booking_completed` | `both` | 完成致谢 + 评价邀请 |
| `member_recharged` | `both` | 储值充值成功 |
| `tail_payment_remind` | `sms` | 尾款待支付提醒 |
| `recurrence_conflict` | `site` | 周期预约冲突告警（发给店员 `recipient_type='user'`） |
| `recurrence_failed` | `site` | 周期预约生成失败（发给店员） |

`NoticesService` 还导出一个 `NOTICE_TEMPLATES` 常量，列出了 `booking_changed` / `booking_noshow` / `recharge_success` / `card_expiring` / `receivable_overdue`。**这些 code 在 seed 里没有对应行**，实际行为见下方「已知不一致」。

模板变量可在模板编辑页维护，`VAR_LABELS` 提供中文标签：`shopName`(门店名称) / `customerName`(顾客姓名) / `bookingDate`(预约日期) / `bookingTime`(预约时间) / `staffName`(美甲师) / `amount`(金额（元）) / `points`(积分) / `dueAmount`(待付尾款（元）) / `cancelReason`(取消原因)。

### 触发点清单（以代码为准）

| 触发点 | 模板 code | 收件人 | 代码位置 |
| --- | --- | --- | --- |
| 后台创建预约 | `booking_created` | `customer` | `bookings.service.ts` `create()` |
| 小程序自助下单 | `booking_created` | `customer` | `bookings.service.ts` `createForCustomer()` |
| 预约完成（含自动完成？**否**，仅手动 `runComplete`） | `booking_completed` | `customer` | `bookings.service.ts` `runComplete()` |
| 次日预约提醒 | `booking_remind` | `customer` | `notices.service.ts` `sendBookingReminders()` |
| 在线充值 / 购卡 / 挂账销账支付成功 | `recharge_success` | `customer` | `payments.service.ts` `sendPaidNotice()` |
| 周期预约生成冲突 | `recurrence_conflict` | `user`（店员） | `recurrences.service.ts` |
| 周期预约生成失败 | `recurrence_failed` | `user`（店员） | `recurrences.service.ts` |
| 手动群发 | 任意（`assertTemplateExists` 先校验存在） | `customer` / `user` | `POST /biz/notice/send` |

::: danger 三个缺失的触发点（当前实现）
1. **改期不发通知**：`BookingsService.update()` 里没有任何 `notices.send`。`booking_changed` 只是常量，没有调用方。
2. **取消 / 爽约不发通知**：`cancel()` / `noShow()` 里也没有。`booking_cancelled` 模板存在但**无人调用**。
3. **自动完成不发通知**：定时任务 `autoCompleteExpiredBookings` 走 `autoCompleteExpired()`，它只改状态 + 计提提成，**不发** `booking_completed`（只有手动 `runComplete` 才发）。

需要补齐时，触发点应加在**事务提交之后**，写法照抄 `create()` 末尾的 `void this.notices.send({...}).catch(() => undefined)`。
:::

### 默认渠道与站内消息

- 模板 `channel='both'` → 展开成 `['site', 'sms']`（`resolveChannels()`，入参 `channels` 优先）。
- **站内消息复用 `sys_notice_log`**（`channel='site'`），**未读 = `read_at IS NULL`**，不另建表。
- 站内消息「写库即送达」：`deliver()` 里 `channel === 'site'` 直接把 status 置 `success` + `sent_at`，没有外部通道。
- 顶栏未读数来自 `GET /biz/notice/inbox` 返回的 `unread` 字段（`count()` where `read_at IS NULL`）。

### `SmsProvider` 抽象与降级

```ts
// src/modules/biz/operations/notices/sms/sms.provider.ts
export abstract class SmsProvider {
  abstract send(input: SmsSendInput): Promise<SmsSendResult>;
}

@Injectable()
export class AliyunSmsProvider extends SmsProvider {
  async send(input: SmsSendInput): Promise<SmsSendResult> {
    const sms = this.config.sms;
    if (!sms.configured || !accessKeyId || !accessKeySecret || !signName)
      throw new Error('短信通道未配置');
    // 阿里云 RPC 签名（HMAC-SHA1）→ POST https://dysmsapi.aliyuncs.com/ → 解析 Code/BizId
  }
}
```

| 项 | 真实情况 |
| --- | --- |
| 抽象 | `SmsProvider` 抽象类，本身充当 DI token |
| 绑定 | `operations.module.ts`：`{ provide: SmsProvider, useExisting: AliyunSmsProvider }` |
| 已实现 | **只有 `AliyunSmsProvider`** |
| `SMS_PROVIDER` 枚举 | `none` / `aliyun` / `tencent` / `mock`（`app-config.service.ts`）——`tencent` 与 `mock` 只是枚举值，**没有对应实现类** |
| `configured` 判定 | `SMS_PROVIDER !== 'none'` **且** `SMS_ACCESS_KEY_ID` / `SMS_ACCESS_KEY_SECRET` / `SMS_SIGN_NAME` 三者齐全 |
| 超时 | `AbortSignal.timeout(5000)` |

::: warning 把 `SMS_PROVIDER` 设成 `tencent` 或 `mock` 会怎样
枚举允许，但没有实现类被绑定 —— 实际仍然注入 `AliyunSmsProvider`。若同时补齐了阿里云凭据，就会**用阿里云去发**；没补齐凭据则 `configured=false` → 抛「短信通道未配置」→ 日志记 `failed`。要做多通道必须自己加 `useExisting` 的分支。
:::

**三重降级闸门**（`smsSkipReason()`），任一命中即 `status='skipped'`，**不重试、不报错**：

```ts
private smsSkipReason(templateCode: string, phone: string | null, notice: NoticeConfig): string | null {
  if (!notice.smsEnabled) return '短信总开关 biz.notice.smsEnabled 未开启';
  if (!notice.smsTemplates.includes(templateCode))
    return `模板 ${templateCode} 未加入短信白名单 biz.notice.smsTemplates`;
  if (!phone) return '收件人缺少手机号';
  return null;
}
```

对应配置（`BIZ_CONFIG_DEFAULTS`，存在 `sys_config` 表，可在系统配置页改）：

| key | 默认值 |
| --- | --- |
| `biz.notice.smsEnabled` | `false` |
| `biz.notice.smsTemplates` | 空（白名单，逗号分隔） |
| `biz.notice.retryLimit` | `3` |

::: tip 开发环境无需短信账号
`SMS_PROVIDER=none`（默认）时，站内消息链路完全跑通，短信分支记一条 `skipped` 并写明原因。这是刻意的设计：本地开发不该被第三方账号卡住。
:::

### 「事务后发送、发送失败不回滚」

**原因**：短信是第三方网络调用，放在事务里会把事务拖长（持锁等 HTTP 回包），一旦超时/失败还可能把业务回滚掉。所以：

- **业务事务只负责落库**；
- **通知在事务提交之后发**；
- **发送失败只写日志，绝不冒泡**。

实现位置一处集中：`NoticesService.send()` **内部捕获全部异常** —— 整个方法体包在 `try` 里，`catch` 只 `logger.warn` + 把 message 塞进 `warnings`，返回 `{ sent: 0, failed: 0, skipped: 0, logIds: [], warnings }`，**绝不向调用方抛出**。

调用方还要再包一层 `.catch()`，双保险：

```ts
// src/modules/biz/booking/bookings.service.ts 第 9 步
void this.notices.send({
  templateCode: 'booking_created',
  recipientType: 'customer',
  recipientId: customer.id,
  variables: { customerName: customer.name, bookingDate: shopDateOf(startAt, tz), bookingTime: formatShopDateTime(startAt, tz).slice(11, 16), amount: (quote.payableAmount / 100).toFixed(2) },
  bookingId: created.bookingId,
}).catch(() => undefined);
```

另有**事务内排队**的路径（周期预约用），避免在事务里做网络 IO：

| 方法 | 时机 | 行为 |
| --- | --- | --- |
| `enqueueInTx(tx, input)` | **事务内** | 只 `prepare` + 落 `status='pending'` 日志，**零网络 IO** |
| `flushPending(logIds)` | **事务提交后** | 按 id 捞 `pending` 行真正投递，异常只 warn |

`deliver()` 内部还有第三层兜底：短信分支 `catch` 后把 `status` 置 `failed`、`error` 记消息（截断 500），返回 `'failed'`，**不抛**。

### 失败重试与状态

`retryFailed()`（由 `retryFailedNotices` 任务驱动，每 5 分钟）：查 `status='failed' AND retry_count < retryLimit` 的行，按 id 升序 `limit(200)`，逐条 `deliver({ retryCount: row.retryCount + 1 })`。

- 上限 `biz.notice.retryLimit`（默认 3）；`retryLimit <= 0` 直接不重试。
- 单次最多处理 **200** 条，靠 5 分钟周期自然消化。
- **手动重发 `POST /biz/notice-logs/:id/resend` 不受 `retryLimit` 限制**（人工动作），但同样累加 `retry_count` 用于举证。

### 通知日志字段（表 `sys_notice_log`）

| 列 | 说明 |
| --- | --- |
| `template_code` | 模板 code |
| `channel` | `sms` / `site` |
| `recipient_type` | `customer` / `user` |
| `recipient_id` | 顾客 id 或后台用户 id |
| `phone` | 发短信时的号码 |
| `title` | 标题 |
| `content` | **渲染后的最终内容**（截断 1000） |
| `status` | `pending` / `success` / `failed` / `skipped` |
| `provider` | 供应商名（如 `aliyun`） |
| `provider_msg_id` | 供应商回执 id（举证用） |
| `error` | 失败原因 / 跳过原因（截断 500） |
| `retry_count` | 已重试次数 |
| `sent_at` / `read_at` | 发送时间 / 站内消息已读时间 |
| `booking_id` | 关联预约（提醒去重靠它） |
| `created_at` | 只追加，无 updated_at |

索引：`idx_notice_log_status(status, retry_count, id)`、`idx_notice_log_recipient(recipient_type, recipient_id, id)`、`idx_notice_log_booking(booking_id)`。

::: warning 为什么必须记录「渲染后的内容」
模板会被运营改版。事后举证（「我到底给他发了什么」）只能靠日志里的最终文本。别为了省存储改成存 `template_code`+变量。
:::

### 接口与权限

| 接口 | 权限 |
| --- | --- |
| `GET/POST /biz/notice-templates`、`PATCH/DELETE /biz/notice-templates/:id` | `biz:notice:template` |
| `GET /biz/notice-logs`、`GET /biz/notice-logs/:id` | `biz:notice:log` |
| `POST /biz/notice-logs/:id/resend`、`POST /biz/notice/send` | `biz:notice:send` |
| `GET /biz/notice/inbox`、`POST /biz/notice/inbox/read` | 登录即可（只查/改自己的 `recipient_id`） |

### 小程序订阅消息授权台账

`NoticesService.recordSubscribeGrant()` 记录小程序端订阅授权（`app_wx_subscribe_grant`，唯一索引 `uq_wx_subscribe_grant`）：

- 额度用 `ON DUPLICATE KEY UPDATE granted_count = granted_count + 1` **累加**（并发重复上报不覆盖）；
- 去重去空客户端上报的 `templateIds`；
- **不校验模板 ID 白名单**：微信模板 ID 是公开的（写死在小程序包里），白名单拦不住攻击者。

订阅消息**本身不发**（需要小程序客户端授权 + 真实模板 ID），本期只落台账。

## 二、定时任务

### 调度机制：`sys_job` 表驱动 + handler Map

**没有使用 `@Cron()` 装饰器**（全仓无 `@Cron` / `CronExpression`）。做的是**表驱动调度**：

1. `JobsService` 构造函数里 `registerHandlers()` 往 `handlers: Map<string, JobHandler>` 注册**全部处理器**；
2. `onModuleInit()` 从 `sys_job` 查 `status='active' AND deleted_at IS NULL` 的行；
3. 每行用 `new CronJob(job.cron, ...)` 建 job，注册到 `SchedulerRegistry`（名字 `job:{id}`），立即 `start()`；
4. 增删改任务（`create`/`update`/`remove`）后重新 `schedule()` / `unschedule()`；
5. `onModuleDestroy()` 停止并删除全部 cron job。

```ts
private schedule(job: JobRow): void {
  this.unschedule(job.id);
  if (job.status !== 'active') return;
  const handler = this.handlers.get(job.handler);
  if (!handler) return;                                    // 未知 handler 静默跳过
  const cronJob = new CronJob(job.cron, () => { void this.execute(job, handler); });
  this.scheduler.addCronJob(this.cronName(job.id), cronJob);
  cronJob.start();
}
```

`cron` 是 **6 段式**（秒 分 时 日 月 周），**不用 Quartz 的 `?`**。

**重入保障**：`sys_job.concurrent`（seed 全为 `false`）——`execute()` 开头：

```ts
private async execute(job: JobRow, handler: JobHandler): Promise<void> {
  if (!job.concurrent && this.running.has(job.id)) return;   // 上一轮没跑完 → 本轮直接跳过
  this.running.add(job.id);
  const startedAt = new Date();
  try {
    await handler();
    await this.recordLog(job, 'success', null, startedAt, new Date());
  } catch (error) {
    await this.recordLog(job, 'failure', messageOf(error), startedAt, new Date());  // 失败落日志，不抛出
  } finally {
    this.running.delete(job.id);
  }
}
```

`running` 是**进程内** Set：多实例部署时它挡不住并发，需要靠 handler 自身的条件更新幂等。

### 全部任务清单（seed 11 条 + 1 个未注册的 handler）

`src/database/seed/biz.ts` 的 `JOB_SEEDS` 是唯一事实来源：

| # | 任务名 | handler | cron（6 段） | 做什么 | 幂等 / 重入保障 |
| --- | --- | --- | --- | --- | --- |
| 1 | 自动完成已到店预约 | `autoCompleteExpiredBookings` | `0 */10 * * * *`（每 10 分钟） | `arrived` 且 `end_at < now` → `completed`，累加到店统计 + 计提提成 | `lockBooking` + 条件更新 `WHERE status='arrived'`；`affectedRows=0` 跳过；`finished_at` 取 `booking.endAt`（非 now） |
| 2 | 自动标记爽约 | `autoNoShowBookings` | `0 */10 * * * *`（每 10 分钟） | `confirmed` 且 `start_at + noShowGraceMinutes < now` → `no_show` | 单条条件 UPDATE，天然幂等 |
| 3 | 次卡到期处理 | `expireMemberCards` | `0 5 0 * * *`（每日 00:05） | `active` 且 `expire_at < now` → `expired` | 条件更新 |
| 4 | 会员等级重算 | `recountMemberLevels` | `0 30 3 * * *`（每日 03:30） | 按 `total_spent` 重算 `level_id`（修正历史 / 手工改级） | 纯计算 + 写回，可重复执行 |
| 5 | 在线支付超时关单 | `closeExpiredPayments` | `0 * * * * *`（每分钟） | `pending` 且 `expire_at < now` → `closed` | 条件更新 |
| 6 | 在线支付主动查单 | `queryPendingPayments` | `0 */2 * * * *`（每 2 分钟） | 对未过期的在线支付单主动向渠道查单，回调丢失时兜底补记 | 落地走支付成功条件更新（唯一化） |
| 7 | 支付渠道对账 | `reconcilePayments` | `0 30 6 * * *`（每日 06:30） | 拉**前一天**（`yesterdayInShop()`，店内本地日）渠道账单逐笔比对，写 `biz_payment_diff` | 唯一键保证可重入 |
| 8 | 应收逾期标记 | `markOverdueReceivables` | `0 10 1 * * *`（每日 01:10） | `status IN ('open','partial')` 且 `due_date < today` → `overdue` | 条件更新 |
| 9 | 预约到店提醒 | `sendBookingReminders` | `0 0 18 * * *`（每日 18:00） | 给**次日** `confirmed` 预约发 `booking_remind` | 业务去重：当天已有同 `(booking_id, booking_remind)` 日志则跳过 |
| 10 | 通知失败重试 | `retryFailedNotices` | `0 */5 * * * *`（每 5 分钟） | `failed` 且 `retry_count < retryLimit` → 重发，单次上限 200 条 | 条件查询 + `retry_count` 递增 |
| 11 | 周期预约滚动生成 | `generateRecurringBookings` | `0 15 3 * * *`（每日 03:15） | 按 `generated_until` 游标批量生成周期单 | 游标 + 唯一索引 `uq_booking_recurrence_start` 双重保险 |

另有 `noop` handler 注册在 `handlers` Map 里但**没有 seed 行**，供新建任务时试跑用。

::: tip 定时任务的第一硬约束：不碰钱
`jobs.service.ts` 的注释写明：「定时任务不碰钱（§15.7 不变量 5），只改状态与等级」。所有 handler 都**不直接改余额 / 积分 / 支付单金额**；涉及钱的兜底（查单补记）走的是支付成功那条既有条件更新路径。
:::

::: warning 任务 7 的「前一天」是店内本地日
`yesterdayInShop()` = `addLocalDays(shopToday(), -1)`。窗口按店内时区算，服务端跑在 UTC 上也不会错位。
:::

### 后台管理与手动执行

`src/modules/jobs/jobs.controller.ts`：

| 接口 | 说明 |
| --- | --- |
| `GET /system/jobs` | 任务列表（`{ items, page, pageSize }`） |
| `GET /system/jobs/:id` | 详情 |
| `POST /system/jobs` | 新建（校验 handler 已知 + cron 合法 + handler 唯一） |
| `PATCH /system/jobs/:id` | 修改后**立刻重新调度** |
| `DELETE /system/jobs/:id` | 软删 + `unschedule()` |
| `POST /system/jobs/:id/run` | **手动执行一次**：`runNow()` → `execute(job, handler)`，同步等结果 |
| `GET /system/jobs/:id/logs` | 任务日志 |
| `DELETE /system/jobs/logs` | 清空任务日志（`clearLogs()`） |

校验与约束：`assertHandler()` 未知 handler → 400『未知的任务处理器：X』；`assertCron()` 用 `new CronJob(cron, () => {})` 试构造，失败 → 400『Cron 表达式无效』；`assertHandlerUnique()` 重复 → 409『任务处理器已存在』。任何 CRUD 之后都会重新 `schedule()` / `unschedule()`，**改数据库不重启也生效**。

::: danger handler 名不能随便改
`handler` 是**代码里的字符串 key**（`handlers` Map），改数据库里的 `handler` 值只会让任务静默失效（`schedule()` 里 `if (!handler) return;`）。要换实现必须同步改代码。
:::

### 任务日志（表 `sys_job_log`）

| 列 | 说明 |
| --- | --- |
| `job_id` | FK → `sys_job.id`，`ON DELETE CASCADE` |
| `job_name` / `handler` | 冗余快照（任务改名后历史日志仍可读） |
| `status` | `success` / `failure` |
| `message` | 失败消息（截断 2000） |
| `started_at` / `finished_at` / `duration_ms` | 耗时 |

写入是 best-effort：`recordLog()` 内部 `try/catch` 只 `logger.warn`，**日志写失败不影响任务本身**。

失败表现：任务抛错 → `status='failure'` + `message`，**不重试**（下次 cron 到点自然再跑）。所以每个 handler 都必须能被重复执行而不产生副作用。

## 三、已知不一致（人工确认项）

| 现象 | 详情 |
| --- | --- |
| `recharge_success` vs `member_recharged` | `payments.service.ts` 的 `PAID_NOTICE_TEMPLATES` 用 `'recharge_success'`，但 seed 模板是 `member_recharged`。结果：充值/购卡/销账成功时模板查不到 → **降级为站内原始变量通知**（`【recharge_success】amount=…；paymentNo=…`）+ warning。要么改代码 code，要么改 seed。 |
| `NOTICE_TEMPLATES` 里 5 个 code 无 seed 行 | `booking_changed` / `booking_noshow` / `recharge_success` / `card_expiring` / `receivable_overdue`。其中 `booking_changed` / `booking_noshow` / `card_expiring` / `receivable_overdue` **在代码里也没有调用方**。 |
| 次卡到期 / 应收逾期无通知 | `cardExpiring` 与 `receivableOverdue` 有模板 code 常量但无触发点，`expireMemberCards` / `markOverdueReceivables` 任务只改状态不发通知。 |
| `SMS_PROVIDER=tencent` / `mock` 无实现 | 枚举允许但只绑定了 `AliyunSmsProvider`。 |
| 技术技能文档与代码不一致 | `.agents/skills/notification/SKILL.md` 说「充值 / 购卡 / 退款成功 → 站内 + 短信」，实际代码只覆盖**支付成功**（`recharge`/`card_buy`/`credit_settle`），**退款完成没有通知**。 |

## 延伸阅读

- [预约主链路实现](/backend/booking) —— `booking_created` 的触发位置（第 9 步）
- [收银与支付通道接入](/backend/payment) —— `sendPaidNotice()` 与查单/关单
- [退款判责与对账](/backend/refund-reconcile) —— `reconcilePayments` 任务写下的 `biz_payment_diff`
- [小程序 app 域实现](/backend/app-domain) —— 订阅消息授权台账
