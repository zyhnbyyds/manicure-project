---
name: base-data
description: 基础数据模块：服务项目、美甲师档案、美甲师可做项目配置、顾客档案（兼会员档案）。含删除保护规则、手机号唯一与软删策略、顾客↔会员↔微信的绑定锚点。写 CRUD、排查"为什么删不掉""为什么建不了同号顾客"时加载。
whenToUse: 实现/修改服务项目、美甲师、美甲师可做项目、顾客档案的接口与页面；处理引用保护与手机号唯一冲突。
metadata:
  version: '1.0.0'
  spec: docs/superpowers/specs/2026-09-11-nail-salon-booking-design.md
  sections: §4.3 / §9.1~§9.4 / §9.11 / §22 / §4.4
---

# 基础数据

## 四块内容

| 模块               | 表                       | 接口                                                              |
| ------------------ | ------------------------ | ----------------------------------------------------------------- |
| 服务项目           | `biz_service_item`       | `GET/POST/PATCH/DELETE /biz/service-items`                        |
| 美甲师             | `biz_staff`              | `GET/POST/PATCH/DELETE /biz/staffs`                               |
| 美甲师可做项目     | `biz_staff_service_item` | `GET/PUT /biz/staffs/:id/service-items`                           |
| 顾客档案（兼会员） | `biz_customer`           | `GET/POST/PATCH/DELETE /biz/customers` + `/bookings` + `/recount` |

## 关键设计点

**服务项目**：`duration_minutes` 决定占用时段；`buffer_minutes` 参与冲突（多项目取 max）；
`price` 单位分；`status=disabled` 后不可被预约（`available-slots` 与下单都要校验）。

**美甲师**：

- `user_id` **可空**——美甲师未必有后台账号（店里可能只有店长登录）；
- `ON DELETE SET NULL`，且停用后不再出现在可约列表。

**美甲师可做项目（§22）**：

- **空集合 = 可做全部项目**（新建美甲师默认能用，兼容旧行为）；只要有一条记录，就只可做这些；
- 影响三处：`available-slots`（不满足 → `reason=staff_cannot_do`）、创建/改期/周期生成（400）、
  前端选完项目后过滤美甲师列表；
- 与**卡种适用项目**是两条独立规则：卡种管"这张卡能核销什么"，本表管"这个人会做什么"，核销要**同时满足**；
- 整体 PUT 替换（物理删表，§3 已豁免）。

**顾客档案**：

- 手机号是会员与小程序绑定的**唯一锚点**：允许"无手机号散客"，**不允许**"无手机号会员"；
- `uq_customer_phone` 唯一；查重**不过滤 `deletedAt`**——命中软删记录时提示「该手机号属于已删除顾客 #id，
  是否恢复？」，否则删掉顾客就永远建不回同号（撞 1062）；
- 会员字段（`level_id` / `total_spent` / `points` / `balance_*`）由账务 service 驱动，**禁止手改**；
- `visit_count` / `last_visit_at` 由预约完成累加，可用 `recount` 修复。

## 删除保护（软删但要先判引用）

| 对象     | 拒绝条件                                         |
| -------- | ------------------------------------------------ |
| 服务项目 | 被预约引用（`biz_booking_item`）或存在未完成预约 |
| 美甲师   | 存在未完成预约                                   |
| 顾客     | 有预约记录                                       |
| 会员等级 | 有会员在该等级                                   |
| 卡种     | 不影响已发出的卡（可删）                         |

## 权限点

`biz:serviceitem:*`、`biz:staff:list|create|update|delete`、`biz:staff:items`（可做项目）、
`biz:customer:*`。菜单与按钮权限写进 `src/database/seed/menus.ts`。

## 验收

- 能完整 CRUD；停用项目不出现在可约选择中；
- 手机号重复创建顾客被拒绝并给出**明确提示**（含"是否恢复软删记录"的分支）；
- 把某美甲师限制为 2 个项目 → 查第 3 个项目的可约时段返回空（`staff_cannot_do`）；下单 → 400；
  **清空配置后恢复"可做全部"**；
- 删除被引用的对象被拒且提示原因。

## 常见坑

- 顾客档案是"顾客 + 会员"一张表，别新建 `biz_member` 实体（v1.3 已定：顾客即会员）。
- 别把 `wx openid` 塞进 `biz_customer`（访客会污染档案）；微信身份在 `app_wx_user`。
- 修改项目时长/缓冲/价格**不影响历史单据**（快照已落库），不要写"回填历史"的逻辑。
