---
title: 后台前端（Vue 3）
---

# 后台前端（Vue 3）

本页覆盖 `web/` 的**技术栈、请求层、菜单驱动路由、列表页统一模式、上传与预览、金额时间口径**与复杂交互要点。页面清单见 [后台页面与权限点清单](/frontend/pages)。

## 技术栈与构建

`web/package.json`（`packageManager: bun@1.4.0`）：

| 依赖 | 版本 | 用途 |
| --- | --- | --- |
| `vue` / `vue-router` / `pinia` | `^3.5.30` / `^5.0.3` / `^3.0.3` | 框架 / 路由 / 状态 |
| `vite` / `typescript` / `vue-tsc` | `^8.0.0` / `^6` / `^3.2.6` | 构建与类型检查 |
| `lew-ui` | `^2.8.2` | UI 组件库（`LewTable` / `LewForm` / `LewModal` / `LewDialog` / `LewUpload`） |
| `unocss` | `^66.6.7` | 原子类 |
| `echarts` | `^6.0.0` | 图表（只在首页用） |
| `axios` / `dayjs` / `lucide-vue-next` | `^1.13.2` / `^1.11.13` / `^0.534.0` | 请求 / 时间 / 图标 |
| `marked` + `dompurify` | `^18.0.12` / `^3.4.15` | AI 页 Markdown 渲染 |
| `unplugin-auto-import` / `unplugin-vue-components` | `^21.0.0` / `^31.0.0` | 自动导入 |

```json
"scripts": {
  "dev": "vite --port 5173 --open",
  "build": "vue-tsc --noEmit && vite build",
  "preview": "vite preview", "lint": "oxlint", "fmt": "oxfmt",
  "typecheck": "vue-tsc --noEmit"
}
```

产物目录在 `web/vite.config.ts` 显式指定：`outDir: path.resolve(import.meta.dirname, '../output/web')` → **`output/web`**。

```ts
// web/vite.config.ts
resolve: { alias: { '~/': `${path.resolve(import.meta.dirname, 'src')}/` } },
server: { port: 5173, proxy: { '/api': { target: 'http://localhost:3000', changeOrigin: true } } },
plugins: [
  AutoImport({ imports: ['vue', 'vue-router', '@vueuse/core'], dts: './types/auto-imports.d.ts', dirs: ['./src/composables'], vueTemplate: true }),
  UnoCSS(), Vue(),
],
```

::: tip `dirs: ['./src/composables']`
`src/composables/**` 的 `useTable` / `useFormat` / `useDict` / `useImagePreview` / `useUploadImagePreview` 是**自动导入**的；`src/utils/**`（`withPassThroughRule` / `confirmDanger` / `toUploadItems` …）**不是**，要显式 import。
:::

## 请求层（`web/src/request.ts`）

`.env.development` 与 `.env.production` 都是 `VITE_API_BASE_URL=/api/v1`；开发时 Vite 把 `/api` 代理到 `localhost:3000`。

```ts
const request = axios.create({ baseURL: import.meta.env.VITE_API_BASE_URL, timeout: 15000 });
```

导出 `get` / `post` / `patch` / `put` / `del` / `upload`，**响应直接返回 `data`**（后端无统一包裹层）。请求拦截器注入 `Authorization` 并给每个请求带一个 `request-id`：

```ts
// src/request.ts:35
// 每次请求带一个请求号：后端 Fastify 用它当 reqId 写日志、并回填进异常响应
config.headers['request-id'] = crypto.randomUUID();
```

`ApiError` 会带上 `requestId` —— 用户报「付了钱但没到账」时，客服凭一个号就能在服务端日志里定位那次请求。

### 401 自动刷新 + 并发排队

```ts
// ---------- 刷新排队 ----------
let refreshing: Promise<string> | null = null;
const pendingQueue: PendingCallback[] = [];
function flushQueue(token: string | null) { while (pendingQueue.length) pendingQueue.shift()?.(token); }
```

`refreshOnce()` 用一个模块级 Promise 做全局去重：并发请求共享同一次刷新；成功 `flushQueue(token)`，失败 `flushQueue(null)` + `useUserStore().reset()` + `window.dispatchEvent(new CustomEvent('auth:logout'))`（用事件解耦，避免循环依赖 router）。响应拦截器重放一次：

```ts
// src/request.ts:159
if (status === 401 && config && !config._retried && !skipRefresh) {
  config._retried = true;
  try {
    const token = refreshing ? await refreshing : await refreshOnce();
    config.headers = { ...config.headers, Authorization: `Bearer ${token}` };
    return request(config);
  } catch { return Promise.reject(new ApiError(401, '登录已过期，请重新登录')); }
}
```

- `NO_REFRESH_URLS = ['/auth/login', '/auth/refresh', '/auth/register']` 不走自动刷新；
- `_retried` 保证**只重放一次**，避免 401 循环；
- 多标签页竞态：刷新失败且 localStorage 里的 token 已变（被别的标签页轮换消耗）时**再试一次**（`src/request.ts:82`）；
- 刷新失败广播 `auth:logout`，由 `main.ts` 统一 `reset()` + `window.location.href = '/login'`。

`formatMessage(error)` 统一文案：字段校验数组用 `；` join；超时 → `请求超时，请稍后重试`；无 response → `网络异常，请检查网络连接`；401/403/404/≥500 各有固定文案。所有错误 `LewMessage.error()` 后 reject。

### token 存储（`store/user.ts`）

| 值 | 位置 | 原因 |
| --- | --- | --- |
| `accessToken` | **仅内存**（`ref`） | 更安全；刷新页面后靠 refreshToken 换回 |
| `refreshToken` | `localStorage`（`REFRESH_TOKEN_KEY = 'manicure:refresh-token'`） | 后端通过 body 返回，无 httpOnly cookie |

`hasPermission(required)` 支持 `'a:b:c'` 精确匹配与 `'*:*:*'` 通配（`isSuperAdmin`）。

## 路由与菜单

### 菜单 seed 驱动路由

**前端路由由后端菜单树生成，不要手改 `router/index.ts`**（它只有静态基础路由）：

```ts
// web/src/router/index.ts
export const constantRoutes = [
  { path: '/login', name: 'login', component: () => import('../views/login/index.vue'), meta: { title: '登录' } },
  { path: '/', name: 'layout', component: () => import('../layouts/default.vue'), redirect: '/dashboard',
    children: [ /* dashboard、profile */ ] },
  { path: '/403', name: 'forbidden', component: () => import('../views/error/403.vue') },
  { path: '/:pathMatch(.*)*', name: 'not-found', component: () => import('../views/error/404.vue') },
];
```

动态注册在 `router/guard.ts` 的 `beforeEach`：

```ts
let dynamicRoutesAdded = false;
if (!dynamicRoutesAdded) {
  const records = await permissionStore.generateRoutes();
  records.forEach((record) => router.addRoute('layout', record));
  dynamicRoutesAdded = true;
  void userStore.fetchProfile().catch(() => undefined);
  // 不能直接 return { ...to }：刷新时首个导航会命中兜底路由，to.name 为 "not-found"，
  // 按 name 重定向会再次命中兜底路由导致 404，必须只保留 path/query/hash
  return { path: to.path, query: to.query, hash: to.hash, replace: true };
}
```

`store/permission.ts` 负责 `RouteNode` → `RouteRecordRaw`：`const viewModules = import.meta.glob('../views/**/*.vue')`，把 `component`（如 `system/users/index`）解析成 `../views/system/users/index.vue`；`type === 'F'`（按钮）直接 `return null`；目录节点（无 `component`）只作布局容器；找不到组件时 fallback 到 404 页。

::: warning 三个必须知道的注意点
1. **刷新页面靠模块级 flag `dynamicRoutesAdded`**：它在内存里，刷新后必然为 `false`，所以每次刷新都重新拉菜单并注册路由 —— 这就是上面那段「按 path 重新解析」存在的原因；
2. **`accessToken` 只在内存**：刷新后 `generateRoutes()` 会 401 → 请求层自动刷新换回 token 并重放 → 导航成功。所以 guard 对「有 refreshToken 但无 accessToken」是**先放行**；
3. **权限变更后必须重新登录或刷新**：`permissions` 来自 accessToken 的 JWT payload，当前会话不会自动感知。
:::

### 按钮级权限

```ts
// web/src/directives/permission.ts（main.ts 里 app.directive('permission', permission)）
export const permission: Directive<HTMLElement, string | string[]> = {
  mounted(el, binding) {
    const userStore = useUserStore();
    if (!binding.value) return;
    if (!userStore.hasPermission(binding.value)) el.parentNode?.removeChild(el);   // 无权限直接移除
  },
};
```

用法 `v-permission="'biz:payment:create'"` 或数组（任一命中即可）；组件版见 `components/IconButton.vue`。**权限点字符串必须与 `src/database/seed/menus.ts` 完全一致**。

## 列表页统一模式

```ts
// web/src/composables/useTable.ts
/**
 * 通用表格分页逻辑
 * 后端分页响应无 total 字段，通过多取一条判断 hasMore 估算 total
 */
async function fetchPage(page = currentPage.value) {
  const data = await get<PageResult<T>>(options.url, { page, pageSize: pageSize.value + 1, ...extraQuery });
  const list = data.items.slice(0, pageSize.value);
  hasMore.value = data.items.length > pageSize.value;
  items.value = options.transform ? options.transform(list) : list;
  currentPage.value = data.page;
}
const total = computed(() => hasMore.value
  ? currentPage.value * pageSize.value + 1
  : (currentPage.value - 1) * pageSize.value + items.value.length);
```

::: danger 后端分页响应**没有 `total`**
`PageResult` 是 `{ items, page, pageSize }`。自己写分页组件并请求 `total` 会永远拿到 `undefined`。小程序端同理（`GET /app/bookings` 的注释也写了「无 `total`」）。
:::

### 约定四件套

| 约定 | 怎么做 | 为什么 |
| --- | --- | --- |
| **`formKey` 重建表单** | 打开弹窗前 `formKey.value += 1`，模板 `:key="formKey"` | 强制重建 `LewForm`，避免上一次编辑的脏状态残留 |
| **`setForm` 回填** | `void nextTick(() => formRef.value?.setForm?.({...}))` | 必须在 `nextTick` 里，等重建后的组件挂载完 |
| **`formOptions` 包 `withPassThroughRule`** | `const formOptions = withPassThroughRule([...])` | 否则非必填 + 真值字段会刷 `The schema does not contain the path: xxx` |
| **`confirmDanger` 二次确认** | 见下 | 危险操作统一防重入 |

### 逐条对照一个真实页面

`web/src/views/biz/credit-accounts/index.vue`：

```ts
/** 表单 key：每次打开弹窗自增，强制重建 LewForm 以回填数据 */
const formKey = ref(0);

const formOptions: LewFormOption[] = withPassThroughRule([
  { field: 'name', label: '主体名称', as: 'input', rule: "Yup.string().required('不能为空')", props: { placeholder: '如 XX 公司 / 张三', clearable: true } },
  { field: 'type', label: '类型', as: 'select', rule: "Yup.string().required('不能为空')", props: { options: TYPE_OPTIONS } },
  { field: 'customerId', label: '关联顾客', as: 'select',
    visible: (formData) => formData.type === 'customer',      // 只有「顾客」类型才需要关联档案
    props: { options: customerOptions, clearable: true } },
  { field: 'creditLimit', label: '额度(元)', as: 'input-number', tips: '0 = 不限额度', props: { min: 0, precision: 2 } },
  { field: 'settleDay', label: '月结日', as: 'input-number', tips: '1~28，0 = 不定期', props: { min: 0, max: 28 } },
  { field: 'status', label: '状态', as: 'switch' },
]);

function openEdit(row: CreditAccount) {
  editingId.value = row.id;
  formKey.value += 1;
  modalVisible.value = true;
  void nextTick(() => {
    formRef.value?.setForm?.({
      ...,
      creditLimit: row.creditLimit / 100,      // 分 → 元
      status: row.status === 'active',         // 枚举 → switch 布尔
    });
  });
}
```

模板侧（同文件）：`<LewForm ref="formRef" :key="formKey" :options="formOptions" v-model="form" />` + `<IconButton v-permission="'biz:credit:create'" @click="openCreate" />`。

`confirmDanger`（`web/src/utils/confirm.ts`）两个实现细节：

1. **不能用 `onOk`**：注释写明「当前安装的 lew-ui 版本的 `LewDialog.warning()/normal()` 等方法不支持 `onOk` 回调……传 `onOk` 会被忽略，导致点确认后不执行任何动作」。改用 `footerButtons` 的确认按钮 `request` 触发回调；
2. **内置防重入**（`let running = false`）：「收银结算 / 退款审批 / 应收销账都走这个弹窗，全是**资金写操作**，重复请求会造成重复建单、超额销账。这里挡在公共出口，各页不必各写一遍。」

## 加载态与过渡（`AppLoading`）

**`web/src/components/AppLoading.vue`** 是唯一的加载占位组件（lew-ui 2.8.2 没有 `LewLoading` / `LewSkeleton`）。三种形态按「内容会不会被销毁」区分：

| `variant`  | 场景 | 内容 |
| --- | --- | --- |
| `skeleton` | 首屏（列表 / 详情 / 统计卡） | 加载中**隐藏**内容，由骨架撑开高度 |
| `spinner`  | 首屏，高度不固定的小区域 | 同上，居中转圈 + 文案 |
| `overlay`  | **刷新 / 局部重载** | 半透明遮罩盖住旧内容，内容**始终挂载** |

```vue
<!-- 首屏骨架：卡片形、4 行、最矮 220px -->
<AppLoading variant="skeleton" shape="card" :rows="4" min-height="220px" :loading="queueLoading">
  <MyList />
</AppLoading>

<!-- 刷新遮罩：图表 / 表单这类「重建就会坏」的内容必须用它 -->
<AppLoading class="app-card p-5" variant="overlay" text="加载图表数据…" :loading="loading">
  <div ref="chartRef" class="h-260px" />
</AppLoading>
```

实现要点（踩过的坑）：

1. **内容用 `v-show` 而不是 `v-if`**，否则每次「加载一下」都会把插槽重建 —— echarts 实例、表单焦点、滚动位置全丢；图表还会因为 `display:none` 容器拿到 0×0 画布。
2. **内容包裹层是 `display: contents`**，所以外面给的 flex / grid 布局类直接作用到插槽内容上，中间不多一层盒子。反过来说：插槽里若是「靠外层 `gap` 排版的一组行内元素」，布局类要给到 `<AppLoading>` 自己（`class="flex flex-col gap-2"`），否则它们会退化成同一段行内文本。
3. `overlay` 的遮罩用 `color-mix(...)` 铺一层半透明底 + 中心胶囊，**不靠给内容降 opacity**（`display: contents` 的盒子没有透明度可言）。
4. 占位与内容**交叉淡入**：`.app-swap-leave-active` 在离场时把元素 `position:absolute`，避免两段高度打架。

配套的全局动画在 `web/src/styles/index.css`：`.app-skeleton`（骨架微光）、`.app-swap-*`（占位↔内容）、`.app-fade-*`（弹层遮罩）、`.app-rise-in`（列表逐条入场，延迟由内联 `--app-stagger` 控制），末尾统一带 `prefers-reduced-motion: reduce` 兜底。

**收银台的展开动画**是这套的组合用法：外层容器 `flex` + `transition-[width,margin,opacity] duration-350 ease-[cubic-bezier(0.22,1,0.36,1)]`（宽度用 `calc(100%_-_316px)` 精确对齐，两边插值相加恒等于 100%），两块面板再用**内联样式**做「迟到滑入」—— 面板上挂着 `app-card`（自带 `transition-shadow`），和 class 版 `transition-[...]` 同权重，谁生效取决于产物 CSS 顺序，内联最稳。

## 文件与图片上传

`web/src/api/files.ts` 是唯一入口：`uploadFile(file)` → `POST /files/upload`；`filePreviewUrl(id)` = `.../files/:id/download?inline=1`（可直接塞 `<img src>`，下载接口是 `@Public()`）；`fileDownloadUrl(id)`。**上传只要登录态，不需要额外权限点**。

`LewForm` 原生支持 `as: 'upload'`（底层 `LewUpload`）：

```ts
// web/src/views/biz/service-items/index.vue
async function uploadImage(params: { fileItem: LewUploadFileItem; setFileItem: (patch: Partial<LewUploadFileItem>) => void }) {
  const { fileItem, setFileItem } = params;
  const file = fileItem.file;
  if (!file) return;
  try {
    const uploaded = await uploadFile(file);
    setFileItem(toUploadedItem(fileItem.key, filePreviewUrl(uploaded.id), fileItem.name));
  } catch {
    setFileItem({ key: fileItem.key, status: 'fail', percent: 0 });
  }
}

{ field: 'images', label: '图片', as: 'upload', tips: '第一张作为封面',
  props: { multiple: true, limit: MAX_IMAGES, accept: IMAGE_ACCEPT, viewMode: 'card',
           maxFileSize: MAX_UPLOAD_FILE_SIZE, uploadHelper: uploadImage } }
```

三个必须用的工具模块：

| 模块 | 内容 |
| --- | --- |
| `~/utils/upload-images` | `toUploadItems`（反显）/ `toUploadedItem`（上传回填）/ `toImageUrls`（提交，只挑 `complete`、`success`）/ `toSingleImageUrl`（单图字段，无图返回 `null`） |
| `~/utils/upload-limits` | `MAX_UPLOAD_FILE_SIZE = 10 * 1024 * 1024`（与后端 `MAX_FILE_SIZE` 一致）；`IMAGE_ACCEPT` |
| `~/utils/form` | `withPassThroughRule` + `PASS_THROUGH_RULE = 'Yup.mixed()'` |

::: danger 不要手写 `{ key, status: 'complete', percent: 100, url }`
`url` 必须过 `toDisplayImageUrl()` 归一化。`web/src/utils/image-url.ts` 写明了原因：lew-ui 判断「能不能当图片渲染」用的是 **url 是否以图片扩展名结尾**，而预览地址是 `/api/v1/files/:id/download?inline=1` —— 不以扩展名结尾 ⇒ 渲染成**文件图标**。这就是「编辑时**原有**图片能看见、**新传**的图片是个文件图标」的真正原因。归一化做法是给显示态地址补无害参数 `__img=.png`，提交前 `stripDisplayImageUrl()` 剥掉。
:::

::: warning `IMAGE_ACCEPT` 别写 `image/*`
「手机相册里的 `.heic` / `.avif` 不在后端白名单里，必然失败。明确列 `image/jpeg` 还有个好处：iOS 会在上传前把 HEIC **自动转成 JPEG**。」
:::

### 图片预览：全站只有一个查看器

`web/src/App.vue` 上挂全局单例 `<ImageViewer />`；入口是 `openImagePreview(urls, startIndex, '图集名')`（`~/composables/useImagePreview`，空数组自动忽略、下标越界自动夹回）。

1. **表单里 `as: 'upload'` 的缩略图，lew-ui 2.8.2 本身不可点** → 用 `useUploadImagePreview(hostRef, () => urls, () => title)` 接管点击（`views/biz/service-items/index.vue:247`）；
2. **不要用 `window.open` / `<a target="_blank">`**，也不要在页面里另摆一套预览弹窗。

## 金额与时间口径

**金额**：后端单位是**分**。各 biz 页面都有自己的 `yuan2fen`（提交前）与 `centsToYuan`（回填/展示，`/ 100`）。前端**不做折扣 / 抵扣计算** —— 后端一律 `Math.floor` 向下取整，前端算出来会差 1 分，必须以服务端返回为准。

**时间**：后端存 UTC，前端统一按 `Asia/Shanghai` 展示（`web/src/composables/useFormat.ts`）：

```ts
dayjs.extend(utc); dayjs.extend(timezone);
// 系统面向中国大陆：所有时间统一按东八区（北京时间）展示，
// 避免浏览器/服务器时区差异导致写入时间看起来"错位 8 小时"
dayjs.tz.setDefault('Asia/Shanghai');
export function formatDateTime(value, template = 'YYYY-MM-DD HH:mm:ss'): string {
  if (!value) return '-';
  return dayjs(value).tz().format(template);
}
export function formatSize(bytes: number): string { ... }
```

可约时段接口返回的就是带 `+08:00` 的 ISO8601，直接展示即可。**枚举**一律以后端枚举值为准，前端只维护中文文案映射。

## 复杂交互

### 收银台（`web/src/views/biz/cashier/index.vue`）

**未选中单据时队列独占整页**（卡片按屏宽铺成 1/2/3 列），点一张单据后队列收成 300px 窄栏、右侧「单据金额明细 + 支付区」整体推展开；标题栏的收起按钮回到整页队列。实现要点：外层用 `flex` 而不是 grid（`grid-template-columns` 的 `1fr ↔ 300px` 浏览器不可插值），队列 `w-full ↔ w-300px`、右侧容器 `w-0 ↔ w-[calc(100%_-_316px)]`（316 = 300 队列 + 16 间距），两边线性插值相加恒等于 100%，动画期间不跳宽；收起态靠 `w-0 + overflow-hidden + opacity-0 + pointer-events-none` 收干净（只写 0 宽不够：`p-4 + border` 会把盒子撑到 34px）。

三栏：待收款队列 → 单据金额明细 → 支付区（混合支付可加多行）。核心是**扫码收款：3 秒轮询 + 5 分钟倒计时**：

```ts
function startPolling(paymentId: number) {
  stopPolling(); qrFailures.value = 0;
  pollTimer = window.setInterval(() => { void pollStatus(paymentId); }, 3000);
}
async function pollStatus(paymentId: number) {
  if (qrStatus.value !== 'pending') return;
  try {
    const data = await getPaymentStatus(paymentId);
    qrFailures.value = 0; qrStatus.value = data.status;
    if (data.status === 'success') { stopPolling(); stopTick(); qrVisible.value = false; await Promise.all([reloadSelected(), loadQueue()]); }
    else if (data.status === 'closed' || data.status === 'failed') {
      // 通道侧已定局：停轮询 + **明确告知** + 刷新单据
      stopPolling(); LewMessage.warning(data.status === 'closed' ? '该支付单已关闭，请重新获取二维码或改现金收款' : '...支付失败...');
      await Promise.all([reloadSelected(), loadQueue()]);
    }
  } catch {
    // 轮询失败静默重试；连续失败 5 次后停止，避免错误提示刷屏
    qrFailures.value += 1; if (qrFailures.value >= 5) stopPolling();
  }
}
```

三个要点：

1. **`codeUrl` 不是图片地址**：「微信 Native 给的是 `weixin://wxpay/bizpayurl?pr=...`、支付宝给的是 `https://qr.alipay.com/...`，两者都不是图片，必须按文本展示（需二维码渲染库才能画成码）」—— 页面用正则判断后才当 `<img>` 渲染；
2. **关弹窗前主动查一次**：「关掉弹窗**不等于**这笔没付：顾客可能刚扫完码。关闭前主动查一次通道，否则这笔只能等后端定时查单（最长 2 分钟），期间店员很可能再收一次钱」；
3. **倒计时**用 `expireAt` 算剩余秒数（缺省按 5 分钟），每秒更新。

### 退款审批（`web/src/views/biz/refunds/index.vue`）

默认只看 `pending`；弹窗展示**判责依据**（命中规则、距开始时间、扣减金额），数据来自 `POST /biz/refunds/preview`；金额可改但**必须填原因**（后端 schema 的 `reason` 是 `min(2).max(200)` 必填）；「驳回」用**独立 `formKey`** 的弹窗（同文件 345 行注释）。申请按钮 `v-permission="'biz:refund:apply'"`，审批走 `biz:refund:approve`。

### 报表（`web/src/views/biz/reports/index.vue`）

6 个页签（`REPORT_TABS`：概览 / 营收 / 项目 / 美甲师 / 会员 / 应收）对应 `REPORT_ENDPOINTS` 的 6 个路径；页头固定标注 `REVENUE_CAVEAT = '营收 = 实收，已扣退款'`；响应字段用宽松类型承接（`ReportPayload`），配合 `reportNumber` / `reportText` / `reportRows` / `reportScalars` 做 camelCase / snake_case 容错读取。导出走 blob：

```ts
// `GET /biz/reports/export` 需要带 Bearer token，而 `window.open` 无法附带 Authorization 头（会 401），
// 因此这里走 axios（`~/request` 已注入 token）拿 blob 再本地下载。
const response = await request.get<Blob>('/biz/reports/export', { params: { format: 'csv', ...query }, responseType: 'blob', timeout: 60000 });
```

::: tip ECharts 只在首页
`echarts` 只在 **`web/src/views/dashboard/index.vue`** 里用，且**按需引入**（`echarts/core` + `BarChart/LineChart/PieChart` + `CanvasRenderer`）。生命周期：`onMounted` 里 `echarts.init(ref)`、`useEventListener(window, 'resize', handleResize)` 里 `chart?.resize()`、`onUnmounted` 里 `dispose()`。另有一个细节：「侧边栏折叠/展开会改变主区宽度（不触发 window resize），等过渡(200ms)结束后再让图表自适应」。

**报表页 `biz/reports/index.vue` 没有图表**，是纯表格 + 导出。想加图表时照抄首页的按需引入 + dispose 模式。
:::

## 相关页面

- 全部页面与权限点清单（含「新增一个页面」的完整步骤）：[后台页面与权限点清单](/frontend/pages)
- 小程序端：[小程序架构与主题系统](/frontend/miniapp)、[小程序页面与接口映射](/frontend/miniapp-pages)
- 后端路由与 RBAC：[鉴权 · RBAC · 数据权限](/backend/auth-rbac)
