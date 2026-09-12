---
name: membership
description: 会员体系：顾客即会员的字段、等级折扣率（千分比）、积分累计/抵扣/兑换、储值本金与赠送余额及退款审批、次卡核销与到期，以及算价公式（等级折扣 → 积分抵扣 → 改价）。写会员、充值、次卡、积分、算价相关代码时加载。
whenToUse: 实现或修改会员等级/积分/储值/次卡接口与页面；写算价逻辑；排查"折扣算错""积分抵太多""次卡核销不了""退款该退多少"。
metadata:
  version: '1.0.0'
  spec: project-design/superpowers/specs/2026-09-11-nail-salon-booking-design.md
  sections: §5.7 / §15 / §9.6 / §9.10 / §12 B2
---

# 会员体系

**顾客即会员**：会员字段直接挂在 `biz_customer`（不新建会员实体，不引入第二个 id）。
微信身份独立在 `app_wx_user`。手机号是必填锚点：可有无手机号散客，不可有无手机号会员。

## 算价（§5.7，服务端重算，前端金额只用于展示）

```
original  = Σ booking_item.price
permille  = customer.level_id ? level.discount_permille : 1000
levelDisc = floor(original * (1000 - permille) / 1000)          // 向下取整
base4Points = max(original - levelDisc, 0)
pointsDisc  = min(floor(points / pointsDiscountPerYuan),
                  floor(base4Points * maxPointsPermille / 1000))
pointsUsed  = pointsDisc * pointsDiscountPerYuan
adjust    = 手动改价差额（可正可负，需 biz:booking:adjust + 原因）
payable   = max(original - levelDisc - pointsDisc + adjust, 0)
deposit   = 全款 ? payable : 定金（§17.2）
```

金额快照全部落库；改等级 / 改价格**不影响历史单据**。

## 等级（§15.2）

- `discount_permille` 千分比（1000=不打折，950=9.5 折，880=8.8 折）；`upgrade_amount` 累计消费门槛。
- 升级：`max(sort) where status='active' and upgrade_amount <= total_spent`；**只升不降**；
  唯一允许"降级"的入口是 `recountMemberLevels` 任务与 `POST /biz/members/:id/recount`。
- 等级门槛必须随 `sort` 单调不减（保存时校验）。
- 手工调级需 `biz:member:adjust` + 原因 + `level_change` 流水。

## 积分（§15.3）

- **累计**：消费 1 元 = 1 分（`pointsPerYuan`），按 `payable_amount` 整元部分，**跟着钱走**
  （收款时累计、退款时扣减；服务完成本身不计分）。
- **抵扣**：100 分抵 1 元（`pointsDiscountPerYuan`），单笔最多抵折后金额的 30%（`maxPointsPermille`）；
  可与等级折扣叠加；不足直接 400，**不做部分抵扣**。
- **兑换**：兑换品直接指向**卡种**（换项目 = 发一张 1 次卡），同一事务内扣积分 + 发卡 + 写
  `points_redeem` 流水 + `biz_points_redeem`；撤销兑换回补积分并废卡。
- 退款导致积分不足时：先扣至 0，差额写 `adjust` 并备注（**退款优先，不阻断**）。

## 储值（§15.4）

- 余额拆 `balance_principal`（实付本金，可退）与 `balance_bonus`（赠送，**不可退、不可提现**）。
- 充值方案（充 1000 送 100）或自定义金额；赠送比例上限 `maxBonusPermille`（默认 200‰）；
  充值收款走 `biz_payment(purpose=recharge)`，支持线上扫码。
- 扣减顺序 `bonusDeductMode`：`bonus_first`（默认，顾客可退本金留存更多）/ `principal_first` / `proportion`。
- **储值退款**：只退**本金**，走退款单 + 审批（`biz:refund:apply` / `biz:refund:approve`），
  原路退回或现金退；成功后同事务回减余额、写 `refund` 流水（`reversal_of`）、冲减 `total_spent` 与积分。

## 次卡（§15.5）

- 卡种（`biz_member_card_type` + 适用项目子表）→ 发卡（`biz_member_card`，`card_no=C{yyyyMMdd}{id}`）→
  核销（`biz_member_card_log`，`type=use`）。
- 核销**不叠加等级折扣**（`payable=0`，支付单 `channel=card`）；只能在卡种适用项目内核销，
  且要满足美甲师可做该项目。
- 撤销核销写 `type=revert` 并回补次数（`biz:card:revoke`，必填原因）。
- 到期：`valid_days=0` 永久；`expireMemberCards` 置 `expired`；退卡走退款单 + 审批，冲减 `total_spent`。
- 积分兑换发出的卡与售出的卡同构（只是 `price=0`）。

## 接口与权限

- §9.6：等级 / 充值方案 / 卡种 / 会员 / 充值 / 退款 / 调整 / recount / 发卡 / 撤销核销 / 退卡。
- §9.10：兑换品维护、抵扣试算、兑换、撤销兑换。
- 权限点见 §8.1：`biz:memberlevel:*`、`biz:rechargeplan:*`、`biz:cardtype:*`、`biz:member:*`、
  `biz:member:recharge`、`biz:member:refund`、`biz:card:*`、`biz:pointsgoods:*`、`biz:points:redeem|revert`。
  **钱的权限默认只给店长。**

## 验收（§12 B2）

- 原价 10000、9.5 折 → 优惠 500、应付 9500；再用积分按上限抵扣后金额正确
- 充 1000 送 100 → 本金 +100000、赠送 +10000；赠送超上限被拒
- 应付 9500、余额 8000 → 409（不部分扣）；余额充足则扣减与流水一致
- `SUM(balance_delta_principal) = balance_principal`、`SUM(points_delta) = points`
- 并发扣减不会把余额扣成负数
- 10 次卡核销 10 次 → `used_up`；第 11 次被拒；撤销后回补；过期卡不可核销
- 流水只追加：没有任何接口能改 / 删流水

## 常见坑

- 在应用层"读余额再相减" → 必须条件更新（见 `money-invariants`）。
- 抵扣不设上限 → 一单被抵成 0；上限必须夹取配置。
- 退款只按金额回减，忘记按比例回减积分与 `total_spent`。
- 把"服务完成"当积分累计时点 → 积分跟着**钱**走，不是跟着完成走。
