# 小程序开发施工单（AI 执行版）· B6 收口 + P2 客户端

> **给 AI 的执行单**，不是给人看的排期表。**不使用「人日」**。
> 基线 commit `00c6f9a` · 分支 `master` · 参考 spec §9.7 / §12 B6 / §16 / §17.1
> 技能：`miniapp-reserved`、`testing-acceptance`、`money-invariants`、`booking-core`

---

## 0. 本单怎么读

### 0.1 门禁标记（本单的核心）

| 标记 | 含义                                                               | AI 该怎么做                                     |
| ---- | ------------------------------------------------------------------ | ----------------------------------------------- |
| 🤖   | **AI 自主**：零外部依赖，AI 做完并自证                              | 直接执行，跑完验证命令再报完成                   |
| 🔑   | **凭据门**：人给凭据后 AI 继续（接入与验证仍由 AI 做）              | **不得空等**，先做 §10 的「离线可验证一半」       |
| 🧑   | **人工必须**：只有人能做的事（手续 / 决策 / 扫码 / 付款 / 点击提审） | AI 停在此处并输出「人需要做什么」的明确交付要求   |

### 0.2 纪律（违反即返工）

1. **契约已冻结**：app 域的 501 骨架（**6 个**；auth/phone 由 A8、member/cards 由 A9、reviews 由 A11 转真实现）把 501 换真实现时，
   **路由、入参、出参形状不许改**；要改先改 spec §9.7 并单独提交。
2. **不许另写一套算价/时段/冲突检测**：app 域一律复用后台 `SlotsService` / `BookingService` / 会员算价 service，app 层只加「仅本人 + `channel=miniapp` + `status=pending`」。
3. **不许为绕过缺失凭据而造假**：禁止硬编码 openid / 商户号 / 跳过验签 / 把假 Provider 挂到生产分支。
4. **触钱改动先加载** `money-invariants`，逐条自检后再报完成。
5. **app 域每次改动自查 4 条隔离**：独立 token 域、不接 RBAC、不复用后台 DTO、限流。
6. **收口验证**（后台改动）：`bun run typecheck && bun run lint && bun run test`。
7. **新表走** `bun run db:generate`，禁手写 SQL 迁移。
8. 一个任务一个 commit，message 带任务号（如 `feat(app/booking): A10 自助下单真实现`）。

### 0.3 已实测：AI 可直接驱动微信开发者工具（**不需要 MCP**）

2026-09-11 本机实测结论：

| 事实 | 实测值 |
| ---- | ------ |
| 开发者工具 | 已装 `C:\Program Files (x86)\Tencent\微信web开发者工具`（2.02.2608070），**当前正在运行**，桥接端口 **33728** |
| CLI 入口 | `<安装目录>\wechatide.cmd` 与 `cli.bat` —— **都不在 PATH** |
| 调用形式 | `wechatide -c <clientName> <toolName> [flags]`；clientName 取工具分组：`ide` / `project-manager` / `project-action` / `runtime` / `compile` / `automation` / `debug` / `cloud` |
| 授权模型 | 每个 client **首次调用返回 `taskId`**，需人在 IDE 内**点一次授权**；之后用 `polling_task_result --task-id <id>` 取结果。本机 `ide`、`project-manager` 已授权（`authorized:true`、`tokenRequired:false`） |
| 登录态 | 已登录（`loginExpired:false`，用户 ZYH）→ **无需重新扫码** |
| 小程序项目 | `D:\project\myproject\manicure-project\miniapp`（项目名 `manicure`，appId **`wx9f814556a48f60ae`**，weapp）；git 里当前是 `?? miniapp/` 未跟踪 |
| 实测通过的工具 | `check_wechatide_status`、`project_list`、`get_user_appids`、`open_project_window`、`simulator_screenshot`（成功截图 564×1217） |

**这直接改写了人工门禁**（§1 的 H11/H12 已据此调整）：

- 前端自证**不再依赖人眼**：`simulator_screenshot`（看图）、`get_simulator_console` / `get_simulator_network`（grep console 与请求）、`simulator_open_page`（编译并跳页）、`simulator_refresh`、`automation_element_action` / `automation_evaluate` / `automation_navigate`（真实点击/输入/读运行时值）、`compile_wxml` / `compile_wxss`（诊断模板与样式编译）。
- 人只在三件事上必须上场：**真机**（`auto_preview` 推送到开发者微信后由人看手机）、**视觉验收**（截图交人确认）、**正式 appid 与提审发布**。

> **你给的那份 MCP 配置在当前状态下用不了**，两个原因：
> 1. `"command": "wechatide"` —— `wechatide` **不在 PATH**（`Get-Command wechatide` → MISSING），必须写绝对路径 `C:\\Program Files (x86)\\Tencent\\微信web开发者工具\\wechatide.cmd`；
> 2. **本会话没有挂 MCP 客户端**：我的工具表里没有任何 MCP 工具，`~/.dsh/settings.yaml` 也无 mcp 段。DSH 自带 `dsh-mcp-client`，所以能接，但要写进配置并**重启/新开会话**才可能作为一等工具暴露。
> 好消息是 `wechatide mcp` 本体是通的（实测打印 `Connected to WechatIDE on port 33728`），所以接 MCP 只是「配置 + 重启」的事，**不是能力问题**——而且上面的 CLI 路径已经能干活，不必等 MCP。

### 0.4 两条泳道可并行

- **后端泳道**：A1 → A14（串行，同一模块）
- **前端泳道**：A15 → A17（门 H1 解除后即可全速）
- 两条泳道**只通过冻结的接口契约交互**，可交给两个 agent 并行；联调点在批次 B/D。

---

## 1. 人工介入点总表（**本单最重要的一节**）

> 「最晚需要」是相对开工的时点。**H1~H4、H15 不解除，AI 只能做批次 A。**

| ID  | 类型 | 事项 | 谁 | 交给 AI 什么 | 卡住哪些任务 | AI 等待期间做什么 | 最晚需要 |
| --- | ---- | ---- | -- | ------------ | ------------ | ----------------- | -------- |
| **H1** | ✅ 已定 | 技术选型 —— 脚手架已建：**原生小程序 + TypeScript**（`miniapp/`，`useCompilerPlugins:["typescript"]`、`componentFramework: glass-easel`、`libVersion: trial`、`skylineRenderEnable: true`） | — | 若要改 uni-app/Taro 请现在推翻，否则按原生 TS 施工 | A15~A17 | 已解除，前端泳道可开工 | 已满足 |
| **H2** | 🧑 决策 | P2 范围：会员码 / 自助改期 / 评价 是否都做；JSAPI 与订阅消息是否本期上 | 你 | 勾选 | A11/A12/A14、批次 C/D | 未定项按「都做」预留结构 | **立即** |
| **H3** | 🔑 凭据 | **AppID 已知**：`wx9f814556a48f60ae`（**接口测试号**，devtools 已绑定）；**AppSecret 仍需人给** | 你（测试号后台复制 Secret） | 一个 Secret 字符串 → `.env`（**不进 git**） | B1、B2 | A1 的 FakeProvider 把业务全测完；测试号让备案/认证/商户号**不阻塞开发** | 第 1 周内 |
| **H4** | 🔑 凭据 | 小程序**代码上传密钥** `private.<appid>.key` + 后台 **IP 白名单** | 你 | 密钥文件路径 + 出口 IP | B3（CI 上传/预览） | 同上 | 第 1 周内 |
| **H5** | 🧑 手续 | **小程序主体认证**（企业；需营业执照 + 对公打款/发票，有年费） | 你 + 财务 | 认证通过 | E 批次提审 | — | **第 1 周启动** |
| **H6** | 🧑 手续 | **小程序备案**（工信部，2023 起为发布硬门槛，**未备案无法上架**；需主体证件 + 人脸核验 + 短信验证） | 你（法人/主体） | 备案号已下 | **E 批次发布（硬门槛）** | — | **立即启动，通常 1~3 周** |
| **H7** | 🧑 手续 | **域名 ICP 备案 + HTTPS 证书 + 生产 API 部署**（供小程序访问） | 你 + 运维 | 可公网访问的 `https://` API 域名 | B2、C5、D、E | 本地用内网穿透/测试域名联调 | **立即启动，1~3 周** |
| **H8** | 🧑 操作 | 微信后台配置**服务器 request 合法域名 / 业务域名** | 你（管理员扫码） | 配置完成截图 | B2 真机、D、E | AI 可先把**域名校验文件**放进静态目录（见 A18） | H7 完成后 |
| **H9** | 🔑 凭据 | **微信支付商户号** + 与 appid 绑定 + **APIv3 密钥 + 商户证书/平台证书** | 你 + 财务 | 商户号、密钥、证书文件 | C1~C4、D 支付 | A13 用假验签器把幂等/金额校验全测完 | 第 2 周内（申请常需 1~2 周） |
| **H10** | 🧑 手续 | **订阅消息模板**申请（预约成功 / 开始前提醒） | 你 | 2 个模板 ID | A12 发送段、B/D | A12 先落授权与字段映射 | 第 3 周 |
| **H11** | 🧑 资源 | **UI 设计稿**（或确认「沿用后台视觉」）；图标 / 门店照片等位图素材（AI 不能生成位图） | 你 | 设计稿或一句「沿用」+ 素材文件 | A16 像素级还原 | A16 用样式变量 + 占位图先把结构做完，并用 `simulator_screenshot` 截图给你看 | 第 1 周 |
| **H12** | 🧑 操作 | **真机验证**（`auto_preview` 推送到开发者微信后由人看手机）；**视觉验收**（看 AI 交的模拟器截图确认） | 你 | 真机问题描述 / 「截图 OK」 | 仅 D1 真机矩阵 | **AI 自行**用 `simulator_screenshot` + `get_simulator_console`/`network` + `automation_*` 跑通界面自证，只在真机差异上找你 | 每轮 UI 交付后（可攒批） |
| **H13** | 🧑 付款 | **真人小额支付验证**（沙箱 1 笔 + 真实 1 笔） | 你 | 支付结果 + 商户后台截图 | C5 收口 | AI 用自造回调报文跑幂等用例 | 第 5 周 |
| **H14** | 🧑 操作 | **体验版内测**（店员 + 2 位真实顾客） | 你 | 反馈清单 | D 收口 | — | 第 6 周 |
| **H15** | 🧑 环境 | **集成测试库可连**（`.env.test` 的 `DATABASE_URL` + MySQL 已启动） | 你 | 「可连」确认或连接串 | **批次 A 全部验收** | — | **立即** |
| **H16** | 🧑 操作 | **提交审核 + 发布**（自建小程序无提审 API，`submitAudit` 属第三方平台/服务商接口，必须人在后台点击） | 你 | 审核结果 | 上线 | AI 负责上传代码（B3）与修驳回问题 | 第 7 周 |
| **H17** | 🧑 决策 | **隐私协议文本**（手机号用途声明）确认 | 你 | 「同意」或改后的文本 | H16 提审 | AI 起草文本 | 第 6 周 |
| **H18** | 🧑 凭据 | **正式小程序 appId**（当前项目绑的是**接口测试号** `wx9f814556a48f60ae`，不能上线）→ 建正式小程序 + 换绑 `project.config.json` | 你 | 正式 appId | **E2 提审（硬门槛）** | 全程用测试号开发与自证，不影响进度 | 第 5 周前 |

> **建议现在就并行启动的 5 件人工事**（都在等外部，不占 AI 产能）：
> H6 备案、H7 域名备案与部署、H5 主体认证、H9 商户号、H1/H2 两个决策 + H15 环境确认。
> **H15 不确认，AI 连批次 A 都验收不了**——这是最该先解决的一条。

---

## 2. 现状核查与缺口

### 2.1 已就绪（P2 不必返工）

| 项 | 证据 | 结论 |
| -- | ---- | ---- |
| app 域模块骨架 | `src/modules/app/`：auth / catalog / member / payments / dto，10 文件 | ✅ |
| 身份表 | `src/database/schema/index.ts:1200` `appWxUsers`（openid 唯一、`customer_id` 可空、软删可恢复） | ✅ 不改表 |
| 独立 token 域 | `app-access-token.guard.ts:65` 要求 `scope==='app'`；app token 故意不写 `username` → 后台守卫自然拒 | ✅ 双向拒绝是硬约束 |
| 未配置凭据可启动 | `app-auth.service.ts:93` → 503「小程序端未启用」 | ✅ 沿用此范式 |
| 环境变量 | `app-config.service.ts:38-39`、`:165-166` | ✅ 已入 Zod |
| app 域限流 | `main.ts:34` 全局 100/min + `app-auth.controller.ts:43` `@RouteConfig` 收紧 10/min/IP | ⚠️ 代码已写，**route 级覆盖是否真生效未经用例证实** |
| Swagger app 分组 | `main.ts:58` 独立 app token scheme | ✅ |
| 501 契约骨架 | member(5) + payments/notify(1) = **6 个端点**（auth/phone 由 A8、member/cards 由 A9、reviews 由 A11 转真实现） | ✅ 形状已冻结 |
| P2 预留字段 | `biz_booking.channel=miniapp`、`status=pending`、`sys_notice_log.channel`、`biz_member_card.card_no`、`biz_service_item.image` | ⚠️ **部分不成立**：`biz_payment.channel` 枚举**没有 `wxpay_jsapi`**（全库检索无此字符串），接 JSAPI 支付**需要迁移**；详见 §2.4 |

### 2.4 纠正一处先前的错误结论（2026-09-11 复核）

之前基于 spec §16.4 / §2529「`biz_payment.channel` 已含 `wxpay_jsapi` 预留值」写下了
「P2 表结构不需再改」。**实测代码与该说法不符**：

- `src/database/schema/index.ts` 的 `biz_payment.channel` 枚举只有
  `wxpay_native / alipay_qr / cash / wechat_offline / alipay_offline / balance / card / credit`；
- 全仓库 `grep wxpay_jsapi` → **0 命中**。

结论：**C1（JSAPI 下单）开工前必须先加一枚迁移**把 `wxpay_jsapi` 加进枚举，
否则预支付单根本落不了库。spec 的这两处描述也要一并修正。

> 教训：spec 里「已预留」这类断言必须落到代码上核对，不能作为排期前提。

### 2.2 缺口（批次 A 要补的，逐条有据）

| # | 缺口 | 证据 | 影响 |
| - | ---- | ---- | ---- |
| G1 | `code2Session` 直连微信域名、无注入点；测试全用 `ctx.appToken()` 直签绕过登录 | `app-auth.service.ts:96-107` | §12 B6 第 1 条验收**完全没自动化** |
| G2 | 「未配置凭据 → 503」分支无用例 | 实现见 `:93` | 环境保障无回归 |
| G3 | openid upsert 幂等（重复/并发登录只一行）无用例 | `app-auth.service.ts:46-64` | §12 B6 第 1 条后半句未验 |
| G4 | ~~9 个 501 骨架只测了 1 个~~ → **已补齐**（实际是 8 个，auth/phone 已转真实现）：`tests/integration/b6-app-contract.int.spec.ts` 的 `SKELETON_ROUTES` 全量覆盖 + 不落库断言 | `b4-b6.int.spec.ts:599-607` | 契约漂移无人拦 → 已拦住 |
| G5 | 骨架条数三处口径不一致：spec §12 说 5 个、§16.1 列 8 个、代码 9 个 | spec:1933 / spec:2201 | 验收扯皮 |
| G6 | slots 一致性断言只在两边**都非空**时才比对，空集静默通过 | `b4-b6.int.spec.ts:585-591` | 「两者一致」没锁住 |
| G7 | 未断言 miniapp 60 分钟提前期 ≠ 后台 0 分钟（spec §5.6 明确不同） | spec:1062-1063、:1071 | 上线后「当天约不了」类投诉 |
| G8 | `/app/member/me` 只测未绑定 401，未测已绑定字段集合与越权 | `b4-b6.int.spec.ts:593-597` | 会员数据越权风险 |
| G9 | 限流与 Swagger 分组无断言 | 无用例 | 安全要求靠人眼；限流可能实际没生效 |
| G10 | app 域写接口只有 `throw 501`，无可测 service 边界 | `app-member.controller.ts:79-198` | P2 落地易另写一套算价 → 口径分裂 |

> **不是缺口、无需返工**：`b4-b6.int.spec.ts:531` 看似没传 token，但 `harness.ts:200-201` 默认注入**后台 token**，所以「后台 token 打 app 域被拒」是真验过的。

### 2.3 需要修的一处事实（与本次核实相关）

线上发布路径分两段，AI 只能做前半段：

| 步骤 | 谁 | 依据 |
| ---- | -- | ---- |
| 上传代码 / 预览 | 🔑 AI 可做（需 H4 上传密钥 + IP 白名单），走 `miniprogram-ci` | [miniprogram-ci 官方文档](https://developers.weixin.qq.com/miniprogram/dev/devtools/ci.html) |
| 提交审核 / 发布 | 🧑 人工在微信后台点击 | 官方 [`submitAudit`](https://developers.weixin.qq.com/doc/oplatform/en/openApi/OpenApiDoc/miniprogram-management/code-management/submitAudit.html) 属**第三方平台（服务商）**接口，自建小程序不适用 |
| 上架前置 | 🧑 **小程序备案**（工信部），未备案不能发布 | [备案为发布硬门槛](https://developer.aliyun.com/article/1524307) |

---

## 3. 执行批次总览

| 批次 | 内容 | 门禁 | 门禁未解除时 |
| ---- | ---- | ---- | ------------ |
| **A** | B6 收口 + 9 个写接口真实现 + 前端工程与页面（离线可验证的全部） | 仅 H1/H2/H15 | 后端可先走，前端等 H1 |
| **B** | 真微信通道接入（登录/手机号）+ CI 上传 | H3、H4、H7、H8 | A1 的 FakeProvider 顶上 |
| **C** | 微信支付 JSAPI 全链路 | H9 | A13 的假验签器顶上 |
| **D** | 真机矩阵 / 弱网 / 内测 | H12、H13、H14、H8 | 开发者工具模拟器 |
| **E** | 上传 → 提审 → 发布 | H5、H6、H16、H17 | — |

---

## 4. 批次 A：🤖 AI 现在就能做完（零外部依赖）

> 唯一环境前提：**H15 集成测试库可连**。若 H15 未确认，AI 先做 A15~A17 前端泳道 + 代码静态验证。

### 4.1 后端泳道（A1~A14，串行）

| # | 任务 | 产出物 | AI 自证方式 | 门 |
| - | ---- | ------ | ----------- | -- |
| **A1** | 把 `code2Session` 抽成端口 `WxMiniappProvider`，并加测试用 `FakeWxMiniappProvider`（**仅测试环境可注入**，生产关闭） | `src/modules/app/auth/wx-miniapp.provider.ts` + 模块注入开关 | `bun run typecheck`；测试里注入固定 `code→openid` 映射 | 🤖 |
| **A2** | 补登录用例（G1/G2/G3） | `tests/integration/b6-miniapp.int.spec.ts` | ① 测试 code 换到 app token；② 同 openid 重复登录**查询 `COUNT(*)=1`**；③ 并发 10 次首登仍 1 行；④ 未配置凭据 → **503「小程序端未启用」** | 🤖 |
| **A3** | 6 个 501 骨架用例 + 不落库断言（G4）✅ 已完成 | `tests/integration/b6-app-contract.int.spec.ts` | 6 个端点全 **501**；调用前后 6 张表行数不变；非法入参仍是 400 | 🤖 |
| **A4** | 收紧 slots 一致性断言 + 提前期口径（G6/G7） | 改 `b4-b6.int.spec.ts:574-591` | 「app 时段集合 ⊆ 后台时段集合」**空集也断言**；并断言 app 侧确实应用 60 分钟提前期、后台为 0 | 🤖 |
| **A5** | `/app/member/me` 已绑定字段集合 + 越权用例（G8） | 同上 | 字段集合字面量锁定（无成本/`createdBy`/内部备注）；换 openid 查不到他人数据 | 🤖 |
| **A6** | 限流与 Swagger 分组断言（G9） | 同上 | 登录第 11 次 → **429**；`swagger.json` 中 app 端点带 `app` tag | 🤖 |
| **A7** | 修 spec 骨架条数口径（G5） | spec §12 B6 与 §16.1 | 两处均为 **6 条**且与代码一致（auth/phone、member/cards、reviews 转真实现后移出骨架清单） | 🤖 |
| **A8** | `/app/auth/phone` 真实现（替换 501） | `app-auth.service.ts` + 控制器 | `getPhoneNumber` code 换号 → 按 §4.3 匹配 `biz_customer`（命中软删走「恢复」）→ 回填 `app_wx_user.customer_id` + `phone`；集成用例含「手机号属他人 openid 仍可绑定」 | 🤖 |
| **A9** | `/app/member/cards` 真实现 ✅ 已完成 | `app-member.service.ts` + `MemberCardPort.listByCustomer` | 仅本人卡；状态按「到店是否真能用」现算（与 `assertUsable` 同规则，不依赖定时任务）；字段 7 个、无成本/备注；分页 + 状态过滤；集成 3 条 | 🤖 |
| **A10** | `/app/bookings` GET/POST + `/:id/cancel` 真实现 | app 域 service + 控制器 | **复用后台算法**；落 `channel=miniapp`+`status=pending`；**未绑定手机号拒单**；服务端重算金额；列表 `{items,page,pageSize}` 无 `total`；**并发 10 单同美甲师同段 → 恰好 1 成功**；仅本人可取消 | 🤖 |
| **A11** | `/app/reviews` 真实现 ✅ 已完成（H2 未定，按「都做」预留结构执行） | `app-member.service.ts` + `ReviewPort.createForCustomer` | 仅本人（归属按预约事实校验 → 他人单 403）+ 仅已完成（未完成 400）；**一单一评**（二次 409）；`customer_id`/`staff_id` 由预约事实带出；集成 3 条 | 🤖 |
| **A12** | `/app/subscribe` 真实现 | ✅ 已完成（2026-09-11） | **偏离原方案**：不塞 `sys_notice_log`（它是「已发生的一次发送」的日志，会污染发送统计），改为新表 `app_wx_subscribe_grant`，按 `(app_wx_user_id, template_id)` 唯一 + `granted_count` 累加额度；`bookingId` 他人单 403 / 不存在 404；未绑定 401 + `needBind`；集成 3 条。**发送段仍等 H10 模板 ID**（届时补：模板 ID 映射、额度消费、`granted_count` 扣减）。取舍见交接文档 D12 |
| **A13** | 支付回调业务层（幂等 + 金额校验 + 同事务发货）用**假验签器**实现 | `app-payments.service.ts` + 注入的 verifier 端口 | 自造回调报文：重放 3 次只生效 1 次；金额不符 → 拒 + 写 `callback_invalid`；关单后回调不改账 | 🤖 |
| **A14** | `app_wx_user_bind_log` 表 + 迁移（若 H2 选做） | schema + `bun run db:generate` 产物 | 换绑留痕：换绑前后 `customer_id`、时间、来源；**只追加不删** | 🤖 |

### 4.2 前端泳道（A15~A17，门 H1）

| # | 任务 | 产出物 | AI 自证方式 | 门 |
| - | ---- | ------ | ----------- | -- |
| **A15** | 建 `miniapp/` 工程（**已由人建好**：原生 TS 模板）→ 按业务改造：请求层（baseURL / Bearer 注入 / 401 清 token）/ 登录态静默续期 / 环境配置 | `miniapp/` 业务骨架 | `typecheck` + `lint` 过；401 带 `needBind` → 跳绑定流程 | 🤖 |
| **A16** | 页面全套：首页 / 项目列表+详情 / 美甲师 / 选时段 / 确认页 / 我的预约 / 会员中心 / 支付页 / 评价 / 会员码 | 页面代码 | 结构完整、三态（加载/空/错）齐全；**每条页面用 §0.3 的 `simulator_open_page` + `simulator_screenshot` + `get_simulator_console` 自证后交人看截图**；样式走变量、图片用占位（等 H11 素材） | 🤖 + 🧑 H11 素材 |
| **A17** | 前端单测：算价展示（分→元）、状态文案映射、提交幂等键 | 单测文件 | 用例全过；算价明细与后端口径一致（折扣/积分抵扣/应付逐项） | 🤖 |
| **A18** | 把微信**域名校验文件**接入静态目录（等 H8 时人只需点一下） | 静态路由/目录 | 本地 `GET /<校验文件名>` 返回文件内容 | 🤖 |
| **A19** | **封装 devtools 自证脚本** `scripts/devtools.mjs`：绝对路径调用 `wechatide.cmd` + 首次授权轮询 + 一键「编译→跳页→截图→拉 console/network」 | 脚本 + 用法注释 | 一条命令产出「截图路径 + console 报错清单」，供每条前端任务复用 | 🤖 |

---

## 5. 批次 B：🔑 真微信通道接入（门 H3/H4/H7/H8）

| # | 任务 | 产出物 | AI 自证方式 | 门 |
| - | ---- | ------ | ----------- | -- |
| **B1** | 真 `WxMiniappProvider`：`code2Session` + 手机号 code 换取 + 微信错误码映射（`errcode` 分类到 400/401/503） | 生产实现 | 用 H3 凭据调通真 code；错误码用例覆盖 `40029`/`45011` 等 | 🔑 H3 |
| **B2** | 登录/绑定端到端（真机 code） | 联调记录 | 真机登录 → 授权手机号 → 命中/创建顾客 → `/app/member/me` 返回真实数据 | 🔑 H3 + 🧑 H12 + H7 |
| **B3** | `miniprogram-ci` 接入：`preview` / `upload` 脚本 | `scripts/miniapp-ci.*` | 脚本跑通上传成功；**IP 白名单**与密钥路径写入文档（不落 git） | 🔑 H4 |

---

## 6. 批次 C：🔑 微信支付 JSAPI（门 H9）

| # | 任务 | 产出物 | AI 自证方式 | 门 |
| - | ---- | ------ | ----------- | -- |
| **C1** | `POST /app/payments/wxpay/jsapi` 真实现：预支付下单 + 客户端签名 | app payments service | 返回 `{paymentId,timeStamp,nonceStr,package,signType,paySign}`；`channel=wxpay_jsapi` | 🔑 H9 |
| **C2** | 把 A13 的假验签器换成**真实验签**（APIv3 证书 + 报文解密） | verifier 生产实现 | 用真实回调报文验签通过；篡改报文被拒 | 🔑 H9 |
| **C3** | 主动查单 + 关单兜底 + 定时任务 | service + job handler | 5 分钟未付自动关单；关单后回调不改账且不静默入账 | 🔑 H9 |
| **C4** | 支付页 + 拉起支付 + 结果轮询 | 页面 | 支付成功 → 预约已付口径；中途退出可从「我的预约」继续付 | 🤖 |
| **C5** | 真机支付验证收口 | 联调记录 | 沙箱 1 笔 + 真实 1 笔留痕；后台发起退款能原路退回 | 🧑 H13 |

---

## 7. 批次 D / E：🧑 真机、内测、提审、发布

| # | 任务 | 产出物 | 谁 | 门 |
| - | ---- | ------ | -- | -- |
| **D1** | 真机矩阵（iOS/Android 各 2 机型）+ 弱网/超时/失败重试提示 | 测试记录 | 🧑 H12 配合，AI 修 | 🧑 |
| **D2** | 体验版内测（店员 + 2 位顾客） | 反馈清单与处置 | 🧑 H14，AI 修 | 🧑 |
| **E1** | 上传代码（AI 执行 `miniprogram-ci`） | 上传成功记录 | AI + 🔑 H4 | 🔑 |
| **E2** | 提交审核（人工点击）+ 按驳回意见修订 | 审核通过 | 🧑 H16，AI 修问题 | 🧑 |
| **E3** | 发布 + 监控（app 域 4xx/5xx、登录失败率、支付成功率）+ 回滚预案 | 监控面板 + 一键回滚到「仅浏览」最小集 | AI 备机制，🧑 H16 发布 | 🧑 |

---

## 8. 🤖 AI 完成判据（每个任务收口都要过）

| 项 | 判据 |
| -- | ---- |
| 编译 | `bun run typecheck` 退出码 0 |
| 风格 | `bun run lint` 退出码 0 |
| 测试 | `bun run test` 全过；**新增验收点必须落成集成用例**，不接受「手测通过」 |
| 契约 | 9 个接口路由/入参/出参形状与 spec §9.7 一致（有 diff 则先改 spec） |
| 迁移 | 新表有 `db:generate` 产物，无手写 SQL |
| 隔离 | app 域 4 条隔离要求逐条自查通过 |
| 钱 | 触钱改动 `money-invariants` 红线逐条自检通过 |
| 记录 | commit message 带任务号；涉真机的附 H12/H13 反馈截图路径 |
| 界面 | 前端任务必须**在模拟器实跑自证**（§0.3）：`simulator_open_page` 编译跳页 → `simulator_screenshot` 出图 → `get_simulator_console`/`get_simulator_network` 无未处理报错，再交人看截图 |

---

## 9. 阻塞降级策略（AI **不得**因缺外部凭据停工）

1. **一切外部通道走端口**：微信登录 / 手机号换取 / 支付下单 / 回调验签各一个 Provider，配置缺失时返回**明确的「未启用」**而非崩溃（沿用 §16.1 既有范式）。
2. **先做可离线验证的一半**：业务逻辑 + 幂等 + 金额校验 + 事务发货全部用假 Provider 写完整集成用例，真 Provider 只换实现，不改调用方。
3. **禁止绕道**：不硬编码 openid/商户号、不跳过验签、不把假 Provider 接进生产分支（测试注入开关必须只在测试环境生效并有代码注释说明）。
4. **拿不到凭据就升级给人**：输出「需要哪个 H 编号的什么交付物」后，转做其它可做任务，不要停在半成品状态。
5. **真机类工作批量做**：把所有待人工预览/付款的项攒成一个清单再一次请人做，减少人工介入轮次（H12/H13/H14 尽量各 1~2 轮）。

---

## 10. 风险与应对

| 风险 | 影响 | 应对 |
| ---- | ---- | ---- |
| **H6 小程序备案慢**（1~3 周） | **阻塞发布**，不阻塞开发 | 立刻启动；期间完成 A~D 批次与体验版内测 |
| H15 测试库不可连 | 批次 A 无法验收 | 最高优先解决；否则 AI 只能交代码不能自证 |
| app 域另写一套算价 | 前后台金额口径分裂 | A10 强制复用后台 service；review 检查 app 域无 `biz_*` 金额计算 |
| 回调验签/幂等不到位 | 重复入账/漏单 | A13 三条用例设为门禁；上线前用 C2 真验签再跑一遍 |
| 会员数据越权 | 换 openid 看到他人数据 | 所有 app 查询强制 `customer_id = 当前绑定顾客`；A5 + A10 各一道用例 |
| 60 分钟提前期引发「当天约不了」 | 顾客投诉 | 空时段给明确 `reason`；`sys_config` 可调；A4 把口径钉死 |
| 提审被拒 | 上线延迟 | E2 预留返工轮次；H17 隐私协议提前定稿 |

---

## 11. 请人现在回复（最小启动集）

**已自动解除的**：H1 选型（脚手架已建 = 原生 TS）、H3 的 AppID（`wx9f814556a48f60ae` 测试号）、登录态（已登录免扫码）。

剩下只需回这几条：

1. **H15**：集成测试库能连吗？（`bun run test` 现在能不能跑通集成用例）——**这条不定，AI 只能交代码不能自证**。
2. **H2**：P2 范围与「JSAPI + 订阅消息是否本期上」？（建议：会员码 + 评价做，自助改期后置；JSAPI 上，订阅消息申请 2 个模板）
3. **H3 补 + H4**：测试号的 AppSecret（后台复制）；代码上传密钥 + IP 白名单。
4. **H6 / H7 / H5 / H18**：小程序备案、域名 ICP 备案与生产 HTTPS、主体认证、**正式 appId** —— 分别什么状态？（这四条共同决定**上线日**）
5. **H9**：微信支付商户号 + APIv3 证书 —— 能不能拿到，什么时候？
6. **H11**：有 UI 设计稿吗？没有的话是否同意「沿用后台视觉 + AI 占位图」？
7. **一次性授权**：我要用 `wechatide` 驱动开发者工具时，IDE 里会弹授权，**每个 client 点一次**即可（`ide`、`project-manager` 已授权）。

> 只要 **H15** 解除，AI 即可按「后端泳道 A1→A14、前端泳道 A15→A19」两路并行全速开工，**前端泳道全程不需要你介入**（自证靠模拟器截图 + console/network），直到 B/C 批次的凭据门。

---

## 12. 需求变更：美甲师工作台（2026-09-11 追加）

### 12.1 为什么这不是「加两个页面」

原设计里 app 域是**纯顾客域**：只有「本人数据」，不接 RBAC（§8.3）。而「美甲师看自己的预约与业绩」
要求同一套 `/app/**` 同时承载**第二种身份**，并且其中「点完成」会**触发提成计提**（§20.3）。
处理不当有两种坏结果：要么破坏 §8.3 的双向隔离，要么让 app 域自己 UPDATE 预约表而漏掉计提。

### 12.2 已确认的决策（你已拍板）

| # | 决策 | 选定 |
| - | ---- | ---- |
| D8 | 美甲师工作台如何开通 | **手机号匹配 + 店长后台确认一次** |
| D9 | 提成可见性 | **逐单明细全见** |
| D10 | 美甲师能否改预约状态 | **允许点「到店」与「完成」** |
| D11 | 顾客手机号 | **默认脱敏 + 拨号按钮**（`wx.makePhoneCall`） |

### 12.3 身份与授权模型

- **不进 token**：token 仍只承载「哪个微信身份」（`sub` = `app_wx_user.id` + `openid` + `scope:'app'`）。
  角色每请求从库取：`app_wx_user.staff_status='active'` **且** `biz_staff.status='active'`。
  理由：① 停用/撤权在下一次请求立即失效，而 token 里的角色要等过期；② 双身份天然支持
  （同一个人可以既是顾客又是美甲师）；③ 客户端无从伪造。
- **开通流程**：手机号命中 `biz_staff.phone` → `staff_status='pending'` → 店长确认 → `'active'`。
  **绝不自动开通**：§16.2 允许「手机号属于他人 openid 也允许绑定」，仅凭手机号提权 = 提权漏洞。
- **数据改动**（迁移已生成 `20260911055121_clear_warhawk`）：`app_wx_user` 增
  `staff_id` / `staff_status(none|pending|active|rejected)` / `staff_requested_at` /
  `staff_decided_at` / `staff_decided_by` + `idx_wx_staff` + FK(`ON DELETE SET NULL`)。

### 12.4 三条硬约束（写码前先看）

1. **app 域的写操作必须调用既有动作 service**（`BookingService` 的到店/完成），
   **禁止**在 app 域自己 `UPDATE biz_booking.status` —— 否则漏掉：提成逐项计提、`visit_count` /
   `last_visit_at` 累加、条件更新 + `affectedRows` 幂等闸门。
2. `/app/staff/**` 一律 `staff_id = 当前绑定美甲师`，**不提供任何跨美甲师查询**（含排行榜）。
3. 「完成」加时间护栏：**不得早于 `start_at`** 标记完成，防止提前刷提成；
   违规返回 400 并留痕。（若要更松，需你明确。）

### 12.5 接口清单（需同步写入 spec §9.7）

**美甲师侧（`/app/staff/**`，全部仅本人）**

| 方法 | 路径 | 说明 |
| ---- | ---- | ---- |
| POST | `/app/staff/apply` | 手机号匹配美甲师档案 → 置 `pending`，返回待确认 |
| GET | `/app/staff/me` | 我的档案 + 授权状态 |
| GET | `/app/staff/bookings?date\|status` | 我的预约（顾客姓名 + **脱敏手机号** + 项目快照） |
| GET | `/app/staff/schedule?date` | 我今天的班次与日期例外（`off`/`custom`） |
| GET | `/app/staff/performance?period` | 完成单量 / 实收分摊 / 提成（逐单明细，按 `accrued\|settled\|reversed` 分列）/ 平均评分 |
| GET | `/app/staff/reviews` | 我的评价（§20.1：美甲师只能看自己的评价） |
| POST | `/app/staff/bookings/:id/arrived` | 点「已到店」→ 调既有动作 service |
| POST | `/app/staff/bookings/:id/complete` | 点「完成」→ 调既有动作 service（**触发计提**），带 §12.4-3 护栏 |

**店长侧（后台 `/biz/app-staff-grants`，权限点 `biz:staff:grant`）**

| 方法 | 路径 | 说明 |
| ---- | ---- | ---- |
| GET | `/biz/app-staff-grants?status=pending` | 待确认的开通申请（含 openid 昵称、匹配到的美甲师、申请时间） |
| POST | `/biz/app-staff-grants/:id/approve` | 通过 → `active`，写 `staff_decided_by/at` |
| POST | `/biz/app-staff-grants/:id/reject` | 驳回 → `rejected`，写原因 |

### 12.6 任务模块（AI 执行粒度，按依赖排序）

| # | 模块 | 内容 | 门禁 |
| - | ---- | ---- | ---- |
| **S1** | 身份与授权 | 迁移（✅ 已完成）；`WxMiniappProvider` 端口加「手机号 code 换取」；`/app/auth/phone` 真实现（匹配/创建顾客 + 探测美甲师档案）；`/app/staff/apply`；staff 作用域校验（每请求查库） | 🔑 H3（真链路要 AppSecret；假 Provider 可先全测） |
| **S2** | 店长确认 | 三个后台接口 + 权限点 `biz:staff:grant` 入 `seed/menus.ts` + 一个后台页面 | 🤖 |
| **S3** | 美甲师只读接口 | me / bookings / schedule / performance / reviews；全部 `staff_id` 限定；字段用 Zod schema 断言（无成本、无其他美甲师数据） | 🤖 |
| **S4** | 美甲师写接口 | arrived / complete → **复用既有动作 service**；补幂等重放、越权（改他人单）、时间护栏用例 | 🤖（触钱，先加载 `money-invariants`） |
| **S5** | 小程序端 | 顾客/工作台模式切换；工作台（今日日程 + 业绩卡）、我的预约、业绩明细、我的评价页；手机号脱敏 + 拨号 | 🤖（自证靠 `simulator_screenshot` + console） |

### 12.7 人工门禁增补

| ID | 类型 | 事项 | 卡住 |
| -- | ---- | ---- | ---- |
| **H19** | 🧑 决策 | 店长确认入口放在**后台页面**（推荐，复用 RBAC 与菜单）还是**小程序内**（店主也用小程序）？ | S2 的形态 |
| **H20** | 🔑 凭据 | 同 H3：`/app/auth/phone` 真链路需要 AppSecret；没有它 S1 只能用假 Provider 自证 | S1/S5 真机联调 |

> **S1 的另一半（顾客侧手机号绑定）本来就是批次 A8 的内容**，本次变更把它提前成 S1 的前置，
> 因为「美甲师开通」必然先要拿到手机号。
