---
title: 踩坑记录与排查手册
---

# 踩坑记录与排查手册

本页把 `project-design/pitfalls/{server,web,miniapp,tooling}.md` 整理成**按症状检索**的手册，
并补上源码注释与集成测试里发现的问题。**每一条都是真踩过的**（来源标在条目末尾）；
本文末尾单独有一节「预防性检查清单」，那里才是推断，且已明确标注。

::: tip 怎么用
**先按症状定位**：不知道是哪一端，就先看下面的分诊表。
**改了代码再回头扫一眼**对应小节：绝大部分坑是"改一次代码就会再犯一次"的类型。
:::

## 分诊表

| 你看到的现象                                     | 大概率是哪一类               | 跳到                                        |
| ------------------------------------------------ | ---------------------------- | ------------------------------------------- |
| 迁移报 `Invalid default value`、`already exists` | 服务端 · 迁移                | 服务端 S1                                   |
| 接口返回 500，但期望 409                         | 服务端 · 错误链              | 服务端 S2                                   |
| 服务起不来，`Nest can't resolve dependencies`    | 服务端 · DI                  | 服务端 S3                                   |
| 图片能 200 但页面空白                            | 服务端 CORP / 小程序相对路径 | S10、M14、M15                               |
| 新接口 404，页面却"看起来正常"                   | 服务端 · 进程没重启          | 服务端 S7                                   |
| 一券多用 / 一单两卖                              | 服务端 · 缺条件更新          | 服务端 S8                                   |
| 契约测试全绿但线上行为不对                       | 服务端 · mock 分叉           | 服务端 S11                                  |
| 刷新页面 404 / 动态路由丢失                      | 后台前端 · 路由              | 后台前端 W6                                 |
| 列表分页拿不到总数                               | 后台前端 · `useTable`        | 后台前端 W5                                 |
| 编辑弹窗回填不进去 / 第一次点不开选项            | 后台前端 · lew-ui 受控组件   | 后台前端 W14                                |
| 控制台刷 `schema does not contain the path`      | 后台前端 · 表单规则          | 后台前端 W3                                 |
| 小程序真机连不上后端                             | 小程序 · 网络与白名单        | M24、M25                                    |
| 小程序页面全白 / 语法错误                        | 小程序 · 导入与编译目标      | M3、M10                                     |
| 小程序图标或图片空白但无报错                     | 小程序 · 渲染规则            | M2、M14、M15                                |
| TabBar 切不动 / 高亮错位                         | 小程序 · 自定义 TabBar       | 小程序 M16                                  |
| 轮播图上某一片区域划不动                         | 小程序 · swiper 与浮层       | 小程序 M27                                  |
| 点卡片里的按钮却跳进了详情页                     | 小程序 · 事件冒泡            | 小程序 M28                                  |
| 报表某个页签整列 ¥0.00 / 行集取错                | 后台前端 · 宽松响应归一      | 后台前端 W16                                |
| 改了代码不生效、一直报 `X is not defined`        | 工具链 · 开发者工具缓存      | 工具链 T13                                  |
| 命令没有输出、文件一个字没改                     | 工具链 · PowerShell          | 工具链 T3                                   |
| 单文件跑绿、全量跑红                             | 工具链 · 全局 mock 污染      | [测试策略与验收标准](/quality/)「禁止事项」 |

---

## 一、服务端（NestJS / Drizzle / MySQL）

- **S1 · 迁移默认值 `DEFAULT (CURRENT_TIMESTAMP)` 炸在半应用状态**
  - **症状**：`bun run db:migrate` 报 `ERROR 1067 (42000): Invalid default value for 'created_at'`；**重跑也过不去**（表已建出，卡在后面的 `CREATE INDEX`）。
  - **原因**：当前 drizzle 版本把 `auditColumns` 的时间列默认值渲染成**带括号的表达式默认值**（`DEFAULT (CURRENT_TIMESTAMP)`）；MySQL 8 建表时**接受**，随后**重建表**的语句才严格拒绝 —— 延迟爆炸，且 **DDL 不回滚**，`__drizzle_migrations` 也没记账。
  - **处置**：迁移尚未成功执行前直接把 SQL 改成 `DEFAULT CURRENT_TIMESTAMP`（安全，因为 drizzle 只在成功后才记 hash）；已经半应用就先查 `__drizzle_migrations` 与表结构，手工补齐缺的索引再继续。
  - **预防**：每次 `db:generate` 后**肉眼扫一遍新 SQL**；根治方向是把 `auditColumns` 时间列改成 `.defaultNow()`（待做，注意要回归全部历史迁移）。（来源 `pitfalls/server.md` §1、`HANDOVER-miniapp.md` §8）
- **S2 · drizzle 的错误在 `cause` 链里，只看顶层 message 会把 409 变成 500**
  - **症状**：插入同名记录返回 **500**，期望 409。
  - **原因**：drizzle 把 mysql2 错误包成 `DrizzleQueryError`，顶层 `message` 只有 `Failed query: insert into ...`，**约束名与 errno 都在 `error.cause` 里**。
  - **处置**：沿 `cause` 链（最多 5 层）拼文本，再匹配约束名 / `ER_DUP_ENTRY` / `1062`。
  - **预防**：任何"唯一冲突转 409"的代码必须先抽 `cause` 文本；集成测试要覆盖"同名 → 409"。（来源 `pitfalls/server.md` §2、`HANDOVER-miniapp.md` §12.3）
- **S3 · `@Global()` 模块的 provider 仍须显式 `exports`**
  - **症状**：加了新端口绑定后服务**起不来**：`Nest can't resolve dependencies of the XxxService (..., ?)`。
  - **原因**：`BizModule` 是 `@Global()`，但全局模块的 provider 只有写进 `exports` 才能被别的模块注入；只在 `providers` 里绑 `XxxPort`、漏了 `exports` 就会这样。
  - **处置**：端口绑定三件套一起改 —— `import` / `providers` 绑定 / **`exports`**。
  - **预防**：**`typecheck` 是绿的，只有真启动一次才暴露**；改 `ports.ts` 后必须 `bun run dev` 起一次。（来源 `pitfalls/server.md` §3）
- **S4 · `exactOptionalPropertyTypes: true`：可选属性要显式写 `| undefined`**
  - **症状**：`Argument of type '{ status?: "a" | "b" | undefined }' is not assignable to parameter of type '{ status?: "a" | "b" }'`。
  - **原因**：tsconfig 开了 `exactOptionalPropertyTypes`，`?:` 与 `?: T | undefined` 不等价。
  - **处置**：被传入的可选属性一律写全 `status?: 'a' | 'b' | undefined;`。
  - **预防**：定义"会往下传"的 DTO/filter 类型时**默认写全**，别等 tsc 报。（来源 `pitfalls/server.md` §4）
- **S5 · 改建单服务前先读清「两条路径 + 四个算价点」**
  - **症状**：以为改一处即可，实际 `bookings.service.ts` 有 **1776 行**、**四个 `this.buildQuote(` 调用点**、**两条建单路径**，且两条路径**入参字段名不同**（biz 层是 `pointsUsed`，app 那条是 `pointsToUse`）。
  - **原因**：后台建单与 app 自助建单共用同一 service，但走不同入参类型。
  - **处置**：改前先数调用点（`Select-String 'this\.buildQuote\('`）；只有 app 建单需要接券，改期/结算沿用原单。
  - **预防**：动这种"共用入口"前先把调用点与字段名列成表，再动手。（来源 `pitfalls/server.md` §5、`HANDOVER-miniapp.md` §10）
- **S6 · 测试清库：`TRUNCATE` 是 DDL，比 `DELETE` 慢 73 倍**
  - **症状**：整套集成测试 **~530 秒**，单个用例 3~4 秒。
  - **原因**：`resetBusinessData()` 每个用例前清 37 张表，用 `TRUNCATE`（InnoDB 的 TRUNCATE = DROP + CREATE **重建表**，约 100ms/张）→ 单次 4 秒；而这些表在用例结束时空着，`DELETE` 只要约 1.5ms/张。
  - **处置**：改用 `DELETE FROM`（**代价**：不重置 `AUTO_INCREMENT`，用例一律用 `insertId`）；整个 reset 必须在**同一条连接**上跑完（`SET FOREIGN_KEY_CHECKS` 是会话级，连接池有 10 条连接，`pool.query` 可能换连接 → 那句 SET 形同虚设）。
  - **预防**：效果实测 **530 秒 → 18 秒**；新写清库逻辑一律遵守"单连接 + DELETE"。（来源 `pitfalls/server.md` §6、`tests/integration/harness.ts`）
- **S7 · 加了后端路由必须重启服务**
  - **症状**：新接口返回 **404**，而前端把 404 静默降级，**页面看起来完全正常**。
  - **原因**：`bun run start` = `bun src/main.ts`，**不带 watch**，进程还是旧代码。
  - **处置**：开发期用 `bun run dev`（`bun --watch src/main.ts`）；验证脚本的**第一步**就写"重启后端"。
  - **预防**：不要靠记性 —— 本项目为此白排查了 4 次。（来源 `pitfalls/server.md` §7、`HANDOVER-miniapp.md` §11.5）
- **S8 · 券核销：只有条件更新能防「一券多用」**
  - **症状**：并发用同一张券下单时出现"一券两单"。
  - **原因**：「先查再判断再写」在并发下必然失效。
  - **处置**：闸门是**条件更新**（`WHERE id=? AND customer_id=? AND status='usable' AND used_booking_id IS NULL`），`affectedRows=0` → 409，且**必须与建单同事务**（否则会出现"券核销了单没建成"或"单建成了券还能再用"）；`previewForBooking`（算价用）**只读、不是闸门**。
  - **预防**：MySQL 没有部分唯一索引 → "同一顾客同一模板只能有一张**未使用**的券"只能用**行锁**（`SELECT ... FOR UPDATE`）串行化。（来源 `pitfalls/server.md` §8、`HANDOVER-miniapp.md` §11.3）
- **S9 · 「渠道下单」曾经在事务里（已于 2026-09-12 修复，留档）**
  - **症状**：`PaymentsService.createInTx(tx, draft)` 在调用方事务**内部**调 `provider.createNativeOrder()`（网络 IO，超时 5s）；事务期间持有连接池连接与行锁。
  - **原因**：`out_trade_no` 是**主键回填**生成的（`buildOutTradeNo('P', id, now)`），渠道下单必须等支付单 insert 拿到 id 之后才能调。
  - **处置（修复后的形态）**：`PaymentDraft` 增加 `channelOrder`；调用方**在事务外**先 prepare（三个循环点：预约建单、结算、销账），事务内把 `channelOrder` 传进 `createInTx`；在线渠道交易号改用 `buildOutTradeNoByToken('P')`（与主键无关）；`createInTx` 对"在线渠道但缺 `channelOrder`"**直接报错**，防止有人把渠道调用悄悄塞回事务。
  - **预防**：**必须保留**"渠道未配置 → 抛错回滚、不留 pending 单"的现有行为（`b3-online-settle.int.spec.ts` 盯着它）；代价是事务回滚时渠道侧留一张没人见过的待支付单，5 分钟后自然过期。（来源 `pitfalls/server.md` §9）
- **S10 · helmet 的 `Cross-Origin-Resource-Policy: same-origin` 会把「图片能被跨源嵌入」堵死**
  - **症状**：图片地址 `200 / image/png`（`Invoke-WebRequest` 完全正常），但**小程序 `<image>`、异源后台 `<img>` 一律空白**，客户端几乎没有可用报错。
  - **原因**：`main.ts` 里 `await app.register(helmet)` 用默认值，于是**每一条响应**都带 `CORP: same-origin`。`<img>` 跨源加载**不需要 CORS**，但 **CORP 正是用来拦它的**。web 后台走 vite 代理是**同源**，所以一直没暴露。
  - **处置**：**只**在文件下载这一条响应上覆盖为 `cross-origin`（`files.controller.ts` 的 `download()`，该接口本就 `@Public` + 随机 UUID 文件名）；**不要**改全局 helmet 配置 —— 其余 API 的 `same-origin` 是有效的纵深防御。
  - **预防**：helmet 在 `onRequest` 阶段写头，handler 里 `reply.header()` 后写即覆盖；端到端要用**异源页面**实测（同源测不出来）。（来源 `pitfalls/server.md` §10、`pitfalls/miniapp.md` §15）
- **S11 · 契约类断言只测 mock：mock 与真实实现分叉时没人会发现**
  - **症状**：`PaymentsService` 的 spec 全绿，但"微信回调失败必须回 4xx"这条**红线实际是错的** —— mock 的 `failureReply` 返回 500，真实 provider 返回的是 **200**。
  - **原因**：断言只落在 mock 上，mock 的返回值是**人写的**，与实现自然分叉。
  - **处置**：契约类（状态码、应答体、字段集合）断言**落到真实实现**上：`channel-reply.spec.ts` 直接把两个渠道的状态码钉死，并显式固定「微信 ≠ 支付宝」（微信失败回 4xx、支付宝失败**仍是 200 + 文本 `failure`**，因为支付宝靠响应体决定是否重投）。
  - **预防**：凡是"外部世界的约定"（HTTP 状态码、报文格式、字段白名单），测试对象必须是真实现。（来源 `src/modules/biz/payment/channels/channel-reply.spec.ts` 文件头注释）

---

## 二、后台前端（Vue 3 + lew-ui + Vite）

- **W1 · `useTable` 按 URL 取数 —— 不要再引一个 `listXxx`**
  - **症状**：`vue-tsc` 报 `TS6133: 'listCouponTemplates' is declared but its value is never read`。
  - **原因**：`useTable({ url })` 自己按 URL 发请求，页面通常**不需要**再 import 那个 `listXxx`。
  - **处置**：列表页只 import `create/update/delete`；`listXxx` 留给别的调用方。
  - **预防**：写新列表页时先看既有页面（如券模板页）的 import 清单。（来源 `pitfalls/web.md` §1，实测）
- **W2 · 类型要从 `lew-ui` 显式 import**
  - **症状**：`TS2304: Cannot find name 'LewFormOption'`。
  - **原因**：组件与类型是两条 import 通道，组件 import 了不代表类型也有。
  - **处置**：`import type { LewFormOption, LewTableColumn } from 'lew-ui';`
  - **预防**：给现有页面加弹窗/表格时，先补类型 import 再写代码。（来源 `pitfalls/web.md` §2，实测）
- **W3 · `formOptions` 必须用 `withPassThroughRule(...)` 包一层**
  - **症状**：控制台刷 `Uncaught Error: The schema does not contain the path: xxx`。
  - **原因**：`LewForm` 只把**带 `rule` 的字段**放进 yup schema，而 `LewFormItem` 的字段级校验走 `Yup.reach(formSchema, field)`，path 不存在时**同步抛错**（它只挂了 `.catch()`，接不住同步异常）。触发条件是「非必填 **且** 当前值为真值」——**空数组 `[]` 也是真值**。
  - **处置**：`import { withPassThroughRule } from '~/utils/form';` 然后 `const formOptions = withPassThroughRule([...])`；模板里内联的 `:options="withPassThroughRule([...])"` 也要包。
  - **预防**：写新页面时**直接包上，别等报错**。（来源 `pitfalls/web.md` §3，技能 + 实测）
- **W4 · 「类型过了 ≠ 页面真的被引用」**
  - **症状**：`vue-tsc` 通过、`oxlint` 0 问题，但页面在新路由下打不开。
  - **原因**：页面可能没被菜单/路由引用到，类型检查**不会**报这种问题。
  - **处置**：`bun run build` 后**在产物里找页面独有的中文串**验证它真进了 bundle：

    ```bash
    cd web && bun run build
    grep -l '优惠券模板' ../output/web/assets/*.js
    ```

  - **预防**：web 验证固定套路 = typecheck → lint → build → **产物找串**。（来源 `pitfalls/web.md` §4，实测）
- **W5 · 列表响应没有总数（没有 `total` 字段）**
  - **症状**：分页拿不到总数。
  - **原因**：后端列表统一返回 `{ items, page, pageSize }`，**没有 `total`**。
  - **处置**：用 `useTable`（它多取一条判断 `hasMore` 并估算总数），**不要自己写分页组件**。
  - **预防**：这是全项目口径（README 的"贯穿全项目的口径"一节也有），新接口也不要加 `total`。（来源 `pitfalls/web.md` §5、`web/src/composables/useTable.ts`）
- **W6 · 菜单驱动路由：不要手改路由表**
  - **症状**：刷新页面后动态路由丢失、命中兜底路由导致 404；或手加的路由与菜单生成的路由冲突。
  - **原因**：路由由 `permissionStore.generateRoutes()` 从菜单数据生成，在 `router.beforeEach` 里注册；`dynamicRoutesAdded` 是模块级标志，**刷新后 JSA 上下文重置 → 必须重新注册**，并且首个导航已经命中兜底路由。
  - **处置**：页面在 `src/database/seed/menus.ts` 里配（`M` 目录 / `C` 页面 / `F` 按钮），改完**必须重跑** `bun run db:seed:menus`；注册后重新进入目标路由时**只保留 `path/query/hash`**，不能 `return { ...to }`（`to.name` 是 `not-found`，按 name 解析会再次命中兜底）。
  - **预防**：不要往动态路由表里手加页面；新增页面 = 改 seed + 重跑 seed。（来源 `pitfalls/web.md` §6、`web/src/router/guard.ts` 注释）
- **W7 · 金额与时间的展示口径**
  - **症状**：页面金额差 100 倍；或时间比后端早/晚 8 小时。
  - **原因**：后端金额一律**分**、时间一律 **UTC**；前端如果自己折算或按本地时区硬解析就会错。
  - **处置**：前端只做 `÷100` 展示，**不在前端做任何折算**（折扣由服务端算）；表单按"元"录入时**只在两个转换函数里**换（提交前 `Math.round(元 * 100)`）；时间统一按 `Asia/Shanghai` 展示（`~/composables/useFormat.ts`）。
  - **预防**：看到"面额/门槛/折扣"这类字段，先问一句"这是谁的口径"。（来源 `pitfalls/web.md` §7、`pitfalls/miniapp.md` §13）
- **W8 · lew-ui 2.8.2 没有图片预览，上传缩略图点了没反应**
  - **症状**：`LewUpload` 的上传/回显缩略图点击后**什么都不发生**。
  - **原因**：库只导出一个 `dist/index.js`，里面**搜不到任何 preview 实现**；`LewUploadByCard` / `LewUploadByList` 给 `LewImage` 传的 `preview-group-key` 是个**没人消费的属性**。此前文档曾写"lew-ui 自带预览"——**那是对的相反的结论，已纠正**。
  - **处置**：图片预览统一走自家全局查看器（`~/components/ImageViewer.vue`，挂在 `App.vue`，`openImagePreview(images, index, title)`）；上传区缩略图要能点，用 `useUploadImagePreview(hostRef, () => urls)` 在**容器**上挂捕获阶段代理（只接管 `.lew-upload-file-image`）。
  - **预防**：**一件事只留一种做法**（本次删掉了服务项目弹窗里的重复入口）。（来源 `pitfalls/web.md` §8，实测）
- **W9 · 查看器缩放：`transition` 的 `transform` 与内联 `transform` 互相覆盖**
  - **症状**：切图动画（`translateX` 淡入）不生效，或一加动画缩放就乱跳。
  - **原因**：缩放/平移用**内联 `style.transform`** 表达，而 `<Transition>` 的 `*-enter-from` 也是改 `transform`；**内联样式优先级高于样式表**，动画类永远赢不了。
  - **处置**：分两层 —— 外层 `.iv-frame` 只负责"缩放 + 平移"（内联 transform），内层 `<img class="iv-image">` 只负责"换图"动画（类里的 transform）。
  - **预防**：给带内联 transform 的组件加动画前，先确认作用元素不同层。（来源 `pitfalls/web.md` §9，实测）
- **W10 · 盖在 lew-ui 弹窗之上的浮层：`z-index` 与 `Esc` 都要自己处理**
  - **症状**：① `z-3000` 不生效，浮层被弹窗盖住；② 在编辑弹窗里打开查看器后按 `Esc`，**查看器和编辑弹窗一起关了**（未保存的表单直接丢）。
  - **原因**：① UnoCSS 预设只生成**已知刻度**（`z-10/50/1200/1201`…），`z-3000` 不在刻度里就没有对应 CSS，必须写任意值语法 `z-[3000]`；② lew-ui 有内部 z-index 管理器（`BASE_Z_INDEX = 2001` + `isTop(id)`），`closeByEsc` 只关它认定的栈顶弹窗，而我们的浮层**没登记**。
  - **处置**：任意 z-index 用 `z-[3000]`（改完去**最新产物 CSS** 里搜 `.z-\[3000\]` 确认）；浮层的 `keydown` 用**捕获阶段**注册（`addEventListener('keydown', fn, true)`），处理掉 `Esc` / `←` `→` 时 `event.stopPropagation()`。
  - **预防**：浮层类组件一律走这两个约定，别逐次试。（来源 `pitfalls/web.md` §10，实测两次）
- **W11 · 平移归零会算出 `-0`**
  - **症状**：`expect({ x: 0, y: -0 }).toEqual({ x: 0, y: 0 })` 失败；样式里出现 `translate3d(0px, -0px, 0)`。
  - **原因**：`Math.max(-90, -0)` 得到 `-0`，而 `Object.is(-0, 0) === false`。
  - **处置**：夹取结果 `+ 0` 归一（`clampPan` 已处理），别指望调用方擦屁股。
  - **预防**：任何 Math 夹取函数都做 `+ 0`。（来源 `pitfalls/web.md` §11，实测）
- **W12 · `LewUpload` 有两条产出路径，两条都要过显示态归一化**
  - **症状**（用户原话）：「新增服务项目的时候传了图片但是展示不出来，编辑时新增的也不行」；更迷惑的是"打开编辑弹窗原有图片正常显示，在同一弹窗里新传一张，新那张是文件图标"。
  - **原因**：`url` 有两条产出路径 —— ① 打开弹窗的**反显**（库里 url → `toUploadItems`）；② 上传成功后**回填**（`uploadHelper` → `setFileItem`）。修①时漏了②，②仍塞 `filePreviewUrl(id)` 的原始地址（`.../download?inline=1`，不以图片扩展名结尾）→ lew-ui 判定失败 → 渲染默认文件图标。
  - **处置**：两条路都走 `~/utils/upload-images`：`toUploadItems` / `toUploadedItem` / `toImageUrls`，页面里**不要手写**回填对象。
  - **预防**：`upload-images.spec.ts` 对两条路都断言"交给 LewUpload 的 url 必须能通过 lew-ui 那条扩展名正则"；把 `toUploadedItem` 的归一化删掉，该测试立刻 2 条变红（做过变异验证）。（来源 `pitfalls/web.md` §12，用户报障）
- **W13 · 文件 mime 不是图片类型时，`<img>` 会被 `nosniff` 挡掉**
  - **症状**：图片地址能 200，但 `<img>` 不渲染（或只在某些浏览器渲染）。
  - **原因**：后端按多部分请求里的 `part.mimetype` 入库（为空则落 `application/octet-stream`），而 helmet 带了 `X-Content-Type-Options: nosniff` —— 声明不是图片类型时浏览器**拒绝**当图片显示。
  - **处置**：上传必须带正确类型。前端 `form.append('file', file)` 传浏览器 `File` 对象即可；**用脚本 / 命令行工具传文件时要显式指定**。
  - **预防**：用 PowerShell `-Form @{file = Get-Item x.png}` 复现过一版 `application/octet-stream` —— 别拿它做图片链路的验收。（来源 `pitfalls/web.md` §13，实测）
- **W14 · 异步选项 + 多选 `LewSelect`：「第一次打开渲染不出来」**
  - **症状**（用户原话）：「点击修改美甲师可做项目的时候，第一次渲染不出来可做项目」—— 关掉再打开（同样的数据）就正常了。
  - **原因**（读 `lew-ui/dist/index.js` 定位）：① `LewSelect` 在 `setup` 里把 `options` **快照**进 `sourceFlattenOptions`；② 多选模式下已选项标签从这个快照渲染；③ `watch(options)` 只更新下拉列表用的 `sourceOptions`/`options`，**不更新快照**；④ `LewDrawer` 的抽屉体是 `v-if`，所以"先 `drawerVisible = true`，再 `await` 取选项" = 组件带**空**选项挂载。`LewTree` 同家族（只读挂载时的 `dataSource`）。
  - **处置**：**选项就绪再挂载**选择器（打开前 `await`，或 `v-if` 门控"加载中/失败/空/就绪"四态）；每次拿到新选项就换 `:key` 重建组件；选项为空 / 拉取失败要**分别**给提示。
  - **预防**：同类已修 `staffs` / `card-types` / `recurrences` / `users`；新页面照"先加载数据，再打开弹窗"写。（来源 `pitfalls/web.md` §14，用户报障 + 翻源码定位）
- **W15 · `accept: 'image/*'` 会把注定失败的文件递给后端**
  - **症状**：手机上传头像/图片，从相册挑一张 → 提示「不支持的文件类型」。
  - **原因**：后端按**扩展名白名单**校验（图片只有 jpg/jpeg/png/gif/webp/svg），而 iPhone 相册的 `.heic`（以及 `.avif`）不在白名单里；`accept: 'image/*'` 恰好把它们列出来。
  - **处置**：用 `~/utils/upload-limits` 的 `IMAGE_ACCEPT`（`image/png,image/jpeg,image/webp,image/gif,image/svg+xml`）+ `MAX_UPLOAD_FILE_SIZE`（与后端 `MAX_FILE_SIZE` 一致的 10MB）。
  - **预防**：显式写 `image/jpeg` 还白捡一个好处 —— **iOS 会在上传前把 HEIC 自动转成 JPEG**，本来传不上的照片反而能传上去。（来源 `pitfalls/web.md` §15，实测）
- **W16 · 响应里有多个数组时，别让「第一个数组」决定行集**
  - **症状**：报表中心「应收」页签整列显示 `¥0.00` / 空白，看着像"这家店没有挂账"，而后端明明回了主体明细。
  - **原因**：`reportRows()` 的兜底策略是「取对象里**第一个**数组字段当行集」，而应收响应里 `buckets`（账龄分桶 3 行）排在 `accounts`（主体明细）**之前** —— 于是表格渲染的是分桶行，而列配置要的是主体字段（`name` / `creditLimit` / `outstanding` / `buckets.0-30`…），全取不到。
  - **处置**：`reportRows(payload, key?)` 支持显式指定行集字段；`TAB_META.receivables.rowsKey = 'accounts'`。**新增报表页签时，只要响应里有多个数组就必须给 `rowsKey`。**
  - **预防**：这条属于「宽松响应归一」的通用陷阱 —— 靠猜（第一个数组 / 第一个标量）的兜底逻辑，遇到多数组结构必然取错，而且**不报错**。（来源 `web/src/api/biz/reports.ts` 注释 + 实测响应键序）

---

## 三、小程序（微信原生 TS）

- **M1 · 图标样式全部失效、图标撑满全屏：不要用 `Add-Content` 追加 WXSS**
  - **症状**：追加一段样式后**整页渲染错乱** —— `.menu__icon` 实际尺寸变成 **320×240**（声明是 40rpx），而 app.wxss 的类正常；大括号/注释配平、无 BOM、无编译告警。
  - **原因**：`Add-Content -Encoding UTF8` 追加会破坏整份样式表（字节层原因未定论，但可稳定复现）。
  - **处置**：整份用 .NET 写回：`[System.IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding($false)))`。
  - **预防**：**别靠截图判断** —— 用 `automation_element_action --action size --selector '.menu__icon'` 量实际尺寸一次定性，再 `git checkout -- <file>` 回退对照。（来源 `pitfalls/miniapp.md` §1、`pitfalls/tooling.md` §7）
- **M2 · `<image>` 不渲染图标（静默失败）**
  - **症状**：图标位置空白，页面只剩文字，**没有任何报错**。
  - **原因**：小程序 `<image>` **不解析 URL 编码的 SVG data-URI**。
  - **处置**：SVG 一律转 **base64**（`utils/icons.ts` 内联了一个 ASCII base64 编码器）。
  - **预防**：新增图标只走 base64 通道。（来源 `pitfalls/miniapp.md` §2）
- **M3 · 不认目录导入**
  - **症状**：页面全白，控制台 `module 'api.js' is not defined, require args is '../api'`。
  - **原因**：小程序模块解析**不做 Node 式目录解析**（不找 `index.ts`）。
  - **处置**：写全路径 `'../../api/index'`。
  - **预防**：这条在 `HANDOVER-miniapp.md` §4 的"契约陷阱清单"里排第 1；类型检查查不出来。（来源 `pitfalls/miniapp.md` §3）
- **M4 · `this.data.x` 与 `this.x` 不能混用**
  - **症状**：`TS2339: Property 'bookingId' does not exist on type 'Instance<...>'`。
  - **原因**：`Page({ data: { bookingId } })` 里的字段**只能** `this.data.bookingId`；只有**实例属性**（写在 `data` 之外）才 `this.x`。
  - **处置**：要 `this.x` 就声明成实例属性（如 `targetBookingId: 0`）；要在 WXML 里用就必须放 `data`（WXML 读不到实例属性）。
  - **预防**：tsc 直接报，属于"看到就懂"的坑，但混用后运行时的静默失败更麻烦。（来源 `pitfalls/miniapp.md` §4）
- **M5 · WXML 里写 markdown 星号会原样渲染**
  - **症状**：页面上出现 `**重要**` 这种字面星号。
  - **原因**：WXML 没有 markdown。
  - **处置**：要强调用样式或「」引号；改完全站扫一遍：`Select-String -Path pages\*\*.wxml -Pattern '\*\*'`。
  - **预防**：注释里的 `**` 不影响渲染，只需清用户可见文本。（来源 `pitfalls/miniapp.md` §5）
- **M6 · 未登录不要显示成「加载失败」**
  - **症状**：未绑定手机号时，页面把 401 的 message 当 `errorText` 显示，顾客以为系统坏了。
  - **原因**：把「未登录」与「加载失败」混成同一个字段。
  - **处置**：**未绑定就不发请求**；用独立的 `guest` 标志，不复用 `errorText`；文案区分"登录后查看"与"绑定手机号后查看"；统一走 `store/session.ts` 的 `requireSession({ needBind, reason })`，并让登录页**显示原因**。
  - **预防**：本轮共 10 个页面统一处理过。（来源 `pitfalls/miniapp.md` §6）
- **M7 · 被引导到登录页后「来回弹」**
  - **症状**：未绑定时点「去登录/绑定」→ 登录页 → 点「微信一键登录」→ **回到原页又被拦** → 再来登录页。
  - **原因**：微信登录只做 `ensureLogin()` 然后 `goBack()`，而「需要绑定」的场景**登录了也还不满足**。
  - **处置**：登录成功后若本页是被带 `reason` 引导来的且仍未绑定，**留在本页**提示"还需绑定手机号才能继续"，不要 `goBack`。
  - **预防**：**把整条引导链路真走一遍**（分看两段代码各自都是对的）。（来源 `pitfalls/miniapp.md` §7）
- **M8 · 验证手段：tabBar 页 / 草稿依赖页 / 需模式的页**
  - **症状**：`simulator_open_page` 到不了三类页面，截图会**截到上一个页面**（看起来像"没生效"）。
  - **原因**：这三类页面没有可直接构造的入口状态。
  - **处置**：tabBar 页 → `automation_navigate --action switchTab --url /pages/xxx/index`；草稿依赖页（预约/确认）→ **真走一遍**（款式库 → 点 `.list-card__add` → 点 `.action-bar .btn`）；需切模式的页（工作台）→ 我的 → 点 `.staff-block__btn`；读数据用 `automation_evaluate` + `getCurrentPages()` → `p.data`（比截图确定），读文本用 `automation_element_action --action text`。
  - **预防**：判断落点用 `automation_runtime_info --action currentPage`，比截图便宜且确定。（来源 `pitfalls/miniapp.md` §8、`HANDOVER-miniapp.md` §9.2）
- **M9 · 前端展示要与服务端同口径**
  - **症状**：选券列表里出现"满 100 元"的券而订单只有 88 元 —— 预估显示减 20，**提交时被服务端 409 拒绝**。
  - **原因**：前端只按"可用"筛券，没有按**等级折扣后**金额过滤门槛。
  - **处置**：门槛按**折后金额**判（与核销处同一口径）；已选券若变为不满足门槛就地清掉；不可选的券要**计数并解释**（"另有 N 张券未达到使用门槛"），而不是让它凭空消失。
  - **预防**：端到端验证时顺手看页面数据是否合理，而不是只看"功能通了"。（来源 `pitfalls/miniapp.md` §9、`HANDOVER-miniapp.md` §11.3）
- **M10 · 预览报 `SyntaxError: Unexpected token ?`：`??` 没有被降级**
  - **症状**：`无效的文件: api/index.js, 108:26 SyntaxError: Unexpected token ?`，预览直接打不开（报错显示的是**编译后**行号，与源文件对不上）。
  - **原因**：两个设置叠加 —— `miniapp/tsconfig.json` 的 `target: ES2020` 让 `??`/`?.` **原样保留**；`project.config.json` 的 `es6: false` + 增强编译关闭 → 开发者工具**不做** Babel 降级。
  - **处置（两层，缺一不可）**：① **`project.config.json` 里 `"enhance": true`（增强编译）** —— 这才是真正解决问题的那一层（开发者工具的 TS 插件不会按 tsconfig 的 `target` 降级语法）；② 同时把 tsconfig 的 `target` 降到 `ES2019`（`lib` 保持 `ES2020`）作为双保险。当前仓库两者都已就位。
  - **预防**：**只在自己模拟器里验证"语法兼容性"不够** —— 真实预览走同一套编译配置但缓存与工具链状态可能不同；验证方式两条都要（编译到临时目录 grep 产物确认 `??`/`?.` 为 0；开发者工具 `debug_clear_cache --action cleanCompileCache` 后重新编译看 console）。另外**注释里不要写该运算符的字面量**，否则 grep 会误报。（来源 `pitfalls/miniapp.md` §10）
- **M11 · `wx.getSystemInfoSync` 已弃用，而 vendored 类型包里没有新 API**
  - **症状**：每进一次页面就刷 `wx.getSystemInfoSync is deprecated...`（调用栈指向各页面 `onLoad`/`applyNavMetrics`）。
  - **原因**：① 代码用 `wx.getSystemInfoSync()` 取 `statusBarHeight`/`windowWidth`（**4 个页面各写一遍**）；② `miniapp/typings/types/wx/lib.wx.api.d.ts` 是**旧版**，`getWindowInfo`/`getDeviceInfo`/`getAppBaseInfo`/`getSystemSetting` 全都没声明，所以当初才用了旧接口。
  - **处置**：补声明（`miniapp/typings/types/wx/lib.wx.api.modern.d.ts`，只声明用到的字段）；收成一个工具函数 `utils/metrics.ts` 的 `getNavMetrics()`（优先 `wx.getWindowInfo()`，**老基础库**才回退旧接口）；4 个页面改为调它。
  - **预防**：**弃用告警会淹掉真问题**（本次就是它先出现、语法错误后出现）—— 控制台应当保持"零告警"。（来源 `pitfalls/miniapp.md` §11）
- **M12 · token 只活 15 分钟，而 401 只清 token 不重登 → 应用「卡死」必须重启**
  - **症状**：小程序开着一段时间后，**每个页面都报 `Unauthorized`**，杀掉重开就恢复正常。
  - **原因**（两个叠加）：① app token TTL **15 分钟**；② `utils/request.ts` 遇到非 `needBind` 的 401 只做 `clearAuth()`，而**没有任何地方会重新登录** —— `ensureLogin()` 只在 `app.ts` 的 `onLaunch` 调用一次，且它的判断是 `isLoggedIn()`（**只看 token 在不在、不看有没有过期**），所以"带着过期 token 启动"也会跳过。
  - **处置**：非 `needBind` 的 401 → 清 token → **重新登录 → 原请求重试一次**（**只重试一次**，否则后端撤权会变成 401 死循环）。**不能在 `request.ts` 里 import `store/auth`**（`auth → api → request` 会成环），用 `setReauthHandler()` 注册回调**反转依赖**；并发 401 去重靠 `ensureLogin()` 里已有的 `loginPromise`。
  - **预防（这条最值得记）**：历次验证都是**手动 `wx.setStorageSync` 塞一个有效 token**，从没走过"token 过期"这条路 —— **用手工种数据代替真实流程，会掩盖真实缺陷**。（来源 `pitfalls/miniapp.md` §12）
- **M13 · 前端硬编码「服务端配置」+ 单位混用**
  - **症状**：确认预约页预估的"积分抵扣"与服务端算出来的对不上；极端情况下**顾客少看抵扣、却多花积分**。
  - **原因**（两个独立问题叠加）：① **上限硬编码且两边不一样**：小程序写 `MAX_POINTS_PERMILLE = 500`，而 web 与后端默认都是 `300`（`biz.member.maxPointsPermille`）；② **单位混用**：`maxByPoints = Math.floor(points / 100)` 得到的是**元**，却与"分"为单位的 `maxByRatio` 取 `min` → 抵扣额小了 **100 倍**。
  - **处置**：**上限从服务端取**（`GET /app/member/me` 的 `maxPointsPermille`，前端只留兜底常量）；换算严格照 `src/modules/biz/common/money.ts`（`pointsToCents = floor(积分 / rate) × 100`、`centsToPoints = ceil(金额分 / 100) × rate`）；web 侧 `views/biz/bookings/index.vue` 的写法是正确的参照。
  - **预防**：**同一份服务端规则在前端存在两份实现，就是漂移的温床** —— 能问服务端就别自己写。回归用例：`b7-app-booking-detail`（500 积分 = 减 500 分；申请 10000 积分按 300‰ 收敛到 3000 分，**超限不报错**）。（来源 `pitfalls/miniapp.md` §13）
- **M14 · 接口返回的图片是相对路径，绑到 `<image src>` 会「空白」而不是报错**
  - **症状**：后台给美甲师传了头像，小程序「选美甲师」页那一圈还是空的（也不是兜底图，就是白）。
  - **原因**：app 域接口返回的是相对地址 `/api/v1/files/12/download?inline=1`。小程序把**以 `/` 开头**的地址当**包内文件**，于是既没走网络、也没报错，只是渲染不出来。
  - **处置**：页面只绑 **`*Resolved`** 字段（`avatarResolved` / `imageResolved`），不要直接绑接口原值；新增这类字段时先想清楚"空值给什么"（`resolveStaffAvatar` 永远返回可用地址，所以模板里连 `wx:else` 兜底分支都不需要）。
  - **预防**：排查口诀 —— **小程序里图片空白 = 先看 src 是不是相对路径**。（来源 `pitfalls/miniapp.md` §14）
- **M15 · 地址已拼成绝对 URL，图片还是空白：后端 helmet 的 CORP**
  - **症状**：按 M14 修完（`imageResolved` = `http://192.168.0.101:3000/api/v1/files/10/download?inline=1`，IP 是**当时的快照**，现值以 `miniapp/miniprogram/config.ts` 为准），图片**依旧空白**，且控制台/日志里什么都看不到。
  - **原因**：见服务端 S10 —— 小程序 `<image>` 在开发者工具里由 `127.0.0.1:<port>` 的 pageframe 渲染，与 API 不同源 → Chromium 把这条 no-cors 子资源请求直接拦掉。
  - **处置**：`files.controller.ts` 的 `download()` 里显式覆盖 `Cross-Origin-Resource-Policy: cross-origin`；**不要**改全局 helmet 配置。
  - **预防（可复用的确诊手法）**：用 headless Chromium 做**四格对照**（同源图 → LOAD；跨源无 CORP → LOAD；跨源带 CORP `same-origin` → ERROR；真实接口地址 → ERROR），一次定性而不是猜。**同一个症状要查到"能证明它好了"，不能停在"看起来修对了"。**（来源 `pitfalls/miniapp.md` §15、`pitfalls/server.md` §10）
- **M16 · 自定义 TabBar「切不动」：高亮下标不该由页面报、更不该拿它当点击闸门**
  - **症状**（用户原话）：「切换有点不顺畅，而且有时候切换页面切不动」—— 人在**我的**，底部高亮却在**首页**，此时点「首页」没反应。
  - **原因**（两层，缺一不可）：① 组件**每个 tab 页各有一个实例**，新实例带 `currentRoute: ''` 出生 → `findIndex === -1` → **退回 `selected: 0`**，而页面 `onShow` 的 `syncTabBar()` 只写 `currentRoute`、**不重算 `selected`**（`pageLifetimes.show` 还早于页面 `onShow`）；② `onTap` 里 `if (index === this.data.selected) return;` —— 高亮错位时点那个"被错误高亮"的 tab 正好命中这句提前 return。
  - **处置**：TabBar **自己**读 `getCurrentPages()` 算真实路由（`refresh()` 一次算清主题+模式+高亮），路由找不到时**保留当前高亮**、绝不退回 0；提前 return 的判据改成 `realRoute() === tab.pagePath`；点击先**乐观 `setData({selected})`**，再加 `switching` 在途保护 + `fail` 回调里 `refresh()` 校准并 toast。
  - **预防**：用 `miniprogram-automator` 打点读出 `{route, selected}` —— **一行数据就定性了**，比截图猜快得多。（来源 `pitfalls/miniapp.md` §16）
- **M17 · 页面工厂的 `onShow` 不能推全量 chrome，否则把加载状态机打回首屏**
  - **症状**：`onLoad` 里发起请求的页面，骨架屏闪一下就没了（先露一瞬空态）；切 Tab 回来仍然回骨架屏；刷新失败还会清空已有内容 —— 与 `runLoad` 承诺的语义**完全相反**。
  - **原因**：`definePage` 注入的 `onShow` 每次 `setData(chrome())`，而 chrome 里含 `loading: false, errorText: '', loaded: false`；生命周期是 `onLoad → onShow`，于是刚 `setData({loading:true})` 就被打回 false，且 `loaded` 每次被重置 → `runLoad` 永远判成"首屏"。
  - **处置**：拆成两份 —— `pageChrome()`（**只用于 `data` 初始化**）与 `pageAppearance()`（`onShow` 每次只刷主题/登录态/图标）。**加载态四件套只在 `data` 里播一次种，之后就只归 `runLoad` 所有。**
  - **预防**：这条是子 agent 读代码推出来的，父 agent 复核实证后修复 —— 分工时"不许改 utils"这条纪律的价值就在这里。（来源 `pitfalls/miniapp.md` §17）
- **M18 · `definePage` 的 chrome 配置项拼错 = 图标静默消失、tsc 还不报错**
  - **症状**：整页图标全没了，但没有任何报错。
  - **原因**：`CustomOption = Record<string, any>`，拼错的键（如 `chromeIcon`）会被 `...rest` 原样透传给 `Page()` 当自定义方法吞掉 —— 类型系统在这里帮不上忙。
  - **处置**：`definePage` 里加了防呆告警：`rest` 中以 `chrome` / `white` 开头但不在白名单的键直接 `console.warn`；新增配置项时同步白名单。
  - **预防**：正确键名是 **`chromeIcons`**（不是 `icons`）。（来源 `pitfalls/miniapp.md` §18）
- **M19 · 入场动画用了 `animation-fill-mode: both`，会把 `.press:active` 永久压掉**
  - **症状**：加了入场动画的元素，按下没有缩放反馈了。
  - **原因**：`both` 让动画**末帧的 `transform` 一直生效**，动画声明优先级高于普通声明 → `:active` 的 `transform` 永远不生效。
  - **处置**：入场动画统一 `backwards`（只在延迟期预置起始态，播完把 `transform` 还给元素）。
  - **预防**：读 CSS 规范即可预判，但**只有"真的去按一下"才会发现** —— `.anim-*` 与 `.press` 同用时必须肉眼验收一次。（来源 `pitfalls/miniapp.md` §19）
- **M20 · 同一零件每页抄一份，必然漂移成 N 套**
  - **症状**：`.chip` 在 5 个页面各有一份、已漂移成 3 套尺寸；`.mini-btn` 3 套；`.tips` 8 处 margin/字号各不相同；`.empty__action` 15 处 3 种外边距。
  - **原因**：不是有人改错了，而是**复制粘贴本身** —— 第 2 份时没人看得出，第 5 份时就没有"标准"了。
  - **处置**：凡是**跨页面同形的零件**一律进 `app.wxss`，页面只保留**排布**（外边距交给容器）。本轮删掉约 30 个重复规则块。
  - **预防（可复用手法）**：把所有 `pages/*/index.wxss` 的类选择器聚合成"选择器 → 出现在几个页面"，出现 ≥3 次的逐个看。（来源 `pitfalls/miniapp.md` §20）
- **M21 · 给「整块 `wx:else`」套入场动画，会把 `position: fixed` 的底栏顶飞**
  - **症状**（只在动画那 0.3 秒里）：底部 `.action-bar`（app.wxss 里是 `position: fixed`）先被摆到**内容底部**，动画一结束再"啪"地跳回屏幕底部。
  - **原因**：祖先元素只要有 `transform`（动画/`will-change` 都会产生），就会成为 `position: fixed` 后代的**包含块**，于是 fixed 不再相对视口定位。
  - **处置**：动画挂在**内容容器**上，不要把整块 `wx:else` 包成一个带 `anim-rise` 的 view；页面里没有 fixed 元素时（首页、款式库列表）包整块才是安全的。
  - **预防（可复用手法）**：写脚本扫一遍所有 wxml 的祖先链，遇到 `.action-bar` 就回头看有没有 `anim-*`/`press*`。（来源 `pitfalls/miniapp.md` §21）
- **M22 · `wx.request` 不支持 PATCH**
  - **症状**：页面更新类操作请求发不出去。
  - **原因**：小程序 `wx.request` 只支持 OPTIONS/GET/HEAD/POST/PUT/DELETE/TRACE/CONNECT。
  - **处置**：app 域接口一律用 POST/PUT，需要局部更新就新开一个动作型端点（如 `POST /app/staff/bookings/:id/arrived`）。
  - **预防**：这是 `HANDOVER-miniapp.md` §4 契约陷阱清单里的第 2 条。（来源 `HANDOVER-miniapp.md` §4）
- **M23 · app 模块不得 import 业务模块**
  - **症状**：`src/modules/app/**` 直接 import `BookingsService` 会形成编译期耦合与潜在循环依赖。
  - **原因**：设计的依赖方向是**只依赖端口抽象**。
  - **处置**：只能依赖 `src/modules/biz/common/ports.ts` 的抽象类，由 `BizModule`（`@Global`）`useExisting` 绑定；新增跨模块能力要**加端口**，不是直接 import。
  - **预防**：改 `ports.ts` 时同时检查 `providers` / `exports`（见服务端 S3）。（来源 `HANDOVER-miniapp.md` §4）
- **M24 · 真机 / 局域网连不上后端**
  - **症状**：模拟器正常，真机请求全失败；或按文档里的 IP 直接**「目标计算机积极拒绝」**。
  - **原因**：三种，看报错区分 ——
    ① `API_BASE` 用了 `127.0.0.1`（真机上那是**手机自己**）；
    ② **IP 过期**：`config.ts` 里写死的局域网 IP 随 DHCP 变了（2026-09 就从 `.101` 变成 `.100`），**那个地址上现在是别的设备** → 表现为**「积极拒绝」/连接被拒**；
    ③ Windows 防火墙没放行 3000 → 表现为**超时**（WLAN 的网络类别常是「公用」，而公用配置文件入站默认拦）。
  - **处置**：先 `Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.PrefixOrigin -eq 'Dhcp' }` 核对**有默认网关**的那张网卡，把 `miniapp/miniprogram/config.ts` 的 `API_BASE` 改成它；防火墙放行（只放同网段）：
    `New-NetFirewallRule -DisplayName "manicure dev API 3000 (LAN)" -Direction Inbound -Protocol TCP -LocalPort 3000 -RemoteAddress LocalSubnet -Action Allow -Profile Any`；
    自查用**手机浏览器**打开 `http://<局域网IP>:3000/api/v1/health`。
  - **预防**：**「拒绝」= IP 上没服务，「超时」= 被防火墙丢了**，两者别混。本机访问局域网 IP 也**不经过**入站规则，所以「本机通、手机不通」是常态。想一劳永逸就在路由器上给这台机做 **DHCP 保留**。（来源 `miniapp/miniprogram/config.ts` 注释、实测）
- **M25 · 开发者工具 `urlCheck` 与「切真接口」的条件**
  - **症状**：`wx.request` 报域名不合法；或后端返回 503「小程序端未启用」。
  - **原因**：本项目走 `http + IP`，必须跳过合法域名校验；且 app 域登录要求 `WX_MINIAPP_APPID` / `WX_MINIAPP_SECRET` 配置齐全（未配置按设计返回 503）。
  - **处置**：`miniapp/project.private.config.json` 改 `urlCheck: false`（该文件被 `miniapp/.gitignore` 忽略，本机怎么改都不会进仓库）；后端 `.env` 配 `WX_MINIAPP_APPID` + `WX_MINIAPP_SECRET`；本地临时可用 `WX_MINIAPP_FAKE=true`（**生产强制失效**，见 `AppConfigService.wxMiniappFake`）。
  - **预防**：上线必须换成正式 AppID/HTTPS 域名白名单，`urlCheck: false` 不能上线。（来源 `HANDOVER-miniapp.md` §7、`src/config/app-config.service.ts`）
- **M26 · WXML 注释用 CSS 的收尾符号 → 注释不闭合，吞掉后面的标签，**报错行号完全对不上****
  - **症状**（用户报障）：`[WXML 文件编译错误] ./pages/notices/index.wxml — get tag end without start / unexpected end tag: view`，指针落在**文件最后一行**（`50 | </view>`），而那一行看着完全正常。
  - **原因**：写在 `<view class="page-body">` **上面**的那条注释被写成了 CSS 的收尾（星号加斜杠），而 WXML 注释必须以 `--` + `>` 收尾。注释一直没闭合，把紧跟其后的 `<view class="page-body">` 一起吞成了注释内容 —— 于是开标签少一个，编译器只能在读到文件末尾时抱怨「多了一个结束标签」。**症状离病因 24 行远。**
  - **处置**：找到那条注释改回收尾符；`bun scripts/verify-wxml-tags.mjs` 会直接指出来（它会提示「往上找：多半是某个注释没闭合」）。同一坑在 JS 里也会复现：**JSDoc 里写这个符号组合会提前结束块注释**（本仓 `scripts/verify-wxml-tags.mjs` 第一版就是这么写坏的）。
  - **预防**：`tsc` **不检查 WXML**，所以小程序改动除了 `bunx tsc --noEmit -p miniapp/tsconfig.json`，还要跑一次 `bun scripts/verify-wxml-tags.mjs`（离线、秒级）；改完 WXML 最好在开发者工具里编译一次确认。（来源 `miniapp/miniprogram/pages/notices/index.wxml`、用户报障）
- **M27 · 盖在 `<swiper>` 上的浮层会**吃掉触摸**：那一片区域划不动**
  - **症状**：首页头图改成轮播后，压在图上的文案与右下角圆点那一片**划不动**，只有图的上半部分能翻页；`pointer-events: none` 写上去毫无效果。
  - **原因**：`<swiper>` 的滑动由它自己的触摸监听实现，压在它上面的兄弟节点会成为触摸目标，事件**不会再冒泡回 swiper**；而 `pointer-events` 在 WXSS 里不可靠（WebView 下常被忽略）。
  - **处置**：**渐变与文案放进 `<swiper-item>` 里**（每屏各带一份，跟着一起滑），只留尺寸很小的自绘圆点在容器上。
  - **预防**：设计稿要「右下角圆点」时**不能用原生 `indicator-dots`**（只能居中）—— 自绘圆点 + `bindchange` 记下标；`circular` / `autoplay` 下自动轮播同样会触发 `bindchange`。（来源 `pages/index`，实测）
- **M28 · 卡片里的独立动作必须 `catchtap`；收藏态以服务端返回为准**
  - **症状**：点「人气款式」卡右上角的收藏心，页面同时跳进了款式详情（体感是"收藏没生效"）。
  - **原因**：心形是"整卡可点进详情"那张卡的子节点，`bindtap` 默认**冒泡**，父级的 `openService` 也被触发。
  - **处置**：卡内一切独立动作（收藏、去支付、取消…）用 **`catchtap`**（与既有页面一致）。
  - **预防**：收藏/取消这类切换，**状态一律以服务端返回的目标状态为准**（`{ favorited }`），不要在本地取反 —— 双击 / 慢网 / 并发点两次时本地取反必然错位；未绑定手机号时**先门禁再发请求**（接口会 400 + needBind，明知失败还打一次只会让"未登录"看起来像"加载失败"）。（来源 `pages/index` + `pages/service-detail` 同一套写法）

---

## 四、工具链（PowerShell / 开发者工具 / 测试运行）

> 这些坑**不属于任何一端**，但三端开发都会踩，而且几乎每次都浪费十几分钟。

- **T1 · `[System.IO.File]` 不认 PowerShell 的 `cd`**
  - **症状**：`Could not find a part of the path '...\src\views\...'`，而**同一条命令里的 `bun run typecheck` 却正常**。
  - **原因**：.NET 的 IO API 用**进程工作目录**（workspace 根），而 `bun`/`node` 认 shell 的当前位置。
  - **处置**：在 `pwsh` 里用 .NET IO API 一律给**绝对路径**。
  - **预防**：默认就写绝对路径（本会话踩了 3 次）。（来源 `pitfalls/tooling.md` §1）
- **T2 · PowerShell 的转义是「反引号」，不是反斜杠**
  - **症状**：`\$ref` → `变量引用无效。"："后没有有效的变量名称字符`；`\'无门槛\'` → `表达式或语句中存在意外的标记`。
  - **原因**：双引号里 `$` 会插值；单引号里 `'` 要写**两遍**（`''`）；`\$` 与 `\'` **都不是** PowerShell 的转义（它用 `` ` ``）。
  - **处置**：**含 `$` 的字符串一律用单引号**；含引号/反引号/中文的**多行代码块**用**先赋值给变量的单引号 here-string**：`$block = @'...'@` 再 `$t.Replace($anchor, $block)`。
  - **预防**：本会话踩了 4 次 —— 遇到"解析失败"先怀疑转义。（来源 `pitfalls/tooling.md` §2）
- **T3 · 单引号 here-string 直接当 `.Replace()` 的参数会整段解析失败**
  - **症状**：命令**没有任何输出**，只有 `[exit code: 1]`，文件一个字都没改。
  - **原因**：`'@)` 这种"终止符后面还有字符"的写法不合法 → 整段脚本不执行。
  - **处置**：先 `$x = @'...'@` 赋值，再 `$t.Replace($a, $x)`。
  - **预防（自查）**：**改完文件先 `git status`**，确认"真的改了"再往下走（否则会基于假前提继续验证一个不存在的改动）。（来源 `pitfalls/tooling.md` §3）
- **T4 · 别拿自己加工过的输出当精确锚点**
  - **症状**：锚点"明明看得见"却匹配不上（`*** 锚点未匹配 ***`），同一处改了两三遍。
  - **原因**：常用 `ForEach-Object { '  ' + $_ }` 给 grep 结果**加缩进前缀**，于是显示出的缩进比文件里多 2 格，照着它写锚点必然偏。
  - **处置**：**构造锚点前用 `read` 工具读原文件**（而不是看 grep 输出）；或让锚点**与缩进无关**（`[regex]::Replace($t, '(?m)^(\s*)pointsToUse\?:', ...)` 用 `$1` 回填缩进）；或**按整行过滤**。
  - **预防**：本会话踩了 4 次。（来源 `pitfalls/tooling.md` §4）
- **T5 · `automation_evaluate` 传长 JS 会被 cmd 截断**
  - **症状**：`Uncaught missing ) after argument list`。
  - **原因**：`wechatide.cmd` 是 cmd shim，长字符串里的引号被吞。
  - **处置**：拆两步 —— ① 用 `curl`/`Invoke-RestMethod` 打**真实接口**拿数据；② 用一段**极短**的 JS 回填/断言（如 `wx.setStorageSync('k','v')`）。
  - **预防**：见 T10 的百分比编码技巧（同一片区）。（来源 `pitfalls/tooling.md` §5、`pitfalls/miniapp.md` §8）
- **T6 · 长时间命令要吃工具超时上限 → 放后台跑**
  - **症状**：全量测试跑到 `[timed out after 600000ms]`，`if` 分支根本没执行，提交也没发生。
  - **原因**：工具默认超时（10 分钟）短于命令耗时。
  - **处置**：可能超过 10 分钟的命令用 `run_in_background: true`，再用 `job_output`（可 `wait: true`）收结果。
  - **预防**：本项目集成测试已从 ~530 秒优化到 ~18 秒（见服务端 S6），正常情况下不需要后台跑。（来源 `pitfalls/tooling.md` §6）
- **T7 · 页面渲染异常时，先量尺寸再怀疑「渲染抖动」**
  - **症状**：截图里图标撑满全屏；连看两次截图两次一样，差点判断成"间歇性渲染抖动"。
  - **原因**：真因是样式没生效（见 M1）。
  - **处置**：用 `automation_element_action --action size --selector '.menu__icon'` **量元素实际尺寸**（声明 40rpx 却量到 320×240 → 定性为"样式没生效"），再用 `git checkout -- <file>` 回退文件对照。
  - **预防**：**截图会骗人，尺寸不会。**（来源 `pitfalls/tooling.md` §7）
- **T8 · `automation_evaluate` 调试的两个「假阴性」**
  - **症状①**：JS 里 `return JSON.stringify({...})`，外层用 `"result":\s*"([^"]*)"` 解析只拿到 `{\`，看起来像"读不到/失败"。**原因**：结果字符串里的 `\"` 提前结束正则。**处置**：让注入的 JS **返回纯标量**（`return 'items=' + n + ' | err=' + (e || 'none');`），别返回 JSON。
  - **症状②**：`wx.setStorageSync('manicure:token', 'garbage')` 之后重进页面，应用**仍然用着旧的有效 token**，401 路径根本没走到。**原因**：`utils/token.ts` 有**模块级内存缓存**，`reLaunch`/重进页面**不会重置模块状态**。**处置**：改完 storage 必须 **`simulator_refresh`** 重置 JS 上下文；并注意 **storage 本身不会被 refresh 清掉**（用探针 key 验证过）—— 这正是"自愈"能被观察到的前提。
  - **预防**：把这两条写进小程序调试 checklist。（来源 `pitfalls/tooling.md` §8）
- **T9 · 微信支付 Skill：CLI 只索引接口文档，概念类问题要查本地知识库**
  - **症状**：`wechatpay-dev-cli knowledge search "<用户原话>"` 对概念类问题返回 `{ "hit": false, ... }`，看起来像"知识库没有"。
  - **原因**：CLI 的知识索引覆盖的是**接口文档**（搜 `JSAPI下单` 能命中），**不含 FAQ / 概念类内容**。
  - **处置**：概念类问题走技能内置的"文档检索与问答"流程 —— 在 `<技能目录>/assets/微信支付官网文档/`（**3985 篇**）上 `Grep` 探路再精读，并用 front matter 里的 `url` 溯源。
  - **预防**：该知识库是同步脚本下载的（**31.6 MB**）可再生缓存，**已加入 `.gitignore`，不要提交**；同步脚本还会改写 `references/` 下文档（值得提交）与三个脚本的**行尾**（纯噪音，`git diff --numstat` 为空但状态是 `M`，`git checkout -- <路径>` 回退即可）。（来源 `pitfalls/tooling.md` §9）
- **T10 · 开发者工具 CLI：URL 里的 `&` 会被 cmd 当命令分隔符**
  - **症状**：`automation_navigate --url '/pages/x/index?a=1&b=2&c=3'` 之后页面只收到**第一个参数**（`a=1`）；用 `^&` 转义在 PowerShell → cmd 这一层**不可靠**（时好时坏）。
  - **原因**：`wechatide.cmd` 是批处理，参数最终由 cmd.exe 解析，`&` 是 cmd 的命令分隔符。
  - **处置**：**绕开命令行** —— 用百分比编码的 URL，在 JS 里解码：`automation_evaluate --fn-source "function(){ wx.reLaunch({ url: decodeURIComponent('%2Fpages%2Fx%2Findex%3Fa%3D1%26b%3D2') }); return 'go'; }"`。
  - **预防**：这个坑让人连续误判了两轮（以为是页面没重渲染）—— **发现前一直以为是代码问题**。（来源 `pitfalls/tooling.md` §10）
- **T11 · 验证「登录态相关」改动前，先确认本地 token 的来源**
  - **症状**：页面一直停在未绑定/401，代码看起来完全正确。
  - **原因**：开发者工具本地存的 token 可能是**更早某次登录**签发的（本项目出现过 token 是 `WX_MINIAPP_FAKE=true` 时代的 `fake-openid-…`、对应 app 用户在库里 `customer_id` 为空）。**改后端绑定不会刷新已签发的 token。**
  - **处置**：动手前先解码 token payload 确认 `sub`/`openid`（`wx.getStorageSync('manicure:token').split('.')[1]`），再用 `SELECT id, openid, customer_id FROM app_wx_user` 对齐；必要时 `wx.removeStorageSync('manicure:token')` + `simulator_refresh` 让它重新静默登录。
  - **预防**：与 M12 同源 —— **不要用手工种数据代替真实流程**。（来源 `pitfalls/tooling.md` §11）
- **T12 · PowerShell `-replace` 是全量替换，拿它做「变异验证」会连带改坏别处**
  - **症状**：用 `-replace` 把修复语句改回错误写法，跑测试确实红了；改回来之后**测试还是红**，而且失败的是另一条断言 —— 文件里另一处同形状的语句也被改了。
  - **原因**：`-replace`（以及 `-creplace`）默认替换**所有**匹配项，不是第一处。
  - **处置**：变异验证优先用 `edit` 工具改单点；非要脚本替换时先数命中数（`(Select-String -Pattern ... | Measure-Object).Count`）或把上下文写长到唯一；变异后**必须 `git diff`** 看清改了哪几行再还原。
  - **预防**：本项目在修"上传的图显示不出来"时因此白跑了一轮全量测试。（来源 `pitfalls/tooling.md` §12）
- **T13 · 改了代码不生效、一直报 `X is not defined`：开发者工具把**中间态**编译进去了**
  - **症状**：首页报 `<ReferenceError: PAGE_ICONS is not defined>`，栈指向 `appservice-hotreload/pages/index/index.js:107`；但源码里**根本没有** `PAGE_ICONS`，`tsc --noEmit -p miniapp/tsconfig.json` 也是 exit 0。
  - **原因**：改动分两步落地 —— 先删掉 `const PAGE_ICONS = [...]`，几秒后才把引用它的那行换掉。**中间那几秒文件是"有引用、无声明"的坏状态**，开发者工具的编译/热重载正好抓到它并留在内存里；之后源码即使改回来，热重载也**不会重建那个模块作用域**，错误便一直复现。
  - **处置**：① **删/改顶层常量时声明与引用一次改完**（一次写入，别分两次编辑）；② 已踩上就「工具 → 清除缓存 → 清除全部缓存」再编译，或重启开发者工具。
  - **预防**：报错**先别改代码**，先核实"源码是否真的还有那个符号"：全仓搜一遍 + `tsc -p miniapp/tsconfig.json --outDir <临时目录> --rootDir ./miniprogram --removeComments` 看**产物**里有没有它。产物干净 = 工具缓存问题，此时改代码只会越改越乱。
    一句话：**`tsc` 绿 ≠ 运行时不报** —— 前者查源码，后者查工具手里那份 bundle。（来源 `pitfalls/miniapp.md` §24，用户报障 + 报错行号反推）

---

## 五、预防性检查清单（**推断，非实测**）

::: warning 以下条目是推断
上面每一节都是**真踩过的**。下面这些是"按现有代码结构推断、还没真炸过"的风险点，
**没有来源出处**，请在遇到相应改动时当作提醒而不是结论。
:::

- [ ] 新增表若使用 `auditColumns`，`db:generate` 之后确认默认值没带括号（S1 的同类风险面）。
- [ ] 给 `ports.ts` 加方法时，除了 `providers` 还要检查 `exports`，并**真启动一次**（S3）。
- [ ] 新增列表接口若返回了 `total` 或改了 `{ items, page, pageSize }` 形状，`useTable` 的 `hasMore` 估算会失真（W5 的对偶面）。
- [ ] 在事务里做任何网络 IO（短信、渠道查单、LLM）都属于 S9 的同类问题，即使在"事务末尾"也要移出去。
- [ ] `uploads/` 目录增长与孤儿文件：DB 行删了、磁盘 `unlink` 失败会留下孤儿文件（`catch` 被吞），建议定期对账。
- [ ] `sys_job` 的 `concurrent = false` 时任务会**静默跳过**而非排队，长耗时任务可能出现"看起来没跑"。
- [ ] 前端新增浮层/弹窗套弹窗时按 W10 检查 `z-[...]` 与 `Esc`；小程序端任何"数字预估"都要问"这是服务端算的吗"（M13）。

## 六、改动前自检清单

- [ ] 我改的是**哪一端**、对应的坑小节扫过了吗？
- [ ] 涉及金额 / 余额 / 积分 / 次卡 / 应收的写入：**是否全部条件更新**？有没有"读-算-写"？
- [ ] 事务内是否只用了 `tx`（没有 `this.database.db`）？事务里有没有网络 IO？
- [ ] 派生字段是否只由 `recalc()` / 会员账务 service 写？只追加表有没有被加上 update/delete 入口？
- [ ] 回调路径：验签 + 金额校验 + **快速应答**（微信失败回 4xx、支付宝回 200+`failure`，别统一）都还在吗？
- [ ] 定时任务有没有碰钱？（设计上**不能碰**）
- [ ] 权限点是否已加进 `src/database/seed/menus.ts`？钱的权限是否只给了店长？
- [ ] 新表有迁移吗？迁移 SQL 扫过 `DEFAULT (CURRENT_TIMESTAMP)` 吗？
- [ ] 本地服务**重启过**吗（S7）？接口真打过一次吗（不是只看前端页面）？
- [ ] `bun run typecheck && bun run lint && bun run test` 三连过了吗？
- [ ] 前端改动是否 `build` 过并在产物里找得到页面独有的中文串（W4）？
- [ ] 小程序改动是否过了 `bunx tsc --noEmit -p miniapp/tsconfig.json`，且**真的在模拟器里跑过一遍**（M16/M19/M21 这类只有跑起来才发现）？

## 七、代码评审常见退回原因

来源：`.agents/skills/testing-acceptance/SKILL.md` 的「代码评审项」+ 施工单 §3「禁止事项」+ `money-invariants` 红线。

| 退回原因                                                                            | 为什么必须退回                                     | 正确做法                                                             |
| ----------------------------------------------------------------------------------- | -------------------------------------------------- | -------------------------------------------------------------------- |
| 资金写入是"读-算-写"                                                                | 并发下必然越界（超扣/超发）                        | 条件更新 + `affectedRows` 闸门                                       |
| 事务内用了 `this.database.db`                                                       | 脱离事务，回滚不回它                               | 一律用 `tx`                                                          |
| 事务内做网络 IO（短信 / 渠道下单 / 查单）                                           | 长时间持锁与占连接（S9）                           | 事务外 prepare，事务内只落本地行                                     |
| 派生字段手工写（`paid_amount` / `due_amount` / 余额 / 积分）                        | 口径分裂，报表对不上                               | 只经 `recalc()` / 账务 service                                       |
| 只追加表出现 update/delete 入口                                                     | 审计与对账失去可信度                               | 只追加；冲正走反向记录                                               |
| 回调只验签不校金额、或回 200 表示失败                                               | 要么被伪造，要么渠道停止重投                       | 验签 + 金额校验 + 正确状态码（S11）                                  |
| 定时任务改钱                                                                        | 破坏"钱只由人发起"的审计链                         | 任务只改状态与等级                                                   |
| 新增权限点没进 `seed/menus.ts`、或钱的权限给了普通店员                              | 前端路由不生成、按钮权限失效；越权改账             | 三件套一起改并重跑 `db:seed:menus`；钱的权限只给店长                 |
| 手写 SQL 迁移 / 手改 schema 与历史迁移 / 列表接口加 `total` / 驼峰权限点            | 迁移不可复现；破坏全局口径                         | `bun run db:generate`；见 W5 与 README「贯穿全项目的口径」           |
| 用 mock db 测并发、用"当前时间+1 小时"构造用例、只测正常路径                        | 测不出真问题、换环境就飘、幂等与并发缺陷上线才暴露 | 真库 + 相对偏移 + 正常/重放/并发/边界四条（见[测试策略](/quality/)） |
| 契约断言只落在 mock 上                                                              | mock 与实现分叉时无人发现（S11）                   | 断言落到真实实现                                                     |
| 延伸阅读：[测试策略与验收标准](/quality/) · [构建 · 部署 · 运维](/quality/deploy) · |
| [预约主链路实现](/backend/booking) · [小程序 app 域实现](/backend/app-domain) ·     |
| [相关文档与资料库](/appendix/related-docs)。                                        |
