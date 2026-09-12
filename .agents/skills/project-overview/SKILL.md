---
name: project-overview
description: 美甲店到店预约系统的项目总纲——技术基线、目录结构、命令、代码铁律、实施批次 B1~B6 与全部技能索引。开始任何开发任务前先加载本技能，用来判断该改哪个模块、该看哪份 spec 章节、该加载哪个子技能。
whenToUse: 接到新任务（写接口 / 建表 / 改前端 / 排查 bug）而不知道该动哪块时；需要确认项目约定、命令、验收口径时。
metadata:
  version: '1.0.0'
  spec: docs/superpowers/specs/2026-09-11-nail-salon-booking-design.md
  specVersion: v1.3
---

# 项目总纲（美甲店到店预约系统）

## 一句话

`manicure-api` —— 美甲店「到店预约 + 会员 + 收银 + 挂账 + 运营」的三端系统：
后端 API + 后台管理前端（`web/`，44 页）+ **微信小程序（`miniapp/`，29 页）**，
小程序已完成落地（顾客端 + 美甲师工作台双模式、7 套主题），不再是「只预留接口」。
详见 [`README.md`](../../../README.md) 与 [`docs/HANDOVER-miniapp.md`](../../../docs/HANDOVER-miniapp.md)。

## 技术基线（不要换）

| 领域            | 选型                                                                        |
| --------------- | --------------------------------------------------------------------------- |
| 运行时 / 包管理 | **Bun 1.4**（唯一运行时，不引入 tsx / Node 启动方式）                       |
| Web             | NestJS 12 + **Fastify** 适配器 + Zod 4 校验                                 |
| ORM             | Drizzle ORM 1.0.0-rc.3（MySQL 方言，`src/database/schema/index.ts` 单文件） |
| 认证            | JWT（`jose`）+ 权限字符串 RBAC（`AccessTokenGuard`）                        |
| 调度            | `@nestjs/schedule` + `cron`（handler Map 模式，`sys_job` 表驱动）           |
| 前端            | Vue 3 + lew-ui（`web/`），列表统一 `useTable`                               |
| 测试            | `bun test`（vitest API 断言）· Lint `oxlint` · 格式化 `oxfmt`               |

## 常用命令

```bash
bun dev                  # 开发（bun --watch src/main.ts）
bun run typecheck        # tsc --noEmit（提交前必过）
bun run lint             # oxlint
bun run test             # bun test
bun run db:generate      # 由 schema 生成迁移
bun run db:migrate       # 执行迁移
bun run db:seed          # 管理员账号
bun run db:seed:menus    # 菜单与权限点
```

## 代码铁律（违反即 bug，非风格问题）

1. **模块导入必须带 `.js` 后缀**（`moduleResolution: NodeNext`）。
2. **金额一律整数「分」**，展示层 ÷100；取整方向**向下**（§5.7）。
3. **时间一律 UTC 存储**：连接会话 `SET time_zone='+00:00'`；「店内本地日 → 绝对时刻区间」**只能**走
   `shopDayRange(date)`，禁止 `new Date('YYYY-MM-DD')`（会按 UTC 零点解析，整体偏 8 小时）。
4. **列表接口返回 `{ items, page, pageSize }`，没有 `total`**；前端多取一条判 `hasMore`。
5. **业务表 `biz_` 前缀 + `auditColumns` 软删**；小程序侧身份表 `app_` 前缀；物理删表已在 §3 声明豁免。
6. **权限点各段全小写、不用驼峰**（`biz:serviceitem:list`，对齐既有 `monitor:loginlog:list`）。
7. **事务内的读写必须用 `tx`**，不要用 `this.database.db`。

## 目录结构（新增部分）

```
src/
  database/schema/index.ts        # 61 张表 + defineRelations（唯一 schema 文件）
                                  #   biz 31 / sys 20 / ai 7 / app 3
  database/seed/menus.ts          # 菜单 + 权限点（前端路由据此生成）
  database/seed/                  # index(管理员) / biz(业务默认值) / nail(美甲基础数据) / demo(演示)
  modules/biz/                    # 业务模块：base-data / scheduling / booking / membership
                                  #            payment / credit / reports / operations / common
                                  #   common/ 里有 shop-time.ts、booking-config.ts、money.ts、pay/、sms/
  modules/app/                    # 小程序域（auth / catalog / member / payments / staff），独立守卫
  modules/jobs/jobs.service.ts    # 注册 handler（当前 10 个）
web/src/
  api/biz/*.ts                    # API 封装
  views/biz/*/index.vue           # 26 个业务页面（另有 18 个基座页面）
  composables/useTable.ts         # 列表分页（无 total）
  utils/table-text.ts             # 单元格文本省略统一走 lew-ui 的 LewTextTrim
miniapp/miniprogram/              # 微信小程序（原生 TS，29 页）
  pages/ · custom-tab-bar/ · store/ · theme/ · utils/ · assets/
  utils/page.ts                   # definePage：页面 chrome + onShow 统一刷新
  utils/load.ts                   # runLoad：统一加载状态机（首屏骨架 / 静默刷新）
.agents/skills/                   # 本套技能（核心指引）
docs/superpowers/specs/           # 设计文档（唯一事实来源）
tests/integration/                # b1~b7 集成测试（真实 MySQL + harness）
```

## 实施批次（一次性全量交付，批次只是开发顺序）

| 批次   | 内容                                                                          | 依赖         |
| ------ | ----------------------------------------------------------------------------- | ------------ |
| **B1** | 预约主链路：基础数据 + 排班 + 可约时段 + 创建/改期/取消 + 冲突与锁 + 状态流转 | —            |
| **B2** | 会员：等级折扣 → 储值充值 → 次卡 → 积分（累计/抵扣/兑换）→ 账务流水与页面     | B1           |
| **B3** | 收银：支付单/回调/对账 + 定金尾款 + 混合支付 + 退款（判责 + 审批）            | B1、B2       |
| **B4** | 挂账应收月结 + 报表中心 + 提成                                                | B3           |
| **B5** | 运营：评价 + 周期预约 + 美甲师可做项目 + 通知（短信/站内）                    | B1~B4        |
| **B6** | ✅ 小程序：`app_` 表 + 认证域 + 全量接口 + **29 页 UI**（顾客端 + 工作台）    | B1（可并行） |
| **B7** | ✅ 小程序收口：优惠券 / 积分兑换 / 充值方案 / 订单详情 + 对应集成用例         | B6           |

**B1~B7 均已完成**（仅 JSAPI 支付是 501 契约位，等支付通道开通后接）；上线前还须过 §12 验收与
`docs/HANDOVER-miniapp.md` 第 5 节列出的人工门禁（备案 / 域名 / 正式 AppID / 证书等）。

## 技能索引（按模块加载）

| 技能                 | 何时加载                                      |
| -------------------- | --------------------------------------------- |
| `data-model`         | 建表 / 改表 / 生成迁移 / 命名与索引           |
| `money-invariants`   | **任何**涉及金额、余额、积分、次卡的写入      |
| `base-data`          | 服务项目 / 美甲师 / 美甲师可做项目 / 顾客档案 |
| `scheduling`         | 排班、请假、班次与既有预约冲突                |
| `booking-core`       | 可约时段、下单、改期、冲突与锁、状态流转      |
| `membership`         | 会员等级 / 积分 / 储值 / 次卡 / 算价          |
| `cashier-payment`    | 在线支付、定金尾款、混合支付、退款、对账      |
| `credit-receivable`  | 挂账主体、应收、销账、账龄                    |
| `notification`       | 短信 / 站内消息、模板、重试                   |
| `operations-reports` | 评价、报表口径、提成                          |
| `recurring-bookings` | 周期预约规则与批量生成                        |
| `miniapp-reserved`   | `/api/v1/app/**` 与 `app_` 表                 |
| `web-frontend`       | 任意后台页面、收银台、表单与权限按钮          |
| `testing-acceptance` | 写验收 / 集成测试 / 判断"做完了没"            |

## 完成定义（DoD）

1. `bun run typecheck`、`bun run lint`、`bun run test` 全过。
2. 新表走 `bun run db:generate` 生成迁移，**不手写 SQL 迁移**。
3. 权限点写进 `seed/menus.ts`，菜单能自动生成前端路由。
4. 相关 §12 验收条目逐条跑过（并发 / 幂等 / 时区类必须有集成测试）。
5. 涉及金额的改动，`money-invariants` 的红线逐条自检。
