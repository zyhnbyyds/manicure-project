# 交接说明：小程序端 + app 域身份（截至 2026-09-11）

> 交接对象：接手的下一位执行者（人或 AI）。
> 本文件只写**事实与入口**，不重复 spec。设计依据见 `docs/superpowers/specs/2026-09-11-nail-salon-booking-design.md`，
> 施工单见 `docs/superpowers/plans/2026-09-11-miniapp-development-plan.md`（含 §12 美甲师工作台需求变更）。

---

## 0. 一句话现状

- **小程序端**：10 个页面已落地，主题系统可用，模拟器里跑得起来（截图验证过 3 页），**接的是演示数据**。
- **后端**：app 域身份域扩出「美甲师工作台」数据层，微信能力已端口化，手机号绑定转真实现，**10 条集成用例全绿**。
- **美甲师工作台本身（S1 下半 ~ S5）尚未开工**：`src/modules/app/staff/` 目录都还不存在。
- **P0-1 已完成**：后台可筛选 / 恢复软删顾客，小程序手机号绑定 409 分支已闭环，恢复后可重新绑定；
- 全量测试：**907 pass / 0 fail**；后端 typecheck / lint、前端 typecheck / lint 通过；工作区干净（无未提交改动）。

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

| #   | 模块                  | 内容                                                                                                                                                                                                                                                                                                                                                                                                             | 门禁                                         |
| --- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| 5   | ✅ **S2 店长确认**    | 已完成：`GET /biz/app-staff-grants?status=pending`、`POST .../:id/approve`、`/:id/reject`；权限点 `biz:staff:grant` 已进 `menus.ts`（25 页）；后台页面 `web/src/views/biz/app-staff-grants`。状态机：已 active 幂等、已驳回 409（须重申）、档案停用/删除 409；驳回原因落新增列 `staff_reject_reason`。12 条单测 + 5 条集成。见提交 `eff60a2`、`8c1aad9`                                                          | 🤖                                           |
| 6   | ✅ **S3 只读 5 接口** | 已完成：`/app/staff/me`、`/bookings`、`/schedule`、`/performance`（**提成逐单明细全见**，D9）、`/reviews`，全部 `staff_id` 硬限定（方法第一参数就是 staffId，不做「传进来再校验」）；顾客/本人手机号一律 `maskPhone`（D11）；字段集合由 `app-staff-workbench.vo.ts` 的 Zod 断言（无成本、无内部字段）。新增 `ReviewPort` + `CommissionPort.listByStaff/summarizeByStaff`。15 条单测（含 2 次变异验证）+ 7 条集成 | 🤖                                           |
| 7   | ✅ **S4 写 2 接口**   | 已完成：`POST /app/staff/bookings/:id/arrived`、`/complete`，走 `BookingPort` → 既有 `runComplete`（提成计提 + `visit_count` + `affectedRows` 幂等闸门），app 域**没有**自己 UPDATE 状态；早于 `start_at` → 400（§12.4-3）；已到目标状态 → `changed:false`（幂等，不报 409）。触钱口径已按 `money-invariants` §4 写集成：重复完成 `biz_commission_record` 仍为 1 条。5 条集成（含越权 403、404、时间护栏）       | 🤖 触钱，**动手前先加载 `money-invariants`** |
| 8   | **S5 小程序端**       | 顾客/工作台模式切换；工作台（今日日程+业绩卡）、我的预约、业绩明细、我的评价页；手机号**脱敏 + `wx.makePhoneCall` 拨号**（D11 已定）                                                                                                                                                                                                                                                                             | 🤖                                           |

### P2 —— 原 B6 收口剩余（可与 P1 并行）

| #   | 任务                                               | 说明                                                                                                           |
| --- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| 9   | **G2**：补「未配置凭据 → 503」用例                 | 需要能在测试里切回 `HttpWxMiniappProvider`（或单测直接构造 Http 实现 + 空配置）                                |
| 10  | **G4**：9 个 501 骨架端点用例 + 不落库断言         | 现在只测了 `POST /app/bookings` 一个                                                                           |
| 11  | **G5**：修 spec 骨架条数口径                       | spec §12 说 5 个、§16.1 列 8 个、代码实际 9 个                                                                 |
| 12  | **G6/G7**：收紧 `available-slots` 一致性断言       | 现在只在两边都非空时才比对；且没断言 miniapp 60 分钟提前期 ≠ 后台 0 分钟                                       |
| 13  | **G8**：`/app/member/me` 已绑定字段集合 + 越权用例 | 现在只测了未绑定 401                                                                                           |
| 14  | **G9**：限流 429 + Swagger app 分组断言            | `@RouteConfig({rateLimit})` + `@fastify/rate-limit` 的组合**从没验证过是否真生效**                             |
| 15  | **A9/A11/A12/A13/A14**                             | `member/cards`、`reviews`、`subscribe`、支付回调业务层（假验签器）、`app_wx_user_bind_log`                     |
| 16  | **A19**：`scripts/devtools.mjs` 自证脚本           | 封装「绝对路径调 wechatide + 首次授权轮询 + 编译→跳页→截图→拉 console」。**注意截图返回 `.png` 但内容是 JPEG** |

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
bun run typecheck && bun run lint && bun run test   # 基线应是 895 pass / 0 fail
```

然后二选一：

- **P0-1 已完成**：从「档案状态 → 已删除」筛出顾客，点「恢复档案」并确认；恢复后重新绑定手机号即可走通。
- **P0-1 ~ P0-4、S2 / S3 / S4 后端已完成**：接口与测试齐了，**剩下的是 S5 小程序端**（顾客/工作台模式切换、工作台页、我的预约、业绩明细、我的评价、脱敏拨号）。

- **推美甲师主线**：P0-3（`BookingPort`）→ S2/S3 → S4/S5。

**动 S4 之前必须加载 `money-invariants`**：那是唯一触钱的一条（完成会触发提成逐项计提）。已完成，`biz_commission_record` 只追加 + 幂等的断言写在 `tests/integration/b6-app-identity.int.spec.ts` 里。

**动 S4 之前必须加载 `money-invariants`**：那是唯一触钱的一条（完成会触发提成逐项计提）。
