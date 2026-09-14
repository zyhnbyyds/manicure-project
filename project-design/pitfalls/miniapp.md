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
  | 场景                    | 手段                                                                 |
  | ----------------------- | -------------------------------------------------------------------- |
  | tabBar 页               | `automation_navigate --action switchTab --url /pages/xxx/index`      |
  | 草稿依赖页（预约/确认） | **真走一遍**：款式库 → 点 `.list-card__add` → 点 `.action-bar .btn`  |
  | 需切模式的页（工作台）  | 我的 → 点 `.staff-block__btn`                                        |
  | 读页面数据              | `automation_evaluate` + `getCurrentPages()` → `p.data`（比截图确定） |
  | 读元素文本              | `automation_element_action --action text --selector ...`             |
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

---

## 13. 前端硬编码「服务端配置」+ 单位混用（同一份规则两份实现必然漂移）

- **现象**：确认预约页预估的「积分抵扣」与服务端算出来的对不上；
  极端情况下**顾客少看抵扣、却多花积分**。
- **根因（两个独立问题叠加）**：
  1. **上限硬编码且两边不一样**：小程序写 `MAX_POINTS_PERMILLE = 500`，
     而 web 与后端默认都是 `300`（`biz.member.maxPointsPermille`）
     → 小程序预估的抵扣**比服务端允许的多**；
  2. **单位混用**：`maxByPoints = Math.floor(points / 100)` 得到的是**元**，
     却与「分」为单位的 `maxByRatio` 取 `min` → 抵扣额小了 **100 倍**；
     而发给服务端的 `pointsToUse` 又是第三套算法（`pointsDisc * 100`）。
- **正确做法**：
  - **上限从服务端取**：`GET /app/member/me` 的 `maxPointsPermille`（前端只留兜底常量）；
  - **换算严格照 `src/modules/biz/common/money.ts`**：
    `pointsToCents = floor(积分 / rate) × 100`、`centsToPoints = ceil(金额分 / 100) × rate`
    （`rate` = `pointsDiscountPerYuan`，默认 100，即 100 积分 = 1 元）；
  - **web 侧 `views/biz/bookings/index.vue` 的写法是正确的参照**，小程序照它对齐。
- **怎么发现的**：核对「小程序 500 vs web 300」这个常量差异时顺出来的 ——
  **同一份服务端规则在前端存在两份实现，就是漂移的温床；能问服务端就别自己写。**
- **回归**：后端加了用例钉住换算与上限（`b7-app-booking-detail`：
  500 积分 = 减 500 分；申请 10000 积分按 300‰ 收敛到 3000 分，**超限不报错**）。

## 14. 接口返回的图片是相对路径，绑到 `<image src>` 会「空白」而不是报错

- **现象**：后台给美甲师传了头像，小程序「选美甲师」页那一圈还是空的（也不是兜底图，就是白）。
- **根因**：app 域接口返回的是相对地址 `/api/v1/files/12/download?inline=1`。
  小程序把**以 `/` 开头**的地址当**包内文件**（`/assets/...` 那种），于是既没走网络、
  也没报错，只是渲染不出来。`pages/staffs/index.wxml` 里就漏了这一层：
  `src="{{item.avatar}}"`，而其它页面（首页 / 服务详情 / 时段页）早就统一用
  `item.avatarResolved`（`utils/present.ts` 的 `resolveStaffAvatar` →
  `absoluteAssetUrl` 拼绝对地址 + 没图时给兜底图）。
- **正确做法**：
  - 页面只绑 **`*Resolved`** 字段（`avatarResolved` / `imageResolved`），不要直接绑接口原值；
  - 新增这类字段时，先想清楚「空值给什么」——`resolveStaffAvatar` 永远返回可用地址，
    所以模板里连 `wx:else` 兜底分支都不需要；
  - 排查口诀：**小程序里图片空白 = 先看 src 是不是相对路径**。
- **来源**：实测（做「美甲师头像上传」时顺手排查到：后台上传没问题，是小程序这一页绑错了字段）。

## 15. 地址已经拼成绝对 URL，图片**还是**空白：后端 helmet 的 `Cross-Origin-Resource-Policy: same-origin`

- **现象**：按 §14 修完（`imageResolved` = `http://192.168.0.101:3000/api/v1/files/10/download?inline=1`），
  图片**依旧一片空白**，且**控制台/日志里什么都看不到**（不是 404，不是 500，不是域名校验）。
- **根因**：后端 helmet 全局下发 `Cross-Origin-Resource-Policy: same-origin`。
  而小程序 `<image>` 在**开发者工具里是由 `127.0.0.1:<port>` 的 pageframe 渲染**的
  （实证：相对路径时 devtools 日志打的是
  `onProxyError /__pageframe__/api/v1/files/10/download`），
  与 API 的 `192.168.0.101:3000` **不同源** → Chromium 把这条 no-cors 子资源请求**直接拦掉**。
  **`<img>` 跨源本来不需要 CORS**，但 **CORP 是专门拦这个的**。
- **正确做法**：`src/modules/files/files.controller.ts` 的 `download()` 里显式覆盖
  `Cross-Origin-Resource-Policy: cross-origin`（该接口本就 `@Public`，文件名是随机 UUID）。
  **不要**改全局 helmet 配置 —— 其余 API 应当继续留在 `same-origin`。
- **怎么确诊的（可复用）**：用 headless Chromium 做**四格对照**，一次定性而不是猜：
  ① 同源图 → LOAD；② 跨源**无** CORP 头 → LOAD；③ 跨源**带** CORP `same-origin` → ERROR；
  ④ 真实接口地址 → ERROR。修完再跑一遍 → ④ 变 LOAD。
  （做法：`chrome --headless=new --screenshot=... --window-size=...` 截一张写着四个 onload/onerror 结论的页面，
  用读图直接看清。`--dump-dom` 在本机被「已有浏览器会话」吞掉，别在这上面浪费时间。）
- **来源**：用户报「图片展示不出来」→ 读 devtools 日志确认第一层（相对路径）已修 →
  发现第二层是**完全不同的根因，症状却一模一样**。**同一个症状要查到「能证明它好了」，不能停在「看起来修对了」。**

## 16. 自定义 TabBar「切不动」：高亮下标不该由页面报、更不该拿它当点击闸门

- **现象**（用户原话）：「切换有点不顺畅，而且有时候切换页面切不动」。
  实测复现：人在**我的**，底部高亮却在**首页**；此时**点「首页」没有任何反应**。
- **根因（两层，缺一不可）**：
  1. 组件是**每个 tab 页各有一个实例**。新页面的 TabBar 带着 `currentRoute: ''` 出生，
     `attached` / `pageLifetimes.show` 里 `findIndex === -1` → **退回 `selected: 0`**；
     而页面 `onShow` 里的 `syncTabBar()` 只写 `currentRoute`、**不会重算 `selected`**
     （时序上 `pageLifetimes.show` 还早于页面自己的 `onShow`）→ 高亮永远停在下标 0。
  2. `onTap` 里有一句 `if (index === this.data.selected) return;` —— 高亮错位时，
     **点那个「被错误高亮」的 tab 正好命中这句提前 return**，于是点击被吞掉 = 切不动。
- **正确做法**：
  - TabBar **自己**读 `getCurrentPages()` 算真实路由（`refresh()` 一次算清主题+模式+高亮），
    不依赖任何页面配合；路由找不到时**保留当前高亮**，绝不退回 0；
  - 提前 return 的判据改成 `realRoute() === tab.pagePath`（真在当前页才短路，并顺手校准高亮）；
  - 点击先**乐观 `setData({selected})`**（高亮立刻跟手，`switchTab` 有延迟），
    再加 `switching` 在途保护 + `fail` 回调里 `refresh()` 校准并 toast —— 静默失败最糟。
- **怎么发现的**：用 `miniprogram-automator`（`cli auto --auto-port 9420`）驱动真机模拟器，
  直接 `getTabBar().onTap({currentTarget:{dataset:{index}}})` 打点，读出
  `{route: pages/mine/index, selected: 0}` —— **一行数据就定性了**，比截图猜快得多。
- **来源**：实测（复现 → 修复 → 6 次切换 + 连点回归全绿）。

## 17. 页面工厂的 `onShow` **不能**推全量 chrome，否则把加载状态机打回首屏

- **现象**：`onLoad` 里发起请求的页面，骨架屏闪一下就没了（先露一瞬空态）；切 Tab 回来
  仍然回骨架屏；刷新失败还会清空已有内容 —— 与 `runLoad` 承诺的语义**完全相反**。
- **根因**：`definePage` 注入的 `onShow` 每次 `setData(chrome())`，而 chrome 里含
  `loading: false, errorText: '', loaded: false`。生命周期是 `onLoad → onShow`，
  于是 `onLoad` 里刚 `setData({loading:true})` 就被 `onShow` 打回 false；
  且 `loaded` 每次被重置 → `runLoad` 永远判成「首屏」。
- **正确做法**：拆成两份 —— `pageChrome()`（**只用于 `data` 初始化**，含加载态四件套初值）
  与 `pageAppearance()`（`onShow` 每次只刷主题/登录态/图标）。
  **加载态四件套只在 `data` 里播一次种，之后就只归 `runLoad` 所有。**
- **来源**：子 agent 读代码时上报的推断（**没有运行时**也能推出来：`setData` 同步更新 `this.data`），
  父 agent 复核实证后修复。**分工时「不许改 utils」这条纪律的价值就在这里：越界改会把问题掩盖掉。**

## 18. `definePage` 的 chrome 配置项拼错 = 图标静默消失、tsc 还不报错

- **现象**：整页图标全没了，但没有任何报错。
- **根因**：`CustomOption = Record<string, any>`，拼错的键（如 `chromeIcon`）会被 `...rest`
  原样透传给 `Page()` 当成自定义方法吞掉 —— 类型系统在这里**帮不上忙**。
- **正确做法**：`definePage` 里加了防呆告警：`rest` 中以 `chrome` / `white` 开头但不在白名单的键
  直接 `console.warn`，把「静默」变回「一眼可见」。新增配置项时同步白名单。
- **来源**：实测（本轮重构真的写成了 `icons` 而文档/示例都是 `chromeIcons`，
  三个并行子 agent 里的一个在开工时发现并上报）。

## 19. 入场动画用了 `animation-fill-mode: both`，会把 `.press:active` 永久压掉

- **现象**：加了入场动画的元素，按下没有缩放反馈了。
- **根因**：`both` 让动画**末帧的 `transform` 一直生效**（`translateY(0) scale(1)`），
  动画声明优先级高于普通声明 → `:active` 的 `transform` 永远不生效。
- **正确做法**：入场动画统一 `backwards`（只在延迟期预置起始态，播完把 `transform` 还给元素）。
- **来源**：读 CSS 规范即可预判，但**只有「真的去按一下」才会发现**——所以 `.anim-*` 与 `.press`
  同时使用时必须肉眼验收一次。

## 20. 同一零件每页抄一份，必然漂移成 N 套

- **现象**：`.chip`（筛选胶囊）在 5 个页面各有一份，已经漂移成 3 套尺寸
  （高 58/60rpx、字号 24/25/26rpx、未选中文字色两种）；`.mini-btn` 3 套；`.tips` 8 处 margin/字号各不相同；
  `.empty__action` 15 处 3 种外边距。
- **根因**：不是有人改错了，而是**复制粘贴本身**——第 2 份时没人看得出，第 5 份时就没有「标准」了。
- **正确做法**：凡是**跨页面同形的零件**（筛选胶囊 / 小按钮 / 提示文字 / 空态按钮）一律进
  `app.wxss`，页面只保留**排布**（外边距交给容器）。本轮已把上述 4 类收归全局：
  **删掉约 30 个重复规则块**，`pages/*/index.wxss` 里再没有 `.chip` / `.mini-btn` / `.tips` / `.empty__action`。
- **排查手法（可复用）**：把所有 `pages/*/index.wxss` 的**类选择器**聚合成
  `选择器 → 出现在几个页面`，出现 ≥3 次的逐个看 —— 一眼就能看出哪些是真重复、哪些只是重名（如 `.hero`）。
- **来源**：用户要求「有通用的地方注意封装」，用上述脚本普查后统一。

## 21. 给「整块 `wx:else`」套入场动画，会把 `position: fixed` 的底栏顶飞

- **现象**（只在动画那 0.3 秒里出现）：底部 `.action-bar`（app.wxss 里是 `position: fixed`）
  先被摆到**内容底部**（可能在屏幕中段、也可能在视口外），动画一结束再「啪」地跳回屏幕底部。
- **根因**：祖先元素只要有 `transform`（动画/`will-change` 都会产生），就会成为
  `position: fixed` 后代的**包含块**。于是 fixed 不再相对视口定位，而是相对那个正在动的盒子。
- **正确做法**：动画挂在**内容容器**上（`.page-body xxx-body`），**不要把整块 `wx:else` 包成一个带
  `anim-rise` 的 view** —— 后者会把同级的 fixed 底栏一起圈进包含块。
  页面里没有 fixed 元素时（首页、款式库列表），包整块才是安全的。
- **排查手法（可复用）**：写个 10 行的**标签栈解析**扫一遍所有 wxml ——
  遇到 `.action-bar` 就回头看祖先链里有没有 `anim-*` / `press*`，一次扫出全部风险点，
  比逐页肉眼看来得可靠（本轮所有页面扫出来只有 1 处，即 `services` 的底栏**自己**带动画，那是安全的）。
- **来源**：并行重构的子 agent 主动提出并拒绝了「字面统一」的做法 ——
  **规范要跟着物理约束走，而不是反过来**。
