---
title: 权限点与菜单清单
---

本页是菜单与权限点的**权威清单**，全部由 `src/database/seed/menus.ts`（756 行）逐条还原而来：`MENU_SEEDS` 静态声明 + `buildBizMenus()` 依据 `BIZ_PAGES` 动态展开。后端守卫读取的是 JWT 里的 `permissions`，而 JWT 的 `permissions` 来自「用户 → 角色 → `sys_role_menu` → `sys_menu.permission`」这条链路，因此**改权限先改 seed**是唯一正确的入口。

::: tip 口径说明

- 菜单行总数 **113**：目录 `M` **3**、菜单 `C` **42**、按钮 `F` **68**。
- 权限点字符串总数 **106**（`sys_menu.permission` 去重后仍是 106，无重复）：
  页面级 `C` 行 **38** 个 + 按钮级 `F` 行 **68** 个。
- 后端 Controller 装饰器里实际出现的权限点 **134** 个，与 seed 的差额见「[seed 与代码的交叉核对](#seed-与代码的交叉核对)」小节。
- 鉴权实现细节见 [鉴权 · RBAC · 数据权限](/backend/auth-rbac)，表结构见 [系统 · 监控 · AI · 小程序身份表](/data/system-tables)，接口细节见 [接口契约索引](/appendix/api)。
  :::

::: warning seed 是唯一权威来源
`sys_menu.permission` 上有唯一索引 `uq_menu_permission`，同一个权限点**只能落在数据库的一行菜单上**。手工在「菜单管理」页面加一个按钮权限点，而不改 `src/database/seed/menus.ts`，下一次 `bun run db:seed:menus` 不会删除它（seed 按 `name` 查，不认识的 `name` 不处理），但它也**永远不会**被 seed 补回：换库、重置环境后这枚权限点会静默消失，角色授权随之失效。任何权限点的新增/重命名，都必须先落进 seed。
:::

## 菜单树

层级取自 `parentKey`（父菜单的 `name`）；顶层节点的 `parentKey` 为空，落库时 `parent_id = 0`。`sort` 同级递增，业务页面的 `sort` 等于它在 `BIZ_PAGES` 中的下标 + 1。

- `dashboard` 首页 · `C` · `/dashboard` · `dashboard/index` · icon `home` · sort 1 · （无权限点）
- `system` 系统管理 · `M` · `/system` · icon `setting` · sort 2
  - `system_users` 用户管理 · `C` · `/system/users` · `system/users/index` · `system:user:list` · icon `user` · sort 1
  - `system_roles` 角色管理 · `C` · `/system/roles` · `system/roles/index` · `system:role:list` · icon `role` · sort 2
  - `system_menus` 菜单管理 · `C` · `/system/menus` · `system/menus/index` · `system:menu:list` · icon `menu` · sort 3
  - `system_depts` 部门管理 · `C` · `/system/depts` · `system/depts/index` · `system:dept:list` · icon `dept` · sort 4
  - `system_posts` 岗位管理 · `C` · `/system/posts` · `system/posts/index` · `system:post:list` · icon `post` · sort 5
  - `system_dicts` 字典管理 · `C` · `/system/dicts` · `system/dicts/index` · `system:dict:list` · icon `dict` · sort 6
  - `system_configs` 参数配置 · `C` · `/system/configs` · `system/configs/index` · `system:config:list` · icon `config` · sort 7
- `monitor` 系统监控 · `M` · `/monitor` · icon `monitor` · sort 3
  - `monitor_login_logs` 登录日志 · `C` · `/monitor/login-logs` · `monitor/login-logs/index` · `monitor:loginlog:list` · icon `loginlog` · sort 1
  - `monitor_operation_logs` 操作日志 · `C` · `/monitor/operation-logs` · `monitor/operation-logs/index` · `monitor:operlog:list` · icon `operlog` · sort 2
  - `monitor_online` 在线用户 · `C` · `/monitor/online` · `monitor/online/index` · `monitor:online:list` · icon `online` · sort 3
  - `monitor_cache` 缓存监控 · `C` · `/monitor/cache` · `monitor/cache/index` · `monitor:cache:list` · icon `cache` · sort 4
- `jobs` 定时任务 · `C` · `/jobs` · `jobs/index` · `system:job:list` · icon `clock` · sort 4
- `files` 文件管理 · `C` · `/files` · `files/index` · `system:file:list` · icon `file` · sort 5
- `generator` 代码生成器 · `C` · `/generator` · `generator/index` · `system:generator:list` · icon `code` · sort 6
- `ai` AI 操作 · `C` · `/ai` · `ai/index` · `ai:chat` · icon `bot` · sort 7
- `biz` 美甲预约 · `M` · `/biz` · icon `activity` · sort 8
  - `biz_service_items` 服务项目 · `C` · `/biz/service-items` · `biz/service-items/index` · `biz:serviceitem:list` · icon `files` · sort 1
    - `biz_serviceitem_create` 服务项目-create · `F` · `biz:serviceitem:create` · sort 1
    - `biz_serviceitem_update` 服务项目-update · `F` · `biz:serviceitem:update` · sort 2
    - `biz_serviceitem_delete` 服务项目-delete · `F` · `biz:serviceitem:delete` · sort 3
  - `biz_staffs` 美甲师 · `C` · `/biz/staffs` · `biz/staffs/index` · `biz:staff:list` · icon `user` · sort 2
    - `biz_staff_create` 美甲师-create · `F` · `biz:staff:create` · sort 1
    - `biz_staff_update` 美甲师-update · `F` · `biz:staff:update` · sort 2
    - `biz_staff_delete` 美甲师-delete · `F` · `biz:staff:delete` · sort 3
    - `biz_staff_items` 美甲师-items · `F` · `biz:staff:items` · sort 4
  - `biz_app_staff_grants` 工作台授权 · `C` · `/biz/app-staff-grants` · `biz/app-staff-grants/index` · `biz:staff:grant` · icon `user` · sort 3
  - `biz_schedules` 排班管理 · `C` · `/biz/schedules` · `biz/schedules/index` · `biz:schedule:list` · icon `clock` · sort 4
    - `biz_schedule_update` 排班管理-update · `F` · `biz:schedule:update` · sort 1
  - `biz_customers` 顾客档案 · `C` · `/biz/customers` · `biz/customers/index` · `biz:customer:list` · icon `user` · sort 5
    - `biz_customer_create` 顾客档案-create · `F` · `biz:customer:create` · sort 1
    - `biz_customer_update` 顾客档案-update · `F` · `biz:customer:update` · sort 2
    - `biz_customer_delete` 顾客档案-delete · `F` · `biz:customer:delete` · sort 3
  - `biz_bookings` 预约管理 · `C` · `/biz/bookings` · `biz/bookings/index` · `biz:booking:list` · icon `activity` · sort 6
    - `biz_booking_create` 预约管理-create · `F` · `biz:booking:create` · sort 1
    - `biz_booking_update` 预约管理-update · `F` · `biz:booking:update` · sort 2
    - `biz_booking_cancel` 预约管理-cancel · `F` · `biz:booking:cancel` · sort 3
    - `biz_booking_arrive` 预约管理-arrive · `F` · `biz:booking:arrive` · sort 4
    - `biz_booking_complete` 预约管理-complete · `F` · `biz:booking:complete` · sort 5
    - `biz_booking_noshow` 预约管理-noshow · `F` · `biz:booking:noshow` · sort 6
    - `biz_booking_delete` 预约管理-delete · `F` · `biz:booking:delete` · sort 7
    - `biz_booking_manageall` 预约管理-manageall · `F` · `biz:booking:manageall` · sort 8
    - `biz_booking_adjust` 预约管理-adjust · `F` · `biz:booking:adjust` · sort 9
  - `biz_member_levels` 会员等级 · `C` · `/biz/member-levels` · `biz/member-levels/index` · `biz:memberlevel:list` · icon `role` · sort 7
    - `biz_memberlevel_create` 会员等级-create · `F` · `biz:memberlevel:create` · sort 1
    - `biz_memberlevel_update` 会员等级-update · `F` · `biz:memberlevel:update` · sort 2
    - `biz_memberlevel_delete` 会员等级-delete · `F` · `biz:memberlevel:delete` · sort 3
  - `biz_recharge_plans` 充值方案 · `C` · `/biz/recharge-plans` · `biz/recharge-plans/index` · `biz:rechargeplan:list` · icon `config` · sort 8
    - `biz_rechargeplan_create` 充值方案-create · `F` · `biz:rechargeplan:create` · sort 1
    - `biz_rechargeplan_update` 充值方案-update · `F` · `biz:rechargeplan:update` · sort 2
    - `biz_rechargeplan_delete` 充值方案-delete · `F` · `biz:rechargeplan:delete` · sort 3
  - `biz_card_types` 次卡卡种 · `C` · `/biz/card-types` · `biz/card-types/index` · `biz:cardtype:list` · icon `dict` · sort 9
    - `biz_cardtype_create` 次卡卡种-create · `F` · `biz:cardtype:create` · sort 1
    - `biz_cardtype_update` 次卡卡种-update · `F` · `biz:cardtype:update` · sort 2
    - `biz_cardtype_delete` 次卡卡种-delete · `F` · `biz:cardtype:delete` · sort 3
  - `biz_members` 会员管理 · `C` · `/biz/members` · `biz/members/index` · `biz:member:list` · icon `online` · sort 10
    - `biz_member_update` 会员管理-update · `F` · `biz:member:update` · sort 1
    - `biz_member_adjust` 会员管理-adjust · `F` · `biz:member:adjust` · sort 2
    - `biz_member_recount` 会员管理-recount · `F` · `biz:member:recount` · sort 3
    - `biz_member_recharge` 会员管理-recharge · `F` · `biz:member:recharge` · sort 4
    - `biz_member_refund` 会员管理-refund · `F` · `biz:member:refund` · sort 5
    - `biz_member_coupon` 会员管理-coupon · `F` · `biz:member:coupon` · sort 6
    - `biz_card_issue` 会员管理-issue · `F` · `biz:card:issue` · sort 7
    - `biz_card_use` 会员管理-use · `F` · `biz:card:use` · sort 8
  - `biz_member_cards` 会员次卡 · `C` · `/biz/member-cards` · `biz/member-cards/index` · `biz:card:list` · icon `generator` · sort 11
    - `biz_card_revoke` 会员次卡-revoke · `F` · `biz:card:revoke` · sort 1
    - `biz_card_refund` 会员次卡-refund · `F` · `biz:card:refund` · sort 2
  - `biz_cashier` 收银台 · `C` · `/biz/cashier` · `biz/cashier/index` · （**页面 `permission` 故意留空**） · icon `gauge` · sort 12
    - `biz_payment_create` 收银台-create · `F` · `biz:payment:create` · sort 1
    - `biz_payment_close` 收银台-close · `F` · `biz:payment:close` · sort 2
    - `biz_refund_apply` 收银台-apply · `F` · `biz:refund:apply` · sort 3
    - `biz_receivable_settle` 收银台-settle · `F` · `biz:receivable:settle` · sort 4
  - `biz_payments` 支付流水 · `C` · `/biz/payments` · `biz/payments/index` · `biz:payment:list` · icon `code` · sort 13
    - `biz_payment_reconcile` 支付流水-reconcile · `F` · `biz:payment:reconcile` · sort 1
  - `biz_refunds` 退款审批 · `C` · `/biz/refunds` · `biz/refunds/index` · `biz:refund:list` · icon `operlog` · sort 14
    - `biz_refund_approve` 退款审批-approve · `F` · `biz:refund:approve` · sort 1
  - `biz_payment_diffs` 支付对账 · `C` · `/biz/payment-diffs` · `biz/payment-diffs/index` · （**被按钮抢占，见下**） · icon `server` · sort 15
  - `biz_credit_accounts` 挂账主体 · `C` · `/biz/credit-accounts` · `biz/credit-accounts/index` · `biz:credit:list` · icon `dept` · sort 16
    - `biz_credit_create` 挂账主体-create · `F` · `biz:credit:create` · sort 1
    - `biz_credit_update` 挂账主体-update · `F` · `biz:credit:update` · sort 2
    - `biz_credit_delete` 挂账主体-delete · `F` · `biz:credit:delete` · sort 3
  - `biz_receivables` 应收台账 · `C` · `/biz/receivables` · `biz/receivables/index` · `biz:receivable:list` · icon `folder` · sort 17
    - `biz_receivable_cancel` 应收台账-cancel · `F` · `biz:receivable:cancel` · sort 1
  - `biz_points_goods` 积分兑换品 · `C` · `/biz/points-goods` · `biz/points-goods/index` · `biz:pointsgoods:list` · icon `post` · sort 18
    - `biz_pointsgoods_create` 积分兑换品-create · `F` · `biz:pointsgoods:create` · sort 1
    - `biz_pointsgoods_update` 积分兑换品-update · `F` · `biz:pointsgoods:update` · sort 2
    - `biz_pointsgoods_delete` 积分兑换品-delete · `F` · `biz:pointsgoods:delete` · sort 3
    - `biz_points_redeem` 积分兑换品-redeem · `F` · `biz:points:redeem` · sort 4
    - `biz_points_revert` 积分兑换品-revert · `F` · `biz:points:revert` · sort 5
  - `biz_coupons` 优惠券模板 · `C` · `/biz/coupons` · `biz/coupons/index` · `biz:coupon:list` · icon `coupon` · sort 19
    - `biz_coupon_create` 优惠券模板-create · `F` · `biz:coupon:create` · sort 1
    - `biz_coupon_update` 优惠券模板-update · `F` · `biz:coupon:update` · sort 2
    - `biz_coupon_delete` 优惠券模板-delete · `F` · `biz:coupon:delete` · sort 3
  - `biz_reviews` 评价管理 · `C` · `/biz/reviews` · `biz/reviews/index` · `biz:review:list` · icon `menu` · sort 20
    - `biz_review_create` 评价管理-create · `F` · `biz:review:create` · sort 1
    - `biz_review_reply` 评价管理-reply · `F` · `biz:review:reply` · sort 2
    - `biz_review_hide` 评价管理-hide · `F` · `biz:review:hide` · sort 3
    - `biz_review_delete` 评价管理-delete · `F` · `biz:review:delete` · sort 4
  - `biz_reports` 报表中心 · `C` · `/biz/reports` · `biz/reports/index` · `biz:report:view` · icon `dashboard` · sort 21
    - `biz_report_export` 报表中心-export · `F` · `biz:report:export` · sort 1
  - `biz_commission_rules` 提成规则 · `C` · `/biz/commission-rules` · `biz/commission-rules/index` · （**页面 `permission` 留空，权限点落在按钮行**） · icon `key` · sort 22
    - `biz_commission_rule` 提成规则-rule · `F` · `biz:commission:rule` · sort 1
  - `biz_commission_records` 提成结算 · `C` · `/biz/commission-records` · `biz/commission-records/index` · `biz:commission:list` · icon `profile` · sort 23
    - `biz_commission_settle` 提成结算-settle · `F` · `biz:commission:settle` · sort 1
  - `biz_recurrences` 周期预约 · `C` · `/biz/recurrences` · `biz/recurrences/index` · `biz:recurrence:list` · icon `loginlog` · sort 24
    - `biz_recurrence_create` 周期预约-create · `F` · `biz:recurrence:create` · sort 1
    - `biz_recurrence_update` 周期预约-update · `F` · `biz:recurrence:update` · sort 2
    - `biz_recurrence_delete` 周期预约-delete · `F` · `biz:recurrence:delete` · sort 3
  - `biz_notice_templates` 通知模板 · `C` · `/biz/notice-templates` · `biz/notice-templates/index` · `biz:notice:template` · icon `dict` · sort 25
    - `biz_notice_send` 通知模板-send · `F` · `biz:notice:send` · sort 1
  - `biz_notice_logs` 通知记录 · `C` · `/biz/notice-logs` · `biz/notice-logs/index` · `biz:notice:log` · icon `cache` · sort 26

### 页面级权限点被「让位」的四行

`buildBizMenus()` 里的 `claimed: Set<string>` 按**遍历顺序**先到先得，这是理解 106 这个数字的关键：

1. **遍历一个页面时，先占页面自己的 `permission`，再占该页面 `permissions[]` 展开出的按钮权限点**。
2. 某个权限点若已被占用，页面行的 `permission` 被置为 `undefined`（落库 `NULL`，可重复），该页面的可见性改由 `sys_role_menu` 授权决定，不依赖页面 `permission`。
3. 按钮行的权限点若已被占用，该按钮**整行不生成**。

按代码顺序推演，最终页面 `permission` 为空的有 4 行：

| 菜单 `name`            | 页面标题 | 页面声明的 `permission`                      | 该权限点实际落在哪一行                                                  | 让位原因                                                                                         |
| ---------------------- | -------- | -------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `dashboard`            | 首页     | 无（seed 未声明）                            | —                                                                       | 首页不设权限点，登录即可见                                                                       |
| `biz_cashier`          | 收银台   | 无（**故意留空**）                           | —                                                                       | 收银台的资金动作由 4 个 `F` 按钮控制；`biz:payment:list` 归「支付流水」页面所有                  |
| `biz_payment_diffs`    | 支付对账 | `biz:payment:reconcile`                      | `F` 行 `biz_payment_reconcile`（挂在「支付流水」下，sort 13 → 15 之前） | `biz_payments`（下标 12）先遍历：页面先占 `biz:payment:list`，按钮再抢走 `biz:payment:reconcile` |
| `biz_commission_rules` | 提成规则 | 无（代码注释：唯一索引下不能与下方按钮重复） | `F` 行 `biz_commission_rule`                                            | 页面权限点与按钮权限点是同一个字符串，只能存在一行                                               |

另外两处容易误判、但**实际未发生让位**的例子：

- `biz_app_staff_grants`（工作台授权）的页面 `permission` 是 `biz:staff:grant`，而它的 `permissions: []` 是**空数组**，展开不出任何按钮行，因此 `biz:staff:grant` 稳稳落在这一行 `C` 菜单上，页面靠这一个点同时管住「列表 + 通过 + 驳回」。
- `biz_members`（会员管理）声明了 `biz:card:issue` / `biz:card:use`，`biz_member_cards`（会员次卡）声明了 `biz:card:revoke` / `biz:card:refund`：四者字符串互不相同，因此四个 `F` 行全部生成，只是分属两个页面。

## 全部权限点清单

`所属菜单`列对页面级权限点填页面自身，对按钮级权限点填它挂载的页面。类型中「菜单」=落在 `C` 行，「按钮」=落在 `F` 行。共 **106** 行，穷举无抽样。

| 权限点字符串              | 中文名称           | 所属菜单   | 类型 | 典型用途                                                               |
| ------------------------- | ------------------ | ---------- | ---- | ---------------------------------------------------------------------- |
| `system:user:list`        | 用户管理           | 用户管理   | 菜单 | 进入用户管理页、查询用户列表                                           |
| `system:role:list`        | 角色管理           | 角色管理   | 菜单 | 进入角色管理页、查看角色与已授权菜单                                   |
| `system:menu:list`        | 菜单管理           | 菜单管理   | 菜单 | 进入菜单管理页、读取菜单树                                             |
| `system:dept:list`        | 部门管理           | 部门管理   | 菜单 | 进入部门管理页、读取部门树                                             |
| `system:post:list`        | 岗位管理           | 岗位管理   | 菜单 | 进入岗位管理页                                                         |
| `system:dict:list`        | 字典管理           | 字典管理   | 菜单 | 进入字典管理页、读取字典类型与字典数据                                 |
| `system:config:list`      | 参数配置           | 参数配置   | 菜单 | 进入参数配置页、按 key 读取参数                                        |
| `monitor:loginlog:list`   | 登录日志           | 登录日志   | 菜单 | 进入登录日志页                                                         |
| `monitor:operlog:list`    | 操作日志           | 操作日志   | 菜单 | 进入操作日志页                                                         |
| `monitor:online:list`     | 在线用户           | 在线用户   | 菜单 | 进入在线用户页                                                         |
| `monitor:cache:list`      | 缓存监控           | 缓存监控   | 菜单 | 进入缓存监控页                                                         |
| `system:job:list`         | 定时任务           | 定时任务   | 菜单 | 进入定时任务页、查看任务与执行日志                                     |
| `system:file:list`        | 文件管理           | 文件管理   | 菜单 | 进入文件管理页、下载文件                                               |
| `system:generator:list`   | 代码生成器         | 代码生成器 | 菜单 | 进入代码生成器页、预览生成结果                                         |
| `ai:chat`                 | AI 操作            | AI 操作    | 菜单 | 进入 AI 页，会话 / 消息 / 操作意图 / 任务的全部读写                    |
| `biz:serviceitem:list`    | 服务项目           | 服务项目   | 菜单 | 进入页面、读取服务项目列表与详情                                       |
| `biz:staff:list`          | 美甲师             | 美甲师     | 菜单 | 进入页面、读取美甲师列表、详情与其可做项目                             |
| `biz:staff:grant`         | 工作台授权         | 工作台授权 | 菜单 | 一个点管住整页：工作台开通申请的列表、通过、驳回                       |
| `biz:schedule:list`       | 排班管理           | 排班管理   | 菜单 | 进入页面、读取周模板与日期例外                                         |
| `biz:customer:list`       | 顾客档案           | 顾客档案   | 菜单 | 进入页面、读取顾客列表/详情/其预约                                     |
| `biz:booking:list`        | 预约管理           | 预约管理   | 菜单 | 进入页面、预约列表、可约时段、预约详情、顾客简要信息                   |
| `biz:memberlevel:list`    | 会员等级           | 会员等级   | 菜单 | 进入页面、读取会员等级列表与详情                                       |
| `biz:rechargeplan:list`   | 充值方案           | 充值方案   | 菜单 | 进入页面、读取充值方案                                                 |
| `biz:cardtype:list`       | 次卡卡种           | 次卡卡种   | 菜单 | 进入页面、读取卡种列表与详情                                           |
| `biz:member:list`         | 会员管理           | 会员管理   | 菜单 | 进入页面、会员列表/详情/流水/已发券、积分试算                          |
| `biz:card:list`           | 会员次卡           | 会员次卡   | 菜单 | 进入页面、读取会员持卡列表与详情                                       |
| `biz:payment:list`        | 支付流水           | 支付流水   | 菜单 | 进入页面、支付单列表/详情/渠道状态查询                                 |
| `biz:refund:list`         | 退款审批           | 退款审批   | 菜单 | 进入页面、退款申请列表                                                 |
| `biz:credit:list`         | 挂账主体           | 挂账主体   | 菜单 | 进入页面、读取挂账主体（顾客/公司/员工）                               |
| `biz:receivable:list`     | 应收台账           | 应收台账   | 菜单 | 进入页面、应收台账列表与账龄汇总                                       |
| `biz:pointsgoods:list`    | 积分兑换品         | 积分兑换品 | 菜单 | 进入页面、读取兑换品列表与详情                                         |
| `biz:coupon:list`         | 优惠券模板         | 优惠券模板 | 菜单 | 进入页面、读取券模板列表与详情                                         |
| `biz:review:list`         | 评价管理           | 评价管理   | 菜单 | 进入页面、评价列表（美甲师身份再被二次收窄）                           |
| `biz:report:view`         | 报表中心           | 报表中心   | 菜单 | 营收/服务/美甲师/会员/应收 5 类报表的查看                              |
| `biz:commission:list`     | 提成结算           | 提成结算   | 菜单 | 进入页面、读取提成明细                                                 |
| `biz:recurrence:list`     | 周期预约           | 周期预约   | 菜单 | 进入页面、读取规则列表与已生成单据                                     |
| `biz:notice:template`     | 通知模板           | 通知模板   | 菜单 | 进入页面、模板的增删改查                                               |
| `biz:notice:log`          | 通知记录           | 通知记录   | 菜单 | 进入页面、读取发送记录与详情                                           |
| `biz:serviceitem:create`  | 服务项目-create    | 服务项目   | 按钮 | 新建服务项目                                                           |
| `biz:serviceitem:update`  | 服务项目-update    | 服务项目   | 按钮 | 修改服务项目                                                           |
| `biz:serviceitem:delete`  | 服务项目-delete    | 服务项目   | 按钮 | 删除服务项目（有引用则被拒）                                           |
| `biz:staff:create`        | 美甲师-create      | 美甲师     | 按钮 | 新建美甲师档案                                                         |
| `biz:staff:update`        | 美甲师-update      | 美甲师     | 按钮 | 修改美甲师档案                                                         |
| `biz:staff:delete`        | 美甲师-delete      | 美甲师     | 按钮 | 删除美甲师                                                             |
| `biz:staff:items`         | 美甲师-items       | 美甲师     | 按钮 | 维护「某美甲师可做哪些项目」                                           |
| `biz:schedule:update`     | 排班管理-update    | 排班管理   | 按钮 | 整体替换周模板、增删日期例外（请假/自定义）                            |
| `biz:customer:create`     | 顾客档案-create    | 顾客档案   | 按钮 | 新建顾客（手机号唯一 + 软删策略）                                      |
| `biz:customer:update`     | 顾客档案-update    | 顾客档案   | 按钮 | 修改顾客、重算派生字段、恢复软删顾客                                   |
| `biz:customer:delete`     | 顾客档案-delete    | 顾客档案   | 按钮 | 软删顾客                                                               |
| `biz:booking:create`      | 预约管理-create    | 预约管理   | 按钮 | 创建预约                                                               |
| `biz:booking:update`      | 预约管理-update    | 预约管理   | 按钮 | 改期、确认、重算（recount）                                            |
| `biz:booking:cancel`      | 预约管理-cancel    | 预约管理   | 按钮 | 取消预约                                                               |
| `biz:booking:arrive`      | 预约管理-arrive    | 预约管理   | 按钮 | 标记到店                                                               |
| `biz:booking:complete`    | 预约管理-complete  | 预约管理   | 按钮 | 标记完工                                                               |
| `biz:booking:noshow`      | 预约管理-noshow    | 预约管理   | 按钮 | 标记未到店                                                             |
| `biz:booking:delete`      | 预约管理-delete    | 预约管理   | 按钮 | 删除预约单据                                                           |
| `biz:booking:manageall`   | 预约管理-manageall | 预约管理   | 按钮 | **不做接口门禁**：服务层判定「美甲师是否只看自己」，持有则解锁全部预约 |
| `biz:booking:adjust`      | 预约管理-adjust    | 预约管理   | 按钮 | **不做接口门禁**：服务层判定手动改价，缺失时抛 403，必须填原因         |
| `biz:memberlevel:create`  | 会员等级-create    | 会员等级   | 按钮 | 新建会员等级（含折扣率千分比）                                         |
| `biz:memberlevel:update`  | 会员等级-update    | 会员等级   | 按钮 | 修改会员等级                                                           |
| `biz:memberlevel:delete`  | 会员等级-delete    | 会员等级   | 按钮 | 删除会员等级                                                           |
| `biz:rechargeplan:create` | 充值方案-create    | 充值方案   | 按钮 | 新建充值方案                                                           |
| `biz:rechargeplan:update` | 充值方案-update    | 充值方案   | 按钮 | 修改充值方案                                                           |
| `biz:rechargeplan:delete` | 充值方案-delete    | 充值方案   | 按钮 | 删除充值方案                                                           |
| `biz:cardtype:create`     | 次卡卡种-create    | 次卡卡种   | 按钮 | 新建次卡卡种                                                           |
| `biz:cardtype:update`     | 次卡卡种-update    | 次卡卡种   | 按钮 | 修改次卡卡种                                                           |
| `biz:cardtype:delete`     | 次卡卡种-delete    | 次卡卡种   | 按钮 | 删除次卡卡种                                                           |
| `biz:member:update`       | 会员管理-update    | 会员管理   | 按钮 | 修改会员资料（建档），钱的字段不在这里                                 |
| `biz:member:adjust`       | 会员管理-adjust    | 会员管理   | 按钮 | 手工调账（余额/积分），需填原因                                        |
| `biz:member:recount`      | 会员管理-recount   | 会员管理   | 按钮 | 重算会员派生字段（累计消费、等级等）                                   |
| `biz:member:recharge`     | 会员管理-recharge  | 会员管理   | 按钮 | 储值充值（本金 + 赠送，**默认只给店长**）                              |
| `biz:member:refund`       | 会员管理-refund    | 会员管理   | 按钮 | 储值退款/冲正（走审批，**默认只给店长**）                              |
| `biz:member:coupon`       | 会员管理-coupon    | 会员管理   | 按钮 | 给顾客发券（复用券模板）                                               |
| `biz:card:issue`          | 会员管理-issue     | 会员管理   | 按钮 | 从会员详情发次卡                                                       |
| `biz:card:use`            | 会员管理-use       | 会员管理   | 按钮 | 从会员详情核销次卡                                                     |
| `biz:card:revoke`         | 会员次卡-revoke    | 会员次卡   | 按钮 | 撤销核销（回退次数）                                                   |
| `biz:card:refund`         | 会员次卡-refund    | 会员次卡   | 按钮 | 次卡退款                                                               |
| `biz:payment:create`      | 收银台-create      | 收银台     | 按钮 | 创建支付单（扫码/线下记账）、主动查单、预约结算                        |
| `biz:payment:close`       | 收银台-close       | 收银台     | 按钮 | 关单                                                                   |
| `biz:refund:apply`        | 收银台-apply       | 收银台     | 按钮 | 申请退款（申请与审批分离，前台可申请）                                 |
| `biz:receivable:settle`   | 收银台-settle      | 收银台     | 按钮 | 销账（从收银台发起）                                                   |
| `biz:payment:reconcile`   | 支付流水-reconcile | 支付流水   | 按钮 | 渠道对账：差异列表、触发对账、处理差异                                 |
| `biz:refund:approve`      | 退款审批-approve   | 退款审批   | 按钮 | 通过 / 驳回退款（**只给店长**）                                        |
| `biz:credit:create`       | 挂账主体-create    | 挂账主体   | 按钮 | 新建挂账主体与额度/账期                                                |
| `biz:credit:update`       | 挂账主体-update    | 挂账主体   | 按钮 | 修改挂账主体                                                           |
| `biz:credit:delete`       | 挂账主体-delete    | 挂账主体   | 按钮 | 删除挂账主体                                                           |
| `biz:receivable:cancel`   | 应收台账-cancel    | 应收台账   | 按钮 | 作废应收单                                                             |
| `biz:pointsgoods:create`  | 积分兑换品-create  | 积分兑换品 | 按钮 | 新建积分兑换品                                                         |
| `biz:pointsgoods:update`  | 积分兑换品-update  | 积分兑换品 | 按钮 | 修改积分兑换品                                                         |
| `biz:pointsgoods:delete`  | 积分兑换品-delete  | 积分兑换品 | 按钮 | 删除积分兑换品                                                         |
| `biz:points:redeem`       | 积分兑换品-redeem  | 积分兑换品 | 按钮 | 积分兑换下单、兑换记录列表                                             |
| `biz:points:revert`       | 积分兑换品-revert  | 积分兑换品 | 按钮 | 撤销兑换（积分回退）                                                   |
| `biz:coupon:create`       | 优惠券模板-create  | 优惠券模板 | 按钮 | 新建券模板                                                             |
| `biz:coupon:update`       | 优惠券模板-update  | 优惠券模板 | 按钮 | 修改券模板                                                             |
| `biz:coupon:delete`       | 优惠券模板-delete  | 优惠券模板 | 按钮 | 删除券模板                                                             |
| `biz:review:create`       | 评价管理-create    | 评价管理   | 按钮 | 代录评价                                                               |
| `biz:review:reply`        | 评价管理-reply     | 评价管理   | 按钮 | 回复评价                                                               |
| `biz:review:hide`         | 评价管理-hide      | 评价管理   | 按钮 | 隐藏/显示评价                                                          |
| `biz:review:delete`       | 评价管理-delete    | 评价管理   | 按钮 | 删除评价                                                               |
| `biz:report:export`       | 报表中心-export    | 报表中心   | 按钮 | 导出报表文件                                                           |
| `biz:commission:rule`     | 提成规则-rule      | 提成规则   | 按钮 | 提成规则的增删改查（页面与按钮共用这一个点）                           |
| `biz:commission:settle`   | 提成结算-settle    | 提成结算   | 按钮 | 结算冻结、冲销                                                         |
| `biz:recurrence:create`   | 周期预约-create    | 周期预约   | 按钮 | 新建周期预约规则                                                       |
| `biz:recurrence:update`   | 周期预约-update    | 周期预约   | 按钮 | 修改规则、暂停/恢复/停止、撤销窗口                                     |
| `biz:recurrence:delete`   | 周期预约-delete    | 周期预约   | 按钮 | 删除规则                                                               |
| `biz:notice:send`         | 通知模板-send      | 通知模板   | 按钮 | 手工发通知、重发失败记录                                               |

### seed 与代码的交叉核对

用 `@RequirePermissions('...')` 在 `src/**/*.controller.ts` 里抓取，实际被装饰器使用的权限点共 **134** 个（出现 253 次）。

**A. 只在 Controller 装饰器里出现、seed 里没有（30 个）**

这 30 个全部是**系统管理 / 系统监控模块的按钮级权限点**——seed 只为这 15 个系统页面声明了页面级 `:list` 权限点，没有为它们的「新增/修改/删除」生成 `F` 行：

`system:user:create`、`system:user:update`、`system:user:delete`、`system:role:create`、`system:role:update`、`system:role:delete`、`system:menu:create`、`system:menu:update`、`system:menu:delete`、`system:dept:create`、`system:dept:update`、`system:dept:delete`、`system:post:create`、`system:post:update`、`system:post:delete`、`system:dict:create`、`system:dict:update`、`system:dict:delete`、`system:config:create`、`system:config:update`、`system:config:delete`、`system:job:create`、`system:job:update`、`system:job:delete`、`system:job:run`、`system:file:delete`、`system:generator:generate`、`monitor:loginlog:delete`、`monitor:operlog:delete`、`monitor:online:delete`。

需要注意：这批权限点**不在 seed 里，就无法通过 `sys_role_menu` 授权**。除了超管（`*:*:*`）之外，任何角色都不可能持有它们——只有把这些点补进 `MENU_SEEDS` 并重跑 `bun run db:seed:menus`，才谈得上「把删日志的权限给某个角色」。

**B. seed 里声明了、但没有任何 `@RequirePermissions` 使用（2 个）**

- `biz:booking:adjust` —— 不是没用，而是**不走装饰器**：`bookings.service.ts` 在手动改价分支里用 `this.hasPermission(actor, 'biz:booking:adjust')` 判定，缺失时抛 `ForbiddenException('无手动改价权限（biz:booking:adjust）')`。
- `biz:booking:manageall` —— 同上，服务层用它决定「美甲师是否被收窄到只看自己的预约/可用时段」，`reviews.service.ts` 也复用它放开评价可见范围。

其余 104 个 seed 权限点都能在 Controller 装饰器里找到（其中 `biz:booking:adjust` / `biz:booking:manageall` 的等价语义在服务层）。

**C. 前端引用了一个并不存在的权限点（隐患）**

`web/src/views/files/index.vue` 使用了 `v-permission="'system:file:upload'"`，但该字符串**既不在 seed、也不在任何 Controller 装饰器**：`POST /api/v1/files/upload` 按设计只要求登录（`src/modules/files/files.controller.ts` 注释说明「用户自定义头像需要普通用户也能上传，不限定 `system:file:upload`」）。结果是这个上传按钮对**所有非超管账号永久隐藏**。要么把 `system:file:upload` 补进 seed，要么去掉该指令。

## 权限点命名规范

- 全小写，冒号分隔的三段式：`模块:资源:动作`。
- **资源名单词连写，不用驼峰、不用连字符、不用下划线**。真实例子：`serviceitem`、`pointsgoods`、`memberlevel`、`rechargeplan`、`cardtype`、`loginlog`、`operlog`。反例：`biz:service-item:list`、`biz:pointsGoods:list` 都是错的。
- 模块段：业务域统一 `biz:`，系统管理 `system:`，系统监控 `monitor:`，AI `ai:`。
- 动作段用动词原形：`list` / `create` / `update` / `delete` / `view` / `export` / `redeem` / `revert` / `settle` / `cancel` / `apply` / `approve` / `recharge` / `refund` / `recount`。
- 按钮菜单的 `name` 由权限点**机械派生**：去掉 `biz:` 前缀后把 `:` 换成 `_`，再拼 `biz_`。例如 `biz:staff:items` → `biz_staff_items`；`biz:card:issue` 挂在「会员管理」页面下，所以 `name` 是 `biz_card_issue` 而不是 `biz_members_issue`——`name` 只取决于权限点字符串，与挂载页面无关。
- 按钮菜单的 `title` 是 `${页面标题}-${action}`（如 `会员管理-recharge`），`sort` 是该页面内 `F` 行的下标 + 1。
- 页面级权限点一律以 `:list` 或页面的单一动作结尾（`biz:report:view`、`biz:notice:template`、`biz:commission:rule`、`biz:staff:grant` 都是真实存在的例外形态）。
- 由于 `uq_menu_permission` 唯一索引，**同一权限点全库只能出现一次**；页面与按钮争抢时按 `buildBizMenus()` 的遍历顺序裁决。

## 新增权限点的步骤

1. **改 seed**：在 `src/database/seed/menus.ts` 的 `MENU_SEEDS` 里加静态行，或在 `BIZ_PAGES` 对应页面的 `permissions[]` 里给 `actions` 追加动作。同时确认该权限点字符串**不与已有 106 个重复**（重复会被 `claimed` 静默跳过，不报错）。
2. **重跑种子**：`bun run db:seed:menus`（`package.json` 中该脚本真实存在，实际执行 `bun src/database/seed/menus.ts`）。全量初始化用 `bun run db:seed`，其入口是 `src/database/seed/index.ts`，内部依次调用 `seedMenus(pool)`、`seedBiz(pool)`、`seedNail(pool)`。
3. **给角色授权**：在「角色管理」页用菜单树勾选该按钮，落到 `sys_role_menu`；或直接调 `POST /api/v1/system/roles/:id/menus`（`system:role:update`）。注意该接口是**整体替换**（先 `DELETE` 再 `INSERT`），不是增量追加。
4. **后端加门禁**：在 Controller 方法上标 `@RequirePermissions('模块:资源:动作')`。多个权限点参数之间是 **OR** 关系（`required.some(...)`），不是 AND。
5. **前端加显隐**：使用 `v-permission` 指令（真实实现见 `web/src/directives/permission.ts`），写法为 `v-permission="'biz:member:recharge'"` 或 `v-permission="['a:b:c', 'd:e:f']"`（数组也是 OR）。无权限时**直接 `removeChild` 移除元素**，不是 `display:none`。指令底层调用 `useUserStore().hasPermission()`，超管（`permissions` 含 `*:*:*`）恒为 `true`。
6. **登录态刷新**：权限写在 JWT 的 `permissions` claim 里，授权后必须**重新登录或刷新令牌**才会生效；前端 `web/src/store/user.ts` 从 JWT payload 解码 `permissions`。

::: tip 页面可见性来自 `sys_role_menu`，不是页面 `permission`
`GET /api/v1/system/menus/routes` 是**登录即可访问**（无 `@RequirePermissions`）的动态路由接口：超管看全部 `M`/`C` 菜单，普通账号只看 `sys_role_menu` 里授权过的 `M`/`C` 菜单（`F` 行不参与路由）。这解释了 `biz_cashier` 这类页面 `permission` 留空仍能被正确授权——页面进不进得来由角色授权决定，页面里的钱能不能动由 `F` 行的权限点决定。
:::

## 角色与菜单的关联方式

### `sys_role_menu`（角色 ↔ 菜单）

| 字段      | 类型           | 约束                                      | 说明                              |
| --------- | -------------- | ----------------------------------------- | --------------------------------- |
| `role_id` | `int unsigned` | 外键 → `sys_role.id`，`ON DELETE CASCADE` | 角色 id                           |
| `menu_id` | `int unsigned` | 外键 → `sys_menu.id`，`ON DELETE CASCADE` | 菜单 id（`M`/`C`/`F` 都可以授权） |

索引：唯一索引 `uq_role_menu(role_id, menu_id)`、普通索引 `idx_role_menu_menu(menu_id)`。表名 `sys_role_menu`，Drizzle 导出名 `roleMenus`。

关联链路：`sys_user_role`（`user_id` + `role_id`，唯一索引 `uq_user_role`，对 `sys_user` / `sys_role` 均 `ON DELETE CASCADE`）→ `sys_role_menu` → `sys_menu.permission`。`auth.service.ts` 的 `getClaims()` 就是这条 JOIN 链：查到的 `permission` 数组进 JWT；若任一角色 `isSystem = true` 或 `key = 'admin'`，直接下发 `['*:*:*']`，不再逐条查。

`grantAdminMenus()` 在 seed 里的行为是「**只补缺失、不删已有**」：按 `key = 'admin'` 找到角色（找不到直接抛错 `Admin role not found, run db:seed first`），查出该角色已有的 `sys_role_menu`，只 `INSERT` 差集。因此运营手工给 admin 加过的额外授权、或手工取消过的授权，重跑 seed 都不会被覆盖或恢复。

### `sys_role_dept` 与数据权限（与菜单权限是两件事）

| 字段      | 类型           | 约束                                      | 说明        |
| --------- | -------------- | ----------------------------------------- | ----------- |
| `role_id` | `int unsigned` | 外键 → `sys_role.id`，`ON DELETE CASCADE` | 角色 id     |
| `dept_id` | `int unsigned` | 外键 → `sys_dept.id`，`ON DELETE CASCADE` | 可见部门 id |

索引：唯一索引 `uq_role_dept(role_id, dept_id)`、普通索引 `idx_role_dept_dept(dept_id)`。表名 `sys_role_dept`，Drizzle 导出名 `roleDepts`。

角色上的数据范围字段是 `sys_role.data_scope`，枚举取值（schema 与 `roles.controller.ts` 的 zod 校验一致，共 5 个）：`all`、`custom`、`dept`、`dept_and_children`、`self`，默认 `all`。

`src/common/data-scope/data-scope.ts` 的 `resolveDataScope()` 把角色集合解析成一个过滤器（`{kind:'all'}` / `{kind:'self'}` / `{kind:'deptIds', ids}`）：

1. `permissions` 含 `*:*:*`，或**没有任何角色** → `all`；
2. 任一角色 `data_scope = 'all'` → `all`；
3. 否则取并集（宽松优先）：`custom` 角色的 `sys_role_dept` 部门 ∪ 本人部门（`dept`）∪ 本人部门及全部下级（`dept_and_children`，靠 `sys_department.ancestors` 祖先路径求子孙）；
4. 有部门范围 → `deptIds`；否则 → `self`。

| 维度     | 菜单权限                                      | 数据权限                                             |
| -------- | --------------------------------------------- | ---------------------------------------------------- |
| 存什么   | `sys_role_menu`（角色能看哪些菜单/按钮）      | `sys_role.data_scope` + `sys_role_dept`              |
| 粒度     | 功能级：能不能调这个接口 / 看不看得到这个按钮 | 行级：同一条接口里能看见哪些行                       |
| 生效点   | `AccessTokenGuard`（全局守卫，接口入口）      | Service 层显式调用 `resolveDataScope()` 后拼查询条件 |
| 超管特例 | `permissions` 含 `*:*:*`，全部放行            | 同样因 `*:*:*` 直接返回 `all`                        |
| 典型组合 | 「有 `biz:booking:list` 才能进预约管理页」    | 「有 list 权限，但只看得到本部门或本人创建的预约」   |

数据权限不是自动施加的：一个 Service 若没主动调用 `resolveDataScope()`，就完全不按角色收窄。业务侧最典型的是预约——`bookings.service.ts` 先判「该账号是否绑定美甲师身份」，绑定且无 `biz:booking:manageall` 时收窄到只看自己，否则回落到通用 `resolveDataScope()`。

角色与菜单、角色与部门的写入接口分别是 `POST /api/v1/system/roles/:id/menus`（`system:role:update`）与 `POST /api/v1/system/roles/:id/depts`（`system:role:update`），两者都是**整体替换**语义（`roles.service.ts` 先 `DELETE` 再 `INSERT`）。表结构细节见 [系统 · 监控 · AI · 小程序身份表](/data/system-tables)。

## 权限点 → 后端接口对照

完整路径 = `/{API_PREFIX}` + `@Controller(...)` + 方法路径。`API_PREFIX` 默认 `api/v1`（`src/config/app-config.service.ts` 的 `API_PREFIX`，`src/main.ts` 里 `app.setGlobalPrefix(config.apiPrefix)`），下文一律按默认值书写。装饰器出现在方法上时，同一个权限点会覆盖该 Controller 的多个路径（下表用「、」合并）。

| 权限点                                 | 方法与完整路径                                                                                                                                                                                                                                                                                         | Controller                                                                                                  |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `system:user:list`                     | `GET /api/v1/system/users`                                                                                                                                                                                                                                                                             | `system/users/users.controller.ts`                                                                          |
| `system:user:create`                   | `POST /api/v1/system/users`                                                                                                                                                                                                                                                                            | 同上                                                                                                        |
| `system:user:update`                   | `PATCH /api/v1/system/users/:id`                                                                                                                                                                                                                                                                       | 同上                                                                                                        |
| `system:user:delete`                   | `DELETE /api/v1/system/users/:id`                                                                                                                                                                                                                                                                      | 同上                                                                                                        |
| `system:role:list`                     | `GET /api/v1/system/roles`                                                                                                                                                                                                                                                                             | `system/roles/roles.controller.ts`                                                                          |
| `system:role:update`                   | `PATCH /api/v1/system/roles/:id`、`POST /api/v1/system/roles/:id/menus`                                                                                                                                                                                                                                | 同上（菜单授权用同一个点）                                                                                  |
| `system:menu:list`                     | `GET /api/v1/system/menus`、`GET /api/v1/system/menus/:id`                                                                                                                                                                                                                                             | `system/menus/menus.controller.ts`                                                                          |
| `system:menu:create`                   | `POST /api/v1/system/menus`                                                                                                                                                                                                                                                                            | 同上                                                                                                        |
| `system:dept:list`                     | `GET /api/v1/system/depts`、`GET /api/v1/system/depts/:id`                                                                                                                                                                                                                                             | `system/depts/depts.controller.ts`                                                                          |
| `system:dict:list`                     | `GET /api/v1/system/dict-types`、`GET /api/v1/system/dict-types/:id`、`GET /api/v1/system/dict-data`、`GET /api/v1/system/dict-data/type/:type`、`GET /api/v1/system/dict-data/:id`                                                                                                                    | `dict-types` + `dict-data` 两个 Controller 共用                                                             |
| `system:config:list`                   | `GET /api/v1/system/configs`、`GET /api/v1/system/configs/key/:key`、`GET /api/v1/system/configs/:id`                                                                                                                                                                                                  | `system/configs/configs.controller.ts`                                                                      |
| `system:job:list`                      | `GET /api/v1/system/jobs`、`GET /api/v1/system/jobs/:id`、`GET /api/v1/system/jobs/:id/logs`                                                                                                                                                                                                           | `jobs/jobs.controller.ts`                                                                                   |
| `system:job:run`                       | `POST /api/v1/system/jobs/:id/run`                                                                                                                                                                                                                                                                     | 同上                                                                                                        |
| `system:file:list`                     | `GET /api/v1/files`、`GET /api/v1/files/:id`                                                                                                                                                                                                                                                           | `files/files.controller.ts`                                                                                 |
| `system:file:delete`                   | `DELETE /api/v1/files/:id`                                                                                                                                                                                                                                                                             | 同上                                                                                                        |
| `system:generator:list`                | `GET /api/v1/generator/tables`、`GET /api/v1/generator/tables/:table/columns`、`POST /api/v1/generator/preview`                                                                                                                                                                                        | `generator/generator.controller.ts`                                                                         |
| `system:generator:generate`            | `POST /api/v1/generator/generate`                                                                                                                                                                                                                                                                      | 同上                                                                                                        |
| `monitor:loginlog:list`                | `GET /api/v1/monitor/login-logs`、`GET /api/v1/monitor/login-logs/:id`                                                                                                                                                                                                                                 | `monitor/login-logs/`                                                                                       |
| `monitor:loginlog:delete`              | `DELETE /api/v1/monitor/login-logs/:id`、`DELETE /api/v1/monitor/login-logs`                                                                                                                                                                                                                           | 同上                                                                                                        |
| `monitor:operlog:list`                 | `GET /api/v1/monitor/operation-logs`、`GET /api/v1/monitor/operation-logs/:id`                                                                                                                                                                                                                         | `monitor/operation-logs/`                                                                                   |
| `monitor:online:list`                  | `GET /api/v1/monitor/online`                                                                                                                                                                                                                                                                           | `monitor/online/online.controller.ts`                                                                       |
| `monitor:online:delete`                | `DELETE /api/v1/monitor/online/:userId`                                                                                                                                                                                                                                                                | 同上（强制下线）                                                                                            |
| `monitor:cache:list`                   | `GET /api/v1/monitor/cache`                                                                                                                                                                                                                                                                            | `monitor/cache/cache.controller.ts`                                                                         |
| `ai:chat`                              | `POST /api/v1/ai/sessions`、`GET /api/v1/ai/sessions`、`GET/PATCH /api/v1/ai/sessions/:id`、`GET/POST /api/v1/ai/sessions/:id/messages`、`POST /api/v1/ai/action-intents/:id/approve`、`/reject`、`/confirm`、`GET /api/v1/ai/tasks`、`GET /api/v1/ai/tasks/:id`、`POST /api/v1/ai/tasks/:id/rollback` | `ai/gateway/ai.gateway.controller.ts`（一个点管整个 AI 域）                                                 |
| `biz:serviceitem:list`                 | `GET /api/v1/biz/service-items`、`GET /api/v1/biz/service-items/:id`                                                                                                                                                                                                                                   | `biz/base-data/service-items/`                                                                              |
| `biz:serviceitem:create`               | `POST /api/v1/biz/service-items`                                                                                                                                                                                                                                                                       | 同上                                                                                                        |
| `biz:serviceitem:update`               | `PATCH /api/v1/biz/service-items/:id`                                                                                                                                                                                                                                                                  | 同上                                                                                                        |
| `biz:serviceitem:delete`               | `DELETE /api/v1/biz/service-items/:id`                                                                                                                                                                                                                                                                 | 同上                                                                                                        |
| `biz:staff:list`                       | `GET /api/v1/biz/staffs`、`GET /api/v1/biz/staffs/:id`、`GET /api/v1/biz/staffs/:id/service-items`                                                                                                                                                                                                     | `biz/base-data/staffs/`                                                                                     |
| `biz:staff:items`                      | `PUT /api/v1/biz/staffs/:id/service-items`                                                                                                                                                                                                                                                             | 同上（维护可做项目）                                                                                        |
| `biz:staff:grant`                      | `GET /api/v1/biz/app-staff-grants`、`POST /api/v1/biz/app-staff-grants/:id/approve`、`POST /api/v1/biz/app-staff-grants/:id/reject`                                                                                                                                                                    | `app/staff/app-staff-grants.controller.ts`（后台域，非 app 域）                                             |
| `biz:schedule:list`                    | `GET /api/v1/biz/staffs/:id/weekly-shifts`、`GET /api/v1/biz/staffs/:id/overrides`                                                                                                                                                                                                                     | `biz/scheduling/scheduling.controller.ts`                                                                   |
| `biz:schedule:update`                  | `PUT /api/v1/biz/staffs/:id/weekly-shifts`、`POST /api/v1/biz/staffs/:id/overrides`、`DELETE /api/v1/biz/staffs/:id/overrides/:overrideId`                                                                                                                                                             | 同上                                                                                                        |
| `biz:customer:list`                    | `GET /api/v1/biz/customers`、`GET /api/v1/biz/customers/:id`、`GET /api/v1/biz/customers/:id/bookings`                                                                                                                                                                                                 | `biz/base-data/customers/`                                                                                  |
| `biz:customer:update`                  | `PATCH /api/v1/biz/customers/:id`、`POST /api/v1/biz/customers/:id/recount`、`POST /api/v1/biz/customers/:id/restore`                                                                                                                                                                                  | 同上                                                                                                        |
| `biz:booking:list`                     | `GET /api/v1/biz/bookings`、`GET /api/v1/biz/bookings/available-slots`、`GET /api/v1/biz/bookings/:id`、`GET /api/v1/biz/bookings/customers/:customerId/brief`                                                                                                                                         | `biz/booking/bookings.controller.ts`                                                                        |
| `biz:booking:create`                   | `POST /api/v1/biz/bookings`                                                                                                                                                                                                                                                                            | 同上                                                                                                        |
| `biz:booking:update`                   | `PATCH /api/v1/biz/bookings/:id`、`POST /api/v1/biz/bookings/:id/confirm`、`POST /api/v1/biz/bookings/:id/recount`                                                                                                                                                                                     | 同上                                                                                                        |
| `biz:booking:arrive`                   | `POST /api/v1/biz/bookings/:id/arrive`                                                                                                                                                                                                                                                                 | 同上                                                                                                        |
| `biz:booking:complete`                 | `POST /api/v1/biz/bookings/:id/complete`                                                                                                                                                                                                                                                               | 同上                                                                                                        |
| `biz:booking:noshow`                   | `POST /api/v1/biz/bookings/:id/no-show`                                                                                                                                                                                                                                                                | 同上                                                                                                        |
| `biz:booking:cancel`                   | `POST /api/v1/biz/bookings/:id/cancel`                                                                                                                                                                                                                                                                 | 同上                                                                                                        |
| `biz:booking:delete`                   | `DELETE /api/v1/biz/bookings/:id`                                                                                                                                                                                                                                                                      | 同上                                                                                                        |
| `biz:booking:adjust`                   | 无装饰器；`POST /api/v1/biz/bookings/:id/settle` 链路内由 Service 判定，缺失抛 403                                                                                                                                                                                                                     | `bookings.service.ts`                                                                                       |
| `biz:booking:manageall`                | 无装饰器；`GET /api/v1/biz/bookings*` 的行级范围判定                                                                                                                                                                                                                                                   | 同上                                                                                                        |
| `biz:member:list`                      | `GET /api/v1/biz/members`、`GET /api/v1/biz/members/:id`、`GET /api/v1/biz/members/:id/transactions`、`GET /api/v1/biz/members/:id/coupons`、`POST /api/v1/biz/points/preview`                                                                                                                         | `biz/membership/members/` + `membership/points/`                                                            |
| `biz:member:update`                    | `POST /api/v1/biz/members`                                                                                                                                                                                                                                                                             | `biz/membership/members/`                                                                                   |
| `biz:member:recharge`                  | `POST /api/v1/biz/members/:id/recharge`                                                                                                                                                                                                                                                                | 同上                                                                                                        |
| `biz:member:refund`                    | `POST /api/v1/biz/members/:id/refund`                                                                                                                                                                                                                                                                  | 同上                                                                                                        |
| `biz:member:adjust`                    | `POST /api/v1/biz/members/:id/adjust`                                                                                                                                                                                                                                                                  | 同上                                                                                                        |
| `biz:member:recount`                   | `POST /api/v1/biz/members/:id/recount`                                                                                                                                                                                                                                                                 | 同上                                                                                                        |
| `biz:member:coupon`                    | `POST /api/v1/biz/members/:id/coupons`                                                                                                                                                                                                                                                                 | 同上                                                                                                        |
| `biz:card:list`                        | `GET /api/v1/biz/member-cards`、`GET /api/v1/biz/member-cards/:id`                                                                                                                                                                                                                                     | `biz/membership/member-cards/`                                                                              |
| `biz:card:issue`                       | `POST /api/v1/biz/member-cards`                                                                                                                                                                                                                                                                        | 同上                                                                                                        |
| `biz:card:use`                         | `POST /api/v1/biz/member-cards/:id/use`                                                                                                                                                                                                                                                                | 同上（核销）                                                                                                |
| `biz:card:revoke`                      | `POST /api/v1/biz/member-cards/:id/revert`                                                                                                                                                                                                                                                             | 同上（撤销核销）                                                                                            |
| `biz:card:refund`                      | `POST /api/v1/biz/member-cards/:id/refund`                                                                                                                                                                                                                                                             | 同上                                                                                                        |
| `biz:points:redeem`                    | `POST /api/v1/biz/members/:id/redeem`、`GET /api/v1/biz/points-redeems`                                                                                                                                                                                                                                | `biz/membership/points/points.controller.ts`                                                                |
| `biz:points:revert`                    | `POST /api/v1/biz/points-redeems/:id/revert`                                                                                                                                                                                                                                                           | 同上                                                                                                        |
| `biz:payment:create`                   | `POST /api/v1/biz/payments`、`POST /api/v1/biz/payments/:id/query`、`POST /api/v1/biz/bookings/:id/settle`                                                                                                                                                                                             | `biz/payment/payments/` + `biz/booking/`                                                                    |
| `biz:payment:list`                     | `GET /api/v1/biz/payments`、`GET /api/v1/biz/payments/:id`、`GET /api/v1/biz/payments/:id/status`                                                                                                                                                                                                      | `biz/payment/payments/`                                                                                     |
| `biz:payment:close`                    | `POST /api/v1/biz/payments/:id/close`                                                                                                                                                                                                                                                                  | 同上                                                                                                        |
| `biz:payment:reconcile`                | `GET /api/v1/biz/payment-diffs`、`POST /api/v1/biz/payment-diffs/reconcile`、`PATCH /api/v1/biz/payment-diffs/:id`                                                                                                                                                                                     | `biz/payment/diffs/`                                                                                        |
| `biz:refund:apply`                     | `POST /api/v1/biz/refunds`、`POST /api/v1/biz/refunds/preview`、`POST /api/v1/biz/bookings/:id/refund`、`GET /api/v1/biz/bookings/:id/refund-preview`                                                                                                                                                  | `biz/payment/refunds/` + `biz/booking/`                                                                     |
| `biz:refund:list`                      | `GET /api/v1/biz/refunds`                                                                                                                                                                                                                                                                              | `biz/payment/refunds/`                                                                                      |
| `biz:refund:approve`                   | `POST /api/v1/biz/refunds/:id/approve`、`POST /api/v1/biz/refunds/:id/reject`                                                                                                                                                                                                                          | 同上                                                                                                        |
| `biz:credit:list`                      | `GET /api/v1/biz/credit-accounts`                                                                                                                                                                                                                                                                      | `biz/credit/credit-accounts/`                                                                               |
| `biz:credit:create`                    | `POST /api/v1/biz/credit-accounts`                                                                                                                                                                                                                                                                     | 同上                                                                                                        |
| `biz:credit:update`                    | `PATCH /api/v1/biz/credit-accounts/:id`                                                                                                                                                                                                                                                                | 同上                                                                                                        |
| `biz:credit:delete`                    | `DELETE /api/v1/biz/credit-accounts/:id`                                                                                                                                                                                                                                                               | 同上                                                                                                        |
| `biz:receivable:list`                  | `GET /api/v1/biz/receivables`、`GET /api/v1/biz/receivables/summary`、`GET /api/v1/biz/receivables/:id`                                                                                                                                                                                                | `biz/credit/receivables/`                                                                                   |
| `biz:receivable:settle`                | `POST /api/v1/biz/receivables/:id/settle`                                                                                                                                                                                                                                                              | 同上                                                                                                        |
| `biz:receivable:cancel`                | `POST /api/v1/biz/receivables/:id/cancel`                                                                                                                                                                                                                                                              | 同上                                                                                                        |
| `biz:pointsgoods:list`                 | `GET /api/v1/biz/points-goods`、`GET /api/v1/biz/points-goods/:id`                                                                                                                                                                                                                                     | `biz/membership/points-goods/`                                                                              |
| `biz:coupon:list`                      | `GET /api/v1/biz/coupon-templates`、`GET /api/v1/biz/coupon-templates/:id`                                                                                                                                                                                                                             | `biz/membership/coupons/`（注意 Controller 前缀是 `biz/coupon-templates`，与菜单 path `/biz/coupons` 不同） |
| `biz:review:list`                      | `GET /api/v1/biz/reviews`                                                                                                                                                                                                                                                                              | `biz/operations/reviews/`                                                                                   |
| `biz:review:reply`                     | `POST /api/v1/biz/reviews/:id/reply`                                                                                                                                                                                                                                                                   | 同上                                                                                                        |
| `biz:review:hide`                      | `PATCH /api/v1/biz/reviews/:id`                                                                                                                                                                                                                                                                        | 同上                                                                                                        |
| `biz:review:delete`                    | `DELETE /api/v1/biz/reviews/:id`                                                                                                                                                                                                                                                                       | 同上                                                                                                        |
| `biz:report:view`                      | `GET /api/v1/biz/reports/overview`、`/revenue`、`/services`、`/staffs`、`/members`、`/receivables`                                                                                                                                                                                                     | `biz/reports/analytics/`                                                                                    |
| `biz:report:export`                    | `GET /api/v1/biz/reports/export`                                                                                                                                                                                                                                                                       | 同上                                                                                                        |
| `biz:commission:rule`                  | `GET/POST /api/v1/biz/commission-rules`、`PATCH/DELETE /api/v1/biz/commission-rules/:id`                                                                                                                                                                                                               | `biz/reports/commission/`                                                                                   |
| `biz:commission:list`                  | `GET /api/v1/biz/commission-records`                                                                                                                                                                                                                                                                   | 同上                                                                                                        |
| `biz:commission:settle`                | `POST /api/v1/biz/commission-settle`、`POST /api/v1/biz/commission-records/:id/reverse`                                                                                                                                                                                                                | 同上                                                                                                        |
| `biz:recurrence:list`                  | `GET /api/v1/biz/recurrences`、`GET /api/v1/biz/recurrences/:id/bookings`                                                                                                                                                                                                                              | `biz/operations/recurrences/`                                                                               |
| `biz:recurrence:create`                | `POST /api/v1/biz/recurrences`                                                                                                                                                                                                                                                                         | 同上                                                                                                        |
| `biz:recurrence:update`                | `PATCH /api/v1/biz/recurrences/:id`、`POST /api/v1/biz/recurrences/:id/pause`、`/resume`、`/stop`、`/revoke-window`                                                                                                                                                                                    | 同上                                                                                                        |
| `biz:recurrence:delete`                | `DELETE /api/v1/biz/recurrences/:id`                                                                                                                                                                                                                                                                   | 同上                                                                                                        |
| `biz:notice:template`                  | `GET/POST /api/v1/biz/notice-templates`、`PATCH/DELETE /api/v1/biz/notice-templates/:id`                                                                                                                                                                                                               | `biz/operations/notices/`                                                                                   |
| `biz:notice:log`                       | `GET /api/v1/biz/notice-logs`、`GET /api/v1/biz/notice-logs/:id`                                                                                                                                                                                                                                       | 同上                                                                                                        |
| `biz:notice:send`                      | `POST /api/v1/biz/notice/send`、`POST /api/v1/biz/notice-logs/:id/resend`                                                                                                                                                                                                                              | 同上                                                                                                        |
| `biz:memberlevel:*`                    | `GET/POST /api/v1/biz/member-levels`、`GET/PATCH/DELETE /api/v1/biz/member-levels/:id`                                                                                                                                                                                                                 | `biz/membership/member-levels/`                                                                             |
| `biz:rechargeplan:*`                   | `GET/POST /api/v1/biz/recharge-plans`、`GET/PATCH/DELETE /api/v1/biz/recharge-plans/:id`                                                                                                                                                                                                               | `biz/membership/recharge-plans/`                                                                            |
| `biz:cardtype:*`                       | `GET/POST /api/v1/biz/card-types`、`GET/PATCH/DELETE /api/v1/biz/card-types/:id`                                                                                                                                                                                                                       | `biz/membership/card-types/`                                                                                |
| `biz:pointsgoods:create/update/delete` | `POST /api/v1/biz/points-goods`、`PATCH/DELETE /api/v1/biz/points-goods/:id`                                                                                                                                                                                                                           | `biz/membership/points-goods/`                                                                              |

### 无权限点保护的接口

以下几类接口**只校验登录态、不校验权限点**（没有 `@RequirePermissions`）：

| 接口                                                                                        | 说明                                                                                                                                                      |
| ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/v1/auth/login`、`POST /api/v1/auth/register`、`POST /api/v1/auth/refresh`        | `@Public()`：完全匿名                                                                                                                                     |
| `GET /api/v1/health`                                                                        | `@Public()`：健康检查                                                                                                                                     |
| `GET /api/v1/files/:id/download`                                                            | `@Public()`：头像 `<img>` 无法携带 `Authorization`，文件名是随机 UUID 不可枚举                                                                            |
| `POST /api/v1/files/upload`                                                                 | 仅需登录，**故意不限权限**（普通用户也要能传头像）                                                                                                        |
| `POST /api/v1/biz/payments/notify/wxpay`、`POST /api/v1/biz/payments/notify/alipay`         | `@Public()`：渠道回调，真伪由**验签 + 幂等**保证，不由 token 保证                                                                                         |
| `POST /api/v1/app/payments/wxpay/notify`                                                    | `@Public()` 且不挂 `AppAccessTokenGuard`，同样靠验签                                                                                                      |
| `GET/PATCH /api/v1/auth/profile`、`PATCH /api/v1/auth/password`、`POST /api/v1/auth/logout` | 仅需登录：操作对象恒为 token 里的自己                                                                                                                     |
| `GET /api/v1/system/menus/routes`                                                           | 仅需登录：返回当前用户的动态路由（超管全部 `M`/`C`，普通账号按 `sys_role_menu`）                                                                          |
| `GET /api/v1/dashboard/users`、`/depts`、`/roles`、`/menus`、`/posts`                       | **有**权限点：分别要求 `system:user:list`、`system:dept:list`、`system:role:list`、`system:menu:list`、`system:post:list`（首页统计卡按模块权限分别门禁） |
| `src/modules/compat/legacy-*`（`/api/v1/user`、`/api/v1/role`、`/api/v1/menu`）             | **有**权限点：复用 `system:user:*` / `system:role:*` / `system:menu:*`，是前端旧接口的兼容层                                                              |
| `src/modules/generated/test/user.controller.ts`（`/api/v1/sys_user`）                       | 代码生成器的产物，`system:user:*` 门禁，与业务无关                                                                                                        |

### `app` 域：不接 RBAC、没有权限点

`src/modules/app/**` 是微信小程序端的独立认证域（`/api/v1/app/**`），设计上**完全不复用后台 RBAC**：

- 每个 app Controller 都标 `@Public()` 跳过后台全局守卫 `AccessTokenGuard`，再挂自己的 `AppAccessTokenGuard`（认证 app token，payload 带 `scope=app`）。
- app token 与后台 access token **双向拒绝**：app token 进不了后台接口，后台 token 也进不了 app 接口。
- 因此 app 域**没有任何权限点**，`@RequirePermissions` 在 app 域里一次都没出现；app 端的可见范围靠「资源归属」（只能看自己的会员、自己的卡、自己的预约）在 Service 层收窄，而不是靠权限点。
- app 域路径（均无权限点）：`POST /api/v1/app/auth/login`、`POST /api/v1/app/auth/phone`、`GET /api/v1/app/service-items`、`GET /api/v1/app/staffs`、`GET /api/v1/app/available-slots`、`GET /api/v1/app/member/me`、`GET /api/v1/app/member/cards`、`GET /api/v1/app/recharge-plans`、`GET /api/v1/app/points-goods`、`POST /api/v1/app/points/redeem`、`GET /api/v1/app/coupon-offers`、`POST /api/v1/app/coupons/claim`、`GET /api/v1/app/coupons`、`GET/POST /api/v1/app/bookings`、`GET /api/v1/app/bookings/:id`、`POST /api/v1/app/bookings/:id/cancel`、`POST /api/v1/app/reviews`、`POST /api/v1/app/payments/wxpay/jsapi`、`POST /api/v1/app/subscribe`、`GET /api/v1/app/staff/me|bookings|schedule|performance|reviews`、`GET /api/v1/app/staff/bookings/:id/phone`、`POST /api/v1/app/staff/bookings/:id/arrived|complete`、`POST /api/v1/app/staff/apply`。

::: warning 一个目录位置上的例外
`src/modules/app/staff/app-staff-grants.controller.ts` 虽然**放在 `app/` 目录下**，但它属于**后台域**：`@Controller('biz/app-staff-grants')` + `@ApiBearerAuth('access-token')` + `@RequirePermissions('biz:staff:grant')`，走的是后台 token 与 RBAC。它只是「美甲师工作台开通申请的店长审批页」，不是小程序接口。按目录判断权限归属会在这里出错。
:::

## 鉴权实现细节

| 组件                                               | 位置                                       | 作用                                                                                                    |
| -------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `REQUIRED_PERMISSIONS` / `RequirePermissions(...)` | `src/common/auth/permissions.decorator.ts` | `SetMetadata` 写入所需权限点数组，可用于方法或类                                                        |
| `IS_PUBLIC` / `Public()`                           | `src/common/auth/public.decorator.ts`      | `SetMetadata(IS_PUBLIC, true)`，跳过鉴权                                                                |
| `AccessTokenGuard`                                 | `src/common/auth/access-token.guard.ts`    | 全局守卫，验 JWT（`jose.jwtVerify`，校验 `JWT_ISSUER`/`JWT_AUDIENCE`）、装配 `request.user`、比对权限点 |
| 全局注册                                           | `src/app.module.ts`                        | `{ provide: APP_GUARD, useClass: AccessTokenGuard }`，对全部路由生效                                    |

判定流程：先看 `IS_PUBLIC`（`getAllAndOverride`，方法级优先于类级）→ 为真直接放行；否则从 `Authorization: Bearer <token>` 取 token，没有就抛 401；验签通过后把 `sub`/`username`/`permissions`/`roles` 写进 `request.user`；最后取 `REQUIRED_PERMISSIONS`，只有 `required.length > 0` 才做权限判断：

```ts
!required.some(
  (permission) =>
    request.user?.permissions.includes(permission) ||
    request.user?.permissions.includes('*:*:*'),
);
```

要点：

- **超管通配符是 `*:*:*`**（三个冒号段），不是 `*`，也不是 `*:*`。`auth.service.ts` 对 `isSystem = true` 或 `key = 'admin'` 的角色直接下发 `['*:*:*']`；`data-scope.ts`、前端 `user.ts` 的 `isSuperAdmin`、AI 工具注册表用的都是同一个字面量。
- 多个权限点参数之间是 **OR**（`some`）；没有任何权限点参数时**不做权限判断**（只要求登录）。
- `@Public()` 的作用范围是「跳过全局后台守卫」。app 域正是靠它把请求让给自己的 `AppAccessTokenGuard`。它也用于登录/注册/刷新/健康检查/文件公开下载/支付回调。
- 权限点来自 **JWT 快照**，改角色授权后必须重新签发 token 才生效。

### 401 与 403 的区别

| 场景                                                         | 抛出者                                                   | HTTP 状态                   |
| ------------------------------------------------------------ | -------------------------------------------------------- | --------------------------- |
| 没带 `Authorization`、token 无效/过期/签发者不匹配           | `AccessTokenGuard` → `UnauthorizedException`             | `401`                       |
| 登录了但**权限点不足**                                       | `AccessTokenGuard` → `UnauthorizedException('权限不足')` | **`401`**（注意：不是 403） |
| 业务层拒绝（如无 `biz:booking:adjust` 改价、数据范围外操作） | Service → `ForbiddenException`                           | `403`                       |

::: warning 权限不足返回的是 401
`AccessTokenGuard` 对「缺权限」抛的是 `UnauthorizedException('权限不足')`，因此前端如果按「401 = 去登录页」处理，权限不足会被误判成登录失效。`GlobalExceptionFilter` 对 `HttpException` 原样透传状态码与响应体，不会改写。区分方式只能看响应体里的 `message`（401 且 `message === '权限不足'` 才是权限问题）。
:::

## seed 的幂等性说明

`seedMenus()`（`src/database/seed/menus.ts`）整体包在一个 `db.transaction()` 里，包含两步；任一步失败整体回滚。

**第一步：`upsertMenus(tx)`** —— 菜单与权限点

1. 一次性 `SELECT * FROM sys_menu`，建两张内存表：`byName`（`name` → 行）与 `idMap`（`name` → id）。
2. 按 `MENU_SEEDS` 的**声明顺序**逐条处理（顺序很重要：父节点先于子节点，所以 `idMap.get(parentKey)` 一定拿得到；拿不到时回落到 `0`，即挂到根）。
3. `desiredValues(seed, parentId)` 算出该行期望的**全部 13 个字段**：`parentId`、`title`、`type`、`path`、`component`、`permission`、`icon`、`sort`、`visible`（恒 `true`）、`cacheable`（恒 `false`）、`external`（恒 `false`）、`status`（恒 `active`）、`deletedAt`（恒 `null`）。
4. 库里没有该 `name` → `INSERT`（并回填 `idMap`），`inserted += 1`；已有 → **逐字段比对这 13 个值**，只要有一个不同才 `UPDATE`，`updated += 1`；全等则**不发任何 SQL**。
5. 结束打印 `[seed:menus] menus inserted=<n> updated=<m>`。

由此可得的四条结论：

- 重复执行**不产生重复行**（查的是 `name`，不是自增 id）；
- **值没变就不发 UPDATE**，不会造成 `updated_at` 被无意义地反复刷新；
- 更新会**覆盖**这 13 个字段，其中包括 `permission`。运营若在「菜单管理」页手工改过某个 seed 行的 `permission`，重跑 seed 会被改回 seed 里的值；手工**新建**的、seed 里不存在的 `name` 则完全不受影响（既不更新也不删除）；
- `MENU_SEEDS` 是模块加载时就算好的常量：`buildBizMenus()` 在数组字面量里被展开（`...buildBizMenus()`），`claimed` 去重也只在**每次进程启动时**按同一顺序跑一遍，因此结果对同一份 seed 是稳定的、可复现的。

**第二步：`grantAdminMenus(tx, [...idMap.values()])`** —— admin 角色授权

1. 按 `sys_role.key = 'admin'` 查角色，查不到直接 `throw new Error('Admin role not found, run db:seed first')`（必须先跑 `bun run db:seed` 建 admin 角色）。
2. 查出该角色在 `sys_role_menu` 里的全部已有授权，放进 `granted: Set<menuId>`。
3. `menuIds.filter((id) => !granted.has(id))` 求差集，**只 INSERT 缺失项**；差集为空则一条 SQL 都不发。
4. 打印 `[seed:menus] admin role granted=<n> (total menus=<total>)`。

「只补缺失、不删已有」的实际后果：运营为 admin 额外勾选的菜单不会被清掉；运营从 admin 上**取消**的 seed 菜单，重跑 seed 会被**重新补回来**（因为它仍是「缺失项」）。

最后打印 `[seed:menus] Done. <MENU_SEEDS.length> menu rows (M/C/F) in place`——即 `113 menu rows`。

**运行方式与入口**

- `bun run db:seed:menus` → `package.json` 中定义为 `bun src/database/seed/menus.ts`；`menus.ts` 末尾有 `if (import.meta.main) { await seedMenus(); }`，直接执行时会自建连接池（读取 `Bun.env.DATABASE_URL`，缺失则抛错）并在结束后 `end()`。
- `bun run db:seed` → `bun src/database/seed/index.ts`。`seed/index.ts` 先幂等写入 `admin`（超级管理员，`isSystem: true`）与 `user`（普通用户）两个角色、admin 用户与 `sys_user_role` 绑定，然后 `await seedMenus(pool)`（复用同一个连接池，不会 `end()` 掉别人的池），再依次 `seedBiz(pool)`（会员等级/退款规则/通知模板/定时任务）与 `seedNail(pool)`（美甲基础资料）。演示顾客数据是可选的，单独跑 `bun run db:seed:demo`。
- seed 入口只有这一条链路：`seedMenus` 是 `menus.ts` 导出的函数，`seed/index.ts` 通过 `./menus.js` 引入。

迁移与种子的完整口径见 [迁移 · 种子数据 · 派生口径](/data/migrations-seeds)，预约与排班的权限/数据范围配合见 [预约主链路实现](/backend/booking) 与 [排班与可约时段算法](/backend/scheduling)。
