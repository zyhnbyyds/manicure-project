---
name: web-frontend
description: 后台前端：46 个页面清单、useTable + lew-ui 列表模式（formKey 重建 / setForm 回填 / v-permission / confirmDanger）、文件与图片上传（LewForm `as:'upload'` + uploadHelper）、菜单 seed 驱动路由、收银台与退款审批等复杂交互、时间与金额的展示口径。写任何 web/ 页面或组件时加载。
whenToUse: 新增/修改 web/src/views/biz 页面、API 封装、表单与权限按钮；做文件/图片上传与预览；实现收银台、退款审批、对账、报表页。
metadata:
  version: '1.4.0'
  spec: project-design/superpowers/specs/2026-09-11-nail-salon-booking-design.md
  sections: §10 / §9 / §3
---

# 后台前端

## 复用基线模式（不要自创列表实现）

- 列表：`useTable` + `LewTable` + `LewPagination`；**响应无 `total`**，`useTable` 多取一条判断 `hasMore`
  并估算总数。
- 表单弹窗：`LewModal` + `LewForm`，用 `formKey` 强制重建 + `setForm` 回填（避免脏状态）。
- 权限：`v-permission` 指令 / `<IconButton permission="...">`，权限点与后端 §8.1 完全一致。
- 删除：`confirmDanger`（危险操作二次确认）。
- 路由：菜单在后端 `seed/menus.ts` 里配（`M` 目录 / `C` 页面 / `F` 按钮），**前端路由自动生成，
  不要手改 `router/index.ts`**。

### 组件优先：lew-ui 有的就必须用（§10.2 / §10.3）

设计文档的取舍口径是「**lew-ui 无可直接复用的组件才自研**，且要在 §10.3 写明理由」
（排班周视图、预约日历就是这么留下来的）。所以别用裸 `div` / `button` + 原子类手搓
控件——先翻一遍 lew-ui 有没有现成的：

| 场景                     | 用什么                                                                       | 别用                                       |
| ------------------------ | ---------------------------------------------------------------------------- | ------------------------------------------ |
| 分段页签 / 视图切换      | `LewTabs`（`type="block"` + `round` 就是分段胶囊；`type="line"` 是下划线式） | 一排 `<button>` + 选中态原子类             |
| 状态 / 折扣 / 类型小标签 | `LewTag`（`type="light"` + `size="small"`，`color` 取 `LewColor`）           | `<span>` + 手写 `bg-[...light] text-[...]` |
| 金额输入                 | `LewInputNumber`（`:min="0"` `:step="0.01"`，`v-model` 是 **number**）       | `LewInput` + 字符串再 `Number()`           |
| 图标按钮                 | `<IconButton>`（项目组件，带 `permission`）                                  | 裸 `<button class="icon-btn">`             |
| 加载占位                 | `<AppLoading>`（见下）                                                       | 自己写骨架/转圈                            |

**目前没有对应组件的**（自研，别重复造）：加载骨架/转圈（`AppLoading`）、
周视图排班网格与预约日历（§10.3 已说明）、首字圆形头像（`LewAvatar` 只认 `src`，
全站 AppHeader / profile 都是首字 `<span>` 手搓的，保持一致）。

### `AppLoading`（`web/src/components/AppLoading.vue`）

lew-ui 2.8.2 没有 `LewLoading` / `LewSkeleton`，所以自己封了一个，三种形态按
**「内容会不会被销毁」**区分：

| `variant`  | 场景                         | 行为                                                                        |
| ---------- | ---------------------------- | --------------------------------------------------------------------------- |
| `skeleton` | 首屏（列表 / 详情 / 统计卡） | 隐藏内容，骨架撑开高度（`shape="line"` \| `"card"`、`:rows`、`min-height`） |
| `spinner`  | 高度不固定的小区域           | 转圈 + 文案（`align="start"` 可塞进一行文字里）                             |
| `overlay`  | **刷新 / 局部重载**          | 半透明遮罩盖住旧内容，**内容始终挂载**                                      |

```vue
<AppLoading
  variant="skeleton"
  shape="card"
  :rows="4"
  min-height="220px"
  :loading="queueLoading"
>
  <MyList />
</AppLoading>
```

- 内容用 `v-show` 不用 `v-if`：否则每次「加载一下」都重建插槽，echarts 实例、表单焦点、
  滚动位置全丢，图表还会在 `display:none` 容器里拿到 0×0 画布（首页 `renderChart()`
  因此挪到 `loading=false` + `nextTick()` 之后）；
- 内容包裹层是 `display: contents`，外面给的 flex / grid 布局类直接作用到插槽内容上；
  插槽里若是「靠外层 `gap` 排版的一组行内元素」，布局类要给到 `<AppLoading>` 自己；
- 配套全局动画在 `styles/index.css`：`.app-skeleton` / `.app-swap-*` / `.app-fade-*` /
  `.app-rise-in`（逐条入场，延迟由内联 `--app-stagger` 控制），末尾统一带
  `prefers-reduced-motion` 兜底。

两个实测坑：

1. **`LewTabs` 没有逐项插槽**：`LewTabsOption` 只有 `label / value / disabled`，
   所以「未收 3」这种带数量的标签只能拼进 `label` 字符串。
2. **宽度/间距类别写在 lew-ui 组件的 `class` 上**：lew-ui 自己的样式和 Uno 工具类同权重
   （都是单类选择器），谁生效看产物 CSS 顺序。实测 `.lew-tabs-wrapper` 自带
   `max-width:100%`，会盖掉 `class="max-w-420px"`（`app-card` 的 `transition-shadow`
   盖掉 `transition-[opacity,...]` 是同一个坑）。要限制尺寸就**套一层普通 div**，
   或走内联 `:style`。

## 展示口径（两端必须一致）

- **时间**：后端存 UTC，前端统一按 `Asia/Shanghai`（`web/src/composables/useFormat.ts`）展示；
  可约时段接口返回的就是带 `+08:00` 的 ISO8601，直接展示即可。
- **金额**：后端单位是**分**，前端 ÷100 展示；不要在前端做折扣/抵扣计算（服务端重算，前端只展示与二次确认）。
- **枚举**：状态、支付方式、流水类型等以后端枚举值为准，禁止前端自己映射成另一套字符串。

## 页面清单（业务 26 个，§10.1）

> 现状：`web/src/views/**` 下共 **46 个页面级 `.vue`**（业务 26 + 后台基座 18 + AI 面板 2）。
> 下面列的是**业务页面 26 个**（基座页见 `docs/admin/*`）；完整清单（含路由与权限点）
> 见开发者文档 `dev-docs/frontend/pages.md`。

基础与预约：`service-items`、`staffs`、`schedules`、`customers`、`bookings`
会员：`member-levels`、`recharge-plans`、`card-types`、`members`、`member-cards`
收银与账务：`cashier`、`payments`、`refunds`、`payment-diffs`
挂账：`credit-accounts`、`receivables`
运营：`points-goods`、`reviews`、`reports`、`commission-rules`、`commission-records`、
`recurrences`、`notice-templates`、`notice-logs`、`coupons`、`app-staff-grants`

> 美甲师可做项目不单独建页：放在「美甲师」详情抽屉里用多选项目组件维护（整体 PUT）。

## 复杂页面要点（§10.5）

| 页面                 | 要点                                                                                                                                                                                                                                                                                                                                                        |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **首页（经营概览）** | 自绘视图，**不跟 `useTable`**：自己 `watch(storeScope.activeStoreId)` + `watch(range)` 重拉 `GET /biz/reports/home`。金额卡按 **`meta.money`** 决定渲不渲染（前台拿到的是**没有金额字段**的响应，`v-if` 藏会留一排 `¥0.00`）。门店对比表**刻意不跟顶栏切换器**（恒看可见门店全量），点「查看」切店。图表用 `v-show` + `loading=false` 后 `nextTick` 再 init |
| **收银台**           | 三栏：待收款队列（未收 / 待收尾款 / 挂账）→ 单据金额明细 → 支付区（**混合支付可加多行**）。本期最复杂页面                                                                                                                                                                                                                                                   |
| 扫码收款             | 二维码 5 分钟失效；轮询 `/biz/payments/:id/status`；过期给「重新获取」与「改现金收款」两个出口                                                                                                                                                                                                                                                              |
| 退款审批             | 默认只看 `pending`；弹窗展示判责依据（命中规则、距开始时间、扣减金额）；金额可改但必填原因                                                                                                                                                                                                                                                                  |
| 对账                 | 差异按 `diff_type` 分色；处理完必须填备注，**不允许静默忽略**                                                                                                                                                                                                                                                                                               |
| 挂账台账             | 按主体聚合 + 账龄色阶；销账支持多笔混合并实时显示剩余额度                                                                                                                                                                                                                                                                                                   |
| 报表                 | 统一日期区间 + 导出；页头标注「营收 = 实收，已扣退款」，避免与"流水"混淆                                                                                                                                                                                                                                                                                    |
| 提成结算             | 结算前二次确认并显示期间总额与人数；结算后不可修改，只能冲销                                                                                                                                                                                                                                                                                                |
| 周期预约             | 创建前先预览"将要生成的日期列表"与冲突情况，再确认                                                                                                                                                                                                                                                                                                          |
| 会员详情             | 四个 Tab：档案 / 账务流水 / 次卡 / 预约历史；流水只读，充值退款按钮按权限显示                                                                                                                                                                                                                                                                               |
| 预约弹窗             | 选顾客后显示等级、折扣率、余额、可用次卡 → 服务端算价；**不在弹窗里新建顾客**                                                                                                                                                                                                                                                                               |

## 文件 / 图片上传（别自己造上传组件）

统一文件接口在 `web/src/api/files.ts`：`uploadFile(file)` → `FileItem`，
`filePreviewUrl(id)` = `.../files/:id/download?inline=1`（可直接塞 `<img src>`，下载接口是 `@Public()`），
`fileDownloadUrl(id)` 走附件下载。上传接口只要登录态，不需要额外权限点。

**LewForm 原生支持 `as: 'upload'`**（底层就是 `LewUpload`），一步拿到多选、拖拽、缩略图、
删除，不用自己写 `input[type=file]`（**注意：缩略图点击放大要自己接，见下**）：

```ts
{
  field: 'images',
  label: '图片',
  as: 'upload',
  props: {
    multiple: true,
    limit: 9,
    accept: 'image/*',
    viewMode: 'card',            // card = 宫格缩略图；list = 列表
    maxFileSize: 10 * 1024 * 1024,
    uploadHelper: uploadImage,   // 见下
  },
}
```

契约（`props` 原样透传给组件，表单值经 `v-model` 绑定）：

- `v-model` 的值是 `LewUploadFileItem[]`（`{ key, name?, url?, status?, percent?, file? }`）。
- `uploadHelper({ fileItem, setFileItem })` 被调用时自己上传，成功后**用 `toUploadedItem` 回填**：
  ```ts
  const uploaded = await uploadFile(file);
  setFileItem(
    toUploadedItem(fileItem.key, filePreviewUrl(uploaded.id), fileItem.name),
  );
  // 失败：setFileItem({ key: fileItem.key, status: 'fail', percent: 0 })
  ```
  **不要手写 `{ key, status: 'complete', percent: 100, url }`** —— `url` 必须过显示态归一化，
  漏了就是「反显的旧图正常、刚上传的图显示成文件图标」（真踩过，用户报过）。见「常见坑」。
- **表单内部存 `LewUploadFileItem[]`，接口收发的是 url 数组**，互转统一用
  `~/utils/upload-images` 的 `toUploadItems` / `toUploadedItem` / `toImageUrls`（有单测），
  提交前只挑 `status === 'complete' | 'success'` 的项，并剥掉显示标记再入库。
- **`formOptions` 必须用 `withPassThroughRule(...)` 包一层**（`~/utils/form`），
  否则控制台会刷 `The schema does not contain the path: images`。原因见「常见坑」。
- **单图字段**（美甲师头像等，接口要 `string | null`）：表单里同样存 `LewUploadFileItem[]`，
  但 `props` 用 `{ limit: 1, viewMode: 'card' }`（不要 `multiple`），提交前用
  **`toSingleImageUrl(items)`**（没有可用图片时返回 `null`，不是空数组/空串）。
- 上传相关的常量都在 `~/utils/upload-limits`：`IMAGE_ACCEPT`（**别写 `image/*`**：
  后端按扩展名白名单校验，`.heic`/`.avif` 必被拒；写 `image/jpeg` 还能让 iOS 自动转 JPEG）
  与 `MAX_UPLOAD_FILE_SIZE`（= 后端 10MB）。

## 图片预览：**全站只有一个查看器**（别自己写弹窗 / 别跳新窗口）

`~/components/ImageViewer.vue` 挂在 `App.vue` 上做**全局单例**，交互统一为：
底部缩略图切换、围绕指针缩放（滚轮 / 双指 / `+` `-`）、拖拽平移（拖不出边界）、
双击复位、`←` `→` / `Home` `End` 切换、`Esc` 关闭、失败可重试。

```ts
import { openImagePreview } from '~/composables/useImagePreview';

openImagePreview(urls, startIndex, '图集名'); // 空数组自动忽略；下标越界自动夹回
```

**不要**再用 `window.open` / `<a target="_blank">` 预览图片（会跳出后台丢上下文），
也不要在页面里另摆一套预览弹窗（同一件事两种做法 = 交互割裂）。
纯逻辑（下标回绕、锚点缩放、平移夹取、标题）在 `~/utils/image-viewer.ts`，有单测。

- 列表里展示图片：`customRender` 渲染缩略图 + 剩余张数徽标，点击 `openImagePreview(urls, 0, name)`。
- 表单里 `as: 'upload'` 的缩略图：**lew-ui 2.8.2 没有图片预览，缩略图点了没反应**（见
  `project-design/pitfalls/web.md` §8）。用 `useUploadImagePreview(hostRef, () => urls, () => title)`
  接管点击，别自己写「大图预览」缩略图带。

## 交互约定

- **不让用户手填内部 ID**：需要引用顾客 / 预约 / 美甲师等实体时，一律给
  「关键词输入 + 搜索 + 下拉选择」，选项里带上**人能认的字段**（姓名 / 手机号 / 单号 / 时间），
  不要把数据库主键做成 `input-number` —— 界面上既看不到也猜不出，
  用户只能先去别的页面翻 ID 再回来粘。
  - 顾客：`useCustomerOptions()`（`web/src/composables/useCustomerOptions.ts`），
    支持关键词搜索、`ensure()` 预置已知顾客、文案里标「无手机号 / 已入会」；
    `search(kw, size, { requirePhone: true })` 会把无手机号的选项置灰（入会场景用）。
  - 预约：`listBookings(1, 30, { keyword })` —— `keyword` 命中**单号 / 顾客姓名 / 手机号**。
  - 注意 `LewSelect` **没有 `search` 事件**（只有 change / blur / clear / focus / delete），
    所以远程搜索只能是「输入框 + 搜索按钮 + 下拉」，`searchable` 只是本地过滤。
  - 唯一例外：`staffs` 的「后台账号」在没有「用户管理」列表权限时退化为手填用户 ID ——
    刻意的降级，`tips` 里已写明原因。
- 预约创建返回 409（时段被占）→ **保留表单内容**、提示并自动刷新可约时段。
- 排班编辑：选美甲师 → 表格展示周一至周日各班次 → 弹窗编辑，**整体 PUT 提交**。
- 请假撞既有预约返回 409 + 受影响清单 → 先展示清单让店员处理，再二次确认 `force=true`。
- 周期单/未收款单在列表中要有明显标识（周期单默认不收预付款）。

## 验收

- 列表分页 / 筛选 / 空态正常；权限按钮按权限点显示与隐藏
- 28 个页面（含抽屉）都能在菜单生成的路由下打开，刷新不丢当前路由
- 金额与时间展示与后端口径一致（抽查一笔跨日、一笔带折扣、一笔混合支付）
- 收银台能完整走通：扫码 → 轮询 → 成功 → 单据金额刷新

## 常见坑

- 自己写分页组件并请求 `total` → 后端没有这个字段。
- 前端算折扣/抵扣 → 与服务端结果不一致；必须以服务端返回为准。
- 手改 `router/index.ts` → 菜单驱动的路由会与之冲突。
- 时间不做时区转换直接展示 → 偏 8 小时。
- 把 `LewUploadFileItem[]` 直接丢给接口 → 库里存进组件内部结构（`key` / `percent` / `file`）。
  必须转成 url 数组再提交。
- 提交时不过滤上传状态 → `pending` / `fail` / `wrong_size` 的半成品也会入库。
  只挑 `complete` / `success`。
- **`formOptions` 里没写 `rule` 的字段 → 控制台刷 `Uncaught Error: The schema does not contain the path: xxx`。**
  链条：`LewForm` 只把带 `rule` 的字段放进 yup schema → `LewFormItem` 的字段级校验
  走 `Yup.reach(formSchema, field)`，path 不存在时**同步抛错**，而它只挂了 `.catch()`，
  接不住同步异常。触发条件是「非必填 **且** 当前值为真值」——**空数组 `[]` 也是真值**，
  所以 `as: 'upload'` 必踩，`as: 'switch'`（值 `true`）同理。
  修法：`const formOptions = withPassThroughRule([...])`（`~/utils/form`，补 `Yup.mixed()`）。
  两种写法都要包：脚本里的 `formOptions`，以及模板里内联的
  `:options="withPassThroughRule([...])"`。写新页面时直接包上，别等报错。
  （全项目 22 个文件 / 29 处已统一包好，2026-09-11。）
- **确认框里的实体名字别单独存变量**：从行内打开弹窗时顺手记下那位顾客 / 预约的名字，
  用户**改选别人之后**确认框仍显示旧名字（写着张三、实际提交的是李四）——
  这种错很难在自测里发现，因为默认路径（不改选）是对的。
  一律从**当前选中项对应的 options** 里取 label，别用「打开弹窗时记住的那个」。
- 图片预览用 `window.open` / `<a target="_blank">` → 跳出后台丢上下文；自己再写一个预览弹窗
  → 与全局查看器两套手感。统一 `openImagePreview(...)`。
- **异步选项 + 多选 `LewSelect` / `LewTree`：必须「选项就绪后再挂载组件」。**
  lew-ui 在 `setup` 时把 `options` / `dataSource` **快照**进内部状态，多选模式下
  「已选项目的标签」就从这个快照渲染，而 `watch(options)` 只刷新下拉列表、**不刷新快照** ——
  选项晚于组件挂载到达 ⇒ 编辑时回填的已选项一个都不显示（关掉重开又正常，
  看起来像「第一次渲染不出来」）。做法：打开弹窗/抽屉前 `await ensureXxx()`，
  或模板上 `v-if` 门控四态（加载中 / 失败 / 空 / 就绪），拿到新选项再换 `:key` 重建。
  踩过：美甲师「可做项目」抽屉第一次打开空白。详见 `project-design/pitfalls/web.md` §14。
- 浮层盖在 lew-ui 弹窗上时：`z-index` 要用任意值语法（`z-[3000]`，`z-3000` 不会被生成），
  并且 `Esc` 要在**捕获阶段**拦掉，否则会连底下的弹窗一起关。详见 `project-design/pitfalls/web.md` §10。
- **列表接口手拼 `?storeId=`** → 门店是**请求级上下文**：顶栏切换器写 `x-store-id` 头
  （`store/store-scope.ts` + `request.ts` 拦截器），后端所有单据表都按它筛（列表）/落店（写入）。
  列表用 `useTable` 就好（它内置 `watch(activeStoreId)` 自动重载）；只有自绘的非列表视图
  （统计卡 / 工作台 / 收银台队列 / 报表页）才需要自己 `watch` 一次。自己拼参数迟早漏，
  漏了就是「看着 A 店的列表、建出来的单在 B 店」。见 `dev-docs/data/multi-store.md`。
- **`LewTabs` 的 `@change` 在 lew-ui 2.8.2 里恒不触发**：它的实现是「先把本地值同步成新值，
  再比较旧值 ≠ 新值才 emit」，那个条件永远不成立 —— 表现是「**页签高亮切了、内容没变**」。
  用 `v-model` + `watch(tab)` 驱动，别指望 `@change`（报表页踩过）。
- **数字输入框要小数就必须给 `step`**：lew-ui 的 `LewInputNumber` **没有 `precision`**
  （写了不生效），而原生 `<input type="number">` 的 `step` 默认是 `1` → 任何小数都是
  `:invalid`，lew-ui 会给值画**删除线**，用户根本填不进去（浏览器提示
  「The two nearest valid values are …」）。用 `~/utils/form` 的 `numberProps()`：
  `numberProps({ min: 0, decimals: 2 })`（金额元）/ `decimals: 6`（经纬度）/
  省略 `decimals` 即整数；直接写组件的地方手写 `:step="0.01"`。
  详见 `project-design/pitfalls/web.md` §16。
- **报表类页面的字段名一律以后端 `ReportsService` 的类型为准**，不要凭感觉猜 camelCase / snake_case：
  后端概览是**分组结构**（`{ revenue: { net } }`），`reportScalars` 会递归展平成
  `revenue.net` 这种点号路径（明细行同理，如账龄的 `buckets.0-30`）。写错键的后果是
  「页面显示『该区间没有数据』，而后端明明回了满屏数字」。
