---
name: web-frontend
description: 后台前端：24 个页面清单、useTable + lew-ui 列表模式（formKey 重建 / setForm 回填 / v-permission / confirmDanger）、文件与图片上传（LewForm `as:'upload'` + uploadHelper）、菜单 seed 驱动路由、收银台与退款审批等复杂交互、时间与金额的展示口径。写任何 web/ 页面或组件时加载。
whenToUse: 新增/修改 web/src/views/biz 页面、API 封装、表单与权限按钮；做文件/图片上传与预览；实现收银台、退款审批、对账、报表页。
metadata:
  version: '1.3.0'
  spec: docs/superpowers/specs/2026-09-11-nail-salon-booking-design.md
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

## 展示口径（两端必须一致）

- **时间**：后端存 UTC，前端统一按 `Asia/Shanghai`（`web/src/composables/useFormat.ts`）展示；
  可约时段接口返回的就是带 `+08:00` 的 ISO8601，直接展示即可。
- **金额**：后端单位是**分**，前端 ÷100 展示；不要在前端做折扣/抵扣计算（服务端重算，前端只展示与二次确认）。
- **枚举**：状态、支付方式、流水类型等以后端枚举值为准，禁止前端自己映射成另一套字符串。

## 页面清单（24 个，§10.1）

基础与预约：`service-items`、`staffs`、`schedules`、`customers`、`bookings`
会员：`member-levels`、`recharge-plans`、`card-types`、`members`、`member-cards`
收银与账务：`cashier`、`payments`、`refunds`、`payment-diffs`
挂账：`credit-accounts`、`receivables`
运营：`points-goods`、`reviews`、`reports`、`commission-rules`、`commission-records`、
`recurrences`、`notice-templates`、`notice-logs`

> 美甲师可做项目不单独建页：放在「美甲师」详情抽屉里用多选项目组件维护（整体 PUT）。

## 复杂页面要点（§10.5）

| 页面       | 要点                                                                                                      |
| ---------- | --------------------------------------------------------------------------------------------------------- |
| **收银台** | 三栏：待收款队列（未收 / 待收尾款 / 挂账）→ 单据金额明细 → 支付区（**混合支付可加多行**）。本期最复杂页面 |
| 扫码收款   | 二维码 5 分钟失效；轮询 `/biz/payments/:id/status`；过期给「重新获取」与「改现金收款」两个出口            |
| 退款审批   | 默认只看 `pending`；弹窗展示判责依据（命中规则、距开始时间、扣减金额）；金额可改但必填原因                |
| 对账       | 差异按 `diff_type` 分色；处理完必须填备注，**不允许静默忽略**                                             |
| 挂账台账   | 按主体聚合 + 账龄色阶；销账支持多笔混合并实时显示剩余额度                                                 |
| 报表       | 统一日期区间 + 导出；页头标注「营收 = 实收，已扣退款」，避免与"流水"混淆                                  |
| 提成结算   | 结算前二次确认并显示期间总额与人数；结算后不可修改，只能冲销                                              |
| 周期预约   | 创建前先预览"将要生成的日期列表"与冲突情况，再确认                                                        |
| 会员详情   | 四个 Tab：档案 / 账务流水 / 次卡 / 预约历史；流水只读，充值退款按钮按权限显示                             |
| 预约弹窗   | 选顾客后显示等级、折扣率、余额、可用次卡 → 服务端算价；**不在弹窗里新建顾客**                             |

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
  setFileItem(toUploadedItem(fileItem.key, filePreviewUrl(uploaded.id), fileItem.name));
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

openImagePreview(urls, startIndex, '图集名');   // 空数组自动忽略；下标越界自动夹回
```

**不要**再用 `window.open` / `<a target="_blank">` 预览图片（会跳出后台丢上下文），
也不要在页面里另摆一套预览弹窗（同一件事两种做法 = 交互割裂）。
纯逻辑（下标回绕、锚点缩放、平移夹取、标题）在 `~/utils/image-viewer.ts`，有单测。

- 列表里展示图片：`customRender` 渲染缩略图 + 剩余张数徽标，点击 `openImagePreview(urls, 0, name)`。
- 表单里 `as: 'upload'` 的缩略图：**lew-ui 2.8.2 没有图片预览，缩略图点了没反应**（见
  `docs/pitfalls/web.md` §8）。用 `useUploadImagePreview(hostRef, () => urls, () => title)`
  接管点击，别自己写「大图预览」缩略图带。

## 交互约定

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
- 图片预览用 `window.open` / `<a target="_blank">` → 跳出后台丢上下文；自己再写一个预览弹窗
  → 与全局查看器两套手感。统一 `openImagePreview(...)`。
- **异步选项 + 多选 `LewSelect` / `LewTree`：必须「选项就绪后再挂载组件」。**
  lew-ui 在 `setup` 时把 `options` / `dataSource` **快照**进内部状态，多选模式下
  「已选项目的标签」就从这个快照渲染，而 `watch(options)` 只刷新下拉列表、**不刷新快照** ——
  选项晚于组件挂载到达 ⇒ 编辑时回填的已选项一个都不显示（关掉重开又正常，
  看起来像「第一次渲染不出来」）。做法：打开弹窗/抽屉前 `await ensureXxx()`，
  或模板上 `v-if` 门控四态（加载中 / 失败 / 空 / 就绪），拿到新选项再换 `:key` 重建。
  踩过：美甲师「可做项目」抽屉第一次打开空白。详见 `docs/pitfalls/web.md` §14。
- 浮层盖在 lew-ui 弹窗上时：`z-index` 要用任意值语法（`z-[3000]`，`z-3000` 不会被生成），
  并且 `Esc` 要在**捕获阶段**拦掉，否则会连底下的弹窗一起关。详见 `docs/pitfalls/web.md` §10。
