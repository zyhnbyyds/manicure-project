---
title: 相关文档与资料库
---

# 相关文档与资料库

本页是开发者文档站的「出口页」：把仓库里除 `dev-docs/` 之外的**其它文档资产**集中做一份索引。当你要找的东西不在这套开发者文档里（`src/` 的实现细节、`project-design/` 的早期设计、`.agents/skills/` 的开发技能、`docs/` 的对客手册），先来这一页定位，再跳出去。

本页只做两件事：**说清每份资料的权威性与时效性**，以及**给出路径**。所有路径均已在本仓库中实际核实存在；本页所有链接都取自 `dev-docs/.vitepress/config.mts` 已登记的站点路径，未登记的路径不会写成链接。

::: tip 找资料的推荐顺序
**要动手改代码 → 先 `.agents/skills/`，再看 `dev-docs/`，最后才翻 `project-design/`。**
技能（`.agents/skills/*/SKILL.md`）是与当前实现同步的模块级开发入口，写作时就带着「该改哪里、红线是什么」；`dev-docs/` 描述已落地的实现；`project-design/` 里的 spec 与计划是**过程资料**，用来理解「为什么这么设计」，不用来确认「接口现在长什么样」。接口与字段的最终事实来源永远是 `src/` 源码。
:::

## 文档分层说明

| 分层（目录）                | 面向谁                             | 内容性质                                                                                                                                           | 权威性 / 时效性                                                                                            |
| --------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `docs/`                     | 门店人员（店长、前台、美甲师）     | 对客操作手册（独立 VitePress 站点）：只写「怎么操作」，不写「怎么实现」                                                                            | 业务行为口径；与系统实际行为不一致时以系统为准，接口与字段细节回到 `dev-docs/` 与 `src/`                   |
| `dev-docs/`                 | 开发者（后端 / 后台前端 / 小程序） | 本开发者文档站（32 个内容页）：总览架构、后端实现、前端实现、数据模型、质量与交付、附录                                                            | 描述**当前源码实现**，随源码同步；编写本页时已核实侧栏登记页与磁盘文件**逐条对齐、没有缺口**，两张清单见下 |
| `project-design/`           | 设计者与决策参与者                 | 设计资料库：原始设计 spec、施工计划、踩坑记录、UI 设计稿与生成提示词、交接说明、品牌资产                                                           | **早期意图与过程资料，权威性低于源码**；spec 自述版本 v1.3、状态仍是「待评审」                             |
| `.agents/skills/`           | AI 执行者与开发者                  | 按模块拆分的开发技能，每个 `<name>/SKILL.md` 含 `description` / `whenToUse` / `metadata.sections`                                                  | 与实现同步的**开发入口**，落地度高于 spec 正文；`project-overview` 是总纲，`money-invariants` 是资金红线   |
| `README.md`、`README.en.md` | 外部访问者与新人（中 / 英双语）    | 项目门面：三端定位、技术栈、表与页面数量、业务覆盖清单                                                                                             | 概览级；文中的数量口径（表数、页面数）会随开发漂移，精确值以源码为准                                       |
| `AGENT.md`                  | AI 执行者（404 行）                | AI 协作总纲：技能索引表、项目铁律、命令与工作流约定                                                                                                | 与 `.agents/skills/` 配套使用；其中引用 spec 的路径存在漂移，见下文「技能里声明的 spec 路径漂移」          |
| `ecosystem.config.js`       | 运维 / 部署者                      | PM2 进程配置：**只部署后端**，应用名 `manicure-server`、`fork` 单实例、解释器 `bun`、入口 `output/server/main.js`、`PORT=1011`、用 `--smol` 限制堆 | 部署事实来源之一；流程说明见 [构建 · 部署 · 运维](/quality/deploy)                                         |
| `.github/`                  | 仓库维护者                         | 目前**只有** `dependabot.yml`（依赖升级自动化）                                                                                                    | 事实：本仓库**没有 CI workflow**，任何「是否达标」的判断都必须本地跑命令验证                               |

### `docs/` 已落地的对客内容页（33 个 `.md`，已逐条核实）

下表为 `docs/` 中**真实存在**的内容页（已排除 `node_modules/`、`.vitepress/dist`、`.vitepress/cache`）：

| 文件                              | 页面主题                                                          |
| --------------------------------- | ----------------------------------------------------------------- |
| `docs/index.md`                   | 首页（`layout: home`），对客手册门面，hero 文案为「门店操作手册」 |
| `docs/guide/index.md`             | 总览：系统能做什么、三端怎么配合                                  |
| `docs/guide/quickstart.md`        | 快速上手：开业前必须配置的 7 件事                                 |
| `docs/guide/roles.md`             | 角色与权限：谁能看到什么、能点什么                                |
| `docs/guide/glossary.md`          | 术语表                                                            |
| `docs/guide/faq.md`               | 总 FAQ（按使用场景分组）                                          |
| `docs/booking/index.md`           | 预约模块总览与营业动线                                            |
| `docs/booking/scheduling.md`      | 排班管理：周模板、请假与冲突保护                                  |
| `docs/booking/booking-flow.md`    | 开单 / 改期 / 取消 / 结算全流程                                   |
| `docs/booking/recurrences.md`     | 周期预约：熟客固定档期自动生成                                    |
| `docs/booking/staff-workbench.md` | 美甲师工作台：手机上的排班卡与打卡机                              |
| `docs/member/index.md`            | 会员模块总览                                                      |
| `docs/member/customers.md`        | 顾客档案                                                          |
| `docs/member/levels.md`           | 会员等级与折扣                                                    |
| `docs/member/recharge-cards.md`   | 储值充值与次卡                                                    |
| `docs/member/points-coupons.md`   | 积分与优惠券                                                      |
| `docs/member/reviews.md`          | 评价                                                              |
| `docs/payment/index.md`           | 收银台总览                                                        |
| `docs/payment/cashier.md`         | 收银台操作                                                        |
| `docs/payment/channels-setup.md`  | 支付通道接入（微信 / 支付宝扫码收款）                             |
| `docs/payment/refunds.md`         | 退款                                                              |
| `docs/payment/reconcile.md`       | 对账                                                              |
| `docs/payment/credit.md`          | 挂账与应收                                                        |
| `docs/report/index.md`            | 报表与经营分析总览                                                |
| `docs/report/reports.md`          | 报表详解（口径与指标）                                            |
| `docs/report/commission.md`       | 提成（规则 / 计提 / 结算 / 冲销）                                 |
| `docs/report/notices.md`          | 通知（模板与站内消息）                                            |
| `docs/admin/index.md`             | 后台管理端总览                                                    |
| `docs/admin/users-roles.md`       | 用户与角色                                                        |
| `docs/admin/menus-depts.md`       | 菜单、部门、岗位、字典与参数                                      |
| `docs/admin/monitor.md`           | 系统监控（日志 / 在线用户 / 缓存）                                |
| `docs/admin/jobs-files.md`        | 定时任务与文件管理                                                |
| `docs/admin/ai-assistant.md`      | AI 操作助手                                                       |

站点工程文件（非内容页）：`docs/.vitepress/config.mts`、`docs/.vitepress/theme/index.ts`、`docs/.vitepress/theme/custom.css`、`docs/package.json`、`docs/bun.lock`。

### `dev-docs/` 已落地的开发者内容页（32 个 `.md`，已逐条核实）

| 分区       | 文件                                    | 站内页面                                               |
| ---------- | --------------------------------------- | ------------------------------------------------------ |
| 首页       | `dev-docs/index.md`                     | `/`（`layout: home`）                                  |
| 总览       | `dev-docs/overview/index.md`            | [项目总览与技术基线](/overview/)                       |
| 总览       | `dev-docs/overview/architecture.md`     | [三端架构与请求生命周期](/overview/architecture)       |
| 总览       | `dev-docs/overview/structure.md`        | [目录结构与代码地图](/overview/structure)              |
| 总览       | `dev-docs/overview/getting-started.md`  | [本地开发与命令手册](/overview/getting-started)        |
| 总览       | `dev-docs/overview/config.md`           | [配置与环境变量](/overview/config)                     |
| 后端       | `dev-docs/backend/index.md`             | [后端分层与请求链路](/backend/)                        |
| 后端       | `dev-docs/backend/auth-rbac.md`         | [鉴权 · RBAC · 数据权限](/backend/auth-rbac)           |
| 后端       | `dev-docs/backend/booking.md`           | [预约主链路实现](/backend/booking)                     |
| 后端       | `dev-docs/backend/scheduling.md`        | [排班与可约时段算法](/backend/scheduling)              |
| 后端       | `dev-docs/backend/payment.md`           | [收银与支付通道接入](/backend/payment)                 |
| 后端       | `dev-docs/backend/refund-reconcile.md`  | [退款判责与对账](/backend/refund-reconcile)            |
| 后端       | `dev-docs/backend/membership.md`        | [会员 · 储值 · 次卡 · 积分](/backend/membership)       |
| 后端       | `dev-docs/backend/credit.md`            | [挂账与应收](/backend/credit)                          |
| 后端       | `dev-docs/backend/reports.md`           | [报表与提成核算](/backend/reports)                     |
| 后端       | `dev-docs/backend/notification-jobs.md` | [通知与定时任务](/backend/notification-jobs)           |
| 后端       | `dev-docs/backend/app-domain.md`        | [小程序 app 域实现](/backend/app-domain)               |
| 后端       | `dev-docs/backend/ai-agent.md`          | [AI 操作助手](/backend/ai-agent)                       |
| 前端       | `dev-docs/frontend/index.md`            | [后台前端（Vue 3）](/frontend/)                        |
| 前端       | `dev-docs/frontend/pages.md`            | [后台页面与权限点清单](/frontend/pages)                |
| 前端       | `dev-docs/frontend/miniapp.md`          | [小程序架构与主题系统](/frontend/miniapp)              |
| 前端       | `dev-docs/frontend/miniapp-pages.md`    | [小程序页面与接口映射](/frontend/miniapp-pages)        |
| 数据       | `dev-docs/data/index.md`                | [数据模型总览](/data/)                                 |
| 数据       | `dev-docs/data/business-tables.md`      | [业务表详解](/data/business-tables)                    |
| 数据       | `dev-docs/data/system-tables.md`        | [系统 · 监控 · AI · 小程序身份表](/data/system-tables) |
| 数据       | `dev-docs/data/migrations-seeds.md`     | [迁移 · 种子数据 · 派生口径](/data/migrations-seeds)   |
| 质量与交付 | `dev-docs/quality/index.md`             | [测试策略与验收标准](/quality/)                        |
| 质量与交付 | `dev-docs/quality/deploy.md`            | [构建 · 部署 · 运维](/quality/deploy)                  |
| 质量与交付 | `dev-docs/quality/pitfalls.md`          | [踩坑记录与排查手册](/quality/pitfalls)                |
| 附录       | `dev-docs/appendix/api.md`              | [接口契约索引](/appendix/api)                          |
| 附录       | `dev-docs/appendix/permissions.md`      | [权限点与菜单清单](/appendix/permissions)              |
| 附录       | `dev-docs/appendix/related-docs.md`     | [相关文档与资料库](/appendix/related-docs)（本页）     |

站点工程文件：`dev-docs/.vitepress/config.mts`（含 `withMermaid` 包装）、`dev-docs/package.json`、`dev-docs/bun.lock`。注意 `dev-docs/` **没有** `theme/` 目录。

::: warning 侧栏登记页与磁盘文件的一致性靠人工维护
两站的 `.vitepress/config.mts` 里都是 `ignoreDeadLinks: false`（死链会让构建失败）。已核实：`dev-docs` 与 `docs` 的 sidebar / nav 登记路径，与上面两张清单**逐条对齐，当前没有缺口**；但配置登记的是**目标目录**，不等于文件永远存在 —— 一旦有页面被删除、重命名或搬迁，构建就会失败。

判断某页是否存在，**用 `Get-ChildItem` 看磁盘，而不是看配置**；漏改时构建会精确定位：

```bash
cd dev-docs && bun run build     # 报错形如：Found dead link /frontend/miniapp in file .../backend/app-domain.md:426
```

因此：

- 新增页面 → 在对应 `config.mts` 登记，并在本页清单里补一行；
- 删除 / 重命名 / 搬迁页面 → 检查所有指向它的链接（含本页、两站首页卡片），历史文档里的路径最容易漏（见「技能里声明的 spec 路径漂移」）；
- **不要**为了「先跑通」把 `ignoreDeadLinks` 关掉 —— 这是刻意的门禁。
  :::

## `.agents/skills/` 全量技能表

表格内容来自每个技能 `SKILL.md` 开头的 YAML frontmatter（`description`、`whenToUse`）与 `metadata.sections`，**不是按目录名推测**。共核实到 **16 个**技能目录。

| 技能名                          | 适用范围                                                                                                                                                                                                                                                                   | 什么时候该加载                                                                                                                                                      |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `project-overview`              | **总纲**：技术基线、目录结构、命令、代码铁律、实施批次 B1~B6 与全部技能索引（`metadata.specVersion: v1.3`，无 `sections`）                                                                                                                                                 | **开始任何开发任务前先加载**，用来判断该改哪个模块、看哪份 spec 章节、再加载哪个子技能                                                                              |
| `money-invariants`              | **资金红线**：金额事实的唯一来源、条件更新模板（余额 / 次数 / 积分 / 销账 / 退款 / 回调）、全局锁顺序、只追加与冲正、对账等式（§6.5 / §6.6 / §15.7 / §17）                                                                                                                 | **任何涉及钱、余额、积分、次卡、应收的写入前必须加载**；评审他人资金代码、排查账实不符时同样加载                                                                    |
| `base-data`                     | 基础数据：服务项目、美甲师档案、美甲师可做项目、顾客档案（兼会员档案）；删除保护、手机号唯一与软删策略、顾客↔会员↔微信绑定锚点（§4.3 / §9.1~§9.4 / §9.11 / §22 / §4.4）                                                                                                    | 实现或修改服务项目 / 美甲师 / 可做项目 / 顾客档案的接口与页面；处理引用保护与手机号唯一冲突，排查「为什么删不掉」「为什么建不了同号顾客」                           |
| `scheduling`                    | 排班：周模板整体替换（PUT）、日期例外（请假 `off` / 自定义 `custom`）、求值优先级、主数据变更与既有预约的冲突保护（409 + 受影响清单 + `force`）（§4.3 / §6.4 / §9.3 / §5.2）                                                                                               | 实现或修改 `weekly-shifts` / `overrides` 接口与排班页面；处理「请假当天还有预约」「缩短班次会不会撞单」                                                             |
| `booking-core`                  | 预约主链路：可约时段算法（班次−预约−缓冲，对称 gap）、冲突检测与 `FOR UPDATE` 锁、服务状态机与资金状态机、创建 / 改期 / 取消 / 结算九步流程与幂等（§5 / §6.1~§6.4 / §7 / §9.5 / §12 B1）                                                                                   | 改预约接口、算可约时段；排查「为什么这个时段不可约」「为什么会超订」「尾款对不上」                                                                                  |
| `membership`                    | 会员体系：顾客即会员字段、等级折扣率（千分比）、积分累计 / 抵扣 / 兑换、储值本金与赠送余额及退款审批、次卡核销与到期、算价公式（§5.7 / §15 / §9.6 / §9.10 / §12 B2）                                                                                                       | 实现或修改会员等级 / 积分 / 储值 / 次卡接口与页面；写算价逻辑；排查「折扣算错」「积分抵太多」「次卡核销不了」「退款该退多少」                                       |
| `cashier-payment`               | 收银与支付：微信 Native 扫码 / 支付宝当面付、线下收款记账、定金与尾款、混合支付、回调验签与幂等、主动查单与关单、退款按服务阶段分流（开始前无理由全退 / 开始后店长手动）+ 额度预留与失败重试、渠道对账差异（§4.5 / §5.8 / §7.4 / §9.8 / §17 / §12 B3）                     | 实现或修改 `/biz/payments`、`/biz/refunds`、`/biz/payment-diffs`、收银台；处理回调、尾款补收、退款执行与重试、对账差异                                              |
| `credit-receivable`             | 挂账与应收：挂账主体（顾客 / 公司 / 员工）、额度与账期、下单挂账（不写支付单、`pay_status=credit`）、销账不得超额、账龄与逾期标记、「挂账不计营收、销账才计入」口径（§4.5 / §9.9 / §18 / §15.7）                                                                           | 实现或修改 `/biz/credit-accounts`、`/biz/receivables` 接口与台账页面；处理月结、销账、逾期、账龄                                                                    |
| `operations-reports`            | 运营三件套：评价（一单一评 / 回复 / 隐藏 / 代录）、报表口径（净营收 = 成功支付 − 成功退款、营业日切分、次卡核销单列）、提成（规则优先级、计提基数、补提、冲销、结算冻结）（§4.6 / §9.11 / §20 / §12 B4）                                                                   | 实现或修改 `/biz/reviews`、`/biz/reports/*`、`/biz/commission-*` 与对应页面；对不上营收数字；美甲师对提成有异议                                                     |
| `notification`                  | 通知：短信 + 站内消息模板（code + 变量校验）、触发点与默认渠道、事务后发送失败不回滚、`SmsProvider` 抽象与未配置降级、失败重试与站内 inbox（§4.6 / §8.1 / §9.11 / §19 / §12 B5）                                                                                           | 实现或修改 `sys_notice_template` / `sys_notice_log`、短信通道、站内消息、提醒任务（次日提醒、次卡到期、应收逾期）；排查「顾客没收到短信」                           |
| `recurring-bookings`            | 周期预约：规则字段（每周几 + 开始时间 + 生效区间 + 滚动窗口）、批量生成幂等游标与唯一约束、生成时跳过收款（`unpaid`）、冲突策略 `skip` / `notify`、「改规则不回溯已生成单据」（§4.6 / §5.9 / §9.11 / §21 / §12 B5）                                                        | 实现或修改 `/biz/recurrences`、`generated_until` 滚动生成任务；处理周期单与排班 / 请假的交互；排查重复生成                                                          |
| `data-model`                    | 数据模型：32 张表分组清单、命名与索引约定、软删与物理删豁免、Drizzle 迁移流程与派生字段口径（§3 / §4.1~§4.6）                                                                                                                                                              | 建表或改表、跑 `db:generate` / `db:migrate`、加索引、处理唯一约束、弄清楚某张表归哪个模块                                                                           |
| `miniapp-reserved`              | 小程序端预留：`app_` 身份表、独立认证域 `/api/v1/app/**`、`AppAccessTokenGuard` 与后台 token 双向拒绝、app 域不接 RBAC、不复用后台 DTO、登录与手机号绑定流程、4 个只读接口真实现 + 写接口 501 契约骨架（§4.4 / §8.3 / §9.7 / §16 / §12 B6）                                | 做 app 域任何代码时；实现或修改 `src/modules/app/**`、`app_` 表、app 守卫与 Swagger 分组；讨论小程序联调与后续 P2 落地                                              |
| `web-frontend`                  | 后台前端：24 个页面清单、`useTable` + lew-ui 列表模式（`formKey` 重建 / `setForm` 回填 / `v-permission` / `confirmDanger`）、文件与图片上传（LewForm `as:'upload'` + `uploadHelper`）、菜单 seed 驱动路由、收银台与退款审批等复杂交互、时间与金额展示口径（§10 / §9 / §3） | 新增 / 修改 `web/src/views/biz` 页面、API 封装、表单与权限按钮；做文件 / 图片上传与预览；实现收银台、退款审批、对账、报表页                                         |
| `testing-acceptance`            | 测试与验收：真实 MySQL 集成测试入口（`.env.test` + 独立库 + 建表清表）、`bun test` 约定、B1~B6 验收清单、并发 / 幂等 / 时区用例写法、「做完了没」的完成定义（§12 / §11 / §6.2 / §6.6）                                                                                     | 写验收或集成测试；准备提交 / 上线前自检；复现并发、超订、账实不符类问题                                                                                             |
| `wechatpay-payment-integration` | 微信支付问题统一入口（外部引入的官方技能包，`version 1.1`，作者 `wechatpay`）：产品选型、官方示例代码、接入质量评估、答疑与排障；**自带离线官方文档资产库 + 排障参考**（详见下方说明）                                                                                     | 只要问题落到微信支付产品与接入（选型、要示例代码、上线前质量检查、字段与接口规则答疑、报错 / 查单 / 支付排障）就加载；项目内具体收银实现仍以 `cashier-payment` 为主 |

### 技能里声明的 spec 路径漂移（已知问题）

16 个技能里，除 `wechatpay-payment-integration` 外的**每一个** `SKILL.md` 都在 frontmatter 里写了：

```yaml
metadata:
  spec: docs/superpowers/specs/2026-09-11-nail-salon-booking-design.md
```

但该路径在仓库里**不存在**。spec 的**真实位置**是：

```text
project-design/superpowers/specs/2026-09-11-nail-salon-booking-design.md
```

即整个 `superpowers/` 从 `docs/` 挪到了 `project-design/`，而技能 frontmatter、以及 `AGENT.md` 与 `project-design/HANDOVER-miniapp.md`、`design-gaps.md` 内的引用都还停留在旧路径。**按 `metadata.spec` 去打开文件一定会失败**，请以本页给出的 `project-design/superpowers/specs/...` 为准。`metadata.sections`（如 `§5`、`§9.8`）指向的章节号仍然有效，spec 未重新编号。

### 关于 `wechatpay-payment-integration`

这是一个**外部引入的大型技能包**，不建议逐条翻阅。已核实其顶层只有 4 项：`SKILL.md`、`assets/`（**4088 个文件**，整棵微信支付官方文档离线镜像）、`references/`、`scripts/`。注意：仓库里**没有**该技能包顶层 `LICENSE` / `README.md`（与部分说明不符）。

- `references/`（6 份排障与检索参考）：`基础概念及业务介绍.md`、`接入质量检查清单.md`、`如何理解用户问题.md`、`文档检索与问答.md`、`APIv3接口动态排障.md`、`wechatpay-dev-cli使用说明.md`。
- `scripts/`：`wechatpay-resource-sync.py` + `.wechatpay-resource-sync-state.json`（资产同步）、`extract_and_sign.sh` / `.ps1`（签名提取）。
- 用法：**先看 `SKILL.md` 与 `references/`，需要官方原文时再从 `assets/` 里检索**，不要全量加载。

## `project-design/` 资料索引

共核实到 **28 个文件**（已排除 `node_modules/`）。以下逐条列出。

### 原始设计与施工计划

| 文件                                                                              | 用途（一句话）                                                                                                                                    | 参考价值 / 时效性提醒                                                                                                                                                                                                                                                                                                               |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `project-design/superpowers/specs/2026-09-11-nail-salon-booking-design.md`        | 项目**原始设计方案**，标题「美甲店到店预约系统 · 设计方案」，首行自述 `版本 v1.3 · 2026-09-11 · 状态：待评审`；含 v1.1 / v1.2 / v1.3 三轮修订说明 | **最有分量的设计意图来源**：v1.1 修了 cron 表达式、缓冲语义（`end_at` 不含缓冲）、时区日界、`booking_no` 唯一性；v1.2 并入会员体系与小程序预留；v1.3 大范围扩容。全文 **2661 行、26 个 `## ` 一级章节**（含 §1~§22 与附录）。**但权威性低于源码，且状态仍是「待评审」**——接口契约以 `src/` 为准（见 [接口契约索引](/appendix/api)） |
| `project-design/superpowers/plans/2026-09-11-b1-b6-implementation-plan.md`        | B1~B6 模块划分与跨模块接口的**唯一施工契约**（「并行施工的接口冻结文档」）：服务类名、文件路径、跨模块方法签名必须一致                            | 308 行、4 个 `## ` 章节。适合理解模块边界与冻结约定；它自己声明「规则来源：spec v1.3 与 `.agents/skills/*`（**15 个技能**）」，而实际技能目录已是 16 个，说明该计划略微滞后                                                                                                                                                         |
| `project-design/superpowers/plans/2026-09-11-rename-to-manicure-and-test-plan.md` | 更名（`nest-admin-ts` → `manicure`）+ 全量补测的实施计划；状态「已拍板，待执行」                                                                  | 153 行、8 个 `## ` 章节。**历史过程文档**，更名已完成，当背景读；不要据此判断当前命名                                                                                                                                                                                                                                               |
| `project-design/superpowers/plans/2026-09-11-miniapp-development-plan.md`         | 小程序开发**施工单（AI 执行版）**：B6 收口 + P2 客户端，含门禁标记表（`> **给 AI 的执行单**…不使用「人日」`）                                     | 371 行、13 个 `## ` 章节。基线 commit `00c6f9a`，是理解小程序 P2 范围的入口；执行状态需对照 `HANDOVER-miniapp.md`                                                                                                                                                                                                                   |

### 踩坑记录（格式固定：现象 → 根因 → 正确做法 → 怎么发现的）

| 文件                                 | 用途（一句话）                                                                                                                      | 参考价值 / 时效性提醒                                                                                  |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `project-design/pitfalls/tooling.md` | 工具链踩坑（PowerShell / 开发者工具 / 测试运行），三端都会踩的通用坑（如 `[System.IO.File]` 不认 PowerShell 的 `cd`）               | **改代码前先扫一眼**，能省下重复排查的十几分钟；本站汇总入口见 [踩坑记录与排查手册](/quality/pitfalls) |
| `project-design/pitfalls/web.md`     | 前端 / 管理端（Vue3 + lew-ui + Vite）踩坑，如 `useTable` 按 URL 取数不要另引 `listXxx`（避免 `TS6133`）                             | 改 `web/` 之前必读；每条标注了「实测 / 技能」来源                                                      |
| `project-design/pitfalls/server.md`  | 后端（NestJS / Drizzle / MySQL）踩坑，如 drizzle 生成的 `DEFAULT (CURRENT_TIMESTAMP)` 会让 `bun run db:migrate` 中途报 `ERROR 1067` | 改后端之前必读；与 `data-model` 技能的迁移约定配合看                                                   |
| `project-design/pitfalls/miniapp.md` | 小程序（微信原生 TS）踩坑，如不要用 `Add-Content` 追加 WXSS（会导致整页渲染错乱）                                                   | 改 `miniapp/` 之前必读                                                                                 |

### 交接与设计补充

| 文件                                       | 用途（一句话）                                                                                                                                                  | 参考价值 / 时效性提醒                                                                                                     |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `project-design/HANDOVER-miniapp.md`       | 小程序端 + app 域身份的**交接说明**（截至 2026-09-11）：「只写事实与入口，不重复 spec」；给出小程序 10 页已落地、后端 app 域 10 条集成用例全绿的现状            | 接手小程序相关工作的**第一入口**；内含指向 `docs/superpowers/specs/...` 的**旧路径**，按漂移说明换成 `project-design/...` |
| `project-design/design-gaps.md`            | 需要补画的设计稿清单：对比 `docs/design.png` 的 6 屏与小程序 14 个页面，列出「必须补 / 需要补 / 设计稿画了但后端没有」                                          | 规划 UI 工作时看；同样引用了 `docs/design.png` 的旧路径（真实文件为 `project-design/design.png`）                         |
| `project-design/design-prompts-miniapp.md` | 小程序 UI 设计稿的**图像生成提示词**（ChatGPT 用），刻意不复刻现有实现，一页一段、自包含可复现                                                                  | 重新出视觉稿时按 §0 的 5 条流程使用；默认风格为 A「柔光编辑」                                                             |
| `project-design/brand/README.md`           | 品牌 LOGO 说明：`logo-master.png`（1073×1097 透明底）是**唯一源文件**，各尺寸均从它导出，禁止直接改 `web/public/**` 或 `miniapp/**/assets/logo.png`（那是产物） | 涉及品牌图时必读；给出了 favicon 64 / apple-touch 180 / 后台 logo 256 / 小程序 logo 240 的导出规格                        |

### UI 设计稿与截图（图片，仅作视觉参考）

| 文件                                                                     | 用途                                                                      |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| `project-design/design.png`                                              | 早期整体 UI 设计稿（6 屏）                                                |
| `project-design/manicure-ui-batch1-hd.png` ~ `manicure-ui-batch3-hd.png` | 美甲 UI 高清设计稿，第 1~3 批                                             |
| `project-design/manicure-ui-batch4.png`、`manicure-ui-batch5.png`        | 美甲 UI 设计稿，第 4~5 批（非 hd 命名）                                   |
| `project-design/brand/logo-master.png`                                   | 品牌 LOGO 唯一源文件                                                      |
| `project-design/screenshots/dashboard.png`、`screenshots/login.png`      | 后台管理端截图（仪表盘、登录页）                                          |
| `project-design/screenshots/miniapp/01-login.png` ~ `07-mine.png`        | 小程序截图 7 张：登录、首页、服务列表、服务详情、门店、美甲师工作台、我的 |

::: warning spec 只是早期设计意图，接口契约以 `src/` 源码为准
`project-design/superpowers/specs/2026-09-11-nail-salon-booking-design.md` 自述 `状态：待评审`，且它的三轮修订说明本身就在**推翻自己早前的结论**（缓冲语义、时区日界、`booking_no` 唯一性等）。因此：

- **不要**照 spec 写接口签名、字段名或表结构 —— 以 `src/` 源码为准；接口契约索引见 [接口契约索引](/appendix/api)。
- **不要**把 spec 的章节号当成实现进度；进度请对照 `.agents/skills/*` 与 `dev-docs/` 里已落地的模块页。
- spec 的正确用法是回答「**为什么**要这么设计」；「**现在是什么样**」请查 [数据模型总览](/data/)、[业务表详解](/data/business-tables) 与 [踩坑记录与排查手册](/quality/pitfalls)。
  :::

## 两站联动

`docs/`（对客手册）与 `dev-docs/`（开发者文档）是**两个独立的 VitePress 工程**：各自有 `package.json`、`bun.lock`、`.vitepress/config.mts`，互不引用，也不共用主题。以下端口、脚本、环境变量均已从四个文件实际读取核实。

### 脚本与端口（真实值）

| 站点         | 目录        | `dev`                         | `build`             | `preview`                         | 端口来源                             |
| ------------ | ----------- | ----------------------------- | ------------------- | --------------------------------- | ------------------------------------ |
| 对客操作手册 | `docs/`     | `vitepress dev . --port 5190` | `vitepress build .` | `vitepress preview . --port 5191` | `docs/package.json` 的 `scripts`     |
| 开发者文档   | `dev-docs/` | `vitepress dev . --port 5180` | `vitepress build .` | `vitepress preview . --port 5181` | `dev-docs/package.json` 的 `scripts` |

两个工程都用 `vitepress@2.0.0-alpha.20`、`packageManager: bun@1.4.0`；`dev-docs` 额外依赖 `vitepress-plugin-mermaid` 与 `mermaid`（config 用 `withMermaid(...)` 包装）。

**本地同时启动两站**（两个终端，或分别放到后台）：

```bash
# 终端 1：对客手册站 → http://localhost:5190/
cd docs && bun install && bun run dev

# 终端 2：开发者文档站 → http://localhost:5180/
cd dev-docs && bun install && bun run dev
```

验证构建产物（各自独立构建）：

```bash
cd docs && bun run build && bun run preview       # http://localhost:5191/
cd dev-docs && bun run build && bun run preview   # http://localhost:5181/
```

### 一起部署：用 `DOCS_BASE` 区分子路径

两个 `config.mts` 都用了同一行写法：

```ts
const base = process.env.DOCS_BASE ?? '/';
```

注释里的示例值各有不同，已核实原文：`docs/.vitepress/config.mts` 写的是 `例如 DOCS_BASE=/manicure/docs/ bun run build`；`dev-docs/.vitepress/config.mts` 写的是 `例如 DOCS_BASE=/manicure/dev-docs/ bun run build`，并补一句「本地开发与默认构建都用根路径」。

于是把两站部署到同域名的两个子路径时，分别注入各自的 `DOCS_BASE`：

```bash
# 对客手册 → /manicure/docs/
cd docs && DOCS_BASE=/manicure/docs/ bun run build

# 开发者文档 → /manicure/dev-docs/
cd dev-docs && DOCS_BASE=/manicure/dev-docs/ bun run build
```

Bash / WSL / Git Bash 下 `VAR=value cmd` 是合法的行内赋值；**PowerShell 不支持这种写法**，必须先设环境变量再执行（注意结尾的斜杠不能省）：

```powershell
# 对客手册
cd docs
$env:DOCS_BASE = '/manicure/docs/'
bun run build

# 开发者文档
cd dev-docs
$env:DOCS_BASE = '/manicure/dev-docs/'
bun run build
```

`$env:DOCS_BASE` 只在当前 PowerShell 会话内有效，不会污染系统环境变量；如需恢复根路径部署，执行 `Remove-Item Env:DOCS_BASE` 或新开一个终端。

### 为什么必须在部署时设置 `DOCS_BASE`

1. **产物目录**：VitePress 默认把静态产物输出到工程内的 `./.vitepress/dist`（即 `docs/.vitepress/dist`、`dev-docs/.vitepress/dist`），两站互不覆盖，可以各自打包后再合并到同一个 Web 根目录的两个子目录。
2. **不设 `DOCS_BASE` 就会 404**：`base` 决定 HTML 里所有静态资源的引用前缀。默认 `/` 生成的产物假设站点挂在域名根目录；一旦实际挂在 `/manicure/docs/` 这类子路径下，`/assets/*.js`、`/assets/*.css`、logo、搜索索引都会指向错误位置而 404 —— 页面可能只剩空白或没有样式。构建期注入 `DOCS_BASE` 后，引用前缀会写成 `/manicure/docs/assets/...`，与部署路径一致。
3. **构建是纯静态的，与运行环境无关**：`base` 在构建时被烘焙进产物，事后改不了，所以必须在 `bun run build` 那一刻就设好；这也是为什么不建议用「改了再传」的方式补救。
4. **两站独立构建、独立部署**：可以发布到不同域名、不同子路径或不同服务，彼此没有运行时依赖；只有在同一域名下用子路径区分时才需要同时设置两个不同的 `DOCS_BASE`。

::: tip 本仓库的后端部署是另一条线
`ecosystem.config.js` 只负责后端（PM2，`manicure-server`，`output/server/main.js`，`PORT=1011`），**不包含 `web/` 前端，也不包含这两个文档站**。文档站是纯静态产物，按上面的方式单独构建与托管即可。
:::

## 新人上手路径

按下面 5 步走，每一步都在本站内有对应页面，读完即可定位到具体模块：

1. **[项目总览与技术基线](/overview/)** —— 先建立技术基线与全局认知：技术栈（NestJS + Fastify + Drizzle/MySQL、Vue 3 + lew-ui、微信原生 TS）、命令、代码铁律与实施批次。同时加载 `project-overview` 技能（总纲）。
2. **[三端架构与请求生命周期](/overview/architecture)** —— 搞清一次请求从三端哪一端发起、经过哪些层；配合 **[目录结构与代码地图](/overview/structure)** 建立「什么代码在哪」的直觉，再用 **[本地开发与命令手册](/overview/getting-started)** 与 **[配置与环境变量](/overview/config)** 把本地环境跑起来。
3. **[后端分层与请求链路](/backend/)** —— 进入后端实现视角：Controller / Service / DTO / 守卫 / 异常与响应包装的落地方式。
4. **[鉴权 · RBAC · 数据权限](/backend/auth-rbac)** —— 权限是几乎所有接口的前置条件，先看懂守卫、权限点与数据权限，再看业务接口会快很多。
5. **落到你的模块** —— 预约：[预约主链路实现](/backend/booking)；排班：[排班与可约时段算法](/backend/scheduling)；钱：[收银与支付通道接入](/backend/payment) 与 [退款判责与对账](/backend/refund-reconcile)，并且**先加载 `money-invariants` 技能**；会员：[会员 · 储值 · 次卡 · 积分](/backend/membership)；挂账：[挂账与应收](/backend/credit)；数据侧从 **[数据模型总览](/data/)** 进，落到 **[业务表详解](/data/business-tables)** 与 **[迁移 · 种子数据 · 派生口径](/data/migrations-seeds)**；前端：[后台前端（Vue 3）](/frontend/) 与 [后台页面与权限点清单](/frontend/pages)；小程序：[小程序架构与主题系统](/frontend/miniapp)、[小程序页面与接口映射](/frontend/miniapp-pages) 与 [小程序 app 域实现](/backend/app-domain)；接口总索引：[接口契约索引](/appendix/api)；权限点：[权限点与菜单清单](/appendix/permissions)；上线：[构建 · 部署 · 运维](/quality/deploy)；踩坑先查 [踩坑记录与排查手册](/quality/pitfalls)。

补充：`/frontend/*` 与 `/backend/app-domain` 对应的开发技能分别是 `web-frontend` 与 `miniapp-reserved`，动手前先加载；[测试策略与验收标准](/quality/) 用来回答「做完了没」。

### 第一周建议任务

按顺序做，每条都对应本仓库里真实存在的命令（脚本名取自根 `package.json` 与 `dev-docs/package.json`）：

1. **跑起来后端**：`bun install` → `bun run db:migrate` → `bun run db:seed` → `bun run dev`，确认服务能起、种子数据可查。（辅助脚本还有 `db:seed:menus`、`db:seed:biz`、`db:seed:nail`、`db:seed:demo`、`db:seed:demo:bookings`；表结构改动用 `db:generate` 生成迁移，`db:studio` 可视化看数据。）
2. **跑通质量门禁**：`bun run typecheck`、`bun run lint`、`bun test` 三条必须全绿 —— 这是仓库明确的提交前提。集成测试需要 `.env.test` 指向独立测试库，写法见 `testing-acceptance` 技能。
3. **读一个模块的技能**：挑一个真实任务相关的技能从头读完（建议先 `booking-core` 或 `base-data`），并对照 [预约主链路实现](/backend/booking) 或 [业务表详解](/data/business-tables) 在源码里找到对应文件。
4. **起本地开发者文档站并改一页**：`cd dev-docs && bun install && bun run dev`（`http://localhost:5180/`），在自己刚读过的模块页里补一段「实测结论」或修正一处过时描述；构建前用 `bun run build` 验证无死链（`ignoreDeadLinks: false`，死链即构建失败）。
5. **写一个集成测试 + 改一个小接口**：优先覆盖并发 / 幂等 / 时区类用例（见 `testing-acceptance` 技能），改动尽量小且可回滚；改完同步文档 —— 对照下节「文档维护约定」表更新对应页面。
6. **收尾**：`bun run format:check`（必要时 `bun run format`）、复核 `git status` 只包含预期文件，并按 PR 自检清单过一遍。

## 文档维护约定

**改了代码就要改文档。** 下表是「改动类型 → 需更新的文档页」对照，全部使用本站已登记、当前可正常打开的路径。

| 改动类型                                                 | 需更新的文档页                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 新增 / 修改接口（路径、入参、出参、错误码）              | [接口契约索引](/appendix/api) + 对应模块页：[预约主链路实现](/backend/booking)、[排班与可约时段算法](/backend/scheduling)、[收银与支付通道接入](/backend/payment)、[会员 · 储值 · 次卡 · 积分](/backend/membership)、[挂账与应收](/backend/credit)、[报表与提成核算](/backend/reports)、[退款判责与对账](/backend/refund-reconcile) |
| 新增 / 修改权限点、菜单、角色绑定                        | [权限点与菜单清单](/appendix/permissions) + [鉴权 · RBAC · 数据权限](/backend/auth-rbac)                                                                                                                                                                                                                                            |
| 新增 / 修改表、字段、索引、唯一约束                      | [数据模型总览](/data/)、[业务表详解](/data/business-tables)、[系统 · 监控 · AI · 小程序身份表](/data/system-tables)                                                                                                                                                                                                                 |
| 新增 / 修改迁移脚本或种子数据                            | [迁移 · 种子数据 · 派生口径](/data/migrations-seeds) + [数据模型总览](/data/)；实际操作前读 `project-design/pitfalls/server.md`                                                                                                                                                                                                     |
| 新增 / 修改环境变量、配置项                              | [配置与环境变量](/overview/config) + [项目总览与技术基线](/overview/)                                                                                                                                                                                                                                                               |
| 本地开发命令、脚本增删                                   | [本地开发与命令手册](/overview/getting-started)、[项目总览与技术基线](/overview/)；以根 `package.json` 的 `scripts` 为准                                                                                                                                                                                                            |
| 构建 / 部署 / 运维流程变化（含 `DOCS_BASE`、PM2）        | [构建 · 部署 · 运维](/quality/deploy) + [配置与环境变量](/overview/config)；PM2 事实来源是 `ecosystem.config.js`                                                                                                                                                                                                                    |
| 踩到并解决一个新坑                                       | [踩坑记录与排查手册](/quality/pitfalls)；同时立即在 `project-design/pitfalls/{tooling,web,server,miniapp}.md` 对应文件里追加一条（格式：现象 → 根因 → 正确做法 → 怎么发现的）                                                                                                                                                       |
| 小程序 / app 域改动（`app_` 表、`/api/v1/app/**`、守卫） | [小程序 app 域实现](/backend/app-domain) + [小程序架构与主题系统](/frontend/miniapp)、[小程序页面与接口映射](/frontend/miniapp-pages)；动手前加载 `miniapp-reserved` 技能                                                                                                                                                           |
| 后台前端页面 / 组件 / 上传 / 收银台交互                  | [后台前端（Vue 3）](/frontend/)、[后台页面与权限点清单](/frontend/pages) + [后端分层与请求链路](/backend/)、[收银与支付通道接入](/backend/payment)；动手前加载 `web-frontend` 技能                                                                                                                                                  |
| 资金相关逻辑（余额、积分、次卡、支付单、退款、应收）     | [挂账与应收](/backend/credit)、[退款判责与对账](/backend/refund-reconcile)、[会员 · 储值 · 次卡 · 积分](/backend/membership)；改前**必须**加载 `money-invariants` 技能，改后核对对账等式                                                                                                                                            |
| 报表口径 / 提成规则 / 评价行为变化                       | [报表与提成核算](/backend/reports)；口径要同时体现在 [业务表详解](/data/business-tables) 的派生字段说明里                                                                                                                                                                                                                           |
| 通知模板、触发点、定时任务变化                           | [通知与定时任务](/backend/notification-jobs)                                                                                                                                                                                                                                                                                        |
| 测试策略、验收标准、完成定义变化                         | [测试策略与验收标准](/quality/) + `testing-acceptance` 技能                                                                                                                                                                                                                                                                         |
| 对客可见行为变化（操作步骤、按钮文案、门店配置项）       | 除本站对应模块页外，**还要同步 `docs/` 对客手册**（`docs/guide/*.md`、`docs/booking/*.md`、`docs/payment/*.md`）                                                                                                                                                                                                                    |
| 架构、分层、目录结构变化                                 | [三端架构与请求生命周期](/overview/architecture)、[目录结构与代码地图](/overview/structure)、[后端分层与请求链路](/backend/)                                                                                                                                                                                                        |
| 品牌 / LOGO / 截图更新                                   | `project-design/brand/README.md`（源文件与导出规格）+ `project-design/screenshots/**`                                                                                                                                                                                                                                               |
| 技能包（`.agents/skills/`）内容变化                      | 本页的「全量技能表」需同步；技能数量或 frontmatter 路径变化时一并更新「路径漂移」说明                                                                                                                                                                                                                                               |
| 新增 / 删除 / 重命名页面                                 | 对应 `config.mts` 的 sidebar 与 nav + [相关文档与资料库](/appendix/related-docs) 的 `docs/` 与 `dev-docs/` 两张清单（`ignoreDeadLinks: false`，漏改即构建失败）                                                                                                                                                                     |

### PR 自检清单

- [ ] `bun run typecheck`、`bun run lint`、`bun test` 三条全绿；涉及资金 / 并发的改动补了对应集成测试。
- [ ] 涉及钱的写入前已加载 `money-invariants`；条件更新、锁顺序、只追加与冲正未被绕过。
- [ ] 涉及权限的接口已同步权限点，且 [权限点与菜单清单](/appendix/permissions) 与 [鉴权 · RBAC · 数据权限](/backend/auth-rbac) 一致。
- [ ] 表 / 字段 / 索引变化已生成迁移（`db:generate`），并更新 [业务表详解](/data/business-tables) 等数据页。
- [ ] 环境变量有新增时，`.env.example` 与 [配置与环境变量](/overview/config) 都已补上。
- [ ] 已按上表逐行核对「改动类型 → 需更新的文档页」，没有漏掉的关联页。
- [ ] 对客可见行为有变化时，`docs/` 对客手册已同步修改。
- [ ] 两站都跑过 `bun run build`：`ignoreDeadLinks: false`，任何死链都会让构建失败。
- [ ] 新踩的坑已追加进 `project-design/pitfalls/` 对应文件，而不是只留在对话里。
- [ ] 未把 `project-design/` 的早期 spec 当作接口契约；接口与字段以 `src/` 源码为准。
- [ ] `bun run format:check` 通过；`git status` 里只有本次改动预期内的文件。
