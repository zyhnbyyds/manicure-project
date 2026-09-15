---
title: 整体架构图
---

# 整体架构图

本页用六张图描述系统的**静态结构**：分几层、有哪些模块、谁依赖谁、钱与预约怎么流。

- 想看**运行时行为**（一个请求怎么走完一生、两个认证域如何互相拒绝）→ [三端架构与请求生命周期](/overview/architecture)；
- 想看**文件在哪**（每个目录放什么、命令怎么敲）→ [目录结构与代码地图](/overview/structure)。

::: tip 怎么读这几张图

- **实线** = 编译期或运行期的强依赖，断了就不工作；
- **虚线** = 可选依赖，没配置就自动降级（Redis、短信、LLM 都属此类）；
- 图里的模块名就是目录名，可以直接按名字去 `src/` 里找。
  :::

## 一、系统全景

```mermaid
flowchart TB
  subgraph CLIENT["客户端"]
    direction LR
    WEB["后台管理前端<br/>web/ · Vue 3.5 + lew-ui"]
    MP["微信小程序<br/>miniapp/ · 原生 TypeScript"]
  end

  subgraph EDGE["接入"]
    NG["nginx<br/>静态托管 + /api 反向代理"]
  end

  subgraph SERVER["应用层 · src/"]
    direction TB
    MW["Fastify 插件链<br/>helmet · rate-limit · multipart · CORS"]
    GD["守卫<br/>AccessTokenGuard（后台域）<br/>AppAccessTokenGuard（app 域）"]
    CT["Controller<br/>路由 + Zod 校验"]
    SV["Service<br/>业务规则 · 事务 · 条件更新"]
  end

  subgraph STORE["数据层"]
    direction LR
    DB[("MySQL 8<br/>67 张表")]
    RD[("Redis<br/>可选 · 未配置降级")]
    FS[("uploads/<br/>本地文件")]
  end

  subgraph EXT["外部系统"]
    direction LR
    WX["微信支付 V3"]
    ALI["支付宝当面付"]
    SMS["短信服务商"]
    LLM["LLM 网关"]
  end

  WEB -->|"Bearer 后台 token"| NG
  MP -->|"Bearer app token"| NG
  NG --> MW --> GD --> CT --> SV
  SV --> DB
  SV -.-> RD
  SV --> FS
  SV -.->|"下单 / 验签回调"| WX
  SV -.->|"当面付"| ALI
  SV -.->|"事务提交后发送"| SMS
  SV -.->|"AI 助手"| LLM
```

这是**部署视角**的分层。注意两个客户端不共享任何代码，后端是唯一的业务真相来源 ——
算价、可约时段、状态机全部在服务端算，前端只负责展示与收集输入。

| 层       | 物理位置                                               | 说明                                                   |
| -------- | ------------------------------------------------------ | ------------------------------------------------------ |
| 客户端   | `web/` · `miniapp/`                                    | Vue 3 后台 + 原生小程序，各自独立构建                  |
| 接入     | nginx                                                  | 静态托管构建产物，`/api` 反代到后端                    |
| 应用     | `src/main.ts`（插件链）· `src/modules/**`（业务）      | 插件链顺序在 `main.ts` 里**硬编码**                    |
| 数据     | MySQL（唯一强依赖）· Redis（可选）· `uploads/`（文件） | Redis 未配置时所有缓存方法返回空值，不影响功能         |
| 外部系统 | 微信支付 / 支付宝 / 短信 / LLM                         | 全部通过抽象接口接入，未配置时降级而非崩溃（见第六节） |

## 二、后端模块地图

`src/app.module.ts` 是整个后端的装配点，它只做三件事：导入全部子模块、
注册全局守卫与全局拦截器。

```mermaid
flowchart TB
  ROOT["AppModule<br/>src/app.module.ts<br/>APP_GUARD + APP_INTERCEPTOR"]

  subgraph BASE["基座（若依式后台能力）"]
    direction LR
    B1["system<br/>users · roles · menus · depts<br/>posts · dict-types · dict-data · configs"]
    B2["monitor<br/>login-logs · operation-logs<br/>online · cache"]
    B3["auth · dashboard · files<br/>jobs · generator · compat · health"]
  end

  subgraph BIZDOM["业务域 BizModule（@Global）"]
    direction LR
    D1["base-data<br/>门店 · 美甲师 · 服务项目 · 顾客"]
    D2["scheduling<br/>周模板 · 日期例外 · 冲突保护"]
    D3["booking<br/>可约时段 · 下单 · 改期 · 结算"]
    D4["membership<br/>等级 · 储值 · 次卡 · 积分 · 券"]
    D5["payment<br/>支付单 · 回调 · 退款 · 对账"]
    D6["credit<br/>挂账主体 · 应收 · 销账"]
    D7["reports<br/>报表口径 · 提成"]
    D8["operations<br/>评价 · 周期预约 · 通知"]
  end

  subgraph APPDOM["小程序域 MiniappModule"]
    direction LR
    P1["auth · catalog · member<br/>payments · staff"]
  end

  AIMOD["ai/<br/>agent · gateway · approval · task<br/>llm · policy · risk · tools · audit"]

  ROOT --> BASE
  ROOT --> BIZDOM
  ROOT --> APPDOM
  ROOT --> AIMOD
```

| 区域     | 目录                                         | 判断标准                                      |
| -------- | -------------------------------------------- | --------------------------------------------- |
| 基座     | `src/modules/system` · `monitor` · `files` … | 「把美甲业务整个删掉，它还要不要？」要 → 基座 |
| 业务域   | `src/modules/biz/**`                         | 只有美甲门店才有语义的规则                    |
| 小程序域 | `src/modules/app/**`                         | 面向 C 端顾客与美甲师工作台，独立认证域       |
| AI 助手  | `src/ai/**`                                  | 工具调用、审批、审计，独立于业务模块          |

::: warning `BizModule` 是 `@Global` 的
它除了汇总子模块，还负责把各 service **绑定到抽象端口**上（见下一节）。
因为它被标记为 `@Global`，其它模块不必 import 就能注入这些端口。
:::

## 三、业务域内部：用端口解耦，而不是互相 import

业务子域之间存在大量交叉调用（下单要读排班、结算要扣会员余额、退款要动支付单）。
如果直接互相 `import` service，会立刻陷入循环依赖。项目的做法是**抽象端口**：

```mermaid
flowchart LR
  subgraph USE["消费方（不 import 任何业务模块）"]
    direction TB
    U1["app 域 controller / service"]
    U2["AI 工具 src/ai/tools/**"]
    U3["定时任务 jobs.service.ts"]
  end

  P["src/modules/biz/common/ports.ts<br/>抽象类 = DI token（22 个）<br/>BookingPort · SlotPort · SchedulePort<br/>MemberAccountPort · MemberCardPort<br/>PaymentPort · RefundPort · CreditPort<br/>StaffPort · StorePort · CustomerPort · …"]

  subgraph IMPL["实现方（biz 子域 service）"]
    direction TB
    I1["BookingsService → BookingPort"]
    I2["SlotsService → SlotPort"]
    I3["PaymentsService → PaymentPort"]
    I4["RefundsService → RefundPort"]
    I5["MemberAccountsService → MemberAccountPort"]
  end

  USE -->|"只依赖抽象类"| P
  P -->|"BizModule 用 useExisting 绑定实现"| IMPL
```

- 端口定义在 `src/modules/biz/common/ports.ts`（抽象类，同时充当 DI token）；
- 绑定写在 `src/modules/biz/biz.module.ts` 的 `providers`，形如
  `{ provide: BookingPort, useExisting: BookingsService }`；
- 结果是 **app 域与业务模块之间没有编译期耦合**，也不存在循环依赖。

::: danger 新增跨模块调用必须走端口
不要图省事直接 `import` 别人的 service。一旦某个子域被两个地方循环引用，
Nest 会在启动时报 `Cannot resolve dependencies`，而且这类错误往往在加完代码很久之后才炸。
:::

## 四、核心业务链路数据流

预约主链路是全系统最长的一条路径，也是 80% 的复杂度所在：它一次穿过了基础数据、
排班、预约、会员、收银、报表六个子域。

```mermaid
flowchart TB
  S1["1 选门店 / 服务项目 / 美甲师"] --> S2["2 算可约时段<br/>班次 − 已占 − 前后缓冲"]
  S2 --> S3["3 创建预约单<br/>biz_booking + biz_booking_item"]
  S3 --> S4["4 算价<br/>等级折扣 → 优惠券 → 积分 → 改价"]
  S4 --> S5["5 定金 / 全款<br/>biz_payment"]
  S5 --> S6["6 渠道回调验签<br/>pay_status = paid"]
  S6 --> S7["7 到店服务与结算"]
  S7 --> S8["8 扣储值 / 核销次卡 / 抵积分<br/>biz_member_transaction"]
  S7 --> S9["9 计提提成<br/>biz_commission_record"]
  S5 -.->|"退款按服务阶段分流"| S10["biz_refund"]
  S8 --> S11["报表<br/>净营收 = 成功支付 − 成功退款"]
  S9 --> S11
```

三个容易画错的地方，这里明确一下：

1. **步骤 2 的"缓冲"是对称的** —— 服务前后各留一段 gap，不只是结束时间；
2. **步骤 5 与 6 之间可能隔着几分钟到几小时** —— 下单只创建支付单，资金状态由回调推进，
   所以「预约已创建」不等于「已付款」；
3. **挂账不走这条链路的资金段** —— 挂账下单**不写支付单**，`pay_status = credit`，
   直到销账才计入营收（详见 [挂账与应收](/backend/credit)）。

## 五、数据模型分组

```mermaid
flowchart TB
  DB[("MySQL 8 · 67 张表<br/>src/database/schema/index.ts<br/>单文件定义 + defineRelations")]

  subgraph SG1["sys_* · 22 张"]
    direction LR
    G1A["权限<br/>sys_user · sys_role<br/>sys_menu · sys_dept · sys_post<br/>+ 4 张关联表"]
    G1B["门店与配置<br/>sys_store · sys_user_store<br/>sys_dict_type · sys_dict_data<br/>sys_config"]
    G1C["任务 · 审计 · 文件<br/>sys_job · sys_job_log<br/>sys_login_log · sys_operation_log<br/>sys_file · sys_refresh_token"]
    G1D["通知<br/>sys_notice_template<br/>sys_notice_log"]
  end

  subgraph SG2["biz_* · 35 张"]
    direction LR
    G2A["基础数据 5<br/>service_item · staff<br/>staff_service_item · staff_store<br/>customer"]
    G2B["排班 2 + 预约 3<br/>staff_weekly_shift<br/>staff_schedule_override<br/>booking · booking_item<br/>booking_recurrence"]
    G2C["会员资产 12<br/>level · recharge_plan<br/>member_card_type + item<br/>member_card + log · transaction<br/>points_goods + redeem<br/>coupon_template · customer_coupon"]
    G2D["资金 8<br/>payment + log · payment_diff<br/>refund + policy · credit_account<br/>receivable + payment"]
    G2E["运营与顾客 7<br/>review · feedback<br/>commission_rule + record<br/>customer_address · customer_favorite"]
  end

  subgraph SG3["ai_* · 7 张"]
    direction LR
    G3A["ai_session · ai_message<br/>ai_task · ai_task_step"]
    G3B["ai_action_intent<br/>ai_approval · ai_audit_log"]
  end

  subgraph SG4["app_* · 3 张"]
    direction LR
    G4A["app_wx_user<br/>app_wx_subscribe_grant<br/>app_wx_user_bind_log"]
  end

  DB --> SG1
  DB --> SG2
  DB --> SG3
  DB --> SG4
```

| 前缀   | 数量 | 归属                             | 删除策略                       |
| ------ | ---- | -------------------------------- | ------------------------------ |
| `sys_` | 22   | 平台能力（权限 / 配置 / 日志 …） | 软删（`auditColumns`）         |
| `biz_` | 35   | 美甲业务事实                     | 软删，个别关联表物理删（见下） |
| `ai_`  | 7    | AI 助手运行时                    | 随会话生命周期                 |
| `app_` | 3    | 小程序身份域                     | 只追加留痕，不复用 `sys_user`  |

::: tip 表数量的核实方式

```bash
grep -c "mysqlTable(" src/database/schema/index.ts   # 67
```

部分历史文档写的是「61 张」，那是 2026-09 上旬的数字；此后新增了
`sys_store`、`sys_user_store`、`biz_staff_store`、`biz_feedback`、
`biz_customer_address`、`biz_customer_favorite` 六张表。
**字段、表名的权威来源永远是 `src/database/schema/index.ts`**，
表清单与索引约定见 [数据模型总览](/data/)。
:::

## 六、部署拓扑（Docker 形态）

```mermaid
flowchart TB
  U["浏览器 / 微信小程序"] -->|"HTTP :${WEB_PORT}（默认 80）"| WEBC["web 容器<br/>nginx<br/>静态托管 + /api 反向代理"]
  WEBC -->|"/api/v1/**"| APIC["api 容器<br/>bun output/server/main.js"]
  APIC --> DBC[("db 容器<br/>mysql:8.4<br/>--default-time-zone=+08:00")]
  APIC -.-> RDC[("redis 容器<br/>redis:7-alpine")]
  APIC --> VOL[("uploads 卷<br/>UPLOAD_DIR")]
  U -.->|":${DOCS_PORT}（默认 8080）"| DC["docs 容器（可选 · profile: docs）<br/>nginx<br/>/docs/ + /dev-docs/"]
```

只有 `web` 与 `docs` 映射宿主端口，`api` / `db` / `redis` 都只在 compose 内网可达 ——
所以本机已占用 3000 / 3306 / 6379 不影响部署。

一键部署（脚本会把随机密码写进 `deploy/.env`）与文档站的启用方式见
[Docker 一键部署](/quality/docker)；传统 PM2 形态见
[三端架构与请求生命周期](/overview/architecture)。

## 七、横切能力都在哪

架构图里看不到、但每个模块都在用的东西，集中在这几个文件：

| 能力         | 唯一入口                                         | 一句话                                           |
| ------------ | ------------------------------------------------ | ------------------------------------------------ |
| 认证         | `src/common/auth/access-token.guard.ts`          | 后台域；**不要**在这里兼容 app token             |
| app 认证     | `src/modules/app/auth/app-access-token.guard.ts` | 靠 `scope: 'app'` 区分，与后台域双向拒绝         |
| 数据权限     | `src/common/data-scope/data-scope.ts`            | 只回答「能看到哪些部门的人」，与业务归属是两件事 |
| 缓存         | `src/common/cache/redis.service.ts`              | 未配置 `REDIS_URL` 时静默降级为无缓存            |
| 业务参数     | `src/modules/biz/common/biz-config.service.ts`   | `biz.*` 配置的唯一读取口，越界回落默认值         |
| 金额与算价   | `src/modules/biz/common/money.ts`                | 整数「分」，取整向下                             |
| 门店本地时间 | `src/modules/biz/common/shop-time.ts`            | 店内日 → 绝对时刻区间只能走 `shopDayRange()`     |
| 单号         | `src/modules/biz/common/doc-no.ts`               | 预约号 / 支付号 / 退款号统一生成                 |
| 门店上下文   | `src/modules/biz/common/store-scope.ts`          | 显式 `storeId` → `x-store-id` 头 → 默认门店      |
| 跨模块调用   | `src/modules/biz/common/ports.ts`                | 22 个抽象端口，见第三节                          |

## 八、改代码时的定位路径

```mermaid
flowchart TB
  Q{"要改什么？"} -->|"一个接口"| A1["controller（路由 + Zod）<br/>src/modules/**/*.controller.ts"]
  Q -->|"业务规则 / 事务"| A2["service<br/>src/modules/**/*.service.ts"]
  Q -->|"表结构"| A3["src/database/schema/index.ts<br/>再 bun run db:generate"]
  Q -->|"权限点 / 菜单"| A4["src/database/seed/menus.ts"]
  Q -->|"后台页面"| A5["web/src/views/**"]
  Q -->|"小程序页面"| A6["miniapp/miniprogram/pages/**"]
  Q -->|"定时任务"| A7["src/modules/jobs/jobs.service.ts<br/>+ sys_job 表"]
```

各模块的实现细节、口子与坑，按 [项目总纲的技能索引](/overview/) 加载对应技能即可。
