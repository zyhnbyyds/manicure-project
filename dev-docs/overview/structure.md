---
title: 目录结构与代码地图
---

# 目录结构与代码地图

## 仓库根目录

```
manicure-project/
├── src/                       # 后端（NestJS + Fastify + Drizzle）
│   ├── main.ts                # 启动入口：helmet / rate-limit / multipart / CORS / 前缀 / Swagger
│   ├── app.module.ts          # 根模块：全局守卫 + 全局拦截器 + 全部子模块
│   ├── config/                # 环境变量：Zod schema 与 AppConfigService
│   ├── database/
│   │   ├── database.service.ts    # mysql2 连接池（timezone: 'Z' + SET time_zone='+00:00'）
│   │   ├── schema/index.ts        # 61 张表定义 + defineRelations（单文件 2667 行）
│   │   ├── migrations/            # drizzle-kit 生成的 15 个迁移（含 snapshot.json）
│   │   ├── migrate.ts             # `bun run db:migrate` 的入口
│   │   └── seed/                  # index(管理员) / menus / biz / nail / demo
│   ├── common/                # 横切：auth · cache · data-scope · filters · logging · password · swagger · utils
│   ├── ai/                    # AI 操作助手：agent · gateway · approval · task · llm · policy · risk · tools · audit
│   └── modules/               # 路由与业务（见下）
├── web/                       # 后台管理前端（Vue 3.5 + Vite 8 + lew-ui）
│   ├── src/views/             # 46 个页面级 .vue
│   ├── src/api/               # auth / dashboard / files / generator / jobs / ai
│   ├── src/request.ts         # axios 实例：token 注入 + request-id + 401 刷新排队
│   ├── src/store/             # user / permission（菜单 seed 驱动动态路由）
│   ├── src/composables/       # useTable / useDict / useFormat / useImagePreview …
│   ├── src/directives/        # permission.ts（v-permission）
│   ├── vite.config.ts         # 5173 + /api → localhost:3000 + outDir ../output/web
│   └── .env.development/.env.production   # VITE_API_BASE_URL=/api/v1
├── miniapp/                   # 微信原生小程序（TypeScript）
│   ├── miniprogram/
│   │   ├── app.json           # 29 个页面 + custom tabBar
│   │   ├── config.ts          # API_BASE（局域网 IP）/ REQUEST_TIMEOUT / SHOP 门店信息
│   │   ├── api/ · store/ · theme/ · utils/ · custom-tab-bar/ · assets/
│   │   └── pages/             # 29 个页面目录
│   ├── typings/               # wx 类型声明
│   ├── project.config.json    # appid + 编译配置（useCompilerPlugins: ["typescript"]）
│   ├── project.private.config.json   # 本机私有配置（urlCheck 等，通常 gitignore）
│   └── tsconfig.json          # 由根目录 `bunx tsc -p miniapp/tsconfig.json` 使用
├── tests/integration/         # 18 个 .int.spec.ts（真实 MySQL）+ harness.ts + wxpay-notify.helper.ts
├── dev-docs/                  # 本 VitePress 文档站
├── project-design/            # 设计资料库（spec / 计划 / 踩坑 / UI 稿 / 品牌）
├── docs/                      # 对客操作手册（**另一个独立的 VitePress 站点**）
│   ├── .vitepress/            # 手册站自己的 config.mts + theme/（含 custom.css）
│   ├── guide/                 # 快速开始 / 角色说明
│   ├── booking/               # 预约流程 · 排班 · 周期预约 · 美甲师工作台
│   ├── payment/               # 收银台 · 退款 · 对账 · 挂账 · 渠道开通配合
│   ├── report/                # 报表 · 提成
│   └── admin/ brand/ pitfalls/ platform/ screenshots/   # 目录已建，暂无文件
├── uploads/                   # 文件上传目录（UPLOAD_DIR，已 gitignore）
├── output/                    # 构建产物：server/ 与 web/（已 gitignore）
├── ecosystem.config.js        # PM2 配置（bun 跑 output/server/main.js，PORT=1011）
├── drizzle.config.ts          # drizzle-kit：schema / out / dbCredentials
├── nest-cli.json              # builder: swc，typeCheck: true
├── tsconfig.build.json        # outDir: ./output/server
├── bunfig.toml                # 只影响 bun test：hook 超时 60s
├── .oxlintrc.json / .oxfmtrc.json
└── .env / .env.example / .env.development / .env.prod / .env.test
```

::: warning app.config 与 tsconfig 的两个坑

- `tsconfig.json` 的 `exclude` 里有 `src/modules/generated`，`tsconfig.build.json` 同样排除 —— 代码生成器的产物**不参与类型检查与构建**；
- `tsconfig.json` 有 `"ignoreDeprecations": "6.0"` 与 `paths: { "@/*": ["./src/*"] }`；后端源码实际用的是**相对路径 + 不带扩展名**（`moduleResolution: Bundler`，源码与产物都由 bun 执行），`@/` 别名基本没人用。
  :::

## `src/modules/` 模块职责

### 业务域 `biz/`

| 目录              | 职责                                                              | 主要文件                                                                                                                            |
| ----------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `biz/base-data/`  | 服务项目、美甲师档案与"可做项目"、顾客档案（兼会员档案）          | `service-items/` `staffs/` `customers/` 各一对 controller+service                                                                   |
| `biz/scheduling/` | 排班：周模板整体替换（PUT）、日期例外（请假 off / 自定义 custom） | `scheduling.controller.ts` `scheduling.service.ts`                                                                                  |
| `biz/booking/`    | 预约主链路：可约时段算法、冲突检测、九步建单/改期/取消、结算      | `slots.service.ts` `bookings.service.ts` `booking-settlement.service.ts`                                                            |
| `biz/membership/` | 等级 / 储值账户 / 次卡 / 积分 / 积分兑换品 / 优惠券               | `member-levels/` `members/` `member-accounts/` `card-types/` `member-cards/` `points/` `points-goods/` `recharge-plans/` `coupons/` |
| `biz/payment/`    | 收银与资金：支付单、渠道 Provider、退款、对账差异                 | `payments/` `channels/` `refunds/` `diffs/`                                                                                         |
| `biz/credit/`     | 挂账与应收：挂账主体额度、应收台账、销账                          | `credit-accounts/` `receivables/`                                                                                                   |
| `biz/reports/`    | 报表口径（净营收 / 营业日切分）与提成核算                         | `analytics/` `commission/`                                                                                                          |
| `biz/operations/` | 评价、周期预约、通知（模板 + 发送 + 短信 Provider）               | `reviews/` `recurrences/` `notices/`（含 `notices/sms/`）                                                                           |
| `biz/common/`     | **横切工具与端口**（改业务前必读）                                | `money.ts` `shop-time.ts` `query.ts` `tx.ts` `doc-no.ts` `ports.ts` `biz-config.service.ts`                                         |

::: tip `biz/common/ports.ts` 是全项目最重要的一个文件
1168 行、20 个抽象类：`ServiceItemPort` · `StaffPort` · `CustomerPort` · `SlotPort` · `SchedulePort` · `BookingPort` · `BookingOpsPort` · `SettlementPort` · `MemberAccountPort` · `MemberCardPort` · `RechargePlanPort` · `PointsGoodsPort` · `CouponPort` · `PaymentPort` · `RefundPort` · `CreditPort` · `CommissionPort` · `ReviewPort` · `NoticePort` · `RecurrencePort`。

各业务模块**只依赖抽象**，由 `BizModule`（`@Global`）用 `useExisting` 绑定实现；`PageResult<T> = { items, page, pageSize }` 也定义在这里。

改 `ports.ts` 的方法签名 = 改冻结契约，会同时影响实现类、app 域、`JobsService` 的 13 处 `handlers.set(...)` 调用点。**不要顺手加参数**。
:::

### 小程序域 `app/`

| 目录            | 职责                                                                                                                                                                    |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app/auth/`     | `AppAuthController`（login / phone）、`AppAccessTokenGuard`、`wx-miniapp.provider.ts`（真实 + 假实现）                                                                  |
| `app/catalog/`  | 只读目录：`service-items` / `staffs` / `available-slots`                                                                                                                |
| `app/member/`   | 会员中心：`member/me` `member/cards` `recharge-plans` `points-goods` `points/redeem` `coupon-offers` `coupons/claim` `coupons`                                          |
| `app/payments/` | 微信支付回调 `POST app/payments/wxpay/notify`（复用 `PaymentsService.handleNotify`）                                                                                    |
| `app/staff/`    | 工作台：`apply` / `me` / `bookings` / `schedule` / `performance` / `reviews` / `arrived` / `complete` + `AppStaffScopeGuard` + 后台用的 `biz/app-staff-grants` 授权审批 |
| `app/dto/`      | app 域专用 VO（`app-vo.ts`、`app-staff-workbench.vo.ts`）                                                                                                               |

### 基座与工具模块

| 目录         | 职责                                                                                           |
| ------------ | ---------------------------------------------------------------------------------------------- |
| `system/`    | RBAC 与配置：`users` `roles` `menus` `depts` `posts` `dict-types` `dict-data` `configs`        |
| `monitor/`   | `login-logs` 登录日志 · `operation-logs` 操作审计 · `online` 在线用户 · `cache` Redis 监控     |
| `dashboard/` | 首页数据看板（聚合统计）                                                                       |
| `jobs/`      | 定时任务：`jobs` 表驱动 cron 注册、手动执行、执行日志；**handler 注册表在 `jobs.service.ts`**  |
| `files/`     | 文件上传/下载，落 `sys_file`，物理文件在 `UPLOAD_DIR`                                          |
| `generator/` | 代码生成器，产物写 `src/modules/generated/`（**gitignore**）                                   |
| `generated/` | 生成器输出（`generated/test/user.*`），已被 tsconfig / lint 排除                               |
| `health/`    | `@Public()` 的 `GET /api/v1/health`，返回 `{ code: 0, data: { status: 'ok' }, message: 'ok' }` |
| `compat/`    | 老前端接口兼容层（`legacy-user` / `legacy-role` / `legacy-menu` controller）                   |
| `auth/`      | 后台登录/刷新/登出（`AuthModule`，`/auth/**` 被审计拦截器跳过）                                |

::: warning `compat/` 是过渡层
`src/modules/compat/legacy*.controller.ts` 只为兼容旧前端页面的接口形状。新功能一律走 `biz/` 或 `system/` 的标准接口，**不要往 compat 里加东西**。
:::

## 「我要改 X，该动哪些文件」

> 表中路径均可直接 Grep。带 ⚠️ 的行表示改动会触碰资金或并发不变量，先加载 `money-invariants` 技能。

| #   | 我要改…                        | 要改的文件                                                                                                                                                                            | 注意事项                                                                                                                                                                               | 需要同步的 seed / 迁移                                                                                 |
| --- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 1   | 可约时段算法（班次−预约−缓冲） | `src/modules/biz/booking/slots.service.ts`（`shopDayRange` 在 108 / 275 / 366 行）、`src/modules/biz/scheduling/scheduling.service.ts`                                                | 缓冲取各项目**最大值**（`money.ts` 的 `maxBuffer`）；时段粒度 `biz.booking.stepMinutes` 由 `BizConfigService` 读                                                                       | 无迁移；调 `biz.booking.stepMinutes` 走 `sys_config`                                                   |
| 2   | 预约建单/改期/取消九步流程 ⚠️  | `src/modules/biz/booking/bookings.service.ts`（九步注释在 454 / 744 行）                                                                                                              | 前置校验必须全在事务外；事务内第一条语句是美甲师行 `FOR UPDATE`；锁顺序 `staff → customer → payment → member_card`                                                                     | 集成测试 `tests/integration/b1-booking.int.spec.ts`                                                    |
| 3   | 预约结算/尾款 ⚠️               | `src/modules/biz/booking/booking-settlement.service.ts` + `payments.service.ts`                                                                                                       | 结算只加支付单，不改 `biz_booking.payable_amount` 口径                                                                                                                                 | `b3-online-settle.int.spec.ts`                                                                         |
| 4   | 加一个收款通道 ⚠️              | 新建 `src/modules/biz/payment/channels/<x>.provider.ts`（实现 `PaymentChannelProvider`）、`payment.module.ts`（provider 注册）、`payments.service.ts`（`OnlineChannel` 分发）         | `OnlineChannel` 联合类型 + `biz_payment.channel` 枚举要一起改；未配置时必须 `configured=false` 并抛「通道未启用」，**不许假数据放行**                                                  | 迁移：`biz_payment.channel` 枚举加值；补 `*_NOTIFY_URL` 等环境变量                                     |
| 5   | 改退款阶段规则 ⚠️              | `src/modules/biz/payment/refunds/refunds.service.ts`（`resolveRefundStage` / `preview` / `apply`）、`web/src/views/biz/refunds/index.vue`、`miniapp/.../pages/cancel`                 | 阶段只看「退款时点 vs `biz_booking.start_at`」；服务开始前锁定全额且忽略前端传值，服务中必须校验 `biz:refund:approve` 且金额 ≤ 剩余可退；判责规则已降级为 `policySuggestAmount` 参考值 | `REFUND_POLICY_SEEDS` 仍保留（供参考值用）；`refund_stage` 列见迁移                                    |
| 6   | 加一个会员等级字段             | `src/database/schema/index.ts`（`bizMemberLevels` 约 975 行）、`member-levels/member-levels.service.ts` + `.controller.ts`、`web/src/views/biz/member-levels/index.vue`               | `discountPermille` 是**千分比**，1000 = 不打折                                                                                                                                         | `bun run db:generate` → 检查 SQL（见坑 #21）→ `db:migrate`；`seed/biz.ts` 的等级默认值                 |
| 7   | 改储值扣减顺序 ⚠️              | `src/modules/biz/common/money.ts` 的 `splitBalanceDeduction()`、`member-accounts/member-accounts.service.ts`                                                                          | 两种模式 `bonus_first` / `proportional`；由 `biz.member.bonusDeductMode` 驱动                                                                                                          | 无（改 `sys_config` 即可生效，`BizConfigService` 缓存 10s）                                            |
| 8   | 改积分抵扣上限 / 汇率 ⚠️       | `src/modules/biz/common/money.ts`（`quoteBooking`）、`membership/member-accounts/member-accounts.service.ts`                                                                          | `maxPointsPermille` 是「‰ 折后金额」；`pointsToCents` 不足 1 元的零头**不抵**；超限按上限收敛而不是报错                                                                                | 无（`biz.member.pointsDiscountPerYuan` / `maxPointsPermille` 在 `sys_config`）                         |
| 9   | 新增积分兑换品                 | `web/src/views/biz/points-goods/index.vue`、`membership/points-goods/points-goods.service.ts`                                                                                         | 库存 `-1 = 不限`（保持 -1 不递减）；兑换走「库存条件更新 → 限兑校验 → 扣积分条件更新 → 发卡」                                                                                          | 无迁移，走后台页面新增数据；`b7-app-points-goods.int.spec.ts`                                          |
| 10  | 优惠券规则（门槛/面额/有效期） | `src/database/schema/index.ts`（文件**末尾** `bizCouponTemplates` / `bizCustomerCoupons`，2574 行起）、`membership/coupons/coupons.service.ts`、`web/src/views/biz/coupons/index.vue` | 首期只做「满 X 减 Y」固定面额；面额与门槛在**发券时快照**；核销闸门是 `used_booking_id` 唯一索引 + 条件更新                                                                            | 迁移；`money.ts` 里券在等级折扣后、积分抵扣前，且与积分**二选一**                                      |
| 11  | 加一个后台页面                 | `web/src/views/<模块>/<页面>/index.vue`、`web/src/api/*.ts`、`src/database/seed/menus.ts`（`BIZ_PAGES` 或基座数组）                                                                   | `path` / `component` 必须与 seed 逐字一致（`component` 形如 `biz/service-items/index`，由 `web/src/store/permission.ts` 的 `import.meta.glob('../views/**/*.vue')` 解析）              | **必须**跑 `bun run db:seed:menus`（幂等，按 `name` upsert）                                           |
| 12  | 加一个菜单权限点               | `src/database/seed/menus.ts`（`permissions: [{ resource, actions }]`）、controller 上 `@RequirePermissions('资源:动作')`                                                              | 全小写、冒号分隔，如 `biz:serviceitem:list`；超管 `*:*:*` 通配                                                                                                                         | `bun run db:seed:menus`；角色授权只**补缺失项**，不清运营已分配的菜单                                  |
| 13  | 加一个小程序接口               | `src/modules/app/<域>/app-*-controller.ts` + `service`、`src/modules/app/dto/app-vo.ts`（新增 VO）                                                                                    | 必须 `@Public()` + 按需 `@UseGuards(AppAccessTokenGuard)`；**不复用后台 DTO**；跨模块取数据走 `biz/common/ports.ts`                                                                    | `tests/integration/b6-app-contract.int.spec.ts`（契约）、必要时 `b6-app-ratelimit-swagger.int.spec.ts` |
| 14  | 改报表口径                     | `src/modules/biz/reports/analytics/reports.service.ts`（文件头注释就是口径定义）、`reports.controller.ts`、`web/src/views/biz/reports/index.vue`                                      | 净营收 = 成功支付 − 成功退款；营业日按**店内本地日**切分（`localDateRange` / `shopDayRange`）；次卡核销**单列不混入营收**；挂账不计营收、销账才计入                                    | 无迁移；改口径必然影响 `b4-b6.int.spec.ts` 与提成基数                                                  |
| 15  | 改提成规则/计提                | `src/modules/biz/reports/commission/commission.service.ts`、`web/src/views/biz/commission-rules                                                                                       | commission-records/index.vue`                                                                                                                                                          | 冲销走条件更新（`status='accrued'`）当唯一闸门；已结算/已冲销一律拒绝；`periodCloseDay` 控制结算冻结   | `biz.commission.periodCloseDay` 在 `sys_config`；提成规则种子在 `seed/nail.ts` |
| 16  | 改短信模板变量                 | `src/database/seed/biz.ts`（`NOTICE_TEMPLATE_SEEDS` + `VAR_LABELS`）、`operations/notices/notices.service.ts`（`renderText` 约 976 行、校验约 298 行）                                | 模板里出现的 `{变量}` **必须**在 `variables` 声明，否则保存即报错；未提供的变量渲染成空串并收集 warning，残留占位符一律剔除；模板不存在时降级为站内原始变量通知                        | `bun run db:seed:biz`；变量预设（`amount` = 元、`points` = 积分）要与发送方传参一致                    |
| 17  | 加定时任务                     | `src/modules/jobs/jobs.service.ts`（`registerHandlers()` 的 `handlers.set(...)`）、`src/database/seed/biz.ts`（任务行带 `handler` + `cron`）                                          | **定时任务不碰钱**（只改状态与等级）；handler 必须幂等（条件更新 + `affectedRows` 闸门）；`handler` 全局唯一                                                                           | `bun run db:seed:biz`；已存在的 handler 不覆盖，改 cron 要跑 seed 或在后台任务页改                     |
| 18  | 加一个通知触发点               | 调用 `NoticePort` 的业务 service、`src/database/seed/biz.ts`（新模板）                                                                                                                | 通知在**事务提交后**发送，发送失败**不回滚**业务；`SMS_PROVIDER=none` 或凭据不全时降级为「只写站内 + failed 日志」                                                                     | `db:seed:biz`；模板 `code` 与调用处字符串要对上                                                        |
| 19  | 加数据库表 / 字段              | `src/database/schema/index.ts`（复用 `auditColumns` + `bigintId()`）                                                                                                                  | 审计列注释里的坑见下面坑 #21；`defineRelations` 关系要一起补                                                                                                                           | `bun run db:generate` → **人工检查 SQL** → `bun run db:migrate`                                        |
| 20  | 加小程序页面                   | `miniapp/miniprogram/app.json`（`pages` 数组）、`miniapp/miniprogram/pages/<名>/`（`.wxml/.wxss/.ts/.json`）、必要时 `custom-tab-bar`                                                 | 页面必须在 `app.json` 注册才会被打包；主题令牌走 `miniprogram/theme/`，工具层走 `miniprogram/utils/`                                                                                   | 无；类型检查 `bunx tsc --noEmit -p miniapp/tsconfig.json`                                              |
| 21  | 改端口 / API 基址              | 后端：`.env` 的 `PORT`；前端：`web/vite.config.ts` 的 `proxy.target`；小程序：`miniapp/miniprogram/config.ts` 的 `API_BASE`                                                           | 小程序真机不能用 `127.0.0.1`（那是手机自己），要用**有默认网关那张网卡**的局域网 IP                                                                                                    | 无；改端口后要同步 `project.private.config.json` 的调试配置与防火墙规则                                |
| 22  | 改操作审计行为                 | `src/common/logging/operation-log.interceptor.ts`                                                                                                                                     | 只记 POST/PATCH/PUT/DELETE，url 含 `/auth/` 直接跳过；敏感字段匹配 `/password                                                                                                          | secret                                                                                                 | token                                                                          | authorization/i`替换为`***`；写库失败**吞掉**不回滚业务 | 无；`src/common/logging/operation-log.interceptor.spec.ts` |
| 23  | 改数据权限规则                 | `src/common/data-scope/data-scope.ts`、`src/modules/system/roles/roles.service.ts`、`web/src/views/system/roles/index.vue`                                                            | 规则是「宽松优先取并集」；`dept_and_children` 靠 `sys_dept.ancestors` 字符串匹配                                                                                                       | 无；`data-scope.spec.ts`                                                                               |
| 24  | 加 AI 工具（自然语言操作后台） | `src/ai/tools/<域>/<x>.tools.ts`、必要时 `src/ai/policy/policy.engine.ts`（风险分级）                                                                                                 | 工具返回统一脱敏；高风险操作走 `ActionIntent` 一次性 token + 预览快照 TOCTOU 校验；全程审计                                                                                            | `src/ai/tools/tool.registry.spec.ts`；需 `AI_ENABLED=true` + `DEEPSEEK_API_KEY`                        |
| 25  | 改 HTTP 插件链 / 中间件顺序    | `src/main.ts`                                                                                                                                                                         | 顺序硬编码：helmet → rateLimit → multipart → CORS → prefix → Swagger；`rawBody: true` 不能删（微信 V3 回调验签依赖原样报文）                                                           | 无；`b6-app-ratelimit-swagger.int.spec.ts`                                                             |

::: details 坑 #21：`auditColumns` 生成迁移时的 `CURRENT_TIMESTAMP` 括号问题
`src/database/schema/index.ts` 顶部注释写得很清楚：drizzle-orm 1.0.0-rc 会把 `.default(sql\`CURRENT_TIMESTAMP\`)`渲染成`DEFAULT (CURRENT_TIMESTAMP)`。MySQL 8.0.23 建表放行，但**随后任何重建表的语句**（`CREATE INDEX`/`ALTER`）会报 `Invalid default value for 'created_at'`。

**手工去掉括号即可**，且 `drizzle-kit generate` 不会因此认为有漂移（快照里存的是表达式，不是字面量）。每次 `db:generate` 后都要人眼过一遍生成的 SQL。
:::

## `.agents/skills/` 开发技能清单

16 个技能，按模块拆分，给人 + AI 共用。**开工前先加载 `project-overview`**，它会告诉你该改哪个模块、该看哪份 spec 章节、该加载哪个子技能。

| 技能                            | 一句话用途                                                                                                                                                                                 |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `project-overview`              | 项目总纲：技术基线、目录结构、命令、代码铁律、B1~B6 批次与全部技能索引                                                                                                                     |
| `money-invariants`              | **资金红线**：条件更新模板（余额/次数/积分/销账/退款/回调）、全局锁顺序、只追加与冲正、对账等式                                                                                            |
| `data-model`                    | 表分组清单、命名与索引约定、软删与物理删豁免、Drizzle 迁移流程与派生字段口径                                                                                                               |
| `base-data`                     | 服务项目 / 美甲师 / 可做项目 / 顾客档案：删除保护、手机号唯一与软删、顾客↔会员↔微信绑定锚点                                                                                                |
| `scheduling`                    | 排班：周模板整体替换（PUT）、日期例外、求值优先级、"主数据变更与既有预约冲突保护"（409 + 受影响清单 + force）                                                                              |
| `booking-core`                  | 预约主链路：时段算法、冲突检测与 `FOR UPDATE`、服务/资金状态机、九步流程与幂等                                                                                                             |
| `membership`                    | 会员：等级折扣千分比、积分累计/抵扣/兑换、储值本金与赠送、次卡核销与到期、算价公式                                                                                                         |
| `cashier-payment`               | 收银与支付：微信 Native / 支付宝当面付、线下记账、定金尾款、混合支付、回调验签幂等、查单关单、退款判责与审批分离、渠道对账                                                                 |
| `credit-receivable`             | 挂账应收：挂账主体、额度与账期、下单挂账（不写支付单、`pay_status=credit`）、销账不得超额、账龄与"挂账不计营收、销账才计入"                                                                |
| `operations-reports`            | 评价（一单一评/回复/隐藏/代录）、报表口径（净营收 / 营业日切分 / 次卡核销单列）与提成（优先级 / 计提基数 / 补提 / 冲销 / 结算冻结）                                                        |
| `notification`                  | 短信 + 站内消息：模板（code + 变量校验）、触发点与默认渠道、事务后发送失败不回滚、SmsProvider 抽象与未配置降级、失败重试与 inbox                                                           |
| `recurring-bookings`            | 周期预约：规则字段、批量生成幂等游标与唯一约束、生成时跳过收款（unpaid）、冲突策略 skip/notify、"改规则不回溯已生成单据"                                                                   |
| `miniapp-reserved`              | app 域：`app_*` 身份表、独立认证域、`AppAccessTokenGuard` 双向拒绝、不接 RBAC、不复用后台 DTO、登录与手机号绑定                                                                            |
| `web-frontend`                  | 后台前端：页面清单、`useTable` + lew-ui 列表模式（`formKey` 重建 / `setForm` 回填 / `v-permission` / `confirmDanger`）、上传、菜单 seed 驱动路由、收银台与退款审批交互、时间与金额展示口径 |
| `testing-acceptance`            | 测试与验收：真实 MySQL 集成测试入口（`.env.test` + 独立库 + 建表清表）、`bun test` 约定、B1~B6 验收清单、并发/幂等/时区用例写法、完成定义                                                  |
| `wechatpay-payment-integration` | 微信支付官方知识库入口（产品选型 / 示例代码 / 接入质量评估 / 排障）。`assets/` 是可再生缓存，已 gitignore，用 `scripts/wechatpay-resource-sync.py` 重新下载                                |

::: tip 技能的用法
技能就是 Markdown（`.agents/skills/<名>/SKILL.md`），人和 AI 读的是同一份。改模块前读对应技能，比在 2667 行的 schema 里翻找快得多。
:::

## `project-design/` 资料说明

| 路径                                                               | 内容                                                                 | 可信度                                                             |
| ------------------------------------------------------------------ | -------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `superpowers/specs/2026-09-11-nail-salon-booking-design.md`        | 主设计文档（表结构、状态机、金额与时段口径、接口契约的**设计意图**） | ⚠️ **可能与现状有偏差**（如"32 张表"），一律以 `src/` 实际代码为准 |
| `superpowers/plans/2026-09-11-b1-b6-implementation-plan.md`        | B1~B6 施工计划；`ports.ts` 的方法签名以此为准                        | 计划视角，已执行部分以代码为准                                     |
| `superpowers/plans/2026-09-11-miniapp-development-plan.md`         | 小程序开发计划                                                       | 同上                                                               |
| `superpowers/plans/2026-09-11-rename-to-manicure-and-test-plan.md` | 重命名与技术债清理计划                                               | 同上                                                               |
| `pitfalls/server.md`                                               | 后端踩坑（时间、并发、迁移、渠道）                                   | 经验记录，**改代码前先扫一眼**                                     |
| `pitfalls/web.md`                                                  | 后台前端踩坑（列表模式、上传、路由）                                 | 同上                                                               |
| `pitfalls/miniapp.md`                                              | 小程序踩坑（真机联调、主题、TabBar）                                 | 同上                                                               |
| `pitfalls/tooling.md`                                              | 工具链踩坑（bun / oxlint / tsc / vitest 断言）                       | 同上                                                               |
| `HANDOVER-miniapp.md`                                              | 小程序 + app 域身份交接说明、验收账本、遗留项与人工门禁              | 交接稿                                                             |
| `design-gaps.md` / `design-prompts-miniapp.md`                     | 设计缺口与小程序 UI 提示词                                           | UI 参考                                                            |
| `brand/`                                                           | 品牌 LOGO 母版与导出流程                                             | 素材                                                               |
| `screenshots/`                                                     | 后台 `login.png` / `dashboard.png`；小程序 7 张                      | 素材                                                               |
| `manicure-ui-batch{1..5}*.png`                                     | 分批次后台 UI 稿                                                     | 素材                                                               |

::: warning `project-design/superpowers/` 在 `.gitignore` 里
整个 `project-design/superpowers/` 目录被 gitignore —— 它是本地设计资料，**不在版本控制内**。引用其中的 spec 章节号（如 `§5.2`）时注意：源码注释里的 `§x.y` 指的是这份 spec，clone 下来的人不一定会看到它。
:::

## 相关页面

- [项目总览与技术基线](/overview/) · [三端架构与请求生命周期](/overview/architecture)
- [本地开发与命令手册](/overview/getting-started) · [配置与环境变量](/overview/config)

::: tip 跨章节链接暂缺
`dev-docs/.vitepress/config.mts` 已经把「后端 / 前端 / 数据 / 质量与交付 / 附录」的侧边栏登记好了，但**这些章节的内容页目前还没有写**。在它们补齐之前，本页只链接 `/overview/` 下的页面，避免整站构建因死链失败（配置里是 `ignoreDeadLinks: false`）。
:::
