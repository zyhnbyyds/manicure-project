---
name: testing-acceptance
description: 测试与验收：真实 MySQL 集成测试入口（.env.test + 独立库 + 建表清表）、bun test 约定、B1~B6 验收清单、并发/幂等/时区用例写法、以及"做完了没"的完成定义。写测试、判断交付是否达标、准备上线前加载。
whenToUse: 写验收或集成测试；准备提交/上线前自检；复现并发、超订、账实不符类问题。
metadata:
  version: '1.0.0'
  spec: docs/superpowers/specs/2026-09-11-nail-salon-booking-design.md
  sections: §12 / §11 / §6.2 / §6.6
---

# 测试与验收

## 开工前提：集成测试入口（必须先做）

基线现有测试**全是 mock db 的单元测试**，而本期的关键验收（并发、时区、幂等、回调、扣减）
**必须有真实 MySQL**。B1 动工前先补：

- `.env.test`（`DATABASE_URL` 指向**独立测试库**）+ `src/config` 的测试环境分支；
- 建表 / 清表脚本（迁移 + `TRUNCATE` 或每用例事务回滚）；
- 一个 `bun test` 能识别的最小集成用例（连通 + 建表 + 插入 + 断言）。

没有这套东西，"恰好 1 个成功"这类验收只能手测，回归时无法发现退化。

## 测试约定

- 运行器 `bun test`（断言/mock 用 vitest API）；单测与集成测试分目录，**集成测试不 mock db**。
- 每个资金/并发用例至少覆盖：正常路径、幂等重放、并发竞争、边界（0 值 / 上限 / 跨时区）。
- 涉及时间的用例**不要**依赖"现在几点"，注入时间或用相对偏移。

## B1~B6 验收清单（详见 spec §12）

**B1 预约主链路**

- 并发 10 个同一美甲师同时段创建 → **恰好 1 成功、9 冲突**
- 缓冲只计一次；交换录入顺序结果一致（对称性）
- 时区：本地日 `2026-09-11` 的时段落在 `[2026-09-10T16:00Z, 2026-09-11T16:00Z)`；`TZ` 改成
  `UTC` / `America/New_York` 结果不变
- `startAt` 不在 `stepMinutes` 网格 → 400；跨班次边界 → 拒绝；非法流转 → 拒绝
- `booking_no` 并发无重复；`off` 撞既有预约 → 409 + 清单
- 定时任务：`arrived` 过期 → `completed`；`confirmed` 超容忍期 → `no_show`（重复执行无副作用）

**B2 会员**

- 算价数值用例（折扣 + 积分抵扣 + 改价，逐项断言）
- `SUM(balance_delta_principal) = balance_principal`、`SUM(points_delta) = points`
- 并发 10 笔余额支付：只成功到余额用尽，**余额不为负**
- 次卡：10 次用完 → `used_up`；第 11 次被拒；撤销后回补；过期卡不可核销
- 流水只追加（代码评审 + 接口层无更新/删除入口）

**B3 收银**

- 定金 → `partial` + `due_amount` 正确；`settle` 收清 → `paid`
- 混合支付 2 张支付单 → `paid` + `pay_channel_summary='balance,cash'`
- 回调重放 3 次只生效一次；**金额不一致的回调被拒**并写 `callback_invalid`
- 超时关单；关单后回调不影响账
- 判责：不同提前量 → 建议金额正确；审批后重复调用返回"已处理"
- 对账：造两类差异 → 落库、可处理、重跑不重复

**B4 挂账 / 报表 / 提成**

- 超额度挂账被拒；销账超额被拒；`used_amount` 与账龄数字对得上
- 营收可手工复核（现金 + 在线 + 退款三笔）
- 提成金额正确；退款/取消 → `reversed`；结算后不可改
- 导出：小数据同步 CSV，超 1 万行异步

**B5 运营**

- 一单一评；隐藏后公开列表不返回
- 美甲师项目限制后：可约时段为空（`staff_cannot_do`）、下单 400、清空后恢复可做全部
- 周期预约 4 周 → 恰好 4 单、重跑不重复、暂停不影响已生成
- 通知：变量未声明被拒；短信未配置不阻塞业务；重试上限 3 次

**B6 小程序预留**

- 测试 code 登录；openid 不重复建身份
- app token / 后台 token **双向拒绝**
- 只读接口字段集合断言（无成本 / `createdBy` / 内部备注）
- `/app/available-slots` 与后台结果一致；未绑定手机号 → 401 + `needBind`；骨架返回 501

## 代码评审项（自动化测不到）

- [ ] 资金写入全部条件更新，无"读-算-写"
- [ ] 事务内没有用 `this.database.db`
- [ ] 派生字段只由 recalc / 会员账务 service 写
- [ ] 只追加表没有 update/delete 入口
- [ ] 回调验签 + 金额校验 + 快速应答
- [ ] 定时任务不碰钱
- [ ] 权限点已加进 `seed/menus.ts`，钱的权限只给店长

## 完成定义（DoD）

1. `bun run typecheck` / `bun run lint` / `bun run test` 全过。
2. 本次改动对应的 §12 验收条目**逐条跑过**并有记录（集成测试或手测截图）。
3. 新表有迁移，菜单/权限点已 seed。
4. 涉及的 `money-invariants` 红线逐条自检通过。

## mock db 单测范式（服务层资金红线）

集成测试跑不了的时候（CI 无库、要压条件更新的分支），服务层单测仍要能覆盖闸门逻辑。
以下四件套是踩过坑后定下来的写法，直接照抄。

**1. 查询链 mock：用 Promise 当节点，把链式方法挂在它身上**

```ts
function chainFor(result: unknown) {
  const make = (): Record<string, unknown> => {
    const node = Promise.resolve(result) as unknown as Record<string, unknown>;
    node.from = make;
    node.where = make;
    node.leftJoin = make;
    node.orderBy = make;
    node.limit = make;
    node.offset = make;
    node.groupBy = make;
    return node;
  };
  return make();
}
```

- **不要**自定义 thenable（在普通对象上挂 `then`）——bun 下 `await` 拿不到结果。
- `select().where()` 的返回值语义是**行数组**。`findOne` 场景要喂 `[[row]]`（一次查询返回一行），
  不是 `[row]`。喂错会报 `TypeError: {} is not iterable`。
- 用 `selectResults` 队列按调用顺序喂结果，`where` 的入参也顺手收集起来供 SQL 断言用。

**2. 条件更新的唯一闸门：用 `affectedRows` 队列驱动分支**

`update().set().where()` 的返回是 `[{ affectedRows }]`。写链单独做一个队列：

```ts
const set = vi.fn((payload) => ({
  where: vi.fn((condition) => {
    whereCalls.push(condition);
    return Promise.resolve(updateResults.shift() ?? [{ affectedRows: 1 }]);
  }),
}));
```

- `affectedRows = 0` 的分支**必须**有用例（并发被抢、状态已变）。
- 同时断言 `.update()` 的**第一个入参是哪张表**（`expect(mock.calls[i][0]).toBe(bizXxx)`），
  比断言 SQL 文本更稳。
- `set` 的调用下标要数准：`insert` 不算，只有 `update().set()` 才进 `set.mock.calls`。

**3. 断言 SQL 片段的形态（条件表达式 / IF 分支）**

drizzle 的 `sql` 模板拍平规则：**字面量文本包在 `StringChunk.value` 数组里，
插值的列是带 `name` 的 `Column`，插值的值是 `Param`；而裸数字会被内联成字面量，不是 `Param`。**

```ts
function sqlText(node: unknown): string {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (typeof node !== 'object') return '';
  if (node instanceof Param) return '?';
  const record = node as { value?: unknown; queryChunks?: unknown[]; name?: string };
  if (Array.isArray(record.queryChunks)) return record.queryChunks.map(sqlText).join('');
  if (Array.isArray(record.value)) return record.value.map(sqlText).join('');
  if (typeof record.name === 'string') return record.name;
  return '';
}
```

用途：把「不许写成 `settled_amount + x >= amount`」这类**只能靠评审发现的顺序陷阱**变成可回归的断言。

```ts
expect(sqlText(set.status)).toBe("IF(settled_amount >= amount, 'settled', 'partial')");
expect(sqlText(gateWhere)).toContain('settled_amount + 10000 <= amount'); // 裸数字内联
```

**4. 调用顺序断言：mock 里显式 push 日志**

不要依赖 `mock.invocationCallOrder`（bun 未必实现）。在 mock 实现里往 `log: string[]` push 名字，
再 `expect(log).toEqual([...])`。资金链路（库存 → 扣款 → 发卡 → 落记录 → 回填单号）必须锁死顺序。

## 全局 mock 污染（`bun test` 不做文件级隔离）

任意一个 spec 里的 `vi.mock('node:crypto', ...)` 会**全局生效**，污染其它文件。
症状：单文件跑绿、全量跑红。

- 源码里要生成唯一值，用 `globalThis.crypto.randomUUID()`，不要 `import { randomUUID } from 'node:crypto'`。
- 已在 `doc-no.ts` / `payments.service` / `refunds.service` 上踩过。

## 常见坑

- 用 mock db 测并发 → 永远测不出超订，必须真库。
- 用"当前时间 + 1 小时"构造用例 → CI 在别的时区/时段跑会飘。
- 只测正常路径，不测重放与并发 → 幂等缺陷上线后才暴露。
- 手测过就算通过，没沉淀成集成用例 → 下次重构立刻退化。
- 断言 `Math.trunc` 类归一化时把 `1.4` 当非法输入 → 取整后是 `1`，其实合法；要用 `0.4`。
- 显式传 `tx` 的服务方法（如 `assertCreditAvailable`）在单测里传 `{}` → 报
  `tx.select is not a function`，要从 harness 里拿那个 mock 出来的 `tx`。
