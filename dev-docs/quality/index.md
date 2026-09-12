---
title: 测试策略与验收标准
---

# 测试策略与验收标准

本页回答三个问题：**测试怎么跑**、**什么必须用真库测**、**什么叫"做完了"**。

::: tip 先记住一条
本项目的测试**只有一个运行器：`bun test`**。`vitest` 只是被当作断言库与 mock 库使用
（测试文件里 `from 'vitest'`），**不经过 vitest runner**；`package.json` 里也没有 `vitest` 脚本。
:::

相关实现页：[预约主链路实现](/backend/booking) · [排班与可约时段算法](/backend/scheduling) ·
[收银与支付通道接入](/backend/payment) · [迁移 · 种子数据 · 派生口径](/data/migrations-seeds) ·
[本地开发与命令手册](/overview/getting-started)。

## 一、测试体系全景

### 1.1 两类测试

| 类型 | 路径约定 | 命名 | 运行方式 | 是否连真库 |
| --- | --- | --- | --- | --- |
| 单元测试 | 与源码**同目录** | `*.spec.ts` | `bun test` | ❌ 不连（mock db / 纯函数） |
| 集成测试 | `tests/integration/` | `*.int.spec.ts` | `bun test` | ✅ 真实 MySQL + 真 HTTP |

单元测试与源码同目录的例子：`src/modules/biz/common/money.spec.ts`、
`src/modules/biz/booking/bookings.service.spec.ts`、`web/src/utils/upload-images.spec.ts`、
`miniapp/miniprogram/utils/asset-url.spec.ts`。

集成测试不走 HTTP 端口，而是用 Fastify 的 `app.inject()` 打**应用内真实请求**：
validation / guard / 事务 / 过滤器全是真的（见 `tests/integration/harness.ts`）。

### 1.2 真实文件数（用 glob 数出来的）

| 范围 | 模式 | 文件数 |
| --- | --- | --- |
| 后端单测 | `src/**/*.spec.ts` | 82 |
| 后台前端单测 | `web/src/**/*.spec.ts` | 4 |
| 小程序单测 | `miniapp/miniprogram/**/*.spec.ts` | 1 |
| **单元测试小计** | — | **87** |
| 集成测试 | `tests/integration/*.int.spec.ts` | 18 |
| **合计测试文件** | — | **105** |

复现命令：

```bash
cd /d/project/myproject/manicure-project
# Git Bash / WSL
find src -name '*.spec.ts' | wc -l
find tests/integration -name '*.int.spec.ts' | wc -l
```

```powershell
# PowerShell（Windows）
(Get-ChildItem src -Recurse -Filter *.spec.ts).Count
(Get-ChildItem tests/integration -Filter *.int.spec.ts).Count
```

::: warning 用例条数请以实际执行输出为准
本页**不写死**用例条数。`README.md` 记的是「105 个文件 / 1158 条」，
`project-design/HANDOVER-miniapp.md` 记的是「1064 通过 / 0 失败」——两者是**不同时间点的快照**，
都不是验收依据。验收依据永远是当场那条命令的输出：

```bash
bun run test
```
:::

### 1.3 集成测试文件与覆盖范围

| 文件 | 覆盖（对应批次） |
| --- | --- |
| `b1-booking.int.spec.ts` | 可约时段 / 缓冲对称性 / 时区 / 格子与班次校验 / **并发恰好 1 成功** / 单号唯一 / 排班冲突保护 / 定时任务幂等（B1） |
| `b2-b3-money.int.spec.ts` | 算价与等级折扣 / 账务不变量 / 充值 / **并发余额支付不为负** / 次卡 / 积分兑换 / 定金尾款 / 混合支付 / 退款判责审批 / 对账差异（B2、B3） |
| `b3-online-settle.int.spec.ts` | 在线渠道结算：pending 单 + 渠道下单 + `code_url`；**渠道未配置 → 409 且不留 pending 单** |
| `b3-refund-reserve.int.spec.ts` | 退款额度预留：渠道失败必须释放、成功占用、第二笔不过额 |
| `b4-b6.int.spec.ts` | 挂账额度与 used_amount / 销账 / 提成计提与结算 / 净营收可复核 / 评价一单一评 / 周期预约 / 美甲师可做项目 / 通知未配置降级 / app 域双向拒绝（B4、B5、B6） |
| `b6-app-identity.int.spec.ts` | 登录换 token、openid 唯一、手机号绑定与软删 409、换绑留痕、工作台申请/审批/只读面/写操作（B6） |
| `b6-app-contract.int.spec.ts` | 501 骨架清单与不落库断言、`/app/member/me` 字段集合与越权、我的次卡、评价、订阅授权、未配置凭据 503、自助下单/取消、充值档位（B6） |
| `b6-app-ratelimit-swagger.int.spec.ts` | 登录限流 429 + `retry-after`、限流按路由收紧、Swagger app 分组（B6） |
| `b6-app-wxpay-notify.int.spec.ts` | **真验签 + 真 AES-GCM 解密**的回调发货/幂等/金额不一致/签名篡改/缺头/迟到回调（B6） |
| `b7-coupon-template.int.spec.ts` | 券模板 CRUD、同名 409、停用不影响已发券（B7） |
| `b7-coupon-issue.int.spec.ts` | 后台发券、重复发放允许、并发单号唯一（B7） |
| `b7-coupon-claim.int.spec.ts` | 顾客自助领券、重复领 409、**并发领恰好一次**（B7） |
| `b7-coupon-redeem.int.spec.ts` | 券核销：门槛、过期、归属、**并发核销恰好一次**（B7） |
| `b7-coupon-booking.int.spec.ts` | 券接入建单：应付金额、券积分二选一 400、未达门槛不消耗券、**并发用同一张券恰好一单成功**（B7） |
| `b7-app-coupons.int.spec.ts` | app 我的优惠券：字段白名单、过期现算、数据隔离（B7） |
| `b7-app-booking-detail.int.spec.ts` | 订单详情：他人单统一 404、积分换算与上限以后端为准（B7） |
| `b7-app-points-goods.int.spec.ts` | 积分兑换品目录：401、未绑定可读、上下架、字段白名单（B7） |
| `b7-app-points-redeem.int.spec.ts` | 积分兑换：积分不足、扣积分与发卡同事务、**并发恰好一次**、每人限兑（B7） |

辅助文件（不是用例）：`tests/integration/harness.ts`（环境与上下文）、
`tests/integration/wxpay-notify.helper.ts`（造微信支付回调签名与密文）。

## 二、集成测试环境

### 2.1 初始化流程（`tests/integration/harness.ts`）

```mermaid
flowchart TD
  A["resolveTestDatabaseUrl()"] --> B{"process.env.TEST_DATABASE_URL ?"}
  B -- 有 --> Z1["直接用"]
  B -- 无 --> C["读 .env 与 .env.test 文件<br/>（.env.test 覆盖 .env）"]
  C --> D{"文件里有 TEST_DATABASE_URL ?"}
  D -- 有 --> Z1
  D -- 无 --> E["取 DATABASE_URL<br/>（文件优先，其次 process.env，最后兜底常量）"]
  E --> F["库名追加 _test"]
  F --> G["prepareTestDatabase()"]
  G --> H["CREATE DATABASE IF NOT EXISTS<br/>utf8mb4 / utf8mb4_unicode_ci"]
  H --> I["migrate(db, './src/database/migrations')"]
  I --> J["applyTestEnv(url)：重建环境变量"]
  J --> K["import AppModule（必须在 env 铺好之后）"]
  K --> L["FastifyAdapter + rawBody:true"]
  L --> M["GlobalExceptionFilter + setGlobalPrefix(apiPrefix)"]
  M --> N["resetBusinessData()：清表 + 停用 sys_job"]
  N --> O["createTestContext 返回 ctx"]
```

**推导顺序（`resolveTestDatabaseUrl`）**：

1. `process.env.TEST_DATABASE_URL`；
2. `.env.test` 文件里的 `TEST_DATABASE_URL`（`.env.test` 的值覆盖 `.env`）；
3. `.env` / `.env.test` 的 `DATABASE_URL`（其次才是 `process.env.DATABASE_URL`）→ **库名后追加 `_test`**；
4. 兜底常量 `FALLBACK_TEST_DATABASE_URL` = `mysql://root:123456@127.0.0.1/manicure_test`。

当前仓库 `.env.test` 的真实内容（**该文件未被 git 跟踪**，`.gitignore` 忽略 `.env.*`）：

```bash
NODE_ENV=test
DATABASE_URL=mysql://root:123456@127.0.0.1/manicure_test
JWT_ISSUER=manicure
JWT_AUDIENCE=manicure-web
JWT_ACCESS_SECRET=test-access-secret-key-0123456789abcdef
JWT_REFRESH_SECRET=test-refresh-secret-key-0123456789abcdef
CORS_ORIGINS=http://localhost:5173
UPLOAD_DIR=uploads
SWAGGER_ENABLED=false
AI_ENABLED=false
SMS_PROVIDER=none
```

### 2.2 `applyTestEnv()` 为什么必要

基线的 `src/config/app-config.service.spec.ts` 会直接 `process.env = {...}` 覆盖
`DATABASE_URL` / `JWT_*` **且不还原**。集成测试如果直接吃 `process.env`，整套用例会连到错误的库、
或因密钥太短启动失败。所以 harness 从 env 文件**重铺一遍**，保证与文件执行顺序无关：

| 变量 | 值 | 原因 |
| --- | --- | --- |
| `NODE_ENV` | `test` | 走测试分支 |
| `DATABASE_URL` | 推导出的测试库 | 隔离 |
| `SWAGGER_ENABLED` | `false` | 不建文档 |
| `AI_ENABLED` | `false` | 不外呼 LLM |
| `SMS_PROVIDER` | `none` | 不发短信 |
| `WX_MINIAPP_FAKE` | `true` | 集成测试不可能连微信域名 |
| `WXPAY_*` | **每次进程现造一对 RSA 密钥** | 回调要跑真验签 + 真 AES-GCM，不是假 provider |
| `REDIS_URL` | **`delete`** | 空串会让 `z.url()` 校验失败；Redis 是可选依赖 |

::: warning 测试专用开关要写进 `applyTestEnv`
`.env.test` **未入库**，所以任何"只在测试里生效"的开关都必须写进 `harness.ts` 的 `applyTestEnv`，
否则换一台机器跑出来的行为就不一样（`WX_MINIAPP_FAKE` 就是为此放在这里的）。
:::

### 2.3 清表：`resetBusinessData()`

`beforeEach` 里逐用例调用（例：`b1-booking.int.spec.ts` 的 `beforeEach`），真实实现要点：

| 要点 | 说明 |
| --- | --- |
| **用 `DELETE` 而不是 `TRUNCATE`** | 本机实测 37 张表：`TRUNCATE` 合计 **4067ms**、`DELETE` 合计 **56ms**，**差 73 倍**。`TRUNCATE` 是 DDL（DROP + CREATE 重建表）。整套回归因此 **~530 秒 → ~18 秒** |
| **代价：不重置 `AUTO_INCREMENT`** | 用例一律用 `insertId`，**不要断言固定 id** |
| **整个 reset 必须在同一条连接上跑完** | `SET FOREIGN_KEY_CHECKS` 是**会话级**的，而连接池有 10 条连接；`pool.query` 可能换连接，那句 SET 形同虚设。实现用 `pool.getConnection()` + `try/finally release()` |
| 清理范围 | `information_schema.tables` 里 `biz\_%` / `app\_%` / `sys\_notice\_%` / `sys\_job\_log` |
| 顺带停用定时任务 | `UPDATE sys_job SET status = 'disabled'`，否则 CronJob 会在用例中途改数据 |
| 外键顺序 | 关掉 `FOREIGN_KEY_CHECKS` 后逐表 `DELETE`，**因此不依赖删除顺序**；但顺序在"开着外键约束"的脚本里必须按依赖倒序 |

### 2.4 运行方式与注意事项

```bash
# 全量（单元 + 集成）
bun run test

# 只跑某个集成文件（最稳，推荐排查时用）
bun test tests/integration/b1-booking.int.spec.ts

# 只跑某条用例（按用例名过滤）
bun test tests/integration/b3-refund-reserve.int.spec.ts -t "预留额度必须释放"

# 观察模式 / 覆盖率
bun run test:watch
bun run test:coverage
```

- **集成用例不能并行跑**：所有集成文件共享**同一个物理测试库**，而每个文件的
  `beforeEach` 都会整库清表 —— 并行执行必然互相清空数据。当前约定是顺序执行；
  不要用分片 / 多进程方式跑 `tests/integration/`。
- **超时**：`bunfig.toml` 把默认 hook 超时提到 `60000`（安全网）。新写的 spec 仍建议显式传超时，
  与既有 `beforeAll(async () => {...}, 120_000)` 的约定一致，双保险。
- **需要能建库的账号**：`prepareTestDatabase()` 会先连 `/`（无库）执行 `CREATE DATABASE IF NOT EXISTS`；
  账号没有建库权限时直接失败。
- **改了环境变量后要重启测试进程**：`AppConfigService` 在构造时读 env，harness 也只在
  `createTestContext()` 时铺一次。

## 三、单测测不出来的路径（本页重点）

一句话原则：**mock db 永远测不出超订**。下面每条都是"单测结构上做不到"，只能上真库。

### 3.1 并发抢单（`FOR UPDATE` 行锁）

| 项 | 内容 |
| --- | --- |
| **为什么单测测不出来** | 单测里的 db 是 mock，`FOR UPDATE` 没有任何语义；「10 个请求并发」在单进程 mock 里根本不存在真实的锁等待 |
| **集成测试怎么构造** | 真库 + `Promise.all` 打 10 个同美甲师同时段创建请求，断言**恰好 1 个 201、9 个 409**；单号并发唯一用同一手法断言 `B{yyyyMMdd}{id}` 不重复 |
| **测试文件** | `tests/integration/b1-booking.int.spec.ts`（`并发 10 个同一美甲师同时段创建 → 恰好 1 个成功`、`并发创建的单号唯一`） |

同类并发闸门还有：同一张券并发核销 / 并发用券下单、并发领券、并发发券单号、并发积分兑换 ——
分别见 `b7-coupon-redeem` / `b7-coupon-booking` / `b7-coupon-claim` / `b7-coupon-issue` / `b7-app-points-redeem`。

### 3.2 幂等重放（回调重复、请求重放）

| 项 | 内容 |
| --- | --- |
| **为什么单测测不出来** | 幂等靠**条件更新的 `affectedRows`**实现。单测能用 `affectedRows: 0` 队列覆盖分支，但"同一行被真的更新过两次"这件事只有真库能证明；渠道回调还带真验签 |
| **集成测试怎么构造** | ① 同一支付回调**连发 3 次**，断言只有 1 次发货、`paid_amount` 不变；② 重复完成预约 `changed:false` 且提成记录仍为 1 条；③ 定时任务连跑两次无副作用 |
| **测试文件** | `b6-app-wxpay-notify.int.spec.ts`（重复通知幂等）、`b6-app-identity.int.spec.ts`（重复到店/完成）、`b1-booking.int.spec.ts`（定时任务重复执行） |

### 3.3 时区与营业日边界

| 项 | 内容 |
| --- | --- |
| **为什么单测测不出来** | 纯函数单测（`shop-time.spec.ts`）只能测函数本身；"进程 `TZ` 变化后整条 HTTP 链路结果不变" 依赖真实日期运算 + DB 存储 + 序列化三层 |
| **集成测试怎么构造** | 断言店内本地日 `2026-09-11` 的时段落在 `[2026-09-10T16:00Z, 2026-09-11T16:00Z)`，且返回的是**带 `+08:00` 偏移的 ISO8601**；用例日期用 `addLocalDays(shopToday(), 3)` 相对偏移，**不依赖"现在几点"**；`startAt` 无时区偏移 → 400（禁止 `new Date('YYYY-MM-DD')` 类误用） |
| **测试文件** | `tests/integration/b1-booking.int.spec.ts`（`时段落在店内本地日区间内，且是带 +08:00 偏移的 ISO8601` 等） |

### 3.4 资金不变量（余额 / 积分 / 次卡 / 销账不得越界）

| 项 | 内容 |
| --- | --- |
| **为什么单测测不出来** | mock 的 `affectedRows` 队列只能证明"代码走了哪条分支"，不能证明"库里余额真的没被扣成负数"。不变量是**对表数据的断言**，不是对调用序列的断言 |
| **集成测试怎么构造** | ① 流水与余额对账等式：`SUM(balance_delta_principal) = balance_principal`、`SUM(points_delta) = points`；② **并发 10 笔余额支付**，只成功到余额用尽，余额永不为负；③ 次卡用完 10 次 → `used_up`、第 11 次被拒、撤销回补；④ 退款额度预留：渠道失败必须释放、第二笔在打渠道前就被拒 |
| **测试文件** | `b2-b3-money.int.spec.ts`、`b3-refund-reserve.int.spec.ts`、`b4-b6.int.spec.ts`（挂账额度与销账不超额） |

### 3.5 渠道回调验签

| 项 | 内容 |
| --- | --- |
| **为什么单测测不出来** | 单测用的是 **mock provider**，与真实 provider 的应答状态码会分叉（本项目真踩过：mock 的 `failureReply` 返回 500、真实实现返回 200，导致"失败必须回 4xx"这条红线测试全绿而实现是错的） |
| **集成测试怎么构造** | harness **每次进程现造一对 RSA 密钥**：公钥通过 `WXPAY_PLATFORM_PUBLIC_KEY` 注入 provider（免联网拉平台证书），私钥留给测试造签名 → 跑**真验签 + 真 AES-GCM 解密**。覆盖：验签通过发货、金额不一致拒绝并写 `callback_invalid`、签名篡改一毛不动、缺验签头必须 4xx、本地已关单的迟到回调仍要落地 |
| **测试文件** | `tests/integration/b6-app-wxpay-notify.int.spec.ts`（含后台 `/biz/payments/notify/wxpay` 补测）、`src/modules/biz/payment/channels/channel-reply.spec.ts`（契约直接测真实实现） |

**Context 的两处已知差异**（`TestContextOptions`）：默认 context **不注册**
`@fastify/rate-limit`、helmet / multipart（G9 限流"代码写了但没验过"的根因由此而来）。
需要验这些时必须通过 `configure` 在 `app.init()` 之前补注册 —— 见 `b6-app-ratelimit-swagger.int.spec.ts`。
同理，要把 provider 换成"未配置凭据"的真实实现，用 `providers` 覆盖位（`b6-app-contract.int.spec.ts` 的 503 用例）。

## 四、B1~B6 验收清单

来源：`project-design/superpowers/plans/2026-09-11-b1-b6-implementation-plan.md` 的批次划分、
spec §12 的验收标准、以及 `.agents/skills/testing-acceptance/SKILL.md` 的口径。
**批次划分以这些真实资料为准**；B7（小程序收口）在 spec 里没有独立章节，见本节末尾说明。

### B1 预约主链路

- [ ] 基础数据完整增删改查；停用项目不出现在可约选择中 —— 手测 + `service-items` 单测 · `src/modules/biz/base-data/service-items/`
- [ ] 手机号重复创建顾客被拒（409 而非 500） —— `b1-booking.int.spec.ts` `手机号重复创建顾客 → 409` · `customers.service.ts`（错误要从 `cause` 链取）
- [ ] 周模板 `10:00–12:00 / 13:00–20:00`，周末不配 → 可约时段为空 —— `b1-booking.int.spec.ts` `当天无班次 → reason=no_shift` · `slots.service.ts`
- [ ] `off` 例外 → 该日返回空；`custom` 例外 → 只返回自定义时段 —— `b1-booking.int.spec.ts` · `scheduling.service.ts`
- [ ] 已有预约时添加 `off` → 409 + 受影响清单，`force=true` 才落库 —— `b1-booking.int.spec.ts` · `SchedulingService.createOverride`
- [ ] 可约时段扣除已有预约与缓冲；**缓冲只计一次**（60 分钟服务 + 15 缓冲 → 下一单最早 11:15） —— `b1-booking.int.spec.ts` · `slots.service.ts` 的对称判据
- [ ] **对称性**：先录 A 再录 B 与先录 B 再录 A 结果一致 —— `b1-booking.int.spec.ts` · `gap = max(B, b.buffer_minutes)`
- [ ] **时区**：本地日 2026-09-11 落在 `[2026-09-10T16:00Z, 2026-09-11T16:00Z)`，进程 `TZ` 改变结果不变 —— `b1-booking.int.spec.ts` · `shopDayRange()`
- [ ] `startAt` 不在 `stepMinutes` 网格 → 400；无时区偏移 → 400；超出班次 → 400 —— `b1-booking.int.spec.ts`
- [ ] **并发 10 个同时段创建 → 恰好 1 成功、9 冲突** —— `b1-booking.int.spec.ts` · `assertNoConflict`（`FOR UPDATE`）
- [ ] 非法状态流转被拒（如 `completed → arrived`）；`booking_no` 并发无重复 —— `b1-booking.int.spec.ts` · `transition()`
- [ ] `arrived` 过期 → `completed`；`confirmed` 超容忍期 → `no_show`（重复执行无副作用） —— `b1-booking.int.spec.ts` · `jobs.service.ts` handler

### B2 会员体系

- [ ] 算价：原价 10000、9.5 折 → 优惠 500、应付 9500；积分抵扣 `min(积分可抵, 折后 30%)` 落库 —— `b2-b3-money.int.spec.ts` · `money.ts` 的 `quoteBooking`
- [ ] 充值：充 1000 送 100 → 本金 +100000、赠送 +10000；赠送超上限被拒 —— `b2-b3-money.int.spec.ts`
- [ ] 余额支付：应付 9500、余额 8000 → 409（**不部分扣**） —— `b2-b3-money.int.spec.ts` · `applyBalancePayment` 条件更新
- [ ] 不变量 `SUM(balance_delta_principal) = balance_principal`、`SUM(points_delta) = points` —— `b2-b3-money.int.spec.ts`
- [ ] 并发 10 笔余额支付只成功到余额用尽，**余额永不为负** —— `b2-b3-money.int.spec.ts`
- [ ] 次卡：10 次用完 → `used_up`；第 11 次被拒；撤销后回补；过期卡不可核销 —— `b2-b3-money.int.spec.ts` · `MemberCardsService.useCard` / `assertUsable`
- [ ] 积分兑换：扣积分 + 发卡同事务；撤销回补积分并废卡 —— `b2-b3-money.int.spec.ts`
- [ ] 等级：累计消费跨门槛自动升级；`recountMemberLevels` 重复执行结果一致 —— `b2-b3-money.int.spec.ts` · `syncLevel`
- [ ] 流水表**只追加**，接口层无更新/删除入口 —— **代码评审项**（自动化测不到）

### B3 收银

- [ ] 定金 → `partial` + `due_amount` 正确；`settle` 收清 → `paid` + `settled_at` —— `b2-b3-money.int.spec.ts` · `BookingSettlementService.recalc`
- [ ] 混合支付 2 张支付单 → `paid` + `pay_channel_summary='balance,cash'` —— `b2-b3-money.int.spec.ts`
- [ ] 回调重放 3 次只生效一次；**金额不一致的回调被拒**并写 `callback_invalid` —— `b6-app-wxpay-notify.int.spec.ts`、`payments.service.spec.ts`
- [ ] 超时关单；关单后回调不影响账（但**迟到的支付成功仍要落地**） —— `b6-app-wxpay-notify.int.spec.ts` · `closeExpired()`
- [ ] 判责：不同提前量 → 建议金额正确；审批只能执行一次 —— `b2-b3-money.int.spec.ts` · `RefundsService`
- [ ] 对账：造两类差异 → 落库、可处理、重跑不重复 —— `b2-b3-money.int.spec.ts` · `PaymentDiffsService`
- [ ] 在线渠道未配置 → 409 且**不留 pending 单** —— `b3-online-settle.int.spec.ts`（重构时必须保留的行为）
- [ ] 退款额度预留：渠道失败释放、成功占用、第二笔不过额 —— `b3-refund-reserve.int.spec.ts`
- [ ] 真实通道联调（微信 Native / 支付宝当面付）正向 + 退款各一次 —— **人工门禁**，见 [构建 · 部署 · 运维](/quality/deploy) 的上线前门禁

### B4 挂账应收 / 报表 / 提成

- [ ] 额度 5000 挂 6000 被拒；挂 4000 → `used_amount=4000`；销账 1500 → 应收 `partial`、`used_amount=2500`；超额销账被条件更新拦下 —— `b4-b6.int.spec.ts` · `ReceivablesService`
- [ ] 到期日过后由 `markOverdueReceivables` 置 `overdue`，账龄汇总对得上 —— `b4-b6.int.spec.ts` + `jobs.service.ts` handler
- [ ] 报表：1 笔现金 + 1 笔在线 + 1 笔退款 → 三个数字可手工复核（净营收 = 成功支付 − 成功退款） —— `b4-b6.int.spec.ts` · `ReportsService`
- [ ] 提成：比例 + 固定额计提正确；退款/取消 → `reversed`；结算后不可改 —— `b4-b6.int.spec.ts` · `CommissionService`
- [ ] 导出：小数据同步 CSV；超 1 万行走异步任务 —— `ReportsService`（**以实际实现为准**）

### B5 运营

- [ ] 一单一评：第二评价被拒；隐藏后公开列表不返回 —— `b4-b6.int.spec.ts` · `ReviewsService`
- [ ] 美甲师项目限制后：可约时段为空（`staff_cannot_do`）、下单 400、清空后恢复可做全部 —— `b4-b6.int.spec.ts` · `StaffsService.allowedServiceItemIds`（空数组 = 可做全部）
- [ ] 周期预约 4 周 → 恰好 4 单且回指 `recurrence_id`；重跑不重复；暂停不影响已生成 —— `b4-b6.int.spec.ts` · `RecurrencesService.generate`
- [ ] 通知：变量未声明被拒；短信未配置不阻塞业务且记 `failed`；重试至多 3 次 —— `b4-b6.int.spec.ts` · `NoticesService.assertTemplateVariables` / `retryFailed`
- [ ] 定时任务**不碰钱**（只改状态与等级）+ 幂等 —— **代码评审项** + 各 handler 集成用例

### B6 小程序

- [ ] `POST /app/auth/login` 用测试 code 换到 app token；同一 openid 重复/并发登录只有一行身份 —— `b6-app-identity.int.spec.ts`
- [ ] **认证隔离双向拒绝**：app token 打 `/api/v1/biz/**` 被拒，后台 token 打 `/api/v1/app/**` 同样被拒 —— `b4-b6.int.spec.ts`、`b6-app-identity.int.spec.ts`
- [ ] 只读接口字段集合断言（**无成本 / 无 `createdBy` / 无内部备注**） —— `b6-app-contract.int.spec.ts`（Zod 断言）
- [ ] `/app/available-slots` 与后台 `available-slots` 同输入结果一致（复用同一 service） —— `b4-b6.int.spec.ts`（G6/G7 收紧后**必须完全相等**）
- [ ] 未绑定手机号访问 `/app/member/me` → 401 + `needBind` —— `b6-app-contract.int.spec.ts`
- [ ] 自助下单落 `channel=miniapp` + `status=pending` 不收款；仅本人可取消 —— `b6-app-contract.int.spec.ts`
- [ ] **501 骨架只剩 1 个**（JSAPI 支付契约位）：清单由 `SKELETON_ROUTES` 钉住，调用返回 501 且**一个字都不落库**、非法入参仍是 400 —— `b6-app-contract.int.spec.ts`
- [ ] 限流：登录第 11 次 → 429 + `retry-after`；别的 app 端点不受该限制 —— `b6-app-ratelimit-swagger.int.spec.ts`
- [ ] 换绑留痕 `app_wx_user_bind_log` 只追加；绑定失败不留痕 —— `b6-app-identity.int.spec.ts`
- [ ] 美甲师工作台：`staff_id` 硬限定、手机号脱敏、越权 403/404、早于 `start_at` 完成 → 400、重复完成只计提一次 —— `b6-app-identity.int.spec.ts`

::: tip B7 是真实存在的批次
spec §12 只写到 B6，但仓库里 **`tests/integration/b7-*.int.spec.ts` 有 9 个文件**，
覆盖优惠券（模板/发放/领取/核销/接入建单）与 app 域（我的优惠券 / 订单详情 / 积分兑换品 / 积分兑换）。
批次划分以代码与 `.agents/skills/project-overview/SKILL.md` 为准：**B7 = 小程序收口**。
:::

## 五、"做完了没"：完成定义（DoD）

### 5.1 五件套

| 件 | 要求 | 怎么验 |
| --- | --- | --- |
| **代码** | 分层正确、事务内用 `tx`、全部资金写入走条件更新 | 代码评审 + `bun run typecheck` |
| **迁移** | 新表/新列必须 `bun run db:generate` 生成，**不手写 SQL** | `src/database/migrations/` 出现新目录；生成后**肉眼扫一遍 SQL** |
| **Seed** | 权限点写进 `src/database/seed/menus.ts`；业务默认值进 `seed/biz.ts` / `seed/nail.ts` | 重跑 `bun run db:seed:menus`，前端路由能自动生成 |
| **测试** | 本次改动对应的验收条目**逐条跑过**；并发/幂等/时区必须有集成用例 | `bun run test` + 记录（集成输出或手测截图） |
| **文档** | 页面/接口/口径变化同步到 `dev-docs/`；踩到新坑追加进 `project-design/pitfalls/` | 评审时对照 |

### 5.2 提交前三连

```bash
bun run typecheck && bun run lint && bun run test
```

前端改动补一条（在 `web/` 下）：

```bash
bun run typecheck && bun run lint && bun run build
```

小程序改动补一条（在仓库根）：

```bash
bunx tsc --noEmit -p miniapp/tsconfig.json
```

### 5.3 回归清单：改了这些就必须重跑

| 改动面 | 必须重跑 |
| --- | --- |
| 算价 / 折扣 / 积分 / 券 | `b2-b3-money.int.spec.ts`、`b7-coupon-booking.int.spec.ts`、`b7-app-booking-detail.int.spec.ts`、`src/modules/biz/common/money.spec.ts` |
| 余额 / 积分 / 次卡 / 应收的任何写入 | `b2-b3-money.int.spec.ts`、`b4-b6.int.spec.ts`、`b7-app-points-redeem.int.spec.ts` |
| 可约时段 / 冲突 / 锁 | `b1-booking.int.spec.ts`、`b4-b6.int.spec.ts`（美甲师项目限制） |
| 排班 / 请假 / 主数据 | `b1-booking.int.spec.ts`（冲突保护段） |
| 支付 / 退款 / 回调 / 对账 | `b3-online-settle.int.spec.ts`、`b3-refund-reserve.int.spec.ts`、`b6-app-wxpay-notify.int.spec.ts`、`src/modules/biz/payment/channels/channel-reply.spec.ts` |
| 权限点 / 守卫 / app 域边界 | `b4-b6.int.spec.ts`、`b6-app-identity.int.spec.ts`、`b6-app-contract.int.spec.ts`、`src/common/auth/access-token.guard.spec.ts` |
| `ports.ts` / `biz.module.ts` 的端口绑定 | **必须真启动一次服务**（`typecheck` 是绿的，漏 `exports` 只有启动才暴露） |

## 六、新增测试的写法约定

### 6.1 命名与目录

- 单测：与源码同目录的 `*.spec.ts`；集成测试：`tests/integration/` 下的 `*.int.spec.ts`（**后缀必须带 `.int`**，README 与本文档的计数口径都靠它区分）。
- 集成文件名前缀用批次号（`b1-` / `b7-`），便于按批次筛跑。
- 新写的 `describe` 用中文，写清对应的 spec 章节，例如 `describe('B1 可约时段（§5.2 / §5.3）', ...)`。

### 6.2 断言与 mock

- 断言/mock **一律 `import { describe, expect, it } from 'vitest'`**，由 `bun test` 执行。
- 集成测试**不 mock db**：用 `createTestContext()` 拿真应用，`ctx.request()` 打真 HTTP，`ctx.sql()` 直接查库断言。
- 需要覆盖"未配置凭据"这类分支时，用 `createTestContext({ providers: [...] })` 覆盖 provider，**不要伪造断言**。
- 服务层单测的 mock db 范式（查询链、`affectedRows` 队列、SQL 片段断言、调用顺序日志）见
  `.agents/skills/testing-acceptance/SKILL.md` 的「mock db 单测范式」——那份写法是踩坑后定下来的，直接照抄。

### 6.3 禁止事项

::: danger 红线
- ❌ **用 mock db 测并发** —— 永远测不出超订，必须真库。
- ❌ **用"当前时间 + 1 小时"构造用例** —— CI 换时区/换时段就飘；用 `addLocalDays(shopToday(), n)` 这类相对偏移。
- ❌ **只测正常路径** —— 每个资金/并发用例至少覆盖：正常路径、幂等重放、并发竞争、边界（0 值 / 上限 / 跨时区）。
- ❌ **断言固定 id** —— `resetBusinessData()` 用 `DELETE`，`AUTO_INCREMENT` 不重置；一律用 `insertId`。
- ❌ **手测过就算通过** —— 没沉淀成集成用例，下次重构立刻退化。
- ❌ **契约类断言只测 mock** —— mock 与真实实现分叉时没人会发现（`channel-reply.spec.ts` 就是为此而生）。
- ❌ **在 spec 里 `vi.mock('node:crypto', ...)`** —— `bun test` 不做文件级隔离，会**全局生效**污染其它文件（症状：单文件绿、全量红）。源码要唯一值用 `globalThis.crypto.randomUUID()`。
:::

### 6.4 每个用例前问自己三句

1. 这条断言**只有在真库上才成立**吗？是 → 放集成测试。
2. 这个数字**换台机器/换个时区还一样**吗？否 → 改成相对偏移或注入时间。
3. 如果把这个修复**改回错误写法**，这条用例会红吗？
   （**变异验证**：本项目的多处关键用例都做过这一步，例如把小程序 `minLeadMinutes` 换成 0、
   把 `toUploadedItem` 的归一化删掉；不红说明用例没钉住东西。）

延伸阅读：[构建 · 部署 · 运维](/quality/deploy) · [踩坑记录与排查手册](/quality/pitfalls) ·
[相关文档与资料库](/appendix/related-docs)。
