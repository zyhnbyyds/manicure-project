# 更名（nest-admin-ts → manicure）+ 全量补测 实施计划

> 状态：已拍板，待执行
> 生成日期：2026-09-11
> 关联：`docs/superpowers/specs/2026-09-11-nail-salon-booking-design.md`（业务唯一事实来源）、
> `.agents/skills/project-overview`（7 条代码铁律）、`.agents/skills/testing-acceptance`（测试铁律）

---

## 0. 目标

1. **更名**：项目不再叫 `nest-admin-ts` / `nest-admin`，所有代码、配置、前端品牌、文档、环境变量统一为美甲业务标识。
2. **补测**：给目前没有测试覆盖的模块补上单测与集成测试，重点是美甲业务域（`src/modules/biz`）。

## 1. 命名规范（本次统一口径）

| 维度 | 取值 |
| --- | --- |
| 后端包名 | `manicure-api` |
| 前端包名 | `manicure-web` |
| PM2 进程名 | `manicure-server` |
| 部署目录 | `/usr/apps/manicure-project` |
| 开发库 / 测试库 | `manicure` / `manicure_test` |
| `JWT_ISSUER` / `JWT_AUDIENCE` | `manicure` / `manicure-web` |
| Swagger 标题 | `美甲店管理系统 API` |
| 前端显示名 | `美甲管理系统` |
| localStorage 前缀 | `manicure:` |

> 表名前缀 `sys_*` / `biz_*` / `app_*` **保持不变**。改名需要动 32 张表 + 全部迁移文件，收益为零、风险极高。

---

## 2. 更名清单（共 18 处）

### 2.1 后端配置与代码

| # | 位置 | 现值 | 目标 |
| --- | --- | --- | --- |
| 1 | `package.json` | name `nest-admin`、description 通用后台描述 | `manicure-api` + 美甲业务描述 |
| 2 | `ecosystem.config.js` | PM2 name `nest-admin-server`；`/usr/apps/nest-admin-ts`（**7 处**：注释 4 + `cwd` + `out_file` + `error_file`） | `manicure-server`；`/usr/apps/manicure-project` |
| 3 | `src/config/app-config.service.ts:25,26-28` | `SWAGGER_TITLE` 默认 `Nest Admin API`；`SWAGGER_DESCRIPTION` 通用描述 | 美甲 API 标题与描述 |
| 4 | `src/modules/system/configs/configs.controller.ts:43` | `example: 'Nest Admin'` | 美甲业务示例值 |
| 5 | `tests/integration/harness.ts:21` | 兜底测试库 `ruoyi_nest_test` | `manicure_test` |

### 2.2 前端品牌与视觉

| # | 位置 | 现值 | 目标 |
| --- | --- | --- | --- |
| 6 | `web/package.json` | name `nest-admin-web` | `manicure-web` |
| 7 | `web/index.html:7,11` | `<title>Nest Admin</title>`；首屏脚本读 `nest-admin:color-mode` | 中文标题；`manicure:color-mode` |
| 8 | `web/src/router/guard.ts:61` | `document.title = ... - Nest Admin` | `- 美甲管理系统` |
| 9 | `web/src/layouts/default.vue:78,85` | `alt="Nest Admin Logo"` / 文本 `Nest Admin` | 美甲品牌 |
| 10 | `web/src/views/login/index.vue:202,208` | 同上 | 美甲品牌 |
| 11 | `web/src/store/settings.ts:7-11` | 4 个 key：`nest-admin:color-mode` / `primary-color` / `radius` / `dark-flag` | `manicure:*` |
| 12 | `web/src/store/user.ts:7` | `REFRESH_TOKEN_KEY = 'nest-admin:refresh-token'` | `manicure:refresh-token` |
| 13 | `web/src/layouts/components/AppHeader.vue:75` | GitHub 链接指向 `zyhnbyyds/nest-admin-ts` | 指向 `zyhnbyyds/manicure-project` |
| 14 | `web/public/favicon.svg`、`web/public/image/logo.png` | 通用图标 | 美甲主题 SVG logo + favicon |

### 2.3 文档与环境变量

| # | 位置 | 现值 | 目标 |
| --- | --- | --- | --- |
| 15 | `README.md:1,186`、`README.en.md:1,167` | `# nest-admin-ts`；`cd nest-admin` | 美甲项目名与仓库名 |
| 16 | `AGENT.md:1,67` | `# AGENT.md — Nest Admin`；`:67` 一整段「通用后端管理 API」描述 | 标题改名；该段改写为美甲业务概述（技术栈表/目录结构保留） |
| 17 | `web/start.md:5` | 提到后端仓库 `nest-admin-ts` | 改名 |
| 18 | `.env.example` / `.env` / `.env.development` / `.env.test` / `.env.prod` | `JWT_ISSUER=ruoyi-nest-admin`、`JWT_AUDIENCE=*-web`、库名 `ruoyi_nest*` / `nest_admin`、`SWAGGER_TITLE=RuoYi Nest Admin API` | `manicure` / `manicure-web` / `manicure` / `manicure_test` / 美甲标题 |

**额外**：删除 `.env.production`（2023-03-04 遗留的无关文件，内容为 `DATABASE_NAME=nest` + `SECRET_KEY`，与本项目无关）。

**保留不改**：`docs/superpowers/specs/2026-09-11-nail-salon-booking-design.md:20` 的「沿用 `nest-admin` 基线」——这是对历史基线的客观描述，改掉反而失真。

### 2.4 风险与前置动作

| 风险 | 影响 | 处理 |
| --- | --- | --- |
| 改 `JWT_ISSUER` / `JWT_AUDIENCE` | 所有已签发的 access/refresh token 立刻失效，全员重新登录 | 开发期直接改；线上需挑时间窗 |
| 改 localStorage key 前缀 | 用户主题设置与 refresh token 丢失 | 在 store 初始化处加一次性迁移：读到旧 key 就写入新 key 并删旧 key |
| 改数据库名 | 连接串指向不存在的库，服务起不来 | **前置动作**：先在 MySQL 执行 `CREATE DATABASE manicure`（测试库由 `harness.ts` 自动建），再改 `.env` |

---

## 3. 测试覆盖盘点

### 3.1 现状

- 单测 **53 个** `*.spec.ts`，覆盖：`modules/system`（8 个子模块 service+controller 齐全）、`modules/monitor`（login-logs / operation-logs / online / cache）、`modules/jobs`、`modules/files`、`modules/generator`、`modules/compat`、`modules/auth`、`modules/health`、`modules/dashboard`（仅 service）、`common/`（auth / cache / filters / logging / utils / data-scope）、`ai/`（8 个）、`biz/common`（money / shop-time）。
- 集成测试 **3 个**：`tests/integration/{b1-booking, b2-b3-money, b4-b6}.int.spec.ts` + `harness.ts`（真库、迁移、TRUNCATE、`app.inject()` 打真实 HTTP）。

### 3.2 缺口

| 域 | 规模 | 单测 | 集成 |
| --- | --- | --- | --- |
| `modules/biz` 业务域 | 21,299 行 / 55 文件 | 仅 2 个（money、shop-time） | b1 / b2-b3 / b4-b6 |
| `modules/app` 小程序域 | 1,443 行 / 10 文件 | 0 | 部分被 b6 覆盖 |
| `ai` 域 | 6,660 行 | 8 个；`llm.service`、`permission.service`、`audit.service`、`approval.service`、`agent.service`、`ai.gateway.*`、`mock.provider`、`tools/*` 无 | — |
| 零散 | — | `dashboard.controller`、`common/password/password.service`、`database/database.service`、`biz/common` 的 `query` / `doc-no` / `tx` / `biz-config` | — |

**结论**：管理后台域基本齐全，美甲核心业务域几乎无单测覆盖——而它恰好是资金最密集、并发最激烈的地方。

---

## 4. 分层补测矩阵

### 4.1 分层原则

| 层 | 对象 | 手段 | 适用 |
| --- | --- | --- | --- |
| L1 | 纯函数 / 工具 | 直接断言，无 mock | `biz/common` 的 query / doc-no / tx / biz-config |
| L2 | Service | mock `DatabaseService.db`（沿用 `AGENT.md` 的 `mockDb` + `selectMock` 模板） | 分支、异常、参数校验、SQL 构造 |
| L3 | Controller | mock service + 断言路由/装饰器/Zod | 权限点、请求校验、响应形状 |
| L4 | 集成（真库） | `tests/integration` + `harness.ts` | **并发、幂等、时区、资金不变量** |

> 铁律（`testing-acceptance`）：mock db **永远**测不出超订，资金与并发用例必须走 L4。

### 4.2 批次矩阵

| 批次 | 范围 | 重点文件（行数） | 核心用例 |
| --- | --- | --- | --- |
| **P0 资金红线** | membership / payment / credit / 结算 | `member-accounts`(1375)、`member-cards`(659)、`payments`(861)、`refunds`(819)、`receivables`(778)、`credit-accounts`(270)、`points`、`card-types`(367)、`member-levels`(283)、`recharge-plans`(194)、`payment-diffs`(289)、`booking-settlement`(148) | 条件更新 `affectedRows=0` 必抛错；余额不为负；流水只追加；`SUM(balance_delta_principal)=balance_principal`、`SUM(points_delta)=points`；回调重放 3 次只生效一次；金额不符回调被拒并写 `callback_invalid`；超额度挂账被拒；销账超额被拒；次卡 10 次用尽→`used_up`、第 11 次被拒、撤销回补、过期卡不可核销；账龄与 `used_amount` 对得上 |
| **P1 核心链路** | booking / scheduling / base-data | `slots`(415)、`bookings`(1267)、`bookings.controller`(456)、`scheduling`(680)、`service-items`(220)、`staffs`(310)、`customers`(354) + 3 个 controller | `startAt` 不在 `stepMinutes` 网格→400；缓冲只计一次；交换录入顺序结果一致（对称性）；跨班次边界拒绝；非法状态流转拒绝；`off` 撞既有预约→409 + 冲突清单；CRUD + Zod + `@RequirePermissions` 断言 |
| **P2 运营报表** | reports / operations | `reports.analytics`(1499)、`commission`(738)、`notices`(1041)、`recurrences`(970)、`reviews`(234) + 4 个 controller | 营收可用现金+在线+退款三笔手工复核；提成计提/退款冲销 `reversed`/结算后不可改；模板变量未声明被拒；短信未配置不阻塞业务；重试上限 3 次；周期预约 4 周恰好 4 单、重跑不重复、暂停不影响已生成 |
| **P3 零散缺口** | app 域 / ai 剩余 / 零散 | `app-auth.service`(143)、`app-access-token.guard`(76)、`app-catalog`(92)、`app-member`(125)、`password.service`、`database.service`、`dashboard.controller`、`biz/common` 4 个、ai 剩余 20+ | app token 与后台 token **双向拒绝**；只读接口字段集合断言（无成本 / `createdBy` / 内部备注）；未绑定手机号→401+`needBind`；骨架写接口→501；工具层纯函数；守卫与异常过滤器边界 |

**新增用例规模预估**：250 ~ 350 个。

---

## 5. 执行顺序

```
批次 0  更名（代码 / 前端 / 文档 / 环境变量 / 视觉资源）
   └─ 独立 commit，先做：改动面小、风险可控，且避免后续写测试时二次返工
批次 1  测试基建 + biz/common 工具层（把 mock 模板固化为可复用范式）
批次 2  P0 资金红线
批次 3  P1 核心链路
批次 4  P2 运营报表
批次 5  P3 零散缺口
批次 6  全量验证（typecheck / lint / test / 覆盖率）+ 分模块提交
```

## 6. 验收标准（DoD）

1. `bun run typecheck` / `bun run lint` / `bun run test` 全绿。
2. 覆盖率：P0 模块行覆盖 **≥ 80%**，其余模块 **≥ 60%**（`bun test --coverage`）。
3. **按模块分开 commit**（`AGENT.md` 第 6 条硬要求），禁止混成单个大 commit。
4. 涉及金额的模块，`money-invariants` 红线逐条自检通过。
5. 更名后全仓 `nest-admin` / `ruoyi` 关键词检索为零命中（历史 spec 描述除外）。

## 7. 团队沉淀（附带产出）

P0 完成后，把「条件更新 + 幂等重放 + 对账等式」三类用例抽成可复制范式，补进
`.agents/skills/testing-acceptance`，让后续任何资金代码都能直接套用模板——
这比多写 50 个孤立用例更能稳住质量。
