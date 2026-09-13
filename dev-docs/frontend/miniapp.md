---
title: 小程序架构与主题系统
---

# 小程序架构与主题系统

本页覆盖 `miniapp/` 的**工程结构、请求层与 token 管理、主题系统（7 套预设 + 10 色自定义色板）、双模式 TabBar、页面工厂与加载状态机**。页面清单与接口映射见 [小程序页面与接口映射](/frontend/miniapp-pages)。

## 工程结构

```
miniapp/
├── project.config.json      # miniprogramRoot = miniprogram/；useCompilerPlugins: ["typescript"]
├── tsconfig.json            # strict + noUnusedLocals + noUnusedParameters；typeRoots: ./typings
├── typings/                 # miniprogram-api-typings
└── miniprogram/
    ├── app.ts / app.json / app.wxss
    ├── config.ts            # API_BASE + SHOP 门店常量
    ├── api/                 # index.ts（调用层，页面只依赖这里）+ types.ts
    ├── store/               # auth.ts / mode.ts / session.ts / draft.ts
    ├── theme/               # presets.ts + theme.ts
    ├── utils/               # request / token / page / load / tabbar / nav / color / icons / ...
    ├── custom-tab-bar/      # 自定义 TabBar
    └── pages/<name>/        # 每页 4 件套 index.{ts,json,wxml,wxss}
```

```json
// miniapp/miniprogram/app.json（节选）
{
  "componentFramework": "glass-easel",
  "lazyCodeLoading": "requiredComponents",
  "style": "v2",
  "window": { "navigationStyle": "default", "navigationBarTextStyle": "black", "navigationBarTitleText": "美甲小铺",
              "navigationBarBackgroundColor": "#FBF5F0", "backgroundColor": "#FBF5F0" },
  "tabBar": { "custom": true, "list": [ /* 5 项，两种模式全部注册 */ ] }
}
```

| 配置 | 作用 |
| --- | --- |
| `componentFramework: "glass-easel"` | 新版组件框架 |
| `lazyCodeLoading: "requiredComponents"` | **按需注入**，只加载当前页面用到的组件 |
| `tabBar.custom: true` | 自定义 TabBar（见「双模式 TabBar」） |
| `style: "v2"` | 新版组件样式 |

### 编译与类型检查

`miniapp/package.json` **没有任何 scripts**（只有 `devDependencies` 里的 `miniprogram-api-typings`）。编译走**微信开发者工具**：`project.config.json` 的 `setting.useCompilerPlugins: ["typescript"]`、`minifyWXSS/minifyWXML: true`、`libVersion: "trial"`、`appid: "wx3d640f2645cb5dea"`。类型检查用 `miniapp/tsconfig.json` 的严格配置（`strict` + `noImplicitAny` + `noUnusedLocals` + `noUnusedParameters` + `noImplicitReturns`），可在 IDE 里跑 `tsc --noEmit`。

::: warning 模块导入必须写**显式文件路径**
`api/index.ts` 头部：「导入本模块必须写**显式文件路径** `'../api/index'`／`'../../api/index'`：小程序的模块解析**不支持目录导入**，`'../../api'` 会被编译成 `require('../../api')` 并在运行时抛 `module 'api.js' is not defined`（已实测）。这一点与 Node/TS 的默认解析行为不同，新增页面时最容易踩。」
:::

## 请求层

### `config.ts`

```ts
/** 后端 API 基址（`API_PREFIX=api/v1`，端口取自根 .env 的 PORT=3000） */
export const API_BASE = 'http://192.168.0.100:3000/api/v1';
export const REQUEST_TIMEOUT = 10000;
```

::: warning 这个 IP 是**会变的**（DHCP）
唯一权威值是 [`miniapp/miniprogram/config.ts`](https://github.com/zyhnbyyds/manicure-project/blob/master/miniapp/miniprogram/config.ts) 里的 `API_BASE`。
2026-09 就因为 DHCP 换号（`.101` → `.100`）踩过一次：老地址连不上，现象是**「目标计算机积极拒绝」**——
那不是防火墙（防火墙是超时），而是**那个 IP 上根本没有我们的服务**（`.101` 后来成了别的设备）。
连不上先核对本机 IP，再怀疑代码：

```powershell
Get-NetIPAddress -AddressFamily IPv4 |
  Where-Object { $_.IPAddress -notlike '127.*' -and $_.PrefixOrigin -eq 'Dhcp' }
```
想一劳永逸：在路由器上给这台机做 **DHCP 保留**。
:::

::: tip 为什么写局域网 IP 而不是 `127.0.0.1`
「模拟器里两者都能用，但**真机上 `127.0.0.1` 指向手机自己**，必然连不上……**挑「有默认网关」的那张网卡** —— VMware / Hyper-V / 蓝牙的虚拟网卡也能通，但手机连不上。换网络后 DHCP 可能改号，需要改这里。」
:::

**真机联调三件事**（`config.ts` 逐条写明）：① 手机与电脑连**同一个 Wi-Fi**；② 手机打开**调试模式**（跳过合法域名校验）；③ **Windows 防火墙放行入站 3000**。

```powershell
# 管理员 PowerShell；只放行同网段，别开成任意来源
New-NetFirewallRule -DisplayName "manicure dev API 3000 (LAN)" -Direction Inbound `
  -Protocol TCP -LocalPort 3000 -RemoteAddress LocalSubnet -Action Allow -Profile Any
```

> 快速自检：用**手机浏览器**打开 `http://<局域网IP>:3000/api/v1/health`，能看到 JSON 就说明网络通了
> （在本机浏览器自测是**测不出防火墙**的）。


取本机局域网 IP：`Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' }`

### `utils/request.ts`

```ts
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';   // 注意：wx.request 没有 PATCH
export interface RequestOptions { path: string; method?: HttpMethod; data?: Record<string, unknown>; auth?: boolean }
```

| # | 行为 | 实现 |
| --- | --- | --- |
| 1 | 注入 `Authorization: Bearer <token>` + `request-id` | `newRequestId()`（小程序无 `crypto.randomUUID`，用时间戳 + 随机串） |
| 2 | **401 + `needBind` 不清 token** | `needBind` 是「已登录但未绑定手机号」，不是登录态失效 |
| 3 | **其它 401 自动重登 + 重试一次** | 见下 |
| 4 | `501` 统一转「这个功能马上就来啦～」 | JSAPI 支付等骨架被点到时优雅落地 |

```ts
/**
 * ## 为什么要有「自动重登」
 *
 * app token 的 TTL 是 **15 分钟**。原本的实现在 401 时只做 `clearAuth()`，而**没有任何地方
 * 会重新登录**（`ensureLogin()` 只在 `app.ts` 的 `onLaunch` 跑一次）。于是：token 一过期，
 * 每个请求都 401，**用户必须杀掉小程序重开才能恢复**。
 *
 * 现在的行为：非 `needBind` 的 401 → 清 token → **重新登录 → 原请求重试一次**；
 * 再失败才把错误交给页面。重试只做一次，避免 401 循环。
 */
```

依赖方向用「注册回调」反转，避免循环依赖（`store/auth → api/index → utils/request`；若 request 反过来 import `store/auth` 就成环）：`setReauthHandler(handler)` 由 `store/auth.ts` 在模块初始化时注册为 `() => ensureLogin()`。

### token 与静默登录

```ts
// utils/token.ts —— 单独成模块也是为了打断循环依赖
const TOKEN_KEY = 'manicure:token';
const CUSTOMER_KEY = 'manicure:customer-id';
export function getToken(): string | null { ... }              // 模块级缓存：undefined = 还没读过
export function getBoundCustomerId(): number | null { ... }
export function clearAuth(): void { setToken(null); setBoundCustomerId(null); }   // 不动主题偏好

// store/auth.ts
export function isLoggedIn(): boolean { return getToken() !== null; }   // 有 app token
export function isBound(): boolean { return getBoundCustomerId() !== null; }   // 已授权手机号

export function ensureLogin(): Promise<void> {
  if (isLoggedIn()) return Promise.resolve();
  if (loginPromise) return loginPromise;      // 首页/项目页/会员页同时触发只登一次
  loginPromise = (async () => {
    const code = await wxLogin();
    const result = await authApi.login({ code });
    setToken(result.accessToken); setBoundCustomerId(result.customerId);
    rememberStaffStatus(result.staffStatus);
  })();
  loginPromise.catch(() => { loginPromise = null; });   // 失败后允许重试，一次抖动不会永久卡住
  return loginPromise;
}

// app.ts
onLaunch() {
  initTheme();
  ensureLogin().catch((error) => console.warn('[manicure] 静默登录失败，进入仅浏览模式', error));
}
```

**没有独立登录页作为前置**：静默登录失败只降级为「仅浏览」（项目 / 美甲师 / 可约时段仍可看）。两层身份刻意分开 —— 未绑定**不是错误状态**。

### 会话门面（`store/session.ts`）

```ts
/**
 * 两种身份层次（与后端一致，别混为一谈）：
 * - **已登录** = 有 app token。可浏览项目/美甲师/时段；
 * - **已绑定** = 授权过手机号，`customer_id` 非空。可下单、看会员与订单。
 */
if (!(await requireSession({ needBind: true, reason: '预约需要绑定手机号' }))) return;
```

顺序刻意如此：**先试一次静默登录**（`ensureLogin` 有并发去重，很便宜）→ 仍不满足才 `goLogin({ reason })`。返回 `false` 时门面**已经做过引导**，调用方直接 return。

### 页面工厂（`utils/page.ts`）与加载状态机（`utils/load.ts`）

```ts
definePage({
  chromeIcons: PAGE_ICONS,          // 自动跟随主题生成图标
  data: { loading: true, items: [] },
  onShow() { void this.load(); },   // chrome 已经刷新过了，这里只写业务
  async load() { ... },
});
```

`definePage` 在**每次 `onShow`**（含首次）刷新主题 / 登录态 / 图标 + `syncTabBar(this)`，然后才调页面自己的 `onShow`。

::: danger 加载态四件套绝不能进 `onShow` 的刷新
「⚠️ **绝对不要把加载态（loading / refreshing / errorText / loaded）放进来。**」后果两个：① `onLoad` 里发请求的页面（`onLoad → onShow` 紧邻）**骨架屏会被立刻撤掉**；② `runLoad` 的 `loaded` 一直被重置 → 每次切回本页都判成「首屏」→ 又回骨架屏，整个状态机被抵消。
:::

`runLoad` 的四条语义：

| 时机 | loading | refreshing | 内容 |
| --- | --- | --- | --- |
| 首屏 | true | false | 骨架屏 |
| 已有数据再刷新 | false | true | **保留旧内容** |
| 首屏失败 | false | false | errorText → 错误态 + 可重试 |
| 刷新失败 | false | false | **保留旧内容** + toast |

数据源**整体换了**（如时段页换日期）要传 `force: true` 回骨架屏；`onPullDownRefresh` 一律用 `runPullDownLoad`（`finally` 保证下拉圈会停）。

## 列表页的工具栏一律吸顶（`.sticky-head`）

小程序页面用的是**原生滚动**（不是 `scroll-view`，因为要保留下拉刷新），所以顶部的搜索/筛选/页签**默认会跟着列表一起滚走**。列表一长，用户就再也够不着筛选，只能一路滚回顶部再滚回来 —— 这不是「不好看」，是**不能用**。

`app.wxss` 里定义了公共类 `.sticky-head`（`position: sticky; top: 0; z-index: 6; background: var(--c-bg)`），用法与三条铁律写在它的注释里：

```html
<view class="page" style="{{themeStyle}}">
  <view class="head sticky-head"><!-- 搜索 / 筛选 / 页签 --></view>
  <view class="page-body"><!-- 列表 --></view>
</view>
```

- **背景必须不透明**（sticky 不裁剪，透底会把滚过去的列表透出来）；
- 滚动容器到它的每一级祖先都**不能有 `overflow`**，否则 sticky 被困在那个盒子里；
- 别用 `position: fixed`：`.anim-rise` 会加 `transform`，而带 transform 的祖先会成为 fixed 的包含块（`app.wxss` 末尾记过这个坑）；
- 工具栏**在 `.page-body` 之外**时，自己带左右内边距，并把紧随其后的 `.page-body` 的 `padding-top` 置 0，间距才与改动前一致。

当前状态（2026-09 排查过一遍）：

| 页面 | 工具栏 | 状态 |
| --- | --- | --- |
| `services` 款式库 | 搜索 + 分类/排序 | ✅ 吸顶（用户反馈「筛选框滚走了」） |
| `bookings` 我的预约 | 搜索 + 状态筛选 | ✅ 吸顶 |
| `staff-bookings` 我的预约（工作台） | 日期条 + 状态筛选 | ✅ 吸顶 |
| `coupons` 优惠券 | 可用/已用/过期页签 | ✅ 吸顶 |
| `notices` 消息 | 页签 + 全部已读 | ✅ 吸顶 |
| `staffs` 选美甲师 | 已选款式摘要 | ✅ 早就吸顶（`.summary`，本次未动） |
| `favorites` 收藏 / `points` 积分 | 分类胶囊 | ⚠️ **故意不吸顶** —— 这两个页面的分类**还没接上筛选**（点了只 toast「待接口接入」），先别给死控件做吸顶 |

另外一条同源的可用性问题：**固定底栏会盖住列表最后一屏**。带 `.action-bar` 的 13 个页面里，只有款式库漏了给列表补 `padding-bottom: 200rpx`（它是有条件出现的，所以跟着 `selectedCount` 走，没选款式时不留空白）。

## 主题系统

### 7 套预设

`theme/presets.ts`（每套只给 5 个值，其余全部派生）：

| id | name | emoji | primary | accent | bg | text |
| --- | --- | --- | --- | --- | --- | --- |
| `softlight`（默认 `DEFAULT_PRESET_ID`） | 柔光玫瑰 | 🌹 | `#B45F6B` | `#D8B4A6` | `#FBF5F0` | `#2D221E` |
| `strawberry` | 草莓奶昔 | 🍓 | `#FF8BA7` | `#FFC2D1` | `#FFF5F8` | `#4A2C36` |
| `peach` | 蜜桃气泡 | 🍑 | `#FF9E7D` | `#FFD3A5` | `#FFF7F2` | `#4A3328` |
| `taro` | 紫芋波波 | 🍠 | `#A98BF5` | `#D9C8FF` | `#F8F5FF` | `#362B4A` |
| `mint` | 薄荷奶绿 | 🌿 | `#4FC9A0` | `#B7EBD8` | `#F2FBF7` | `#23443A` |
| `sky` | 天空棉花糖 | ☁️ | `#6FB6FF` | `#BBDCFF` | `#F3F8FF` | `#24384F` |
| `lemon` | 柠檬芝士 | 🍋 | `#F5C242` | `#FFE79A` | `#FFFBF0` | `#4A3C1E` |

`softlight` 是设计稿配色（`docs/design.png` 像素采样）。10 色自定义色板 `CUSTOM_PALETTE`：樱花粉 / 珊瑚橘 / 蜂蜜黄 / 抹茶绿 / 海盐青 / 宝石蓝 / 鸢尾紫 / 莓果紫红 / 奶茶棕 / 雾感灰。

> 「限定色板（而不是自由取色）是刻意的：这套色都能和白色卡片、深色正文配出合格对比度，自由取色很容易挑出『白字看不清』的主色，反而伤可用性。」

### 令牌命名与派生

令牌是**语义名**，摊平成 WXSS 自定义属性时统一加 `--c-` 前缀、驼峰转 kebab：

```ts
// theme/theme.ts
export function toStyleString(input: ThemeTokens): string {
  return Object.entries(input).map(([key, value]) => {
    const kebab = key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
    return `--c-${kebab}:${value}`;
  }).join(';');
}
```

| 令牌 | 派生规则 |
| --- | --- |
| `--c-primary` / `--c-primary-soft` / `--c-primary-deep` | 主色 / `mix(primary, card, 0.14)` / `darken(primary, 0.2)` |
| `--c-on-primary` | `readableOn(primary)` → `#FFFFFF` 或 `#000000`（WCAG 相对亮度 > 0.62 用黑） |
| `--c-accent` / `--c-accent-soft` / `--c-chip-bg` | 强调色 / `mix(accent, card, 0.35)` / `mix(accent, card, 0.22)` |
| `--c-bg` / `--c-bg-soft` / `--c-card` | 预设背景 / `mix(primary, card, 0.04)` / 预设卡片色（预设均为 `#FFFFFF`） |
| `--c-text` / `--c-text-sub` / `--c-text-weak` | 正文 / `mix(text, card, 0.56)` / `mix(text, card, 0.34)` |
| `--c-border` | `mix(text, card, 0.09)`（中性暖色，避免整页泛粉） |
| `--c-shadow` / `--c-shadow-strong` | `withAlpha(text, 0.06)` / `withAlpha(text, 0.1)` |
| `--c-gradient` | `linear-gradient(135deg, lighten(accent,0.45) 0%, lighten(primary,0.78) 100%)` |

派生全走 `utils/color.ts`：`normalizeHex` / `mix` / `lighten` / `darken` / `withAlpha` / `luminance` / `readableOn`。**自定义主色走同一套规则**（`buildTokensFromCustom`：`accent = lighten(primary, 0.42)`、`bg = mix(primary, '#FFFFFF', 0.07)`、`text = mix(primary, '#2B2B2B', 0.24)`），避免「预设好看、自定义翻车」。

### 导航栏联动、持久化与对外 API

```ts
function syncChrome(input: ThemeTokens): void {
  try {
    // 设计稿的导航栏是**奶油底色 + 深色标题**（不是主色底白字），
    // 所以这里用 bg 作底色、黑色作前景；主色只留给按钮与价格。
    wx.setNavigationBarColor({ frontColor: '#000000', backgroundColor: input.bg, fail: () => {} });
  } catch { /* 忽略：导航栏不是关键路径 */ }
}
```

`app.json` 的 `navigationBarBackgroundColor: "#FBF5F0"` 就是 `softlight` 的 `bg` —— 首帧与主题一致，不闪。

持久化 key 是 `manicure:theme`，**只存两个字段**（`presetId` + `customPrimary`），足以重建整套令牌；`restore()` 对非法值容错（保持默认）。

对外 API：`initTheme()`（`app.onLaunch` 调一次）/ `getThemeState()` / `getThemeTokens()` / `themeStyle()`（页面根节点挂 `style="{{themeStyle}}"`）/ `setPreset(id)` / `setCustomPrimary(hex)` / `resetTheme()` / `subscribe(listener)`。**刷新路径**：页面靠 `definePage` 的 `onShow` 重取；自定义 TabBar 是常驻组件，用 `subscribe`。

### TabBar 也吃令牌

`custom-tab-bar/index.ts` 的 `refresh()` 里 `themeStyle: themeStyle()`、`iconsIdle: buildIcons(TAB_ICONS, tokens.textWeak)`、`iconsActive: buildIcons(TAB_ICONS, tokens.primary)`。图标是**内联 SVG**（`utils/icons.ts` 的 `buildIcons(names, color)`），不是位图。

## 双模式 TabBar

```ts
// custom-tab-bar/index.ts
const CUSTOMER_TABS = [ {pages/index/index,首页}, {pages/bookings/index,预约}, {pages/mine/index,我的} ];
const STAFF_TABS    = [ {pages/staff-workbench/index,工作台}, {pages/staff-bookings/index,我的预约}, {pages/mine/index,我的} ];
```

`app.json` 的 `tabBar.list` 里**两种模式的路径都注册**（5 项，`pages/mine/index` 共用）。原因：「`wx.switchTab` 只认里面出现过的路径」，真正「显示哪几个」由组件按模式决定。

### 「模式只是偏好，能不能进工作台由服务端授权决定」

```ts
// store/mode.ts
/**
 * 关键取舍：**模式只是「偏好」，能不能进工作台由服务端说了算**。
 * 所以 `getMode()` 可能返回 `'staff'`，但 `isStaffMode()` 仍然是 `false`
 * （授权还是 pending / 已经被停用）。这样店长撤权后，小程序下一次 `onShow`
 * 就自动落回顾客模式，不需要额外的同步逻辑，也不会让人卡在空白页。
 */
export function getMode(): AppMode { return wx.getStorageSync(MODE_KEY) === 'staff' ? 'staff' : 'customer'; }
export function isGranted(): boolean { return getStaffStatus() === 'active'; }
export function isStaffMode(): boolean { return getMode() === 'staff' && isGranted(); }
export function demoteToCustomer(): void { if (getMode() === 'staff') setMode('customer'); }
```

授权状态只从**登录响应**（`staffStatus`）与**手机号绑定响应**来；每次进工作台页面时再用 `GET /app/staff/me` 复查（401/403 即失效）。服务端的表达方式见 [小程序 app 域实现](/backend/app-domain)。

| 判断时机 | 谁来判断 |
| --- | --- |
| 应用启动 | `app.onLaunch` → `initTheme()` + `ensureLogin()`（登录响应回填 `staffStatus`） |
| 每次页面 `onShow` | `definePage` → `syncTabBar(this)` → TabBar 的 `refresh()` |
| TabBar 点击 | `onTap()`：乐观更新高亮 → 在途保护 → `switchTab` |
| 进工作台页面 | `GET /app/staff/me` 复查；403 → `demoteToCustomer()` |

::: danger TabBar 的两个真实 bug（改动前必读）
`custom-tab-bar/index.ts` 的注释：

> **① 高亮必须由「真实路由」算，不能由页面报上来。** 组件是**每个 tab 页各有一个实例**：新页面的实例带着 `currentRoute: ''` 出生，`attached` / `pageLifetimes.show` 里算出 `findIndex === -1` → 退回 `selected: 0`。结果：人在「我的」，高亮却在「首页」。
>
> **② 有了错位的高亮，`index === selected` 的提前 return 就会把点击吞掉。**

→ 现在 `refresh()` 自己读 `getCurrentPages()` 一次算清（`selected: index >= 0 ? index : this.data.selected`，找不到也**保留当前高亮**）；点击只对「真实当前页」短路，且短路时顺手校准高亮。图标两态**同时渲染靠透明度交叉淡入**（`iconsIdle` / `iconsActive`），不要换 `src`（会闪白）。
:::

## 与后端交互的约定与坑

1. **app 域 token**：所有 `/app/**` 带 `Authorization: Bearer <token>`；登录接口传 `auth: false`。
2. **401 分两种**：`needBind` → 不清 token，引导绑定；其它 401 → 清 token → 自动重登 → 原请求重试**一次**。
3. **`501` 不是错误**：请求层转成「这个功能马上就来啦～」。
4. **`wx.request` 没有 PATCH**：需要 PATCH 语义时让后端补一个 POST 动作端点，**不要在客户端硬塞**（类型层就会拦下来）。
5. **列表响应没有 `total`**：`{ items, page, pageSize }`。
6. **接口调用只走 `api/index.ts`**：页面不直接碰 `request()`；`api/types.ts` 是返回类型契约。

::: danger 门店信息目前是**前端常量**
```ts
// config.ts
/**
 * ⚠️ **应该来自后端**：app 域目前没有「门店档案」接口（如 `GET /app/shop`），
 * 所以先集中在这里 —— 改一处即可全局生效；等后端补了接口再换成请求。
 */
export const SHOP = { name: '美甲小铺', nameEn: 'BEAUTY NAILS', hours: '10:00 - 20:00', phone: '13800000000', ... };
```
门店名 / 电话 / 地址 / 营业时间改动需要重新发版。
:::

## 已知限制与 TODO

出处：代码注释与 `project-design/HANDOVER-miniapp.md`。

| 项 | 状态 | 出处 |
| --- | --- | --- |
| **JSAPI 支付** | 后端 `POST /app/payments/wxpay/jsapi` 仍 **501**（P2 接通道）；支付页保留完整调用位 | `api/index.ts`、§11.4 |
| **微信真凭据** | `.env` 未配 `WX_MINIAPP_APPID/SECRET`，开发期用 `WX_MINIAPP_FAKE=true`（**生产强制失效**）；上线前必须配真凭据 | §11.4 |
| **真实微信链路** | `code2Session` / `getPhoneNumber` **完全没跑过真接口**（缺 AppSecret） | §2.2 |
| **订阅消息模板** | 未申请（H10）；台账能记、发不出去 | §5、表注释 |
| **优惠券建单接线** | `redeemForBooking()` 与 `quoteBooking` 的券支持已实现，**只差建单事务接线**；已勘察未实施 | §10 |
| **核销二维码** | 不伪造（动态码必须服务端签名，否则客户端可离线造码）；现用卡号作凭据 | §9.4 |
| **取消扣费金额** | app 域读不到判责规则（在 `RefundPort.preview`），取消页只写原则 | §9.4 |
| **用户协议 / 隐私政策正文** | 需门店主体信息与手机号用途声明，**提审前必须替换** | §9.4 |
| **真机验证** | 需人工扫码/操作；本轮以 `miniprogram-automator` 自动化为主 | §9.4 / §13.5 |
| **会员卡页促销区 `.catch`** | 接口失败会被静默降级成「暂无可领的券」；下次应把「加载失败」与「确实没有」区分开 | §11.4 |
| **`biz_booking.coupon_id` 外键** | 未加（与 `biz_customer_coupon.used_booking_id` 会形成互相 SET NULL 的环） | §11.4 |
| **AppID** | `project.config.json` 是 `wx3d640f2645cb5dea`；`HANDOVER` §5 记录的是接口测试号 —— **上线前需人工确认** | 两处不一致 |

## 相关页面

- 29 个页面与接口映射、三条端到端链路：[小程序页面与接口映射](/frontend/miniapp-pages)
- 后端 app 域（认证、守卫、授权模型）：[小程序 app 域实现](/backend/app-domain)
- 后台前端：[后台前端（Vue 3）](/frontend/)
