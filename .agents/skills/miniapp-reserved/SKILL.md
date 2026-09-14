---
name: miniapp-reserved
description: 小程序端预留：app_ 身份表、独立认证域 /api/v1/app/**、AppAccessTokenGuard 与后台 token 双向拒绝、app 域不接 RBAC、不复用后台 DTO、登录与手机号绑定流程；除小程序内 JSAPI 支付（501 契约位）外，app 域写接口均已真实现。做 app 域任何代码时加载。
whenToUse: 实现或修改 src/modules/app/**、app_ 表、app 守卫与 Swagger 分组；讨论小程序联调与后续 P2 落地。
metadata:
  version: '1.0.0'
  spec: project-design/superpowers/specs/2026-09-11-nail-salon-booking-design.md
  sections: §4.4 / §8.3 / §9.7 / §16 / §12 B6
---

# 小程序端预留（本期不做 UI）

## 隔离要求（§8.3，安全红线）

1. **独立 token 域**：`/api/v1/app/**` 走 `AppAccessTokenGuard`，签发时带 `scope: 'app'`；
   后台 token 与 app token **互不通用**——后台守卫拒绝 app token，app 守卫拒绝后台 token。
2. **app 域不接 RBAC**：没有角色与权限点，只有「本人数据」；所有查询强制
   `customer_id = 当前绑定顾客`。未绑定手机号的访客只能访问项目 / 美甲师 / 可约时段。
3. **不复用后台 DTO**：单独写 `AppXxxVo`，禁止返回成本、`createdBy`、其他顾客信息、后台备注。
4. 复用 `@fastify/rate-limit`，app 域单独收紧（如登录 10 次/分钟/IP）。
5. Swagger 用独立分组 `app`，便于小程序端按文档联调。

## 本期落地清单（§16.1）

| 项              | 内容                                                                                                                                                                                      |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 数据            | `app_wx_user`（openid 唯一、unionid、`customer_id` 可空、nickname/avatar/phone 快照、last_login_at）                                                                                      |
| 认证            | `AppAccessTokenGuard` + app 域 JWT + 独立 Swagger 分组                                                                                                                                    |
| 模块            | `src/modules/app/`：`auth` / `catalog` / `member`                                                                                                                                         |
| 真实现          | `POST /app/auth/login`、`GET /app/service-items`、`GET /app/staffs`、`GET /app/available-slots`、`GET /app/member/me`                                                                     |
| 契约骨架（501） | `POST /app/auth/phone`、`GET /POST /app/bookings`、`POST /app/bookings/:id/cancel`、`POST /app/payments/wxpay/jsapi`、`GET /app/member/cards`、`POST /app/reviews`、`POST /app/subscribe` |
| 环境变量        | `WX_MINIAPP_APPID` / `WX_MINIAPP_SECRET`（走 `app-config.service.ts` 的 Zod schema）                                                                                                      |

**未配置微信凭据时要能正常启动**：登录接口返回「小程序端未启用」，而不是让进程起不来。

## 登录与绑定流程（§16.2）

```
wx.login → code
  → POST /app/auth/login → code2Session → openid/unionid
      → upsert app_wx_user（openid 唯一）→ 签发 app token
  → 可浏览：项目 / 美甲师 / 可约时段（无需手机号）
  → 点「预约」→ getPhoneNumber → code
      → POST /app/auth/phone → 换手机号
        → 按 §4.3 策略匹配 biz_customer（命中软删记录走「恢复」确认）
        → 绑定 app_wx_user.customer_id 并回填 phone
  → 可访问 /app/member/me
```

- 手机号属于他人 openid → 允许绑定（顾客换微信号是常态），先写 `remark`；P2 若需完整历史再加绑定日志表。
- 一个 openid 同时只绑定一个 `customer_id`；换绑覆盖旧关系。

## 复用点

- `GET /app/available-slots` **必须复用后台同一个 service**（含美甲师可做项目过滤、缓冲 gap、时区日界），
  验收要求两者结果一致。
- 在线支付本期走后台 **Native 扫码**；`jsapi` 只是给 P2 留的契约位。

## 当前门店（多店，阶段 1.10）

顾客选的店通过**请求头 `x-store-id`** 传（小程序 `store/shop.ts` 存 id → `utils/request.ts`
统一注入），后端用 `src/modules/app/common/app-store.ts` 的 `resolveAppStore()` 解析：

- 与后台的 `resolveStoreScope` **不是一回事**：那边看「账号被授权了哪些店」，
  顾客没有这个概念，只有「选了一家店」；
- 头里的 id 存在且**启用**才采用，否则（没传 / 乱值 / 已停用）**回落默认门店** ——
  宁可退化成单店期行为，也不能因为小程序缓存过期就让人下不了单；
- **已按店生效**：门店档案 `GET /app/shop`、美甲师目录 `GET /app/staffs`、
  下单 `POST /app/bookings`（落 `biz_booking.store_id`）。
- **不要按店收窄的**：顾客自己的预约列表（他本来就可能在不同店都有单）。

写 app 域新接口时先问一句：**它跟「哪家店」有关吗？** 有关就读这个头，
别自己发明 `?storeId=` 参数（两套并存必然分叉）。

## app 域写接口的三条硬约定

1. **`wx.request` 的 method 里没有 PATCH**（只有 OPTIONS/GET/HEAD/POST/PUT/DELETE/TRACE/CONNECT）——
   需要「部分更新」语义时，后端开一个 **POST 动作端点**（如 `POST /app/member/profile`），
   不要在客户端硬塞 PATCH：`miniapp/miniprogram/utils/request.ts` 的 `HttpMethod` 会直接拦下来。
   （2026-09 就差点把「顾客自助改资料」设计成 `PATCH /app/member/me`，写前端时才发现调用不了。）
2. **动作型 POST 用 `@HttpCode(200)`**（`points/redeem` / `coupons/claim` / `bookings/:id/settle`
   / `member/profile` 都这么写）；只有真正「建单」才保留 201。
3. **写门店档案必须走 `CustomerPort`**（`src/modules/biz/common/ports.ts`），app 域不直接 update 表 ——
   手机号唯一性校验、审计字段这些规则只在 biz 侧有一份。`created_by` / `updated_by` 统一用
   `APP_ACTOR_ID = 0`（`src/modules/app/app-actor.ts`），与后台操作者（真实 `sys_user.id`）区分开。

字段白名单一律 `.strict()`：传白名单外的字段直接 400，**不要静默忽略** —— 静默忽略会让顾客以为
「我改过了」，回头发现没生效，变成查不出原因的悬案。（`POST /app/member/profile` 只放开
name / gender / birthday；**`phone` 必须走 `/app/auth/phone` 的换绑留痕链路**。）

## 验收（§12 B6）

- 测试 code 能换到 app token；同一 openid 重复登录不产生第二条身份记录
- app token 打 `/api/v1/biz/**` 被拒；后台 token 打 `/api/v1/app/**` 被拒
- app 域只读接口返回字段**不含**成本 / `createdBy` / 后台备注（用 Zod schema 断言字段集合）
- `GET /app/available-slots` 与后台结果一致
- 未绑定手机号访问 `/app/member/me` → 401 + `needBind`
- **唯一仍是契约位的接口**：`POST /app/payments/wxpay/jsapi` → 501 且不落库；
  其余 app 域接口（bookings 增查/取消、reviews、subscribe、member/cards、points/redeem、
  券三件套、`app/staff/*` 工作台）**都已接真实 service 并落库**，验收要按真实现测，
  不要因为控制器文件头的旧注释（写着"骨架本期全部返回 501"）就当成未实现。

## 常见坑

- 为省事让 app 域复用后台 DTO / 直接返回实体 → 泄露成本与内部字段。
- 忘记双向拒绝，导致会员 token 能打后台接口。
- 把文件头注释当现状：`app-member.controller.ts` 的旧注释仍写着"本期全部返回 501"，
  实际除 `wxpay/jsapi` 外都已实现；**判断是否实现要看 handler 体**，不要看注释。
- 订阅消息要真发出去，必须由小程序客户端先授权（`app_wx_subscribe_grant` 记授权额度）；
  没配模板/额度时只落站内消息，不要以为"调用成功就等于用户收到了"。
