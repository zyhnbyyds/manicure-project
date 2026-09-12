# 踩坑记录 · 前端 / 管理端（Vue3 + lew-ui + Vite）

> **用法**：改 `web/` 代码前先扫一眼本文件；踩到新坑并解决后，**立刻**在下面追加一条。
> 格式固定：**现象 → 根因 → 正确做法 → 怎么发现的**。
> 每条末尾标「来源」：`实测` = 本项目真踩过；`技能` = `web-frontend` 技能已载明。

---

## 1. `useTable` 按 URL 取数 —— 不要再引一个 `listXxx`

- **现象**：`vue-tsc` 报 `TS6133: 'listCouponTemplates' is declared but its value is never read`。
- **根因**：`useTable({ url })` 自己按 URL 发请求，
  页面通常**不需要**再 import 那个 `listXxx` 函数。
- **正确做法**：列表页只 import `create/update/delete`；`listXxx` 留给别的调用方。
- **来源**：实测（写券模板页时踩）。

---

## 2. 类型要从 `lew-ui` 显式 import

- **现象**：`TS2304: Cannot find name 'LewFormOption'`。
- **根因**：组件与类型是两条 import 通道，组件 import 了不代表类型也有。
- **正确做法**：`import type { LewFormOption, LewTableColumn } from 'lew-ui';`
- **来源**：实测（给会员页加发券弹窗时踩）。

---

## 3. `formOptions` 必须用 `withPassThroughRule(...)` 包一层

- **现象**：控制台刷 `Uncaught Error: The schema does not contain the path: xxx`。
- **根因**：`LewForm` 只把**带 `rule` 的字段**放进 yup schema；
  `LewFormItem` 的字段级校验走 `Yup.reach(formSchema, field)`，path 不存在时**同步抛错**，
  而它只挂了 `.catch()`，接不住同步异常。
  触发条件是「非必填 **且** 当前值为真值」—— **空数组 `[]` 也是真值**。
- **正确做法**：`import { withPassThroughRule } from '~/utils/form';`
  然后 `const formOptions = withPassThroughRule([...])`；
  模板里内联的 `:options="withPassThroughRule([...])"` 也要包。
- **来源**：技能（`web-frontend`）—— 写新页面时**直接包上，别等报错**。

---

## 4. 「类型过了 ≠ 页面真的被引用」

- **现象**：`vue-tsc` 通过、`oxlint` 0 问题，但页面在新路由下打不开。
- **根因**：页面可能没被菜单/路由引用到，类型检查**不会**报这种问题。
- **正确做法**：`bun run build` 后**在产物里找页面独有的中文串**，
  例如 `Select-String -Path output/web/assets/xxx*.js -Pattern '优惠券模板'`；
  能搜到才说明它真进了 bundle。
- **来源**：实测（本会话的 web 验证固定套路：typecheck → lint → build → 产物找串）。

---

## 5. 列表响应**没有 `total`**

- **现象**：分页拿不到总数。
- **根因**：后端列表统一返回 `{ items, page, pageSize }`，没有 `total`。
- **正确做法**：用 `useTable`（它多取一条判断 `hasMore` 并估算总数），**不要自己写分页组件**。
- **来源**：技能。

---

## 6. 菜单驱动路由，**不要手改 `router/index.ts`**

- **现象**：手加的路由与菜单生成的路由冲突。
- **正确做法**：页面在 `src/database/seed/menus.ts` 里配（`M` 目录 / `C` 页面 / `F` 按钮），
  前端路由自动生成；**改完必须重跑 `bun run db:seed:menus`**，否则菜单不生效。
- **来源**：技能 + 实测（券模板页接入时需要重跑 seed）。

---

## 7. 金额与时间的口径

- **金额**：后端一律**分**，前端只做 `÷100` 展示；**不在前端做任何折算**
  （面额就是面额，折扣由服务端算）。
  表单如果按「元」录入，**只在两个转换函数里换**（提交前 `Math.round(元 * 100)`）。
- **时间**：后端存 UTC，前端统一按 `Asia/Shanghai` 展示（`~/composables/useFormat.ts`）。
- **来源**：技能 + 实测。

---

## 8. lew-ui 2.8.2 **没有**图片预览，上传缩略图点了没反应

- **现象**：`LewUpload` 上传/回显的缩略图，点击后**什么都不发生**；想要「点击放大」只能自己接。
  （此前技能与本文件曾写过「lew-ui 自带预览能切换、但不能缩放」—— **那是错的**，本次已纠正。）
- **根因**：库只导出一个 `dist/index.js`，里面**搜不到任何 preview 实现**：
  `LewUploadByCard` / `LewUploadByList` 给 `LewImage` 传的 `preview-group-key`
  是个**没人消费的属性**（`LewImage` 的 props 里根本没有它），`dist/index.css` 里也没有
  `.lew-*-preview` 之类样式。真正存在的只有「按扩展名判定渲染成图片还是文件图标」那一条正则。
- **正确做法**：
  1. 图片预览统一走自家全局查看器（`~/components/ImageViewer.vue`，挂在 `App.vue`，
     任何页面 `openImagePreview(images, index, title)` 调用）；
  2. 上传区缩略图要能点，用 `useUploadImagePreview(hostRef, () => urls)` 在**容器**上挂一层
     捕获阶段代理（命中 `.lew-upload-file-image` 才接管，删除/重传按钮不受影响）；
  3. 别再抄一条「大图预览」缩略图带 —— 一件事只留一种做法（本次删掉了服务项目弹窗里的重复入口）。
- **来源**：实测（先按「库自带预览」的错误假设写了拦截方案，翻 `lew-ui/dist` 后推翻）。

---

## 9. 查看器的缩放：`transition` 的 `transform` 与内联 `transform` 会互相覆盖

- **现象**：切图动画（`translateX` 淡入）加上去之后**不生效**，或者一加动画缩放就乱跳。
- **根因**：缩放/平移是用内联 `style.transform` 表达的，而 Vue `<Transition>` 的
  `*-enter-from` 也是改 `transform`；**内联样式优先级高于样式表**，动画类永远赢不了。
- **正确做法**：分两层 —— 外层 `.iv-frame` 只负责「缩放 + 平移」（内联 transform），
  内层 `<img class="iv-image">` 只负责「换图」动画（类里的 transform），互不打架。
- **来源**：实测（重写查看器时踩）。

---

## 10. 盖在 lew-ui 弹窗之上的浮层：`z-index` 与 `Esc` 都要自己处理

- **现象**：
  1. `z-3000` 不生效，查看器被弹窗盖住；
  2. 在「编辑服务项目」弹窗里打开查看器后按 `Esc`，**查看器和编辑弹窗一起关了**（未保存的表单直接丢）。
- **根因**：
  1. UnoCSS 预设只生成**已知刻度**（`z-10/50/1200/1201`…），`z-3000` 这种不在刻度里就不会有对应 CSS
     —— 必须写任意值语法 `z-[3000]`；
  2. lew-ui 有一套内部 z-index 管理器（`BASE_Z_INDEX = 2001` + `isTop(id)`），
     `closeByEsc` 时只关「它自己认定的栈顶弹窗」，而**我们的浮层没登记**，
     于是底下的弹窗依然认为自己是栈顶 → Esc 把它也关了。
- **正确做法**：
  1. 任意 z-index 用 `z-[3000]`（改完去**最新的**产物 CSS 里搜 `.z-\[3000\]` 确认）；
  2. 浮层的 `keydown` 用 **捕获阶段** 注册（`addEventListener('keydown', fn, true)`），
     处理掉 `Esc` / `←` `→` 时 `event.stopPropagation()`，事件就到不了 lew-ui 的监听。
- **来源**：实测（两次都真踩了，`e379a3e` 修 z-index，本次修 Esc）。

---

## 11. 平移归零会算出 `-0`

- **现象**：`expect({ x: 0, y: -0 }).toEqual({ x: 0, y: 0 })` 失败；样式里出现 `translate3d(0px, -0px, 0)`。
- **根因**：`Math.max(-90, -0)` 得到 `-0`，`Object.is(-0, 0) === false`。
- **正确做法**：夹取结果 `+ 0` 归一（`clampPan` 里已处理），别指望调用方擦屁股。
- **来源**：实测（`image-viewer.spec.ts` 第一次跑就红）。

---

## 12. `LewUpload` 的**两条**产出路径都要过显示态归一化

- **现象**（用户报的原话）：「新增服务项目的时候传了图片但是展示不出来，编辑时新增的也不行」。
  更迷惑的是：**打开编辑弹窗，原有图片正常显示；在同一弹窗里新传一张，新那张是文件图标**。
- **根因**：`url` 有两条产出路径 ——
  ① 打开弹窗的**反显**（库里 url → `toUploadItems`）；② 上传成功后**回填**（`uploadHelper` → `setFileItem`）。
  修「反显看不到」时只给了 ① `toDisplayImageUrl`，② 仍然塞 `filePreviewUrl(id)` 的原始地址
  （`.../download?inline=1`，不以图片扩展名结尾）→ lew-ui 判定失败 → 渲染默认文件图标。
  新建时没有反显，于是整个图集都看不见。
- **正确做法**：两条路都走 `~/utils/upload-images`：`toUploadItems` / `toUploadedItem` / `toImageUrls`，
  页面里**不要手写**回填对象。单测（`upload-images.spec.ts`）对两条路都断言
  「交给 LewUpload 的 url 必须能通过 lew-ui 那条扩展名正则」；把 `toUploadedItem` 里的归一化删掉，
  该测试立刻 2 条变红（做过变异验证）。
- **来源**：实测（用户报障 → 定位到上传回填路径漏了归一化）。

---

## 13. 文件 mime 不是图片类型时，`<img>` 会被 `nosniff` 挡掉

- **现象**：图片地址能 200，但 `<img>` 不渲染（或只在某些浏览器里渲染）。
- **根因**：后端按多部分请求里的 `part.mimetype` 入库（为空则落 `application/octet-stream`，
  见 `src/modules/files/files.service.ts`），而 fastify 的 helmet 带了
  `X-Content-Type-Options: nosniff`（实测响应头里就有）—— 声明不是图片类型时浏览器**拒绝**当图片显示。
- **正确做法**：上传必须带正确的类型。前端 `form.append('file', file)` 传浏览器 `File` 对象即可
  （浏览器会自动带 `Content-Type: image/png`）；**用脚本 / 命令行工具传文件时要显式指定**，
  否则查半天「为什么上传成功却看不见图」。
- **来源**：实测（用 PowerShell `-Form @{file = Get-Item x.png}` 复现了一版
  `application/octet-stream`，改用真实前端链路的文件则正常）。

---

## 14. 异步选项 + 多选 `LewSelect`：「第一次打开渲染不出来」

- **现象**（用户报的原话）：「点击修改美甲师可做项目的时候，第一次渲染不出来可做项目」——
  打开「美甲师详情」抽屉，「可做项目」多选框里**已配置的项目一个都不显示**；
  关掉再打开（同样的数据）就正常了。
- **根因**（读 `lew-ui/dist/index.js` 源码定位）：
  1. `LewSelect` 在 `setup` 里把 `options` **快照**进内部状态：
     `sourceFlattenOptions: tn(r.options)`；
  2. 多选模式下，已选项的标签正是从这个快照渲染的：
     `V = () => (c.sourceFlattenOptions || []).filter(...)` → 传给 `LewSelectInput`
     的 `formatItems` → 逐个渲染 `LewTag`；
  3. `watch(options)` 回调里只更新 `c.sourceOptions` / `c.options`（下拉列表），
     **不更新 `sourceFlattenOptions`**；
  4. `LewDrawer` 的抽屉体是 `v-if`（`visible ? <div class="lew-drawer-body"> : null`），
     所以「先 `drawerVisible = true`，再 `await` 取选项」= 组件带着**空**选项挂载
     ⇒ 标签渲染不出来；第二次打开时选项已在，快照就是对的 ⇒ 正常。
  - 同一个家族：`LewTree` 也只在挂载时读 `dataSource`（`roles` 页早就改成
    「先加载数据，再打开弹窗」，注释还在）。
- **正确做法**：
  1. **选项就绪再挂载**选择器 —— 打开弹窗/抽屉前 `await`（把请求包成
     `ensureXxx()` 记住 Promise，成功前不重复发、失败后允许重试），或模板上用
     `v-if` 门控「加载中 / 失败 / 空 / 就绪」四态；
  2. 每次拿到新选项就换 `:key` 重建组件，保证挂载时的快照就是最新的；
  3. 选项为空 / 拉取失败要**分别**给提示，别让它看起来像「本来就没有项目」。
- **来源**：实测（用户报障 → 翻 lew-ui 源码定位；真实数据：12 个启用项目、
  该美甲师配了 6 个，打开顺序天然命中）。
- **同类已修**：`staffs`（抽屉）、`card-types` / `recurrences` / `users`（弹窗，
  选项在页面挂载时就发请求，点得够快就会晚到）。`bookings` 的多选新建时是空的，
  晚到只是短暂空列表、不会丢数据，故未改。

---

## 15. `accept: 'image/*'` 会把注定失败的文件递给后端

- **现象**：手机上传头像/图片，选择器里挑了一张相册照片 → 提示「不支持的文件类型」。
- **根因**：后端按**扩展名白名单**校验（`src/modules/files/files.service.ts` 的
  `ALLOWED_EXTENSIONS`：图片只有 jpg/jpeg/png/gif/webp/svg），而 iPhone 相册的
  `.heic`（以及 `.avif`）不在白名单里；`accept: 'image/*'` 恰好会把它们列出来。
- **正确做法**：用 `~/utils/upload-limits` 的 `IMAGE_ACCEPT`
  （`image/png,image/jpeg,image/webp,image/gif,image/svg+xml`）+ `MAX_UPLOAD_FILE_SIZE`
  （与后端 `MAX_FILE_SIZE` 一致的 10MB）。**显式写 `image/jpeg` 还白捡一个好处**：
  iOS 会在上传前把 HEIC 自动转成 JPEG，本来传不上的照片反而能传上去。
- **来源**：实测（做美甲师头像上传时发现；顺带把服务项目图集的 `image/*` 也换掉了）。




