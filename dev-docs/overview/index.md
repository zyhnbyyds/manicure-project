---
title: 项目总览与技术基线
---

# 项目总览与技术基线

## 一句话定位

**美甲门店的到店预约与经营管理系统**，三端一体：

| 端 | 目录 | 面向 | 入口 |
| --- | --- | --- | --- |
| 后端 API | `src/` | 后台前端 + 小程序 | `/api/v1/**`（含独立 app 域 `/api/v1/app/**`） |
| 后台管理前端 | `web/` | 店长 / 店员 / 管理员 | `http://localhost:5173`（开发）/ `output/web`（构建产物） |
| 微信小程序 | `miniapp/` | 顾客 + 美甲师工作台 | 微信开发者工具导入 `miniapp/` |

业务覆盖：预约与排班（可约时段算法）· 会员（等级折扣 / 储值 / 次卡 / 积分 / 优惠券）· 收银（微信 Native、支付宝当面付、定金尾款、混合支付、退款判责与审批）· 挂账应收 · 报表与提成 · 运营（评价 / 周期预约 / 通知）。
基座覆盖：RBAC 权限、部门/岗位/字典/配置、操作与登录审计、定时任务、文件管理、代码生成器、AI 操作助手。

::: tip 三份文档各写什么
- `docs/` —— **对客操作手册**（"这个按钮点下去会发生什么"）；
- `dev-docs/` —— **本开发者文档**（"这是怎么实现的、为什么这么实现、改动要注意什么"）；
- `project-design/` —— **设计资料库**（spec / 施工计划 / 踩坑记录 / UI 稿）。
:::

## 技术栈（已按仓库核实）

### 后端

| 项 | 选型 | 备注 |
| --- | --- | --- |
| 框架 | NestJS 12 + `@nestjs/platform-fastify` | `src/main.ts` 用 `FastifyAdapter({ logger: true, trustProxy: true })` |
| ORM | Drizzle ORM `1.0.0-rc.3` + `drizzle-kit` 同版本 | MySQL 8，驱动 `mysql2` |
| 校验 | Zod 4 | 全局中文提示：`src/main.ts` 里 `z.config(zhCN())` |
| 令牌 | `jose` ^6 | 不用 `@nestjs/jwt` |
| 密码 | `Bun.password`（argon2id） | `src/common/password/password.service.ts` |
| 定时任务 | `@nestjs/schedule` + `cron` ^4 | 任务定义存在 `sys_job` 表，启动时注册 |
| 接口文档 | `@nestjs/swagger` + `@asteasolutions/zod-to-openapi` | `/api/v1/docs` |
| 日志 | `pino` / `pino-pretty` | Fastify 内置 logger |
| 运行时 + 包管理 | **Bun 1.4**（`packageManager: bun@1.4.0`，`engines.bun >=1.4`） | 应用 / 迁移 / seed / 测试统一，**不引入 tsx / Node 启动方式** |

### 后台前端（`web/`）

| 项 | 选型 |
| --- | --- |
| 框架 | Vue 3.5 + Vite 8 + TypeScript 6（`vue-tsc` ^3.2.6） |
| 路由 / 状态 | Vue Router 5 · Pinia 3 |
| UI / 样式 | lew-ui ^2.8 · UnoCSS ^66 · `@unocss/reset` |
| 图表 / 请求 | ECharts 6 · axios（401 自动刷新 + 并发排队，见 `web/src/request.ts`） |
| 其它 | `@vueuse/core` · `dayjs` · `marked` + `dompurify`（AI 消息渲染） |
| 构建 | `vue-tsc --noEmit && vite build`，`vite.config.ts` 里 `outDir: ../output/web` |
| 开发代理 | `server.port = 5173`，`/api` → `http://localhost:3000` |

### 小程序（`miniapp/`）

- **微信原生小程序 + TypeScript**（`project.config.json` 的 `useCompilerPlugins: ["typescript"]`），组件框架为 **glass-easel**；
- **不引第三方 UI 库**：主题令牌自绘（`miniprogram/theme/`）+ 薄封装工具层（`miniprogram/utils/`）+ `custom-tab-bar`；
- 不装依赖（`miniapp/package.json` 只是壳），类型检查在仓库根执行 `bunx tsc --noEmit -p miniapp/tsconfig.json`。

### 工程与质量

| 项 | 说明 |
| --- | --- |
| Lint / Format | `oxlint` ^1.80 · `oxfmt` ^0.65（配置：`.oxlintrc.json` / `.oxfmtrc.json`） |
| 测试 | `bun test`（`vitest` 只当**断言 / mock 库**用，源码里 `from 'vitest'` 由 bun test 执行，不经过 vitest runner） |
| 测试超时 | `bunfig.toml` 把默认 hook 超时提到 60s（集成测试逐表 TRUNCATE 约 40 次往返） |
| 构建产物 | 后端 `nest build` → `output/server`（`tsconfig.build.json` 的 `outDir`）；前端 → `output/web` |

::: warning `nest build` 用的是 SWC
`nest-cli.json` 里 `"builder": "swc"` + `"typeCheck": true`，且仓库**没有 `.swcrc`**。SWC 不做类型检查以外的事，`emitDecoratorMetadata` 由 `tsconfig.json` 提供 —— 改 `tsconfig.json` 的装饰器相关选项会静默改掉 Nest 的依赖注入元数据。
:::

## 规模现状

| 维度 | 数字 | 核实方式 |
| --- | --- | --- |
| 数据表 | **61 张**（业务 `biz_*` 31 / 系统 18 + `sys_notice_*` 2 / AI `ai_*` 7 / 小程序身份 `app_*` 3） | `src/database/schema/index.ts` 里 `mysqlTable(` 出现 61 次 |
| 后台页面 | **46 个页面级 `.vue`**（`web/src/views/**`，另有 7 个 AI 面板子组件） | `web/src/views/` 下共 53 个 `.vue`，减去 `ai/components/*.vue` |
| 小程序页面 | **29 个** | `miniapp/miniprogram/app.json` 的 `pages` 数组长度 29 |
| 后端 Controller / Service | 53 / 61（含基座与 AI） | `glob **/*.controller.ts` / `**/*.service.ts` |
| 迁移 | 15 个（最新 `20260912005048_wise_tomas`） | `src/database/migrations/` |
| 测试文件 | `bun test` 扫到约 105 个（`src/**/*.spec.ts` 82 + `tests/integration/*.int.spec.ts` 18 + `web/src/**/*.spec.ts` 4） | 文件计数 |

::: details 「业务表 31 张」的口径
`biz_*` 共 31 张，其中 `biz_coupon_template` / `biz_customer_coupon` 定义在 `src/database/schema/index.ts` **文件末尾**（第 2574 行起，晚于 `sys_notice_*`），不在业务表段落里 —— 按位置扫文件很容易漏掉这两张。
:::

## 代码铁律（全局口径）

这几条是项目级别的硬约束，改动前先确认自己没踩到。

### 1. 钱：整数分、向下取整、只在服务端算

```ts
// src/modules/biz/common/money.ts
export function permilleOf(amount: number, permille: number): number {
  return Math.floor((amount * permille) / 1000); // 取整方向向下（少收不多少）
}
```

- 数据库里金额列一律是**整数「分」**（`int`），折扣率 / 抵扣上限用**千分比整数**，避免浮点误差；
- 展示层 ÷100（前端 `web/src/composables/useFormat.ts`）；
- **只在服务端算钱**：前端传的 `payableAmount` 一律不信，服务端用 `quoteBooking()` 复算；
- 算价顺序固定在 `quoteBooking()`：`原价 → 等级折扣 → 券抵扣 → 积分抵扣 → 手动改价 → 应付`，且**券与积分同一单二选一**（`money.ts` 第 101-121 行的注释写明了为什么：免得出现"被抵成 0 元"这种没定义过的行为）。

### 2. 时间：UTC 存储，"店内本地日 → 绝对时刻区间"只走 `shopDayRange()`

唯一入口是 **`src/modules/biz/common/shop-time.ts` 的 `shopDayRange(date, timeZone)`**（注意：它在 `biz/common/`，**不在** `src/common/`）。

```ts
const { start, end } = shopDayRange('2026-09-11');
// start = 2026-09-10T16:00:00Z, end = 2026-09-11T16:00:00Z（Asia/Shanghai）
```

- `src/database/database.service.ts` 建连接池时 `timezone: 'Z'`，并且每个连接 `SET time_zone = '+00:00'`；
- 默认时区 `DEFAULT_SHOP_TIMEZONE = 'Asia/Shanghai'`，可被 `sys_config` 的 `biz.booking.timezone` 覆盖（`BizConfigService.booking()`）。

::: danger 禁止 `new Date('2026-09-11')`
它会按 **UTC 零点**解析，整体偏 8 小时。列表筛选请用 `src/modules/biz/common/query.ts` 的 `localDateRange()`，它内部就是 `shopDayRange()` + `addLocalDays(to, 1)`（右边界取次日 00:00，`lt` 而非 `lte`）。
:::

- 单号里的日期段也用店内本地日：`buildDocNo()`（`src/modules/biz/common/doc-no.ts`），格式 `前缀 + yyyyMMdd + 主键补零 6 位`。

### 3. 列表接口：`{ items, page, pageSize }`，**没有 total**

```ts
// src/modules/biz/common/ports.ts
export type PageResult<T> = { items: T[]; page: number; pageSize: number };
```

- 分页解析统一走 `parsePagination(rawPage, rawPageSize)`（`biz/common/query.ts`）：默认 `pageSize = 20`，**上限 100**；
- 前端**多取一条判 `hasMore`**，不查 count（大表上 `COUNT(*)` 是纯浪费）。

::: warning 别顺手加 total
加 `total` 就等于给每个列表接口加一次全表 count。真要统计口径，用报表接口（`biz/reports/analytics`）。
:::

### 4. 涉及钱的写入：条件更新模板 + 全局锁顺序

这是 `money-invariants` 技能的核心，任何动钱、余额、积分、次卡、应收、退款的代码都必须遵守：

- **条件更新当闸门**：`UPDATE ... WHERE id = ? AND <不变量条件>`，然后检查 `affectedRows`，为 0 就是失败（409 / Conflict）。**禁止"读出来 → 应用层判断 → 写回去"**，那在并发下必然出错；
- **全局锁顺序**：`biz_staff → biz_customer → biz_payment → biz_member_card`（同类多行按 `id` 升序），见 `src/modules/biz/membership/member-accounts/member-accounts.service.ts` 的类注释与 `src/modules/biz/payment/payments/payments.service.ts` 第 300 / 344 行；
- **事务内一律用 `tx`**：`src/modules/biz/common/tx.ts` 注释写明"跑到 `this.database.db` 上就等于绕开了行锁，防超订会失效"。

## 实施批次 B1~B6

`src/app.module.ts` 里 `BizModule` 的注释就是批次地图：

| 批次 | 内容 |
| --- | --- |
| B1 | 基础数据 / 排班 / 预约主链路 |
| B2 | 会员（等级 / 储值 / 次卡 / 积分） |
| B3 | 收银（微信 Native + 支付宝当面付 / 退款 / 对账） |
| B4 | 挂账应收 / 报表 / 提成 |
| B5 | 评价 / 周期预约 / 通知 |
| B6 | 小程序 app 域（真实现在 B6~B7 之间继续落地，见 `tests/integration/b7-*.int.spec.ts`） |

集成测试的命名也是按批次：`tests/integration/b1-booking.int.spec.ts` … `b6-app-*.int.spec.ts` … `b7-coupon-*.int.spec.ts`。

## 文档分层

| 目录 | 内容 | 可信度 |
| --- | --- | --- |
| `docs/` | 对客操作手册（面向门店人员） | 运营向，讲"每个模块怎么用 + 注意事项 + 支付开通配合流程"。**它本身也是一个独立的 VitePress 站点**（`docs/.vitepress/config.mts`），已有 `guide/` `booking/` `payment/` `report/` 四个内容目录 |
| `dev-docs/` | 本开发者文档站 | 读者是开发者 / 测试 / 运维 |
| `project-design/superpowers/specs/` | `2026-09-11-nail-salon-booking-design.md` | **早期设计意图**，与现状有偏差，见下 |
| `project-design/superpowers/plans/` | 施工计划（B1~B6 / 小程序 / 重命名） | 计划视角 |
| `project-design/pitfalls/` | `server.md` / `web.md` / `miniapp.md` / `tooling.md` | 踩坑记录，改代码前先扫一眼 |
| `.agents/skills/` | 按模块拆分的开发技能 16 个 | 给人 + AI 共用，见 [目录结构与代码地图](/overview/structure) |

::: danger spec 不是现状
`project-design/superpowers/specs/2026-09-11-nail-salon-booking-design.md` 是**早期设计意图**，里面「32 张表」等说法已过时。

**凡涉及现状，一律以 `src/`、`web/`、`miniapp/` 的实际代码为准**，不要引用 spec 去否定已实现的功能。
:::

## 下一步

- [三端架构与请求生命周期](/overview/architecture)
- [目录结构与代码地图](/overview/structure)
- [本地开发与命令手册](/overview/getting-started)
- [配置与环境变量](/overview/config)
