# 踩坑记录 · 后端（NestJS / Drizzle / MySQL）

> **用法**：改后端代码前先扫一眼本文件；踩到新坑并解决后，**立刻**在下面追加一条。
> 格式固定，便于扫读：**现象 → 根因 → 正确做法 → 怎么发现的**。
> 只写「会再犯」的坑，不写一次性的笔误。

---

## 1. drizzle 生成的 `DEFAULT (CURRENT_TIMESTAMP)` 会让迁移在中途炸掉

- **现象**：`bun run db:migrate` 报
  `ERROR 1067 (42000): Invalid default value for 'created_at'`；
  而且**重跑也过不去**，因为第一次已经把表建出来了，卡在后面的 `CREATE INDEX`。
- **根因**：当前 drizzle 版本把 `auditColumns` 里的 `sql\`CURRENT_TIMESTAMP\`` 渲染成
**带括号的表达式默认值**（`DEFAULT (CURRENT_TIMESTAMP)`），而历史迁移是无括号的
`DEFAULT CURRENT_TIMESTAMP`。MySQL 8 在 `CREATE TABLE`时**接受**带括号的写法，
但随后`CREATE INDEX` 触发表的**重建**时会严格校验并拒绝 TIMESTAMP 用表达式默认值
  —— 属于**延迟爆炸**：建表时不报，建索引时才炸。
- **正确做法**：新建迁移后检查 SQL，把 `DEFAULT (CURRENT_TIMESTAMP)` 改成
  `DEFAULT CURRENT_TIMESTAMP`（迁移尚未成功执行前改文件是安全的，因为 drizzle
  只在成功后才把 hash 记入 `__drizzle_migrations`）。
- **根治（待做）**：把 `auditColumns` 的时间列改成 `.defaultNow()`，并回归全部历史迁移。
- **怎么发现的**：加券表时迁移失败；用 `mysql -e "CREATE INDEX ..."` 手工复现拿到真实报错。

---

## 2. drizzle 的错误在 `cause` 链里，只看顶层 message 会把 409 变成 500

- **现象**：插入同名记录时接口返回 **500**，但期望 409。
- **根因**：drizzle 把底层 mysql2 错误包成 `DrizzleQueryError`，
  顶层 `message` 只有 `Failed query: insert into ...`，
  **约束名与 errno 都在 `error.cause` 里**。
- **正确做法**：沿 `cause` 链（最多 5 层）拼文本，再匹配约束名 / `ER_DUP_ENTRY` / `1062`。
- **怎么发现的**：集成测试断言「同名 → 409」直接失败，打印出实际 500。

---

## 3. `@Global()` 模块的 provider **仍须显式 `exports`**

- **现象**：加了新端口绑定后服务**起不来**：
  `Nest can't resolve dependencies of the XxxService (..., ?)`。
- **根因**：`BizModule` 是 `@Global()`，但全局模块的 provider 只有写进 `exports`
  才能被别的模块注入。我在 `providers` 里绑了 `PointsGoodsPort`，**漏了 `exports`**。
- **正确做法**：端口绑定三件套一起改：`import` / `providers` 绑定 / **`exports`**。
- **怎么发现的**：**typecheck 是绿的**，只有真启动一次才暴露。

---

## 4. `exactOptionalPropertyTypes: true`：可选属性要显式写 `| undefined`

- **现象**：`Argument of type '{ status?: "a" | "b" | undefined }' is not assignable to
parameter of type '{ status?: "a" | "b" }'`。
- **根因**：tsconfig 开了 `exactOptionalPropertyTypes`，`?:` 与 `?: T | undefined` 不等价。
- **正确做法**：被传入的可选属性一律写全 `status?: 'a' | 'b' | undefined;`。
- **补一句（2026-09-15）**：当值来自**外部输入**（LLM 工具入参、可选 query）时，
  逐个给 service 的 filter 类型都补 `| undefined` 反而侵入大；更省事的是先用一个
  `defined()` 把 `undefined` 键摘掉再传（`src/ai/tools/biz-common/biz-tool.util.ts`）。
  注意它**只删 `undefined`，不删 `null`** —— 很多过滤条件的「不传」与「显式置空」语义不同。
- **怎么发现的**：改 controller 传 filter 对象时 tsc 直接报。

---

## 5. 改建单服务前先读「两条路径 + 四个算价点」

- **现象**：以为改一处即可，实际 `bookings.service.ts` 有 **1776 行**、
  **四个 `this.buildQuote(` 调用点**、**两条建单路径**，且两条路径入参字段名不同
  （biz 层是 `pointsUsed`，app 那条是 `pointsToUse`）。
- **正确做法**：改前先 `Select-String 'this\.buildQuote\('` 摸清调用点；
  只有 app 建单需要接券，改期/结算沿用原单。
- **怎么发现的**：勘察阶段专门数了一遍调用点（详见 `project-design/HANDOVER-miniapp.md` 第 10 节）。

---

## 6. 测试清库：`TRUNCATE` 是 DDL，比 `DELETE` 慢 73 倍

- **现象**：整套集成测试 **~530 秒**；单个用例约 3~4 秒。
- **根因**：`resetBusinessData()` 每个用例前清 **37 张表**，用的是 `TRUNCATE` ——
  InnoDB 的 `TRUNCATE` = DROP + CREATE **重建表**，实测约 100ms/张 → 单次 4 秒。
  而这里每张表在用例结束时空着，`DELETE` 只要约 1.5ms/张。
- **正确做法**：
  1. 改用 `DELETE FROM`（**代价**：不重置 AUTO_INCREMENT —— 用例一律用 `insertId`，
     **不要断言固定 id**）；
  2. 整个 reset **必须在同一条连接上**跑完：`SET FOREIGN_KEY_CHECKS` 是**会话级**的，
     而连接池有 10 条连接，`pool.query` 可能换连接 → 那句 SET 形同虚设。
     用 `pool.getConnection()` + `try/finally release()`。
- **效果**：整套 **530 秒 → 18 秒**。
- **怎么发现的**：写探针把 reset 按阶段切开计时（setFk / information_schema /
  truncateAll / deleteAll），数字直接指认了 `truncateAll=4067ms` vs `deleteAll=56ms`。

---

## 7. 加了后端路由必须**重启**服务

- **现象**：新接口返回 **404**，而且前端把 404 静默降级，页面看起来完全正常。
- **根因**：`bun run start` = `bun src/main.ts`，**不带 watch**，进程还是旧代码。
- **正确做法**：**把「重启后端」写进验证脚本的第一步**，别靠记性
  （本会话为此白排查了 4 次）。或开发期用 `bun --watch`。
- **怎么发现的**：手工打接口看状态码才发现是 404，而不是先看页面。

---

## 8. 券核销：只有条件更新能防「一券多用」

- **现象**：并发用同一张券下单时，可能出现「一券两单」。
- **根因**：「先查再判断再写」在并发下必然失效。
- **正确做法**：
  - 闸门是**条件更新** `WHERE id=? AND customer_id=? AND status='usable'
AND used_booking_id IS NULL`，`affectedRows=0` → 409；
  - **与建单同事务**（否则会出现「券核销了单没建成」或「单建成了券还能再用」）；
  - `previewForBooking`（算价用）**只读、不是闸门**；
  - MySQL 没有部分唯一索引 → 「同一顾客同一模板只能有一张**未使用**的券」
    只能用**行锁**（`SELECT ... FOR UPDATE`）串行化。
- **怎么发现的**：专门写了并发用例（3 并发 → 恰好 1 成功）。

---

## 9. 「渠道下单」还在事务里（**已于 2026-09-12 修复**，留档说明）

- **现象**：`PaymentsService.createInTx(tx, draft)` 在调用方事务**内部**调
  `provider.createNativeOrder()`（网络 IO，超时 5s）。
- **影响**：事务期间持有连接池连接与行锁（结算流程里同时还锁着 `biz_booking` 行）。
  单店单收银台时影响很小；并发结算或连接池被别处占满时会放大成超时/死锁风险。
  **不是资金安全问题**（顺序上渠道下单在本地落行之后、事务提交之前，
  回滚只会留下一张没人看到过的渠道单）。
- **（当时的）修复成本**：`out_trade_no` 是**主键回填**生成的（`buildOutTradeNo('P', id, now)`），
  渠道下单必须等支付单 insert 拿到 id 之后才能调；要把它移出事务，得先让
  「单号」与「主键」解耦，或把渠道下单变成**事务提交后的第二个动作** ——
  两者都要改 `PaymentPort.createInTx` 的契约与 4 个调用方
  （预约结算 3 处 + 挂账 1 处），属于动资金主链路的改造。**故先记录、后重构。**
- **建议做法（择一）**：
  1. 单号改成与主键无关的唯一串（如 `P + yyyyMMddHHmmss + random`）→
     可在开事务**前**调渠道，把 `codeUrl` 当入参传进 `createInTx`；
  2. `createInTx` 只落本地行（`code_url = null`），事务提交后由调用方调
     新增的 `requestChannelOrder(outTradeNo)` 补下单并回写 `code_url`。
- **2026-09-12 补充的勘察结论（下次直接照这个做）**：
  - `buildOutTradeNo = 'P' + 6 位主键 + base36 时间戳`（**主键内嵌**，这是必须解耦的点）；
  - **全仓没有任何地方解析它的格式**，只有两条单测断言了它
    （`payments.service.spec.ts:476` 断言 `^P000001[0-9A-Z]+$`、`:487` 断言临时号），
    所以改成与主键无关的串**代价很小**；
  - 现成可用的写法参照 `tempDocNo()`（它已经用 `globalThis.crypto` 生成
    与主键无关的唯一串，且注释解释了为什么不能用 `node:crypto`）；
  - 结算流程（`bookings.service.ts` 的 settle）是在**一个事务里循环**调
    `createInTx`，后面还要 `recalc` + `recordConsumption` —— 也就是说渠道调用
    发生在事务**中段**，且此时 `biz_booking` 行已被更新（持有行锁）；
  - **安全网已就位**：`tests/integration/b3-online-settle.int.spec.ts`
    覆盖了「在线结算 → pending 单 + 渠道下单 + code_url 回传」与
    「渠道未配置 → 409 且不留 pending 单」，重构前先跑它。
- **改完必须保留的现有行为**：**渠道未配置 → 抛错回滚、不留 pending 单**
  （已有测试盯着，别改成「先落单再补」）。

### 修复后的形态（2026-09-12）

1. `PaymentDraft` 增加 `channelOrder`（`PreparedChannelOrder`），
   `PaymentPort` 增加 `prepareChannelOrder` / `prepareChannelOrders`；
2. 调用方**在事务外**先 prepare（三个循环点：预约建单、结算、销账），
   事务内把 `channelOrder` 传进 `createInTx` —— **事务里不再有任何渠道调用**；
3. 在线渠道的交易号改用 `buildOutTradeNoByToken('P')`
   （与主键无关，因为下单时还没有本地单）；离线渠道仍用主键回填，两者语义各自成立；
4. `createInTx` 对「在线渠道但缺 `channelOrder`」**直接报错** ——
   防止以后有人把渠道调用悄悄塞回事务；
5. **未配置渠道的错误现在发生在事务外**：从「靠事务回滚不留 pending 单」
   升级为「连事务都不会开」。

**代价**：事务最终回滚时，渠道侧会留下一张**没人见过**的待支付单
（`code_url` 从未返回给任何客户端），5 分钟后自然过期 —— 无资金流、不影响对账。

---

## 10. helmet 的 `Cross-Origin-Resource-Policy: same-origin` 会把「图片能被跨源嵌入」这条路堵死

- **现象**：图片地址 `200 / image/png / 16524 字节`（`Invoke-WebRequest` 完全正常），
  但**小程序 `<image>`、异源后台 `<img>` 一律空白**，且客户端几乎没有可用报错。
- **根因**：`main.ts` 里 `await app.register(helmet)` 用的是默认值，
  于是**每一条响应**（含 `GET /files/:id/download`）都带
  `Cross-Origin-Resource-Policy: same-origin`。
  `<img>` 跨源加载**不需要 CORS**，但 **CORP 正是用来拦它的**：
  只要页面 origin ≠ 响应 origin，Chromium 直接丢弃这个 no-cors 子资源请求。
  web 后台因为走 vite 代理是**同源**，所以一直没暴露。
- **正确做法**：**只**在文件下载这一条响应上覆盖为 `cross-origin`
  （`files.controller.ts` 的 `download()`，该接口本就 `@Public` + 随机 UUID 文件名）。
  **不要**改全局 helmet 配置 —— 其余 API 的 `same-origin` 是有效的纵深防御。
- **注意**：helmet 在 `onRequest` 阶段写头，handler 里 `reply.header()` 后写即覆盖，无需 unregister。
- **验证**：`Invoke-WebRequest ... | Select-Object -ExpandProperty Headers` 看
  `Cross-Origin-Resource-Policy` 是否已是 `cross-origin`；
  端到端要用**异源页面**里的 `<img>` 实测（同源测不出来）。详见 `project-design/pitfalls/miniapp.md` §15。
- **另一个坑（同一片区）**：改了后端**必须重启**服务（见本文件 §7）——
  头像/封面这类问题很容易在「代码已修但进程没重载」的状态下反复怀疑人生。
