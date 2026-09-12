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


