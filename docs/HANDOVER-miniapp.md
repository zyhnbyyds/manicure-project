# 交接说明：小程序端 + app 域身份（截至 2026-09-11）

> 交接对象：接手的下一位执行者（人或 AI）。
> 本文件只写**事实与入口**，不重复 spec。设计依据见 `docs/superpowers/specs/2026-09-11-nail-salon-booking-design.md`，
> 施工单见 `docs/superpowers/plans/2026-09-11-miniapp-development-plan.md`（含 §12 美甲师工作台需求变更）。

---

## 0. 一句话现状

- **小程序端**：10 个页面已落地，主题系统可用，模拟器里跑得起来（截图验证过 3 页），**接的是演示数据**。
- **后端**：app 域身份域扩出「美甲师工作台」数据层，微信能力已端口化，手机号绑定转真实现，**10 条集成用例全绿**。
- **美甲师工作台（S2 ~ S5）已全线完成**：后端只读 5 接口 + 写 2 接口 + 真号端点，后台授权页、小程序 4 个工作台页面与双模式 TabBar 都已落地。
- **P2 收口进行中**：G2 / G4 / G5 / G6 / G7 / G8 / G9 已完成（其中 G9 挖出并修掉一个真 bug：限流 429 被全局过滤器降级成 500）；A9 我的次卡、A11 评价、A12 订阅消息授权、**A13 微信支付回调**、**A10 自助下单/我的预约/自助取消**已转真实现（501 骨架 9 → **1**，只剩 JSAPI 契约位）；A14 换绑留痕已完成（新表 `app_wx_user_bind_log`）；只剩 A19 devtools 脚本（被环境卡住）。
- **P0-1 已完成**：后台可筛选 / 恢复软删顾客，小程序手机号绑定 409 分支已闭环，恢复后可重新绑定；
- 全量测试：**1019 pass / 1 skip / 0 fail**（87 文件 / 2588 expect；skip 的是时间敏感的 G7，护栏生效）；后端 typecheck / lint、前端 typecheck / lint 通过；工作区干净（无未提交改动）。

---

## 1. 已提交的交付物（我做的，按时间）

```
cc3f221 feat(app/auth): 微信能力端口化 + 手机号绑定真实现（S1 上半）
328334d feat(app/auth): app_wx_user 增美甲师工作台身份域
eb36f39 fix(miniapp): 小程序不认目录导入，api 层改为显式文件路径
aba267e feat(miniapp): 会员中心 / 我的 / 主题设置，并启用自定义 TabBar
45782c6 feat(miniapp): 浏览与预约主链路（首页/项目/详情/美甲师/时段/确认/我的预约）
aed748b feat(miniapp): 应用骨架与展示层映射，清理模板残留
46bce3f fix(miniapp): 去掉 wx.request 不支持的 PATCH，并为模板 typings 开 skipLibCheck
9a1f481 feat(miniapp): app 域接口层与登录态（真接口 / 演示数据双通道）
91ca0b9 feat(miniapp): 主题系统（预设 + 令牌派生 + 持久化 + 导航栏联动）
adea53f feat(miniapp): 基础层（配置 / 颜色派生 / 格式化 / 令牌 / 交互封装）
e59e6ae chore(miniapp): 引入原生小程序工程脚手架（TS + glass-easel）
```

> 期间历史里还夹着 4~5 个**不是本次任务**的提交（`7cddd8a` lint、`24d536a` web、`1065513` repo、
> `eb13618`/`3265036` web+skill）。交接时不要把它们算进小程序这条线。

### 主要文件

| 分类        | 路径                                                                                                                      |
| ----------- | ------------------------------------------------------------------------------------------------------------------------- |
| 小程序工程  | `miniapp/miniprogram/**`（10 页面 + 主题 + api/utils/store + `custom-tab-bar`）                                           |
| 小程序配置  | `miniapp/project.config.json`（appid）、`miniapp/.gitignore`、`miniapp/tsconfig.json`                                     |
| 后端身份域  | `src/modules/app/auth/*`、`src/modules/app/dto/app-vo.ts`                                                                 |
| 后端端口    | `src/modules/biz/common/ports.ts`、`src/modules/biz/base-data/staffs/staffs.service.ts`                                   |
| 迁移        | `src/database/migrations/20260911055121_clear_warhawk/`                                                                   |
| 集成用例    | `tests/integration/b6-app-identity.int.spec.ts`、`tests/integration/harness.ts`                                           |
| 设计/施工单 | `docs/superpowers/specs/...nail-salon-booking-design.md`、`docs/superpowers/plans/2026-09-11-miniapp-development-plan.md` |

---

## 2. 已完成（附验证证据与**局限**）

### 2.1 小程序端（计划里的 A15 / A16）

- **主题系统（本次需求核心）**：6 套可爱预设 + 10 色自定义色板；点击即生效；持久化；
  `wx.setNavigationBarColor` 让导航栏一起换色；自定义 TabBar 也吃同一套令牌。
  派生链路唯一（`theme/theme.ts` 的 `buildTokens()`），预设与自定义同源。
- **10 个页面**：首页 / 项目列表(多选 1~3) / 项目详情 / 选美甲师 / 选时间 / 确认预约 /
  我的预约 / 会员中心 / 我的 / 主题设置。
- **地基**：请求层（401+`needBind` 不清 token、501 收敛成人话）、登录态并发去重、
  演示数据双通道、`utils/present.ts` 展示层映射、草稿失效联动。

**验证到什么程度**：

- ✅ `tsc --noEmit` 通过；开发者工具编译无 console error。
- ✅ 模拟器截图验证了 **3 页**：首页、主题设置、项目列表（见「截图产物」一节）。
- ❌ **其余 7 页没有逐页截图**，只保证编译通过与静态结构正确。
- ❌ **交互链路未验证**（点选项 → 底部合计变化 → 选美甲师）：需要 `automation` client 授权。

### 2.2 后端 app 域身份（计划里的 S1 上半 + 原 A1/A8）

- **微信能力端口化**：`WxMiniappProvider` + 真实现（含 access_token 进程内缓存）+ 假实现。
  假实现在生产**双重强制失效**（config 层 + 构造函数）。
- **`POST /app/auth/phone` 从 501 转真实现**：先落手机号快照 → 匹配/创建顾客 → 绑定锚点；
  命中软删顾客回 409 + `needRestoreConfirm`（**不自动恢复**）；命中美甲师档案只回 `staffCandidate`。
- **数据层**：`app_wx_user` 增 `staff_id` / `staff_status(none|pending|active|rejected)` /
  `staff_requested_at` / `staff_decided_at` / `staff_decided_by` + `idx_wx_staff` + FK。
- **端口补口**：`StaffPort.findByPhone`。

**验证到什么程度**：

- ✅ 新增 10 条集成用例全绿，覆盖：登录换 token、重复/并发登录只 1 行、未绑定 401+needBind、
  新建顾客、复用已有顾客、软删 → 409 且不恢复不绑定、未登录 401、
  美甲师候选只回不给权、**防提权（请求体塞 staffStatus 被丢弃）**、停用/删除不算候选。
- ✅ 迁移在真库执行通过（harness 会跑 `migrate`）。
- ❌ **「未配置微信凭据 → 503」这条分支没测**（测试环境强制假实现，走不到 Http 实现）。
- ❌ 真实微信链路（`code2Session` / `getPhoneNumber`）**完全没跑过真接口**（缺 AppSecret）。

---

## 3. 未完成（按接手顺序，含依赖与门禁）

### P0 —— 建议立刻做，否则后面的活会踩空

| #   | 任务                                                                      | 为什么是 P0                                                                                                                                                                                                                                                                                                                                      | 依赖                  |
| --- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------- |
| 1   | ✅ **恢复软删顾客**（`CustomerPort.restore` + 服务实现 + 后台顾客页入口） | 已完成：`GET /biz/customers?status=deleted` 找回，`POST /biz/customers/:id/restore` 幂等恢复；恢复后小程序可重新绑定。见提交 `50120dd`                                                                                                                                                                                                           | 无                    |
| 2   | ✅ **`/app/staff/apply` + staff 作用域校验**                              | 已完成：手机号匹配在职档案后置 `pending`；重复 / rejected 重申幂等；请求体不可提权；`AppStaffScopeGuard` 每请求查 `app_wx_user + biz_staff`，要求授权 active、档案 active 且未软删。见提交 `2a975d4`                                                                                                                                             | 无（表已就绪）        |
| 3   | ✅ **新增 `BookingPort`**                                                 | 已完成：`BookingPort`（`listByStaff` / `listByCustomer` / `arriveForStaff` / `completeForStaff`）由 `BizModule` 用 `useExisting` 绑到 `BookingsService`，`BookingsService implements BookingPort` 让契约在编译期就受检；S4 复用既有完成动作（`runComplete`），带本人闸门 + `start_at` 时间护栏 + 幂等。12 条单测（含变异验证）。见提交 `fe75c18` | 无                    |
| 4   | ✅ **`wxpay_jsapi` 加进 `biz_payment.channel` 枚举**                      | 已完成：列上已加（`20260911080757`）；但**故意不进** `PaymentChannel` 类型——没有 provider 却被当线上渠道会被 `isOnlineChannel` 判成线下、直接置成功（钱没到账却已核销），所以 `toPaymentChannel` 显式 400 拦住。见提交 `fdc5c3b`                                                                                                                 | `bun run db:generate` |

### P1 —— 美甲师工作台主线（施工单 §12.6 的 S2~S5）

| #   | 模块                  | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | 门禁                                         |
| --- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| 5   | ✅ **S2 店长确认**    | 已完成：`GET /biz/app-staff-grants?status=pending`、`POST .../:id/approve`、`/:id/reject`；权限点 `biz:staff:grant` 已进 `menus.ts`（25 页）；后台页面 `web/src/views/biz/app-staff-grants`。状态机：已 active 幂等、已驳回 409（须重申）、档案停用/删除 409；驳回原因落新增列 `staff_reject_reason`。12 条单测 + 5 条集成。见提交 `eff60a2`、`8c1aad9`                                                                                                                                                                                                                                            | 🤖                                           |
| 6   | ✅ **S3 只读 5 接口** | 已完成：`/app/staff/me`、`/bookings`、`/schedule`、`/performance`（**提成逐单明细全见**，D9）、`/reviews`，全部 `staff_id` 硬限定（方法第一参数就是 staffId，不做「传进来再校验」）；顾客/本人手机号一律 `maskPhone`（D11）；字段集合由 `app-staff-workbench.vo.ts` 的 Zod 断言（无成本、无内部字段）。新增 `ReviewPort` + `CommissionPort.listByStaff/summarizeByStaff`。15 条单测（含 2 次变异验证）+ 7 条集成                                                                                                                                                                                   | 🤖                                           |
| 7   | ✅ **S4 写 2 接口**   | 已完成：`POST /app/staff/bookings/:id/arrived`、`/complete`，走 `BookingPort` → 既有 `runComplete`（提成计提 + `visit_count` + `affectedRows` 幂等闸门），app 域**没有**自己 UPDATE 状态；早于 `start_at` → 400（§12.4-3）；已到目标状态 → `changed:false`（幂等，不报 409）。触钱口径已按 `money-invariants` §4 写集成：重复完成 `biz_commission_record` 仍为 1 条。5 条集成（含越权 403、404、时间护栏）                                                                                                                                                                                         | 🤖 触钱，**动手前先加载 `money-invariants`** |
| 8   | ✅ **S5 小程序端**    | 已完成：模式切换（`store/mode.ts`，**模式只是偏好、能否进工作台由授权决定**，403 时主动 `demoteToCustomer()`）；4 个页面 `staff-workbench`（今日日程+业绩卡+到店/完成）、`staff-bookings`、`staff-performance`（月份切换+逐单提成明细）、`staff-reviews`；自定义 TabBar 两套 tab 按模式换（`app.json` 注册两种模式全部路径，`switchTab` 只认注册过的）。**D11 的实现取舍**：列表 VO 只给 `customerPhoneMasked`，真号走新增端点 `GET /app/staff/bookings/:id/phone`「点一次取一次、限本人单」（同时给明文+脱敏等于没脱敏），复用 `assertOwnedByStaff` 保证越权口径与到店/完成一致。见提交 `8485713` | 未做真机/模拟器冒烟，只过了 `tsc --noEmit`   |

### P2 —— 原 B6 收口剩余（可与 P1 并行）

| #   | 任务                                                  | 说明                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 9   | ✅ **G2**：补「未配置凭据 → 503」用例                 | 已完成：`harness.createTestContext` 新增 `providers` 覆盖位，注入「空凭据」的 `HttpWxMiniappProvider` → 登录/绑手机号都 503 且不落身份；另加 `wx-miniapp.provider.spec.ts` 8 条单测（含 `configured=false` 但有值、半套凭据、以及**反证**：凭据齐全时不 503）。**集成环境永远走假实现，这条分支只能靠注入真实现来验**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 10  | ✅ **G4**：5 个 501 骨架端点用例 + 不落库断言         | 已完成：常量 `SKELETON_ROUTES`（与 spec §16.1 逐条对应）逐个断言 501 + 调用前后 6 张表行数不变 + 非法入参仍是 400（不是「一律 501」）+ 除支付回调外都要 app token。新增 `tests/integration/b6-app-contract.int.spec.ts`。**每实现一个 P2 端点这里就少一条，条数即进度**（A9、A11、A12、A13、A10 后 9 → **1**，只剩 JSAPI）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 11  | ✅ **G5**：修 spec 骨架条数口径                       | 已统一为 **1 条**（auth/phone、member/cards、reviews、subscribe、notify、bookings 三端点转真实现后移出）：spec §12 B6 / §16.1 / 施工单 + G4 + 各任务条目全部改为 **1**，并写明 A8/A9/A11/A12/A13/A10 已转真实现、移出骨架清单。口径现在由 G4 用例的 `SKELETON_ROUTES` 长度钉住                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 12  | ✅ **G6/G7**：收紧 `available-slots` 一致性断言       | 已完成：去掉「两边都非空才比对」的空集豁免，未来某天两边**必须完全相等**；新增 G7 用例断言 miniapp 60 分钟提前期 ≠ 后台 0 分钟（班次相对当前时间铺开 + `Intl` 算店内墙钟，深夜自动 skip）。已做变异验证：把小程序渠道的 `minLeadMinutes` 换成 0，用例立刻红                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 13  | ✅ **G8**：`/app/member/me` 已绑定字段集合 + 越权用例 | 已完成：9 个顶层字段 + 7 个次卡字段字面量锁定（无成本/无 `memberNo`/无 `remark`）；换 openid 只看到自己、等级与折扣率各不相同，`?customerId=` 入参被忽略；顾客档案软删 → 401 + `needBind`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 14  | ✅ **G9**：限流 429 + Swagger app 分组断言            | **已完成并修出一个真 bug**：`@fastify/rate-limit` 抛的是「普通 `Error` + `statusCode=429`」，`GlobalExceptionFilter` 只认 `HttpException`，于是限流**静默降级成 500**（还每次打一条 ERROR 堆栈）。已在过滤器加「Fastify 4xx 透传」分支（5xx 仍兜底 500），现在第 11 次登录真返回 429 + `retry-after`。Swagger 侧断言 app 端点都归「小程序端」分组、回调端点不挂 app-token                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 15  | ✅ **A9/A10/A11/A12/A13/A14 全部完成**                | **A9 `/app/member/cards` 已完成**（`MemberCardPort.listByCustomer`；状态按「到店是否真能用」现算，与 `assertUsable` 同规则；字段 7 个；分页 + 状态过滤；集成 3 条）。**A10 自助下单/我的预约/自助取消已完成**（`BookingPort.createForCustomer` **复用后台九步**：前置校验 → 算价 → 锁美甲师行 FOR UPDATE → 冲突复检 → 建单 → 积分/次卡条件扣减 → recalc，一行没另写；落 `channel=miniapp` + `status=pending`；不收款，JSAPI P2 做；`memberCardId` 整单次卡当场核销（须选 1 个项目）；顾客时段重叠 → 409（无 force）；`cancelForCustomer` 复用 `transition` + `assertOwnedByCustomer`（他人单 403 / 404 / 状态机 409）。集成 6 条 + 单测 4 条。**并发恰好 1 成功**这类正确性由后台 `b1-booking.int.spec.ts` 用同一 service 验过，app 域不重跑）。**A11 `/app/reviews` 已完成**（`ReviewPort.createForCustomer`：仅本人 403 / 仅已完成 400 / 一单一评 409；`customer_id`、`staff_id` 由预约事实带出；集成 3 条）。**A12 `/app/subscribe` 已完成**（新表 `app_wx_subscribe_grant`：`(app_wx_user_id, template_id)` 唯一，额度按 `granted_count` 累加而非覆盖；`bookingId` 他人单 403 / 不存在 404；未绑定 401 + `needBind`；集成 3 条）。**A13 支付回调已完成**（`PaymentPort.handleNotify` 复用后台 `PaymentsService.handleNotify`，资金逻辑一行没重写；真验签 + 真解密的集成 6 条，含 2 次变异验证；顺带补上一直只有单测的后台 `/biz/payments/notify/wxpay`）。**A14 `app_wx_user_bind_log` 已完成**：新表 + 迁移，换绑与留痕在同一事务里（`bindPhone`），`before/after` 两个 `customer_id` + `openid`/`phone` 快照，只追加不删；绑定失败（409 软删）不留痕；集成 3 条。**D12 三个取舍见文末** |
| 16  | **A19**：`scripts/devtools.mjs` 自证脚本              | 封装「绝对路径调 wechatide + 首次授权轮询 + 编译→跳页→截图→拉 console」。**注意截图返回 `.png` 但内容是 JPEG**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

---

## 4. 契约陷阱清单（踩过的坑，必须知道）

1. **小程序不认目录导入**：`from '../../api'` 会编成 `require('../../api')` 并在运行时抛
   `module 'api.js' is not defined`，页面**全白**且类型检查查不出来。必须写 `'../../api/index'`。
2. **`wx.request` 不支持 PATCH**：只有 OPTIONS/GET/HEAD/POST/PUT/DELETE/TRACE/CONNECT。
3. **app 模块不得 import 业务模块**：只能依赖 `src/modules/biz/common/ports.ts` 的抽象类，
   由 `BizModule`（@Global）`useExisting` 绑定。新增跨模块能力要**加端口**，不是直接 import。
4. **角色不进 token**：美甲师权限每请求从库校验，否则撤权后有「token 仍有效」的窗口。
5. **时间口径**：本地日绝不用 `toISOString()` 反推；店内时刻直接读 ISO 字面量
   （`utils/format.ts` 的 `isoClockTime`），否则顾客手机时区一变时间就漂。
6. **金额只在服务端算**：确认页只显示项目原价合计，客户端不猜折扣/积分后的最终金额。
7. **WXML 不能调函数**：所有格式化必须在 `utils/present.ts` 里预先算好。
8. **flex `gap` 在 iOS 老 WKWebView 不生效**：网格用 margin（`48% + 4%`）。
9. **`getTabBar()` 只在 Component typings 里**：页面侧要用 `utils/tabbar.ts` 的结构化窄类型。
10. **`bindgetphonenumber` 的 typings 是旧的 `getWeRunData` 形态**（没有 `code`），需自声明窄类型。
11. **`wechatide` 相关**：命令**不在 PATH**（要绝对路径）；每个 client 首次调用**要人在 IDE 里点授权**；
    `simulator_screenshot` 默认写 JPEG 但返回 `.png` 后缀。
12. **`.env.test` 未被 git 跟踪**：测试专用开关要写进 `tests/integration/harness.ts` 的 `applyTestEnv`。

---

## 5. 人工门禁现状

| ID              | 事项                                                | 状态                                                                                                          |
| --------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| H1              | 技术选型                                            | ✅ 已定：原生小程序 + TypeScript（脚手架已建）                                                                |
| H15             | 集成测试库可连                                      | ✅ **已解除**（895 tests 全绿，真库跑通迁移）                                                                 |
| H19             | 店长确认入口放哪                                    | ✅ 已定：**后台页面**（`biz:staff:grant`）                                                                    |
| H3              | 小程序 AppID / AppSecret                            | ⚠️ AppID 已知 `wx9f814556a48f60ae`（**接口测试号**，不能上线）；**AppSecret 仍缺**                            |
| H4              | 代码上传密钥 + IP 白名单                            | ❌ 未提供                                                                                                     |
| H11             | UI 设计稿 / 位图素材                                | ❌ 未提供（已用「分类 emoji + 主题渐变底」占位，不阻塞开发）                                                  |
| H12             | 真机与视觉验收                                      | ⚠️ 降级运行：我能截图自证；但 `compile` / `automation` 两个 client 的授权**仍是 pending**，元素级自动化做不了 |
| H5/H6/H7/H18    | 主体认证 / 小程序备案 / 域名备案+HTTPS / 正式 appId | ❌ 全部未启动 —— **这四项决定上线日**，不阻塞开发                                                             |
| H8              | 微信后台服务器域名配置                              | ❌ 未配置                                                                                                     |
| H9              | 微信支付商户号 + APIv3 证书                         | ❌ 未提供                                                                                                     |
| H10             | 订阅消息模板                                        | ❌ 未申请                                                                                                     |
| H13/H14/H16/H17 | 真人支付验证 / 内测 / 提审发布 / 隐私协议           | ❌ 未开始                                                                                                     |

---

## 6. 截图产物（本地，未入库）

`output/` 被 gitignore，所以这些图只在本地：

- `output/p-index.jpg` —— 首页
- `output/p-theme.jpg` —— 主题设置页
- `output/p-services.jpg` —— 项目列表
- `output/miniapp-sim.jpg` —— 最初的模板 Hello World（对照用）

---

## 7. 小程序端当前运行方式与「切真接口」条件

- **模式**：`miniapp/miniprogram/config.ts` 的 `isMockEnabled()` **默认 true → 走演示数据**。
  原因：`WX_MINIAPP_APPID/SECRET` 未配置时后端登录按设计返回 503，UI 拿不到真数据。
  UI 上有显眼的「演示数据」标记，不会被误当真实数据。
- **切真接口需要**：① 后端 `.env` 配 `WX_MINIAPP_APPID` + `WX_MINIAPP_SECRET`；
  ② `config.ts` 把默认值改成 `false`；③ `miniapp/project.private.config.json` 的 `urlCheck` 改 `false`
  （要访问 `http://127.0.0.1:3000`）；④ 或者后端开 `WX_MINIAPP_FAKE=true`（仅非生产）先用假微信登录。
- **注意**：`project.private.config.json` 被 `miniapp/.gitignore` 忽略（开发者私有配置），
  所以本机怎么改都不会进仓库。

---

## 8. 接手第一步建议

```bash
bun run typecheck && bun run lint && bun run test   # 基线应是 978 pass / 0 fail（83 文件 / 2410 expect）
cd miniapp/miniprogram && ../../node_modules/typescript/bin/tsc --noEmit -p tsconfig.json   # 小程序类型检查（miniapp 自己没装 typescript）
```

### 当前进度

- **P0-1 ~ P0-4、S2 / S3 / S4 / S5 全部已完成**：后端接口、后台授权页、小程序 4 个工作台页面齐了。
  美甲师主线**只剩真机/模拟器冒烟**（目前只过了类型检查，没实际跑起来看页面）。

### 下一步：P2 收口（任务表第 9~16 项）

建议按「先便宜后贵」排：

1. **#11 G5**（最便宜）：修 spec 骨架条数口径（§12 说 5 个 / §16.1 列 8 个 / 代码 9 个），纯文档对齐。
2. **#13 G8**：`/app/member/me` 已绑定字段集合 + 越权用例。
3. **#9 G2**：未配置凭据 → 503 用例。
4. **#10 G4**：9 个 501 骨架端点用例 + 不落库断言。
5. **#12 G6/G7**：收紧 `available-slots` 一致性断言（含 miniapp 60 分钟提前期 ≠ 后台 0 分钟）。
6. **#14 G9**：限流 429 + Swagger app 分组断言（`rateLimit` 组合从未验证过是否真生效）。
7. **#15 A9/A11/A12/A13/A14**（最大一块）：全部完成 ✅。
8. **#16 A19**：`scripts/devtools.mjs` 自证脚本（Windows 上 agent-browser 不可用，只能靠它做小程序冒烟）。

**动触钱代码前必须加载 `money-invariants`**：S4 已完成，`biz_commission_record` 只追加 + 幂等的断言写在
`tests/integration/b6-app-identity.int.spec.ts` 里；A13 支付回调同样触钱，动手前照做。

### D12：`/app/subscribe`（A12）的三个取舍

1. **授权额度单独建表 `app_wx_subscribe_grant`，没有塞进 `sys_notice_log`。**
   spec §16.4 那句「`sys_notice_log.channel` 预留枚举值」在代码里其实**没有预留**（枚举只有 `sms` / `site`），
   而 `sys_notice_log` 是「已发生的一次发送」的日志（带 `provider` / `provider_msg_id` / `retry_count` / `sent_at`），
   把「获得了一次下发额度」塞进去会污染发送成功率统计。真正要发的时候再决定要不要扩 `channel`。
2. **按 `(app_wx_user_id, template_id)` 聚合累加，而不是记 append-only 流水。**
   微信一次性订阅的语义就是「点一次允许 = 一次额度，可累积」，流水查不出「还能发几次」。
   累加走 `ON DUPLICATE KEY UPDATE granted_count + 1`，并发重放是累加不是覆盖。
3. **不校验模板 ID 白名单，也不做「模板 ID ↔ 内部 templateCode」映射。**
   微信模板 ID 是**公开的**（写死在小程序包里），白名单拦不住任何攻击者，只能挡客户端拼写错误；
   映射要等 **H10 申请到真实模板 ID** 才有得可填。H10 落地时要补三件事：白名单（或映射表）、
   消费额度的发送段（`granted_count` 减去已用、并落 `sys_notice_log`）、以及「额度用完就不再发」的判定。

### 踩坑：drizzle-orm 1.0.0-rc 生成的 `DEFAULT (CURRENT_TIMESTAMP)` 会让 MySQL 8.0.23 炸

新增表只要用到 `auditColumns`，生成的 `created_at` / `updated_at` 默认值就是**带括号**的表达式写法。
MySQL 8.0.23 建表时放行，但随后任何**重建表**的语句（`CREATE INDEX` / `ALTER TABLE`）会报
`Invalid default value for 'created_at'`，而且 DDL 不回滚——迁移会停在半应用状态
（表建好了、索引没建、`__drizzle_migrations` 没记录，下次跑直接 `already exists`）。
手工把括号去掉即可，`drizzle-kit generate` 不会因此认为有漂移。已在 `src/database/schema/index.ts`
的 `auditColumns` 上方写了警示注释。**每次 `db:generate` 之后都要肉眼扫一遍新 SQL。**


---

## 9. 设计稿还原进度与验证账本（2026-09-12 更新）

### 9.1 结论

`docs/design.png` + `docs/manicure-ui-batch1~5`（约 36 屏）覆盖的页面**已全部实现**，
并且**全部通过了「真机模拟器截图 vs 设计稿」的逐项比对**。

### 9.2 验证方式（重要，可复用）

会话中期踩过的坑：`simulator_open_page` **到不了三类页面** ——
① 依赖内存草稿的页（预约美甲、确认预约）；② tabBar 页（我的预约、首页）；③ 需切换模式的页（工作台）。

后来发现 **`automation` client 授权后可以用真实交互驱动**，于是改为：

| 场景 | 做法 |
| ---- | ---- |
| 普通页 | `simulator_open_page --page ... --query ...` |
| 带 ID 的页 | `--query 'bookingId=8801'` 直达（收银台、订单详情、评价、次卡） |
| tabBar 页 | `automation_navigate --action switchTab --url /pages/bookings/index` |
| 需草稿的页 | 真实走一遍：`navigateTo services` → 点 `.list-card__add` → 点 `.action-bar .btn` |
| 需模式的页 | `switchTab mine` → 点 `.staff-block__btn` 进工作台 |

判断落点用 `automation_runtime_info --action currentPage`（比截图便宜且确定）。

### 9.3 验证成果与查出并修掉的问题

| 页面 | 结果 |
| ---- | ---- |
| 首页 / 款式库 / 款式详情 / 收银台 / 个人中心 / 会员卡 / 门店信息 / 登录页 | ✅ 截图比对通过 |
| 订单详情 / 服务评价 / 取消说明 / 确认预约 / 我的预约 / 预约美甲 | ✅ 截图比对通过 |
| 工作台 / 工作台·我的预约 / 业绩明细 / 我的评价 | ✅ 截图比对通过 |
| 支付结果 | ✅ 截图已抓取（两态：success / pending） |

**验证过程中查出并修掉的真问题**（都是 typecheck 与单页截图抓不到的）：

1. **美甲师被问两遍**：我把「选美甲师」按设计稿并进了预约页，但「下一步」仍调用旧的
   `goStaffs()`，于是先跳独立选美甲师页、进预约页又要再选一次。
   修法：`goNext()` 改调 `goSlots()`。**只有真实点击走一遍才会暴露**。
2. **emoji 兜底**：订单详情的美甲师行渲染成「🍊 小柚」——`staffEmoji()` 是
   `present.ts` 里的共享逻辑，属系统性问题。改为本地占位头像。
3. **文本星字符**：工作台评价用 `'★★★★★'.slice(...)`，在部分平台会被渲染成 emoji，
   改为 5 枚图标（实心/描边按分数）。
4. 首页分享按钮、详情分享按钮被**微信胶囊按钮**盖住（改用
   `getMenuButtonBoundingClientRect()` 算右侧间距）。
5. **小程序 `<image>` 不解析 URL 编码的 SVG data-URI**：图标静默不渲染、页面只剩文字，
   必须用 base64（已内联一个 ASCII base64 编码器）。
6. **小程序不认目录导入**：`from '../../api'` 运行时抛 `module 'api.js' is not defined`，
   页面全白；必须写 `'../../api/index'`。

### 9.4 明确未做（以及为什么）

| 项 | 原因 |
| -- | ---- |
| 优惠券、收藏、收货地址、意见反馈、消息中心、积分兑换、充值、次卡的**真实数据** | 数据模型不存在或 app 域无接口。**视觉按稿完整还原，交互如实降级**，不塞假数据 |
| 核销二维码 | 不伪造：动态码必须服务端签名，否则客户端可离线造码。现用卡号作凭据并注明正解 |
| 取消扣费金额 | app 域读不到判责规则（在 `RefundPort.preview`）。写死数字会给出错误金额预期，故只写原则 |
| 真机验证 | 需要人扫码/真机操作，AI 无法完成 |
| 用户协议 / 隐私政策正文 | 需门店主体信息与手机号用途声明，**提审前必须替换**，否则会被驳回 |


---

## 10. 优惠券核销「建单接线」设计（**已勘察、未实施**）

> 状态：2026-09-12。`CouponsService.redeemForBooking()` 已实现并有 6 个测试
> （含并发红线）；算价 `quoteBooking` 已支持券；`biz_booking` 已有
> `coupon_id` / `coupon_discount_amount` 两列。**只差建单事务里的接线**。
> 本文把勘察结论固化下来，避免下一个接手的人重新读 1700 行。

### 10.1 关键结构（`src/modules/biz/booking/bookings.service.ts`，1776 行）

`buildQuote`（L1590）是**所有路径共用的算价入口**，改一处即可：

| 调用点 | 用途 | 是否要支持券 |
| ------ | ---- | ------------ |
| L476 | 后台建单（含 payments / 挂账） | P2 可支持 |
| **L754** | **app 建单**（`pointsToUse`、`useCard`） | **本目标要做的** |
| L953 | 改期 | 否（沿用原单的券） |
| L1210 | 结算 | 否（沿用原单的券） |

`CreateBookingInput`（biz 层）已有 `pointsUsed`；app 那条路径用的是**另一个**入参类型
（L692 附近，字段名是 `pointsToUse`）。**注意两者字段名不同**，接参时别混。

### 10.2 唯一正确的顺序（有鸡生蛋问题）

券抵扣额是算价**输入**，而核销又需要 **bookingId**（`used_booking_id`）——
两者互相依赖。正确顺序：

1. 先用 `couponDiscountAmount = 0` 调一次 `buildQuote` → 取 `levelDiscountAmount`
   → `baseAfterLevel = originalPrice − levelDiscountAmount`（门槛按**折后**金额判，与后端口径一致）；
2. 若有 `couponId`：在事务内读券并做**前置校验**（归属 / 状态 / 过期 / 门槛），取面额；
3. 再用 `couponDiscountAmount = 面额` 调 `buildQuote`（纯函数，两次调用很便宜）；
4. `insert(bizBookings)` —— 写入 `couponId` 与 `quote.couponDiscountAmount`；
5. **拿到 id 后调 `redeemForBooking(tx, {...bookingId})`** 做条件更新。
   `affectedRows = 0` → 409 → **整个事务回滚**，不会出现「券用了单没建成」。

> 第 2 步的校验**只为了给出友好报错**；并发安全完全由第 5 步的条件更新保证。
> 若把第 2 步当成闸门（读-判断-写），并发下同一张券会被两单同时用掉。

### 10.3 两个必须一起处理的坑

1. **券与积分二选一**：入口处显式 400（`couponId && pointsToUse` 同时存在）。
   **不能静默忽略积分** —— 顾客会以为积分也抵了。`money.ts` 里也有兜底
   （有券则 `pointsUsed` 归 0），但那是防御，不是主校验。
2. **`useCard`（次卡核销）必须同时清零券**：`buildQuote` 在 `useCard` 分支里
   已经把 `levelDiscountAmount` / `pointsDiscountAmount` 归零，
   **新增的 `couponDiscountAmount` 也要归零** —— 次卡 `payable = 0`，
   再叠一张券等于白送（且券还被消耗掉了）。

### 10.4 还要改的四处

| 位置 | 改动 |
| ---- | ---- |
| `buildQuote` 入参与 `useCard` 分支 | 加 `couponDiscountAmount`，并在次卡分支归零 |
| app 建单入参类型 / `CreateBookingInput` | 加 `couponId?: number` |
| `BookingPort.create`（`common/ports.ts`） | 透传 `couponId` |
| app DTO（`AppCreateBookingRequest`） | 加 `couponId: z.number().int().positive().optional()` |

### 10.5 测试要求（缺一不可）

- 带券建单：应付金额 = 折后 − 券；`biz_booking` 两列落库；券翻 `used` 且 `used_booking_id` = 该单；
- **并发建单用同一张券 → 恰好一单成功**（另一单 409 且**不留脏单**）；
- 门槛不足 → 409 且**券不被消耗**；
- 券 + 积分同时传 → 400；
- 券 + 次卡 → 400（或按 10.3 归零，二选一后必须**写测试钉住**）；
- 不传券的建单**回归不变**（现有集成测试应全绿）。
### 10.6 精确坐标（2026-09-12 二次勘察补充）

上一版把端口方法名写成了 `BookingPort.create` —— **实际是 `createForCustomer`**
（`ports.ts` 里 `createForCustomer` 出现两处：L695 与 L923，改的时候两处都要看）。
补上完整调用链与逐处坐标，接手可直接动手、无需再探索：

```
小程序 → POST /app/bookings
  → app-member.controller.ts      @Post('bookings')
  → app-member.service.ts         createBooking(appUserId, input)   ← 入参加 couponId
  → BookingPort.createForCustomer(customerId, input)                ← ports.ts 加 couponId
  → bookings.service.ts:686       createForCustomer(customerId, input)  ← 入参加 couponId
```

`bookings.service.ts` 内要改的四处（行号为当前值）：

| 行 | 现状 | 改法 |
| -- | ---- | ---- |
| L687-694 | `createForCustomer` 入参（`memberCardId` / `pointsToUse` / `remark`） | 加 `couponId?: number \| undefined` |
| L747-761 | `useCard` 判定 + 步骤 3 算价 | 加两个 400 校验（见 10.3），并按 10.2 顺序取券、带券重算 |
| L776-806 | `insert(bizBookings).values({...})` | 加 `couponId` 与 `couponDiscountAmount: quote.couponDiscountAmount` |
| L825-834 | 步骤 8a 积分抵扣（`deductPoints` 的既有写法） | 紧邻其后加券核销 `redeemForBooking(tx, {...})` |

另外两处：

| 位置 | 改动 |
| ---- | ---- |
| `bookings.service.ts` 构造器（13 个依赖） | 注入 `CouponsService`（MembershipModule 已 export，BizModule 已 import） |
| `app-vo.ts` 的 `appCreateBookingRequestSchema` | 在 `memberCardId` / `pointsToUse` 之后加 `couponId: z.number().int().positive().optional()` |

**算价的既有写法可直接照抄**：L825-834 的积分抵扣就是「先算价 → 建单拿 id → 事务内扣减」
的现成范例，券走同一形状，唯一差别是券要**两次算价**（10.2 的鸡生蛋问题）。

### 10.7 `CouponsService` 还差一个只读方法

`previewForBooking({couponId, customerId, baseAmount})` —— 算价阶段取券面额用。
**它只读、不是闸门**：真正的并发安全在 `redeemForBooking` 的条件更新里
（若读取与核销之间券被别人用掉，核销 409 → 整个建单事务回滚）。
实现时把 `redeemForBooking` 已有的三段前置校验（归属 / 状态与过期 / 门槛）
抽成一个私有方法复用，避免两处口径分叉。

---

## 11. 真接口对接 / 优惠券 / 积分 —— 验证账本（2026-09-12）

### 11.1 五条要求的达成证据

| 要求 | 证据 |
| ---- | ---- |
| ① 清掉 mock、全部接真接口 | 小程序侧 grep `isMock / MOCK_BADGE / DEMO_CUSTOMER_ID / use-mock` **为 0**；`api/mock.ts`（552 行）已删；实测登录换真 token、11 个项目、4 位美甲师、33 个时段 |
| ② 优惠券 + 积分 | app 域新增 6 条路由（见 11.2）；**6 个集成测试文件**；券核销与建单**同事务**；`used_booking_id` 唯一索引 + 条件更新防一券多用 |
| ③ 未登录/已登录区分 | 统一门面 `store/session.ts`；**10 个页面**有 `guest / requireSession / needBind` 分支（bookings, booking-detail, pay, confirm, member, points, coupons, card-detail, recharge, mine）；引导链路端到端验证过 |
| ④ 补接口 + 测试 | 两侧 `tsc --noEmit` **exit 0**；**1064 通过 / 0 失败**（整套 ~18 秒） |
| ⑤ 一页/一链路一提交 | 本目标 35 个提交，每页或每条链路一次 |

### 11.2 新增的 app 域接口

```
GET  /app/points-goods        积分兑换品目录（只要 token，不要求绑定）
POST /app/points/redeem       兑换（复用后台 redeem() 的同事务实现）
GET  /app/coupons             我的优惠券（状态**现算**：usable 但过期 → expired）
GET  /app/coupon-offers       可领取的券（排除已持有可用券的模板）
POST /app/coupons/claim       领券（事务内锁模板行串行化）
POST /app/bookings            建单新增 couponId（券核销同事务）
```

### 11.3 关键口径（改之前先读这一段）

1. **算价顺序**：原价 → 等级折扣 → **券抵扣** → 积分抵扣 → 手动改价 → 应付；
   **券与积分同一单二选一**（同时传 → 400，**不静默忽略积分**）；
2. **次卡 `payable = 0`，券必须同时归零**（`buildQuote` 的 `useCard` 分支）——
   否则等于白送一次让利，**而且券会被真实消耗掉**；
3. **核销的唯一闸门是条件更新**（`status='usable' AND used_booking_id IS NULL`），
   `affectedRows=0` → 409 → 整个建单事务回滚。
   `previewForBooking` 只用于算价，**不是闸门**；
4. **券的门槛按「等级折扣后」金额判**，前端也要按这个口径过滤可选券
   （否则会展示注定被 409 拒绝的选项）；
5. **领券用行锁而非「先查再插」**：MySQL 没有部分唯一索引，
   表达不了「同一顾客同一模板只能有一张**未使用**的券」。

### 11.4 明确未做 / 已知取舍

| 项 | 说明 |
| -- | ---- |
| 确认预约页的选券交互 | **只有手工验证**：用 `wx.showActionSheet`，原生弹层不便自动化断言。逻辑本身（门槛过滤、二选一、金额预估）已读页面 data 验证过 |
| 会员卡页促销区的 `.catch` | 接口失败会被静默降级成「暂无可领的券」。取舍是「次要区块不该让整页失败」，但**下次应把「加载失败」与「确实没有」区分开** |
| `biz_booking.coupon_id` 外键 | 未加。与 `biz_customer_coupon.used_booking_id → biz_booking` 会形成互相 SET NULL 的环；两表都软删，外键只剩装饰作用 |
| JSAPI 支付通道 | 后端仍是 501 契约骨架（**原始范围外**，不是本次引入）。收银台的真实支付走不通，页面已如实提示 |
| 微信凭据 | `.env` 未配置 `WX_MINIAPP_APPID/SECRET`，开发期用 `WX_MINIAPP_FAKE=true`（**生产强制失效**）。**上线前必须配真凭据** |

### 11.5 测试基础设施（重要，别踩回去）

1. **`resetBusinessData()` 用 `DELETE` 而不是 `TRUNCATE`**：
   实测 37 张表 `TRUNCATE` 合计 **4067ms**、`DELETE` 合计 **56ms**（**差 73 倍**）。
   InnoDB 的 `TRUNCATE` 是 DDL（重建表），而这里每张表在用例结束时空着。
   整套回归因此从 **~530 秒降到 ~18 秒**。
   **代价**：`AUTO_INCREMENT` 不重置 —— 用例一律用 `insertId`，**不要断言固定 id**；
2. **reset 必须在一条连接上跑完**：`SET FOREIGN_KEY_CHECKS` 是**会话级**的，
   而池子里有 10 条连接 —— 原来的 `pool.query` 可能换连接，那句 SET 形同虚设；
3. `bunfig.toml` 的 `[test] timeout = 60000` 是**安全网**（hook 实测已 ~60ms）；
4. **加后端路由后必须重启**：`bun src/main.ts` 不带 watch。
   本会话为此白排查了 4 次 —— **建议把「重启后端」写进验证脚本的第一步**，
   别靠记性。


---

## 12. 优惠券后台管理端（2026-09-12 完成）

### 12.1 能力清单

| 操作 | 接口 | 权限点 |
| ---- | ---- | ------ |
| 券模板 列表 / 详情 | `GET /biz/coupon-templates`、`GET /biz/coupon-templates/:id` | `biz:coupon:list` |
| 券模板 新增 / 修改 / 停用 | `POST`、`PATCH :id`、`DELETE :id` | `biz:coupon:create/update/delete` |
| **给顾客发券** | `POST /biz/members/:id/coupons` | `biz:member:coupon` |
| 查某顾客的券 | `GET /biz/members/:id/coupons` | `biz:member:list` |

页面：`web/src/views/biz/coupons/index.vue`（券模板维护，菜单 `biz_coupons`）+
会员列表操作列的「发券」入口。菜单 seed 已含 `biz:coupon:*` 与 `biz:member:coupon`。

### 12.2 两条发放口径**必须不一样**（已被测试固定）

| 场景 | 口径 | 为什么 |
| ---- | ---- | ------ |
| 顾客**自助领券** `POST /app/coupons/claim` | **一次一张**，已持有可用券 → 409 | 防薅羊毛；且事务内锁模板行串行化 |
| 后台**发券** `POST /biz/members/:id/coupons` | **允许重复发放** | 补偿、活动补发是正常诉求，加去重会把合法操作挡掉 |

**不要「顺手统一」这两条** —— 各自都有测试钉着
（`b7-coupon-claim` / `b7-coupon-issue`）。

### 12.3 几个容易改坏的点

1. **单号是「主键回填」且必须包在事务里**：先插占位号 → 拿自增 id → 回填正式号。
   不能用「查当日最大号 +1」（并发必然重号）；不包事务则中途失败会
   **永久留下一张 `TMP...` 号的券**；
2. **模板停用/删除不影响已发出的券** —— 面额与门槛在发券时已快照到持有行。
   列表里给 `claimedCount` 就是为了让运营看得见影响面；
3. **错误要从 `cause` 链里找**：drizzle 把 mysql2 错误包成 `DrizzleQueryError`，
   顶层 message 只有 `Failed query: ...`，约束名与 errno 在 `cause` 里。
   只看顶层会让「同名模板」返回 500 而不是 409；
4. **前端金额（元）↔ 接口金额（分）** 只在两个转换函数里做，页面不做任何折算。

### 12.4 未做（按需再补，不是缺口）

| 项 | 说明 |
| -- | ---- |
| 会员详情加「优惠券」Tab | 接口 `GET /biz/members/:id/coupons` 已就绪，页面还没用 |
| **手工作废/核销券** | 目前券只能等下单自动核销。运营发错一张券时**没有手工纠正手段** —— 这是最值得补的一项（需要新接口 + 状态流转 + 审计原因） |
| 发券记录页 | 现在只能按顾客查；没有「某模板发给了谁」的全局视角 |

---

## 13. 小程序端基础设施（2026-09-12 重构，**新页面必须按这套写**）

> 本轮把「每个页面各写一遍」的样板收成了四个件：`definePage` / `pageChrome` / `runLoad` /
> 自定义 TabBar 自治。改小程序页面前先读本节，别再造第五个轮子。

### 13.1 页面：`definePage`（`utils/page.ts`）

```ts
import { definePage } from '../../utils/page';
import { runLoad, runPullDownLoad } from '../../utils/load';

definePage({
  chromeIcons: PAGE_ICONS,        // 跟随主题色生成 data.icons（whiteIcons / extra 同理）
  data: { loading: true, items: [] },   // 只写本页自己的字段
  onLoad() { void this.load(); },
  onShow() { /* 主题/登录态/图标/TabBar 已由工厂刷新，这里只写业务 */ },
  onPullDownRefresh() { return runPullDownLoad(() => this.load()); },
  async load() {
    await runLoad(this, () => api(), {
      merge: (r) => ({ items: r.items.map(toVM) }),
      after: () => this.refresh(),
    });
  },
});
```

- 工厂注入的 data：`themeStyle / themePrimary / onPrimary / themeName / themeEmoji /
  loggedIn / bound` + `loading / refreshing / errorText / loaded`。
- **`onShow` 只推「外观/身份」**（`pageAppearance`），**绝不推加载态** ——
  推了会把 `runLoad` 的状态机打回首屏（详见 `docs/pitfalls/miniapp.md` §17）。
- 配置项名是 **`chromeIcons`**（不是 `icons`）；拼错会被静默吞掉，工厂有防呆告警（§18）。

### 13.2 加载：`runLoad` 的四条语义（`utils/load.ts`）

| 时机 | loading | refreshing | 内容 |
| ---- | ------- | ---------- | ---- |
| 首屏 | true | false | 骨架屏 |
| 已有数据再刷新 | false | true | **保留旧内容**（切 Tab 回来不再闪白） |
| 首屏失败 | false | false | errorText → 错误态 + 可重试 |
| 刷新失败 | false | false | **保留旧内容** + toast |

数据源**整体换了**（如时段页换日期）要传 `force: true` 回骨架屏，否则旧数据还留在屏幕上且**可点**。
`onPullDownRefresh` 一律用 `runPullDownLoad`（它的 `finally` 保证下拉圈会停）。

### 13.3 TabBar：高亮**由组件自己算**（`custom-tab-bar/index.ts`）

- `refresh()` 自己读 `getCurrentPages()` 推主题+模式+高亮，**不依赖页面调用**；
  页面侧的 `utils/tabbar.ts#syncTabBar` 只是「戳一下让它重算」。
- 点击 = **乐观更新高亮 → 在途保护 → `switchTab`**；`fail` 必须校准 + 给反馈，不许静默。
- 图标两态**同时渲染靠透明度交叉淡入**，不要换 `src`（会闪白）。

### 13.4 样式与动效

- **动效令牌**（`app.wxss` 的 `page{}`）：`--dur-instant/fast/mid/slow`、`--ease-out/back/in-out`。
  **不要在页面里写 0.2s/ease 这类字面量**，否则全项目的快慢手感又会散掉。
- **工具类**：`.anim-rise`（内容块入场）、`.anim-pop`（空态/小元素）、`.anim-item` + `style="--i:{{index}}"`（一次性列表逐项入场）、
  `.press` / `.press-sm`（按下反馈）。
  入场动画统一 `animation-fill-mode: backwards` —— 用 `both` 会压掉 `.press:active`（§19）。
- **跨页面同形的零件一律进 `app.wxss`**：`.chip` / `.mini-btn` / `.tips` / `.empty__action`
  已经收归全局，页面只保留排布（外边距交给容器）。新增零件时先 grep 一遍有没有同形的（§20）。
- **不给横向 `scroll-view` 内的元素加 `.press`**：横向拖动会误触发 `:active`，看起来像卡住。
- 不给**没有 `bindtap`** 的元素加 `.press`（会误导「可点」）。

### 13.5 怎么验收（本轮用到的真手段，别再只靠 tsc）

```bash
# 1) 打开自动化端口（IDE 需已开着项目）
"C:\Program Files (x86)\Tencent\微信web开发者工具\cli.bat" auto --project <项目路径> --auto-port 9420
# 2) 用 miniprogram-automator（临时目录装，别进仓库依赖）
#    connect({ wsEndpoint:'ws://127.0.0.1:9420' }) → mp.evaluate / page.data() / mp.screenshot()
```

- **`page.data()` 直接断言**（如 `loaded === true`、`selected === 2`）比截图猜快得多；
- 改了 TabBar / 动效这种「体验类」问题，**必须真跑一遍并截图**——
  `tsc` 与单页静态检查对这类问题完全无效（本轮两个真 bug 都是这么抓到的）。
