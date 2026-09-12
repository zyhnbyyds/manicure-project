---
name: operations-reports
description: 运营三件套：评价（一单一评/回复/隐藏/代录）、报表口径（净营收=成功支付−成功退款、营业日切分、次卡核销单列）与提成（规则优先级、计提基数、补提、冲销、结算冻结）。写评价、报表、提成相关代码或核对数字时加载。
whenToUse: 实现或修改 /biz/reviews、/biz/reports/*、/biz/commission-* 与对应页面；对不上营收数字；美甲师对提成有异议。
metadata:
  version: '1.0.0'
  spec: project-design/superpowers/specs/2026-09-11-nail-salon-booking-design.md
  sections: §4.6 / §9.11 / §20 / §12 B4
---

# 评价 / 报表 / 提成

## 评价（§20.1）

- `biz_review`：`booking_id` **唯一**（一单一评）、`score` 1..5、`content`、`images`(json)、
  `is_public`、`reply` / `replied_at`、`status`(published/hidden)。
- 触发：预约 `completed` 后开放评价入口；后台可**代录**（顾客当面口述），仍受一单一评约束。
- 后台可回复、可隐藏（处理恶意评价）；软删保留数据。
- 美甲师只能看自己的评价；评分进入美甲师业绩报表。
- 权限：`biz:review:list|create|reply|hide|delete`。

## 报表口径（§20.2，每个数字都要能手工复核）

| 报表          | 口径                                                                   |
| ------------- | ---------------------------------------------------------------------- |
| **营收**      | **净营收 = Σ 成功支付 `received_amount` − Σ 成功退款 `actual_amount`** |
| 单量          | `status='completed'` 的预约数；取消 / 爽约单量**单列**                 |
| 客单价        | 净营收 ÷ 完成单量                                                      |
| 新客 / 回头客 | 首次完成时间落在区间内 = 新客；区间内再次完成 = 回头客                 |
| 项目排行      | 按 `biz_booking_item` 聚合；**次卡核销单列**（金额 0 但计次数）        |
| 美甲师业绩    | 完成单量、净营收分摊、提成、平均评分                                   |
| 会员报表      | 新增会员、储值充退、余额结存、次卡发售与核销、积分发放/抵扣/兑换/结存  |
| 应收报表      | 按主体：额度、已挂未结、账龄分档、逾期金额                             |

- **挂账在下单时不计营收，销账时才计入**（§18.4）。
- "营业日"按 `shopDayRange` 切（默认自然日 00:00–24:00；若营业到凌晨需改为按营业结束时间切日）。
- 导出 `GET /biz/reports/export`：≤1 万行同步 CSV，超过走异步任务（复用 jobs + 文件模块），
  完成后在通知中心提示下载。
- 权限：`biz:report:view` / `biz:report:export`。

## 提成（§20.3）

**规则**（`biz_commission_rule`）：`scope` = `staff` / `category` / `service_item`，
优先级 `service_item > category > staff`（同维度取 `sort` 最小且生效期命中的一条）；
`permille`（千分比）与 `fixed_amount` 可同时存在（取"比例 + 固定"之和）；
`base` 默认 `paid`（实收，防挂账提前计提）。

**计提**：

- 时点：预约 `completed` 时按 `biz_booking_item` **逐项计提**（一单多项目 → 多条记录）。
- 未结清时按已收比例计提，尾款收清后**补提差额**（同一 `booking_item_id` 允许多条，`period` 取补提时间）。
- **未命中任何规则 → 不提成**，报表里单独列出"未配置规则"的单量（不要猜默认比例）。

**冲销与结算**：

- 取消 / 退款 / 爽约 → 对应记录置 `reversed`（**不删**）；已结算期间发生的冲销进下一期为负数。
- `POST /biz/commission-settle { period }` → 生成 `settle_batch`，把 `accrued` 置 `settled`；
  **结算后不可修改，只能冲销**。
- 权限：`biz:commission:rule`（规则维护）、`biz:commission:list`、`biz:commission:settle`（默认只给店长）。

## 验收（§12 B4）

- 构造 1 笔现金 + 1 笔在线 + 1 笔退款 → 三个营收数字可手工复核
- 分类 10% + 美甲师固定 5 元 → 完成一单后计提金额正确；退款 / 取消 → 记录 `reversed`
- 按期间结算生成批次；结算后再改计提被拒（只能冲销）
- 报表导出：小数据同步 CSV；超 1 万行走异步任务并可下载
- 评价：同一预约二次评价被拒；隐藏后公开列表不再返回

## 常见坑

- 营收把"挂账"或"未收尾款"算进去 → 与 §15.7 不冲突地漏算/多算，必须按净营收口径。
- 提成按"原价"计提 → 默认基数是实收（`paid`），否则退款时会多发工资。
- 提成重组规则后回算历史 → 规则只在生效期内命中，历史记录保留 `rule_id` 与 `base_amount` 以便追溯。
- 报表用 `SUM(payable_amount)` 当营收 → 应付 ≠ 实收（有定金、挂账、退款）。
