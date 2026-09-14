---
title: 会员 · 储值 · 次卡 · 积分
---

# 会员 · 储值 · 次卡 · 积分

本页覆盖会员账务的**全部写入路径**：等级折扣、算价公式、储值本金 / 赠送、次卡核销、积分累计与抵扣、优惠券，以及所有余额类写入必须遵守的**条件更新模板与锁顺序**。

- 代码位置：`src/modules/biz/membership/`
  - `member-accounts/member-accounts.service.ts`（1380 行，**所有会员账务写入的唯一入口**）
  - `member-levels/member-levels.service.ts`、`recharge-plans/`、`card-types/`、`member-cards/`（661 行）
  - `points/points.controller.ts`、`points-goods/points-goods.service.ts`、`coupons/coupons.service.ts`
- 算价纯函数：`src/modules/biz/common/money.ts`
- 表：`biz_customer`（`schema/index.ts:778`）、`biz_member_level`、`biz_recharge_plan`、`biz_member_card*`、`biz_member_transaction`（1137 行）、`biz_points_*`、`biz_coupon_template` / `biz_customer_coupon`

## 顾客即会员

**不新建会员实体，不引入第二个 id**：会员字段直接挂在 `biz_customer` 上。

```ts
// src/database/schema/index.ts:778
/** 顾客档案（兼会员档案，§4.4）：level_id 以下字段全部由账务流水驱动 */
export const bizCustomers = mysqlTable('biz_customer', {
  id: ..., name: varchar('name', { length: 50 }).notNull(), phone: varchar('phone', { length: 20 }),
  gender / birthday / remark,
  visitCount: int('visit_count'), lastVisitAt: datetime('last_visit_at'),
  levelId: int('level_id'), memberNo: varchar('member_no', { length: 32 }), memberSince: datetime('member_since'),
  totalSpent: int('total_spent'), points: int('points'), pointsTotal: int('points_total'),
  balancePrincipal: int('balance_principal'), balanceBonus: int('balance_bonus'),
  ...auditColumns,
}, (table) => [
  uniqueIndex('uq_customer_phone').on(table.phone),
  uniqueIndex('uq_customer_member_no').on(table.memberNo),
  index('idx_customer_level').on(table.levelId),
  ...
]);
```

要点：

- **手机号是唯一锚点**：`uq_customer_phone` 是唯一索引，`phone` 可空（MySQL 唯一索引允许多个 NULL）→ 允许无手机号散客，但**有手机号即为会员档**；
- 微信身份独立在 `app_wx_user`（见 [小程序 app 域实现](/backend/app-domain)）；
- `member_no` / `member_since` 由 `CustomerPort.ensureMembership()` 在**首次充值 / 首次入会**时生成（`member-accounts.service.ts:936`、`ensureMember()`），不是建档时就有；
- `total_spent` / `points` / `points_total` / `balance_principal` / `balance_bonus` / `level_id` **全部由账务流水驱动**，不存在任何"直接改字段"的正规入口。

### 派生字段的维护时机

| 字段                | 累加时机                                                                  | 回减时机                                                        |
| ------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `total_spent`       | `applyEarning()`：正常收款（`type='consume'`）、购卡（`type='card_buy'`） | `reverseEarning()`：退款 / 退卡（`type='refund'`）              |
| `points`            | `applyEarning()`：`floor(amount/100) × pointsPerYuan`                     | `reverseEarning()`（不足时先扣至 0，差额写 `adjust` 流水）      |
| `points_total`      | 只增不减（累计获得）                                                      | —                                                               |
| `balance_principal` | `recharge()` / `creditBalance()`                                          | `applyBalancePayment()` / `refundMember(mode='balance')`        |
| `balance_bonus`     | `recharge()` / `creditBalance(bonus)`                                     | 同上                                                            |
| `level_id`          | `syncLevel()`（自动升级，只升不降）                                       | 仅 `recount()` / `recountAllLevels()` / `adjustMember(levelId)` |

::: tip 积分跟着「钱」走，不跟着「完成」走
`recordConsumption()` 由**支付成功后**的 `deliver()` 调用（[收银与支付通道接入](/backend/payment)），不是服务完成时。所以"服务完成但未收款"不会计积分。
:::

## 等级与折扣率

### 折扣率是**千分比**

`biz_member_level.discount_permille`：`1000` = 不打折，`950` = 95 折，`880` = 88 折。默认 seed（`src/database/seed/biz.ts` 的 `MEMBER_LEVEL_SEEDS`）：

| name | discount_permille | upgrade_amount（分） | sort |
| ---- | ----------------- | -------------------- | ---- |
| 银卡 | 1000              | 0                    | 1    |
| 金卡 | 950               | 50000（¥500）        | 2    |
| 钻卡 | 880               | 200000（¥2000）      | 3    |

服务层校验（`member-levels.service.ts`）：

```ts
throw new BadRequestException('折扣率必须是 0~1000 的整数千分比');
throw new BadRequestException('升级门槛必须是非负整数（分）');
throw new BadRequestException(
  `等级门槛必须随排序单调不减：「${level.name}」排序更小但门槛更高`,
);
```

::: warning 门槛必须随 `sort` 单调不减
否则「取 `sort` 最大的达标等级」这个算法会依赖遍历顺序，结果不可复现。保存时的校验就在 `member-levels.service.ts:254` 附近。
:::

### 升级 / 降级

`pickUpgradeLevel(levels, totalSpent)` 是纯函数（`member-levels.service.ts:47`）：取 `status='active'` 且 `upgrade_amount <= total_spent` 中 `sort` **最大**者。

```ts
// src/modules/biz/membership/member-accounts/member-accounts.service.ts:655
override async syncLevel(tx: BizTx, customerId: number, actorId?: number | null) {
  const row = await this.lockCustomerRow(tx, customerId);
  const levels = await this.levels.allLevels(tx);
  const target = pickUpgradeLevel(levels, row.totalSpent);
  if (!target) return row.levelId;
  const current = row.levelId === null ? null : (levels.find((l) => l.id === row.levelId) ?? null);
  // 只升不降：目标等级排序不高于当前等级时不动（降级只允许 recount / 手工调级）
  if (current && current.sort >= target.sort) return row.levelId;
  ...
}
```

**只升不降**。唯一允许降级的入口：

| 入口                                           | 权限点               | 说明                                                            |
| ---------------------------------------------- | -------------------- | --------------------------------------------------------------- |
| `POST /biz/members/:id/recount`                | `biz:member:recount` | 按流水重算 `total_spent` / 余额 / 积分 / 等级（对账修复，幂等） |
| `POST /biz/members/:id/adjust`（带 `levelId`） | `biz:member:adjust`  | 手工调级，**必须填原因**，写 `level_change` 流水                |
| 定时任务 `recountMemberLevels`                 | —                    | 全量重算（cron `0 30 3 * * *`，每日 03:30）                     |

## 算价公式

算价的**唯一实现**是 `src/modules/biz/common/money.ts` 的 `quoteBooking()`。**服务端重算，前端金额只用于展示与二次确认**。

```ts
// src/modules/biz/common/money.ts:90（节选）
const levelDiscountAmount = Math.floor(
  (originalPrice * (1000 - permille)) / 1000,
);
const baseAfterLevel = Math.max(originalPrice - levelDiscountAmount, 0);
// 券在**等级折扣之后、积分抵扣之前**；且与积分**同一单二选一**
const couponDiscountAmount = input.couponDiscountAmount
  ? Math.min(
      Math.max(Math.trunc(input.couponDiscountAmount), 0),
      baseAfterLevel,
    )
  : 0;
const base4Points = Math.max(baseAfterLevel - couponDiscountAmount, 0);
const maxPointsDiscountAmount = permilleOf(
  base4Points,
  Math.max(input.maxPointsPermille, 0),
);
const maxPoints = centsToPoints(maxPointsDiscountAmount, rate);
const requested =
  couponDiscountAmount > 0 ? 0 : Math.max(Math.trunc(input.pointsUsed ?? 0), 0);
const pointsUsed = Math.min(requested - (requested % rate), maxPoints);
const payableAmount = Math.max(
  originalPrice -
    levelDiscountAmount -
    couponDiscountAmount -
    pointsToCents(pointsUsed, rate) +
    adjustAmount,
  0,
);
```

### 分步口径

| 步骤         | 公式                                                                                                             | 边界                                                            |
| ------------ | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| ① 原价       | `Σ booking_item.price`                                                                                           | 全部是**快照价**，改项目价格不影响历史单                        |
| ② 等级折扣   | `Math.floor(originalPrice × (1000 − permille) / 1000)`                                                           | `permille` 被 `clampPermille` 夹到 `[0, 1000]`，非法值回落 1000 |
| ③ 优惠券     | `Math.min(Math.max(券面额, 0), baseAfterLevel)`                                                                  | 券**不能把单抵成负数**；面额与门槛在**发券时已快照**            |
| ④ 积分上限   | `permilleOf(base4Points, maxPointsPermille)`，默认 `300` → **折后金额的 30%**；再 `centsToPoints()` 折成所需积分 | 上限必须夹取配置，否则一单能被抵成 0                            |
| ⑤ 实际扣分   | `pointsUsed = Math.min(requested − requested % rate, maxPoints)`                                                 | **取整到整元的倍数**（不足 1 元的零头不抵）                     |
| ⑥ 积分抵扣额 | `pointsToCents(pointsUsed, rate) = Math.floor(points / rate) × 100`                                              | `rate = pointsDiscountPerYuan`，默认 **100 分抵 1 元**          |
| ⑦ 手动改价   | `adjustAmount` 可正可负（`Math.trunc`）                                                                          | 需要 `biz:booking:adjust` + **原因**                            |
| ⑧ 应付       | `Math.max(原价 − 等级折扣 − 券 − 积分 + 改价, 0)`                                                                | **不能为负**；取整方向全部**向下**                              |

```ts
/** 千分比取整（向下），`permilleOf(10000, 950) = 9500` */
export function permilleOf(amount: number, permille: number): number {
  return Math.floor((amount * permille) / 1000);
}
```

::: danger 券与积分**同一单二选一**
`quoteBooking()` 里写死：`couponDiscountAmount > 0` 时 `requested = 0`（本单不再抵积分）。建单处还应**显式拒绝**「同时传券与积分」，这里只是兜底 —— 免得出现第三种没人定义过的行为（比如被抵成 0 元）。
:::

### 数字例子

原价 10000 分（¥100），等级 950‰（95 折），顾客想用 5000 积分，`pointsDiscountPerYuan = 100`，`maxPointsPermille = 300`：

| 步骤             | 计算                         | 结果     |
| ---------------- | ---------------------------- | -------- |
| 原价             | —                            | 10000    |
| 等级折扣         | `floor(10000 × 50 / 1000)`   | 500      |
| 折后             | `10000 − 500`                | 9500     |
| 积分上限（金额） | `floor(9500 × 300 / 1000)`   | 2850     |
| 积分上限（分数） | `ceil(2850 / 100) × 100`     | 2900     |
| 实际扣分         | `min(5000 − 0, 2900)`        | 2900     |
| 积分抵扣额       | `floor(2900 / 100) × 100`    | 2900     |
| **应付**         | `10000 − 500 − 0 − 2900 + 0` | **6600** |

### 配置项

`BIZ_CONFIG_DEFAULTS`（`biz-config.service.ts:65`）：

| key                                | 默认          | 含义                           |
| ---------------------------------- | ------------- | ------------------------------ |
| `biz.member.pointsPerYuan`         | `1`           | 每元累计积分                   |
| `biz.member.pointsDiscountPerYuan` | `100`         | 多少积分抵 1 元                |
| `biz.member.maxPointsPermille`     | `300`         | 单笔积分抵扣上限（‰ 折后金额） |
| `biz.member.maxBonusPermille`      | `200`         | 充值赠送比例上限（‰）          |
| `biz.member.bonusDeductMode`       | `bonus_first` | 余额扣减顺序                   |
| `biz.member.minRechargeAmount`     | `10000`       | 单次充值下限（分）             |
| `biz.member.refundNeedReason`      | `true`        | 退款 / 冲正是否必填原因        |

## 储值

### 本金与赠送分列

- `balance_principal`：**实付本金，可退**；
- `balance_bonus`：**赠送，不可退、不可提现**。

### 充值

`POST /biz/members/:id/recharge`（权限 `biz:member:recharge`）：

```ts
// src/modules/biz/membership/member-accounts/member-accounts.service.ts:864
const customer = await this.lockCustomerRowReadOnly(customerId);
if (!customer.phone)
  throw new BadRequestException('会员必须有手机号，请先补全手机号再充值');

if (input.planId) {
  const plan = await this.requirePlan(input.planId);
  payAmount = plan.payAmount;
  bonusAmount = plan.bonusAmount;
  await this.assertBonusRatio(payAmount, bonusAmount);
} else {
  payAmount = Math.trunc(input.payAmount);
  bonusAmount = 0;
}
if (payAmount < minRechargeAmount)
  throw new BadRequestException(
    `单次充值不得低于 ${(minRechargeAmount / 100).toFixed(2)} 元`,
  );
```

- **方案充值**：金额**服务端按方案重算**，绝不信任前端传值；
- **赠送比例上限**：`assertBonusRatio()` → `bonusAmount * 1000 > payAmount * maxBonusPermille` 即 400；
- **首次充值入会**：`before.levelId === null || before.memberNo === null` 时调 `ensureMembership()` 建会员号，并置为**最低启用等级**（`pickLowestLevel`）；
- 流水：`type='recharge'`，`balance_delta_principal = payAmount`、`balance_delta_bonus = bonusAmount`、`amount = payAmount + bonusAmount`、`plan_id` 记录方案。

### 扣减顺序

`bonusDeductMode` 从 `sys_config` 读，默认 `bonus_first`：

```ts
// src/modules/biz/membership/member-accounts/member-accounts.service.ts:1345
private async resolveDeductMode(): Promise<'bonus_first' | 'principal_first' | 'proportional'> {
  const raw = await this.config.getString('biz.member.bonusDeductMode', 'bonus_first');
  if (raw === 'principal_first') return 'principal_first';
  return raw === 'proportional' ? 'proportional' : 'bonus_first';
}
```

| 模式                      | 行为                                           | 代码位置                                                             |
| ------------------------- | ---------------------------------------------- | -------------------------------------------------------------------- |
| `bonus_first`（**默认**） | 先扣赠送，不足再扣本金 —— 顾客可退本金留存更多 | `splitBalanceDeduction(..., 'bonus_first')`（`money.ts:167`）        |
| `principal_first`         | 先扣本金，不足再扣赠送                         | **内联计算**（`member-accounts.service.ts:249`），不在 `money.ts` 里 |
| `proportional`            | 按本金 : 赠送的比例分摊，赠送部分向下取整      | `splitBalanceDeduction(..., 'proportional')`                         |

### 退款只退本金

会员侧的独立冲正入口是 `POST /biz/members/:id/refund`（权限 `biz:member:refund`），`mode` 只有两个值：

| mode      | 行为                                                                        |
| --------- | --------------------------------------------------------------------------- |
| `balance` | 从储值余额退回 → 条件更新回减余额（同样按 `bonusDeductMode` 拆本金 / 赠送） |
| `cash`    | 现金退回 → **只写流水，不动余额**                                           |

```ts
// member-accounts.service.ts:967 —— 冲正 / 退款（§9.6）：写**反向流水**（`reversal_of` 指向原流水），原流水不改。
// 说明：冲正不冲减 `total_spent` / 积分（那是 `reverseConsumption` 的口径），
// 因此流水类型用 `adjust`、金额为正数，`recount` 不会把它算进累计消费。
```

而**预约退款的 `mode='balance'`**（走退款单审批，见 [退款判责与对账](/backend/refund-reconcile)）回补时只传 `principal`：

```ts
await this.members.creditBalance(tx, { customerId: refund.customerId,
  principal: refund.actualAmount,   // 只回补实付本金，赠送不退
  ... });
```

## 次卡

### 卡种与卡种项目

`biz_member_card_type`（名称 / 次数 / 价格 / `valid_days`）+ 子表 `biz_member_card_type_item`（适用项目）。`card-types.service.ts` 的 `applicableServiceItemIds()` 返回适用项目集合；**空集合 = 未配置**（核销时报「卡种未配置适用项目」）。

### 开卡

`issueCard()`（`member-cards.service.ts:106`）：`requireActiveCardType` → `lockCustomer`（锁顺序 customer → member_card）→ 算 `expireAt`（`validDays > 0` 时 `purchasedAt + validDays × 86400000`，**`valid_days = 0` → `expire_at = null` 永久**）→ INSERT 后回填 `card_no = C{yyyyMMdd}{id}`（`buildDocNo('C', ...)`）。

`issue()`（后台发卡入口）在 `payChannel === 'balance'` 时**先** `applyBalancePayment()` 条件扣款（不足 409、不部分扣），再在同一事务里发卡；其余渠道由收银台落 `purpose='card_buy'` 的支付单。

### 核销（不产生金额）

```sql
-- member-cards.service.ts:180（原生 SQL，非 drizzle .set()）
UPDATE biz_member_card
   SET status = IF(used_times + 1 >= total_times, 'used_up', 'active'),
       used_times = used_times + 1
 WHERE id = :id AND deleted_at IS NULL AND status = 'active'
   AND used_times < total_times AND (expire_at IS NULL OR expire_at > NOW());
```

::: danger 这里的 `SET` 顺序不能改
注释写得很明确：**MySQL 的 `UPDATE` 从左到右赋值，后置表达式会读到前面刚赋的新值**，所以 `status` 必须在 `used_times` 之前。drizzle 的 `.set()` 按表列顺序重排，做不到 —— 所以这里用了**原生 SQL**。`affectedRows = 0` → `ConflictException('次卡不可核销（状态已变或次数已用完）')`。
:::

核销的完整副作用：`biz_member_card_log(type='use', times=1)` + `biz_member_transaction(type='card_use')`（`recordLedgerOnly`，**零变动流水**）。支付侧落 `channel='card'`、`amount = received_amount = 0` 的支付单，`payable = 0`，**不叠加等级折扣**。

可用性校验 `assertUsable()`：卡存在 → 未退卡（`refunded`）→ 未过期（`expired` 或 `expire_at <= now`）→ 有剩余次数 → 项目在卡种适用集合内。

### 撤销核销

`POST /biz/member-cards/:id/revert`（权限 `biz:card:revoke`，**必填原因**）：写 `type='revert'` 日志 + 条件更新回补次数。

```ts
SET status = IF(status IN ('used_up', 'expired'), 'active', status),
    used_times = used_times - 1
WHERE id = ? AND deleted_at IS NULL AND status <> 'refunded' AND used_times > 0
```

注意 `refunded` 被排除：**已退卡的核销记录不能撤销**。

### 到期

`expireCards()`（定时任务 `expireMemberCards`，cron `0 5 0 * * *`，每日 00:05）：`active` 且 `expire_at <= now` → `expired`。**幂等，不碰钱**。

```ts
// src/modules/biz/membership/member-cards/member-cards.service.ts:299
.update(bizMemberCards).set({ status: 'expired' })
.where(and(isNull(deletedAt), eq(status, 'active'), isNotNull(expireAt), lte(expireAt, new Date())));
```

::: tip 小程序端不依赖这个任务
`GET /app/member/cards` 的状态是**现算**的（与 `assertUsable` 同一套规则），不依赖定时任务是否已把 `expire_at` 翻成 `expired`。
:::

### 流水表

`biz_member_card_log`：`card_id` / `booking_id` / `service_item_id` / `type`（`use` / `revert`）/ `times` / `remark`。**只追加**。报表的「次卡核销次数」就来自这张表（见 [报表与提成核算](/backend/reports)）。

## 积分

### 累计

```ts
// src/modules/biz/membership/member-accounts/member-accounts.service.ts:432
const { pointsPerYuan } = await this.config.member();
const pointsEarned = Math.floor(amount / CENTS_PER_YUAN) * pointsPerYuan; // 按整元部分
```

默认 **消费 1 元 = 1 分**（`pointsPerYuan = 1`），只算 `payable_amount` 的**整元部分**，**跟着钱走**：收款时累计（`recordConsumption`）、退款时扣减（`reverseConsumption`）。服务完成本身不计分。

### 抵扣

- 汇率 `pointsDiscountPerYuan = 100` → 100 分抵 1 元；
- 单笔上限 `maxPointsPermille = 300` → 折后金额的 30%；
- **不足直接 409，不做部分抵扣**：

```ts
// src/modules/biz/membership/member-accounts/member-accounts.service.ts:318
.where(and(eq(bizCustomers.id, input.customerId), isNull(bizCustomers.deletedAt), gte(bizCustomers.points, points)));
if (!result[0].affectedRows) throw new ConflictException('积分不足');
```

- 试算接口 `POST /biz/points/preview`（权限 `biz:member:list`），服务端按 §5.7 复算上限。

### 退款导致的积分不足

```ts
// src/modules/biz/membership/member-accounts/member-accounts.service.ts:549
// 积分不足：先把差额记在 adjust 上（流水和 = 实际积分余额），备注人工确认
if (pointsReversed < requiredPoints)
  await this.writeLedger(tx, {
    customerId, type: 'adjust',
    pointsDelta: requiredPoints - pointsReversed,
    ...
    remark: `积分不足，人工确认（应扣 ${requiredPoints}，实扣 ${pointsReversed}）`,
  });
```

**退款优先、不阻断**：先扣至 0，差额写 `adjust` 流水使 `SUM(points_delta) = points` 恒成立。

### 兑换

兑换品（`biz_points_goods`）**直接指向卡种**：换项目 = 发一张 N 次卡。

| 接口                                              | 权限点              |
| ------------------------------------------------- | ------------------- |
| `POST /biz/members/:id/redeem`                    | `biz:points:redeem` |
| `GET /biz/points-redeems`                         | `biz:points:redeem` |
| `POST /biz/points-redeems/:id/revert`（必填原因） | `biz:points:revert` |

- 同一事务内扣积分（`deductPoints(type='points_redeem')`）+ 发卡 + 写 `biz_points_redeem` + 流水；
- 库存 `stock`（`-1` = 不限）与每人限兑 `perLimit`（`0` = 不限）在 `points-goods.service.ts` 校验，超限 409；
- **撤销兑换**：回补积分（`creditPoints`）+ 废卡。
- 积分兑换发出的卡与售出的卡**同构**（只是 `price = 0`）。

## 优惠券

- 模板表 `biz_coupon_template`（`schema/index.ts:2588`）、持有表 `biz_customer_coupon`（2617）；
- 后台接口在 `coupons.controller.ts`：`@Controller('biz/coupon-templates')`，`biz:coupon:list|create|update|delete`；
- 顾客侧接口：`GET /app/coupon-offers`、`POST /app/coupons/claim`、`GET /app/coupons`（见 [小程序页面与接口映射](/frontend/miniapp-pages)）；
- 给顾客发券（运营动作）：`POST /biz/members/:id/coupons`（权限 `biz:member:coupon`）。

**叠加顺序（以 `quoteBooking()` 为准）**：

```
等级折扣 → 优惠券 → 积分抵扣 → 手动改价
```

即券在等级折扣**之后**、积分抵扣**之前**，并且**与积分同一单二选一**。券的实际抵扣额会被夹到折后金额以内（券不能把单抵成负数）。

## 写入安全

### 全局锁顺序

```
biz_staff → biz_customer → biz_payment → biz_member_card
```

同类多行按 `id` 升序。事务内一律用 `tx`（`BizTx`）。代码里的体现：

- `createInTx` 里 `balance` 扣减**先于** `biz_payment` INSERT；`card` 核销**后于** `biz_payment` INSERT；
- `issueCard` / `useCard` / `revertUse` 都先 `accounts.lockCustomer(tx, customerId)` 再动卡；
- `lockCustomerRow()` 用 `.for('update')` 锁会员行。

### 条件更新模板

**唯一正确的写法**（`affectedRows = 0` → 抛 409，绝不"读出来再判断"）：

```sql
-- 余额（本金 / 赠送分开判，余额永不为负）
UPDATE biz_customer
   SET balance_bonus = balance_bonus - :b, balance_principal = balance_principal - :p
 WHERE id = :id AND balance_bonus >= :b AND balance_principal >= :p;

-- 次卡核销
UPDATE biz_member_card
   SET status = IF(used_times + 1 >= total_times, 'used_up', 'active'),
       used_times = used_times + 1
 WHERE id = :id AND status = 'active' AND used_times < total_times
   AND (expire_at IS NULL OR expire_at > NOW());

-- 积分（抵扣 / 兑换）
UPDATE biz_customer SET points = points - :p WHERE id = :id AND points >= :p;
```

对应实现见 `member-accounts.service.ts:261`（储值扣减）、`member-cards.service.ts:180`（次卡核销）、`member-accounts.service.ts:318`（积分）—— 三处都是 `if (!result[0].affectedRows) throw new ConflictException(...)`。

### 错误写法（真实反例）

下面是**同一个文件里被刻意避免**的写法，等价于把并发安全交给运气：

```ts
// ❌ 错误：读出来相减 —— 并发下会把余额扣成负数
const row = await tx.select().from(bizCustomers).where(eq(bizCustomers.id, id));
if (row.balancePrincipal + row.balanceBonus < amount) throw new ConflictException('余额不足');
await tx.update(bizCustomers).set({ balancePrincipal: row.balancePrincipal - amount }).where(eq(bizCustomers.id, id));

// ❌ 错误：撤销核销不带状态与次数条件
.update(bizMemberCards).set({ usedTimes: sql`${bizMemberCards.usedTimes} - 1` }).where(eq(bizMemberCards.id, id));
// 会把已退卡 / 未核销过的卡减成负数（unsigned 列 → 静默截断），并让对账等式失衡
```

`balance_principal` / `balance_bonus` / `points` / `used_times` 都是 **unsigned 列**：不设下限条件时，MySQL 非严格模式会**静默截断为 0**，账就丢了。

### 只追加 + 冲正

`biz_member_transaction` / `biz_member_card_log` / `biz_payment_log` / `biz_receivable_payment` / `biz_commission_record` **只插入，不更新不删除**。纠错一律**反向流水**：唯一写流水入口是 `writeLedger()`（`member-accounts.service.ts:1200`），只 `INSERT`，`reversal_of` 指向原流水、`remark` 写原因，**原记录保持不动**。

### 对账等式

```
SUM(balance_delta_principal) = biz_customer.balance_principal
SUM(balance_delta_bonus)     = biz_customer.balance_bonus
SUM(points_delta)            = biz_customer.points
```

不一致时用 `recount()`（`member-accounts.service.ts:692`）按流水聚合后整体回写并重算等级，**禁止手改字段**。

### 「改动这里时最容易踩的坑」

1. **在应用层"读余额再相减"** → 必须条件更新；`affectedRows = 0` 一律 409。
2. **抵扣不设上限** → 一单被抵成 0；上限必须夹取 `maxPointsPermille`。
3. **退款只按金额回减，忘记按比例回减积分与 `total_spent`** → 对账等式失衡。
4. **把"服务完成"当积分累计时点** → 积分跟着**钱**走；退款要先扣至 0，差额写 `adjust`。
5. **改 `bonusDeductMode` 只改 `money.ts`** → `principal_first` 是内联计算的，两处都要看。
6. **给次卡核销叠加等级折扣** → 核销 `payable = 0`，不叠加折扣。
7. **用 drizzle `.set()` 写次卡核销的 `status` / `used_times`** → 列顺序会重排，必须用原生 SQL。
8. **退款回补赠送余额** → 赠送**不可退、不可提现**，只回补 `principal`。
9. **新写一张流水表或改流水** → 流水只追加，纠错走 `reversal_of`。
10. **忘了先锁 `biz_customer` 就动 `biz_member_card`** → 破坏全局锁顺序，跨表并发会死锁 1213。

## 相关页面

- 收款如何触发 `recordConsumption`：[收银与支付通道接入](/backend/payment)
- 退款如何回减积分与冲销提成：[退款判责与对账](/backend/refund-reconcile)
- 会员相关报表口径：[报表与提成核算](/backend/reports)
- 会员账务表结构详解：[业务表详解](/data/business-tables)
