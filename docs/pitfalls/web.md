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
