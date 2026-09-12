# 踩坑记录 · 小程序（微信原生 TS）

> **用法**：改小程序代码前先扫一眼本文件；踩到新坑并解决后，**立刻**在下面追加一条。
> 格式固定：**现象 → 根因 → 正确做法 → 怎么发现的**。

---

## 1. 图标样式全部失效、图标撑满全屏：**不要用 `Add-Content` 追加 WXSS**

- **现象**：给页面 wxss 追加一段样式后，**整页渲染错乱** ——
  `.menu__icon` 实际尺寸变成 **320×240**（声明是 40rpx），而 app.wxss 的类正常。
  大括号、注释都配平、无 BOM、无编译告警。
- **根因**：用 `Add-Content -Encoding UTF8` 追加会破坏整份样式表
  （具体字节层原因未定论，但可稳定复现）。
- **正确做法**：整份用 .NET 写回：
  `[System.IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding($false)))`。
- **决定性诊断**：**别靠截图判断**（连看两次会以为是「渲染抖动」）——
  用 `automation_element_action --action size --selector '.menu__icon'` **量元素实际尺寸**，
  一次定性；再 `git checkout -- <file>` 回退该 wxss 对照，立刻确认是它。

---

## 2. `<image>` 不渲染图标（静默失败）

- **现象**：图标位置空白，页面只剩文字，**没有任何报错**。
- **根因**：小程序 `<image>` **不解析 URL 编码的 SVG data-URI**。
- **正确做法**：SVG 一律转 **base64**（`utils/icons.ts` 内联了一个 ASCII base64 编码器）。
- **怎么发现的**：逐个替换成 base64 后图标出现，反推出是编码问题。

---

## 3. 不认目录导入

- **现象**：页面全白，控制台 `module 'api.js' is not defined, require args is '../api'`。
- **根因**：小程序模块解析**不做 Node 式目录解析**（不找 `index.ts`）。
- **正确做法**：写全路径 `'../../api/index'`。
- **怎么发现的**：控制台报错直接指出。

---

## 4. `this.data.x` 与 `this.x` 不能混用

- **现象**：`TS2339: Property 'bookingId' does not exist on type 'Instance<...>'`。
- **根因**：`Page({ data: { bookingId } })` 里的字段**只能** `this.data.bookingId`；
  只有**实例属性**（写在 `data` 之外）才 `this.x`。
- **正确做法**：要 `this.x` 就声明成实例属性（如 `targetBookingId: 0`）；
  要在 WXML 里用就必须放 `data`（WXML 读不到实例属性）。
- **怎么发现的**：tsc 直接报。

---

## 5. WXML 里写 markdown 星号会**原样渲染**

- **现象**：页面上出现 `**重要**` 这种字面星号。
- **根因**：WXML 没有 markdown。
- **正确做法**：要强调用样式或「」引号；改完**全站扫一遍**：
  `Select-String -Path pages\*\*.wxml -Pattern '\*\*'`。
- **注意**：注释里的 `**` 不影响渲染，只需清用户可见文本。

---

## 6. 未登录不要显示成「加载失败」

- **现象**：未绑定手机号时，页面把 401 的 message 当 `errorText` 显示，顾客以为系统坏了。
- **根因**：把「未登录」与「加载失败」混成同一个字段。
- **正确做法**：
  - **未绑定就不发请求**（明知 401 还打只会让 console 变红）；
  - 用**独立的 `guest` 标志**，不复用 `errorText`；
  - 文案区分「登录后查看」与「绑定手机号后查看」；
  - 统一走 `store/session.ts` 的 `requireSession({ needBind, reason })`，
    并让登录页**显示原因**（否则用户不知道凭什么要登录）。
- **怎么发现的**：逐页梳理登录态时统一处理（共 10 个页面）。

---

## 7. 被引导到登录页后「来回弹」

- **现象**：未绑定时点「去登录 / 绑定」→ 登录页 → 点「微信一键登录」→
  **回到原页又被拦** → 再来登录页。
- **根因**：微信登录只做 `ensureLogin()` 然后 `goBack()`，
  而「需要绑定」的场景**登录了也还不满足**。
- **正确做法**：登录成功后若本页是被带 `reason` 引导来的且仍未绑定，
  **留在本页**提示「还需绑定手机号才能继续」，不要 `goBack`。
- **怎么发现的**：**把整条引导链路真走了一遍**（分看两段代码各自都是对的）。

---

## 8. 验证手段：tabBar 页 / 草稿依赖页 / 需模式的页

- **现象**：`simulator_open_page` 到不了三类页面，截图会**截到上一个页面**（看起来像「没生效」）。
- **正确做法**：
  | 场景 | 手段 |
  | ---- | ---- |
  | tabBar 页 | `automation_navigate --action switchTab --url /pages/xxx/index` |
  | 草稿依赖页（预约/确认） | **真走一遍**：款式库 → 点 `.list-card__add` → 点 `.action-bar .btn` |
  | 需切模式的页（工作台） | 我的 → 点 `.staff-block__btn` |
  | 读页面数据 | `automation_evaluate` + `getCurrentPages()` → `p.data`（比截图确定） |
  | 读元素文本 | `automation_element_action --action text --selector ...` |
- **注意**：`automation_evaluate` 传**长 JS 会被 cmd 的引号处理截断**
  （报 `missing ) after argument list`）→ 拆成「curl 打真接口 + 极短 JS 回填」两步。

---

## 9. 前端展示要与服务端**同口径**

- **现象**：选券列表里出现「满 100 元」的券，而订单只有 88 元 ——
  预估显示减 20，**提交时被服务端 409 拒绝**。
- **根因**：前端只按「可用」筛券，没有按**等级折扣后**金额过滤门槛。
- **正确做法**：门槛按**折后金额**判（与核销处同一口径）；
  已选券若变为不满足门槛就地清掉；不可选的券要**计数并解释**
  （「另有 N 张券未达到使用门槛」），而不是让它凭空消失。
- **怎么发现的**：端到端验证时顺手看了下页面数据是否合理，而不是只看「功能通了」。

---

## 10. 预览报 `SyntaxError: Unexpected token ?`：`??` 没有被降级

- **现象**：`无效的文件: api/index.js, 108:26 SyntaxError: Unexpected token ?`，
  预览直接打不开（报错显示的是**编译后**的行号，所以和源文件行号对不上）。
- **根因**：两个设置叠加 ——
  1. `miniapp/tsconfig.json` 的 `target: ES2020` → `??` / `?.` **原样保留**；
  2. `project.config.json` 的 `es6: false` + `enhance: false` → 开发者工具**不做** Babel 降级。

  于是产物 JS 里带着 `??`，小程序编译/运行时直接语法报错。
- **正确做法（两层，缺一不可）**：
  1. **`project.config.json` 里打开 `"enhance": true`（增强编译）** ——
     这才是**真正解决问题的那一层**：开发者工具的 TS 插件**不会**按 tsconfig 的
     `target` 降级语法，必须靠增强编译做 Babel 降级；
     （社区答案里说的「启用 glass-easel」本项目**早已满足**（`app.json` 的
     `componentFramework: glass-easel`），所以那不是缺的那一环。）
  2. **同时把 tsconfig 的 `target` 降到 `ES2019`**（`lib` 保持 `ES2020`）——
     这层不影响开发者工具，但让 `tsc`/CI 侧的产物也一致，属于双保险。

  > ⚠️ **我第一版只做了第 2 层就宣称修好了**（并且在自己的模拟器里确实没复现）——
  > 因为模拟器那次编译基于 `tsc` 的降级结果。真实预览仍然报错。
  > **教训：只在我自己的模拟器里验证「语法兼容性」是不够的，预览/真机走的是同一套
  > 编译配置，但缓存与工具链状态可能不同；声称修好前要按用户的实际路径复验。**
- **区分两件事（很容易混）**：
  - `??` / `?.` 是**语法** → tsc **会**降级；
  - `Array.prototype.flatMap` / `Object.fromEntries` 等是**运行时 API** → tsc **只降级语法、
    不替换 API**，老基础库上会 `undefined`。
  本项目原有一处 `flatMap`（`pages/slots/index.ts`），已改成显式循环。
- **验证方式**（两条都要）：
  1. 编译到临时目录再 grep 产物：
     `tsc -p miniapp/tsconfig.json --outDir <tmp> --rootDir miniapp/miniprogram`，
     然后搜 `??` / `?.`（应为 0）；
  2. 开发者工具里 `debug_clear_cache --action cleanCompileCache` → 重新编译 → 看 console。
- **坑里还有个小坑**：**注释里不要写该运算符的字面量**，否则第 1 步的 grep 会命中注释、
  当成漏网的语法（本会话就误报过一次，白查一轮）。已把注释改写成「空值合并运算符」。
- **怎么发现的**：用户预览报错；先量规模（`??` 60 处 / 28 文件），再定位到编译设置。

---

## 11. `wx.getSystemInfoSync` 已弃用，而 vendored 类型包里没有新 API

- **现象**：控制台每进一次页面就刷
  `wx.getSystemInfoSync is deprecated. Please use wx.getSystemSetting/wx.getAppAuthorizeSetting/wx.getDeviceInfo/wx.getWindowInfo/wx.getAppBaseInfo instead.`
  （调用栈指向各页面的 `onLoad` / `applyNavMetrics`）。
- **根因**：
  1. 代码里用 `wx.getSystemInfoSync()` 取 `statusBarHeight` / `windowWidth`（**4 个页面各写一遍**）；
  2. 想改用新 API 时发现**类型包里没有** —— 本仓库的
     `miniapp/typings/types/wx/lib.wx.api.d.ts` 是从 miniprogram-api-typings 拷来的**旧版**
     （854 KB 那个），`getWindowInfo` / `getDeviceInfo` / `getAppBaseInfo` / `getSystemSetting`
     **全都没有声明**，所以当初才用了旧接口。
- **正确做法**：
  1. **补声明**（`Wx` 接口在 `declare namespace WechatMiniprogram` 下，可声明合并）：
     新增 `miniapp/typings/types/wx/lib.wx.api.modern.d.ts`，只声明用到的字段；
  2. **收成一个工具函数** `miniapp/miniprogram/utils/metrics.ts` 的 `getNavMetrics()`：
     优先 `wx.getWindowInfo()`，**老基础库**才回退到旧接口
     （回退分支在老库上走，那时本来也没有弃用告警）；
  3. 4 个页面改为调它 —— 顺带消掉了「同一段取法抄 4 遍、兜底口径容易漂」的问题。
- **验证**：开发者工具清编译缓存 → 重新编译 → 依次进入 4 个页面 →
  控制台里 `deprecated` 与 `getSystemInfoSync` 均 **0 条**，且页面正常渲染。
- **注意**：**弃用告警会淹掉真问题**。这次就是它先出现、语法错误后出现，
  两件事混在一起时容易只盯一个。控制台应当保持「零告警」。

---

## 12. token 只活 15 分钟，而 401 只清 token 不重登 → 应用「卡死」必须重启

- **现象**：小程序开着一段时间后，**每个页面都报 `Unauthorized`**，杀掉重开就恢复正常。
- **根因（两个叠加）**：
  1. app token 的 TTL 是 **15 分钟**（后端 `expiresIn: "15m"`）；
  2. `utils/request.ts` 遇到非 `needBind` 的 401 只做 `clearAuth()`，
     而**没有任何地方会重新登录** —— `ensureLogin()` 只在 `app.ts` 的 `onLaunch` 调用一次；
     更糟的是 `ensureLogin()` 的判断是 `isLoggedIn()`，**只看 token 在不在、不看有没有过期**，
     所以「带着过期 token 启动」时它也会直接跳过。

  于是 token 一过期就进入死状态：清掉 → 不再登录 → 每次请求都 401。
- **正确做法**：非 `needBind` 的 401 → 清 token → **重新登录 → 原请求重试一次**
  （**只重试一次**，否则后端撤权会变成 401 死循环）。
  - **不能在 `request.ts` 里 import `store/auth`**：`auth → api → request` 会成环
    （`utils/token.ts` 开头就解释过这个依赖方向问题）。用 `setReauthHandler()` 注册回调
    **反转依赖**，由 `store/auth` 在模块初始化时把 `ensureLogin` 注册进来；
  - 并发 401 的去重靠 `ensureLogin()` 里已有的 `loginPromise`。
- **怎么发现的**：用户报真机 401 → 查本地 storage 发现**没有 token**、
  而控制台**没有**「静默登录失败」日志 → 反推出「清了但没人重登」。
- **为什么之前一直没发现（这条最值得记）**：
  历次验证我都是**手动 `wx.setStorageSync` 塞一个新的有效 token**，
  从来没走过「token 过期」这条路。**用手工种数据代替真实流程，会掩盖真实缺陷。**
- **验证方法（细节决定成败）**：必须让**新的 JS 上下文读到那个坏 token**，否则测不出来：
  1. `wx.setStorageSync('manicure:token', 'garbage')`；
  2. **`simulator_refresh`** —— 重置模块级缓存，但**保留 storage**
     （先用一个探针 key 证明 storage 不被清，否则无法区分「自愈」与「被清后重新登录」）；
  3. 进页面 → 期望 **自愈**：`items>0`、`err=none`，且 storage 里的 token
     变成**真实 JWT 长度**（几百字符）。
