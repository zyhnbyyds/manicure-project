---
title: 本地开发与命令手册
---

# 本地开发与命令手册

## 环境要求

| 依赖 | 版本 / 说明 | 是否必须 |
| --- | --- | --- |
| **Bun** | `>= 1.4`（`package.json` 的 `engines.bun`，`packageManager: bun@1.4.0`） | **必须**。后端与前端都用它当运行时 + 包管理器 |
| **MySQL** | 8.x，需要一个能建库的账号 | **必须**（应用启动要 `DATABASE_URL`，集成测试要额外建测试库） |
| **Redis** | 任意版本 | 可选。不配置则缓存 / 在线用户 / 部分任务自动降级 |
| 微信开发者工具 | 稳定版，`libVersion` 用 trial | 可选，只有跑小程序时用 |
| Node.js | — | **不需要**。项目不引入 tsx / Node 启动方式 |

::: warning Bun 版本低于 1.4 会直接坏
`src/common/cache/redis.service.ts` 用的是 **Bun 内置的 `Bun.RedisClient`**（不是 ioredis），`src/common/password/password.service.ts` 用的是 `Bun.password`。旧版 Bun 没有这些 API。
:::

## 从零跑起来

### 第 1 步：准备环境变量

```bash
cp .env.example .env
```

`.env.example` 只有 45 行，**必填项是这 5 个**（缺任何一个进程都起不来）：

| 变量 | 说明 |
| --- | --- |
| `DATABASE_URL` | `mysql://user:pass@host:port/db`，`z.url()` 校验 |
| `JWT_ISSUER` / `JWT_AUDIENCE` | 非空字符串 |
| `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` | **至少 32 字符**（`z.string().min(32)`） |

::: danger `.env.example` 里没有 `SEED_ADMIN_PASSWORD`
`src/database/seed/index.ts` 第 12-14 行要求它存在：

```ts
const password = Bun.env.SEED_ADMIN_PASSWORD;
if (!url || !password) throw new Error('DATABASE_URL and SEED_ADMIN_PASSWORD are required');
```

照抄 `.env.example` 后 `bun run db:seed` 会**直接抛错**。请自己在 `.env` 里补一行 `SEED_ADMIN_PASSWORD=<你的管理员密码>`（仓库当前工作区的 `.env` 里就有这一项，但模板里没有 —— 这是模板的缺口）。
:::

::: tip `REDIS_URL` 不想要就**整行删掉**
`envSchema` 里是 `z.url().optional()`：**空字符串会让校验失败**（空串不是合法 URL）。集成测试的 `applyTestEnv()` 也为此显式 `delete process.env.REDIS_URL`。
:::

### 第 2 步：安装依赖

```bash
bun install
```

生成 / 校验 `bun.lock`。后端依赖装在仓库根 `node_modules/`。

### 第 3 步：建表 + 灌初始数据

```bash
bun run db:migrate      # 执行 src/database/migrations/ 下的 15 个迁移
bun run db:seed         # 管理员 admin + 超级管理员角色
bun run db:seed:menus   # 菜单树与权限点（幂等）
bun run db:seed:biz     # 业务默认值
bun run db:seed:nail    # 美甲店基础资料
bun run dev             # http://localhost:3000
```

逐条说明：

| 命令 | 入口 | 做什么 |
| --- | --- | --- |
| `bun run db:migrate` | `src/database/migrate.ts` | 读 `process.env.DATABASE_URL`，用 `drizzle-orm/mysql2/migrator` 跑 `./src/database/migrations`，失败 `process.exit(1)` |
| `bun run db:seed` | `src/database/seed/index.ts` | 建 `admin` / `user` 两个角色 → 建 `admin` 用户（`Bun.password` argon2id）→ 绑角色 → **然后依次调用 `seedMenus` / `seedBiz` / `seedNail`** |
| `bun run db:seed:menus` | `src/database/seed/menus.ts` | 菜单与按钮权限点，按 `name` upsert（值没变不发 UPDATE），角色授权只补缺失项 |
| `bun run db:seed:biz` | `src/database/seed/biz.ts` | 会员等级 / 退款判责规则 / 8 个通知模板 / 11 个定时任务 / `biz.*` 业务参数 + 中文名 |
| `bun run db:seed:nail` | `src/database/seed/nail.ts` | 服务项目 / 美甲师 / 周排班 / 卡种 / 充值方案 / 积分兑换品 / 提成规则 / 挂账主体 |
| `bun run db:seed:demo` | `src/database/seed/demo.ts` | **演示用**顾客与会员数据 |

::: warning `bun run db:seed` 其实已经把 menus / biz / nail 都跑了
`seed/index.ts` 第 49-53 行显式调用了 `seedMenus(pool)` / `seedBiz(pool)` / `seedNail(pool)`，第 54 行注释还专门说明 demo 不在里面。

所以 `db:seed:menus` / `db:seed:biz` / `db:seed:nail` 是**可单独重跑的幂等命令**，不是必须按顺序执行的前置步骤。日常改完 `seed/menus.ts` 只跑 `db:seed:menus` 即可，比全量 seed 快。

**只有 `db:seed:demo` 必须单独跑，且生产绝对不要跑。**
:::

::: danger 环境变量加载：Nest 只读根 `.env`
`src/app.module.ts` 里是 `ConfigModule.forRoot({ isGlobal: true })` —— 源码核实过 `@nestjs/config` 的实现：**没有传 `envFilePath` 时只加载 `process.cwd()/.env`**。

也就是说仓库里的 `.env.development` / `.env.prod` / `.env.test` **不会被 Nest 应用读取**（`ConfigModule` 默认也不是"按 NODE_ENV 拼文件名"）。真正生效的只有：

| 来源 | 谁读它 |
| --- | --- |
| `.env` | Nest（`ConfigModule`）+ Bun 运行时自动加载（`bun run db:migrate` 用的 `process.env` 就靠这个） |
| `.env.development` / `.env.prod` / `.env.test` | **只有集成测试 harness** 在 `applyTestEnv()` 里手工解析（`.env` → `.env.test` 后者覆盖前者） |

所以切换环境请**改 `.env` 本身**，别指望 `NODE_ENV=production` 会自动切到 `.env.prod`。详见 [配置与环境变量](/overview/config)。
:::

### 第 4 步：打开验证

| 地址 | 内容 |
| --- | --- |
| `http://localhost:3000/api/v1/health` | `{ "code": 0, "data": { "status": "ok" }, "message": "ok" }`（`@Public()`） |
| `http://localhost:3000/api/v1/docs` | Swagger（需 `SWAGGER_ENABLED=true`，默认开） |

默认管理员：用户名 `admin`，密码 = 你填的 `SEED_ADMIN_PASSWORD`。

## 后台前端

```bash
cd web
bun install
bun run dev            # http://localhost:5173，自动打开浏览器
```

- `web/package.json` 的 `dev` 是 `vite --port 5173 --open`；
- `web/vite.config.ts` 的 `server.proxy` 把 `/api` 代理到 `http://localhost:3000`（`changeOrigin: true`）；
- `web/.env.development` 与 `.env.production` 都是 `VITE_API_BASE_URL=/api/v1` —— 走同源 + 代理；
- 构建：`bun run build`（`vue-tsc --noEmit && vite build`），产物到 **`../output/web`**。

::: warning `web/` 与仓库根**各自独立安装依赖**
根 `bun install` 不会装 `web/` 的依赖（`miniapp/` 同样）。Vite 8 / Vue 3.5 / lew-ui 都在 `web/package.json` 里。
:::

::: tip 登录后页面空白 / 只有布局没有内容
动态路由由菜单 seed 驱动：`web/src/store/permission.ts` 用 `import.meta.glob('../views/**/*.vue')` 把 `component` 路径（形如 `biz/service-items/index`）解析成组件，路由来自后端返回的菜单树。

**没跑 `bun run db:seed:menus`，或者当前账号没被授权任何菜单 → 导航后命中兜底 404。**
:::

## 微信小程序

```bash
# 方式一：微信开发者工具「导入项目」，目录选 miniapp/（appid 已在 project.config.json）
# 方式二：只做类型检查（根目录执行，miniapp 自身不装 typescript）
bunx tsc --noEmit -p miniapp/tsconfig.json
```

### 真机 / 模拟器联调的三个前提

1. **`miniapp/miniprogram/config.ts` 的 `API_BASE` 用局域网 IP**，不是 `127.0.0.1`
   ```ts
   export const API_BASE = 'http://192.168.0.100:3000/api/v1';
   ```
   模拟器里两者都能用，但**真机上 `127.0.0.1` 指向手机自己**，必然连不上。挑**有默认网关**的那张网卡（VMware / Hyper-V / 蓝牙的虚拟网卡也能通，但手机连不上）。

   ::: warning 这个 IP 会随 DHCP 变，连不上先查它
   唯一权威值是 `config.ts` 里的 `API_BASE`（上面只是抄了一份当时的快照）。2026-09 就换过一次号（`.101` → `.100`），
   症状是 **「目标计算机积极拒绝」** —— 那是**那个 IP 上压根没有我们的服务**（`.101` 成了别的设备），
   不是防火墙（防火墙的表现是**超时**）。核对本机 IP：

   ```powershell
   Get-NetIPAddress -AddressFamily IPv4 |
     Where-Object { $_.IPAddress -notlike '127.*' -and $_.PrefixOrigin -eq 'Dhcp' }
   ```
   想一劳永逸：在路由器上给这台机做 **DHCP 保留**。
   :::
2. **`miniapp/project.private.config.json` 里 `urlCheck: false`**（工作区当前已是 false）—— 项目走 `http + IP`，不是 https 合法域名。
3. **Windows 防火墙放行入站 3000**：

   ```powershell
   # 管理员 PowerShell；只放行同网段，别开成任意来源
   New-NetFirewallRule -DisplayName "manicure dev API 3000 (LAN)" -Direction Inbound `
     -Protocol TCP -LocalPort 3000 -RemoteAddress LocalSubnet -Action Allow -Profile Any
   ```

   注意 WLAN 的网络类别常常是「公用」，而公用配置文件的入站默认是**拦**。

::: tip 网络自检的正确答案
用**手机浏览器**打开 `http://<局域网IP>:3000/api/v1/health`，能看到 JSON 就说明网络通了。

在本机浏览器上自测是**测不出防火墙**的 —— 本机访问 `127.0.0.1` 根本不经过防火墙。这个坑写在 `config.ts` 的注释里。

反过来，本机访问**局域网 IP**（如 `http://192.168.0.100:3000/...`）也**不经过**防火墙的入站规则，
所以「本机通、手机不通」是常态，别据此判断防火墙没问题。
:::

### 小程序的 UI 数据来源

`miniapp/miniprogram/config.ts` 顶部注释说明：后端 app 域已有真实现，但要拿到 app token 必须先过 `wx.login` → `POST /app/auth/login`，而这个接口在**未配置凭据时返回 503**。所以凭据到位之前页面走演示数据；**凭据到位后把 `useMock` 改成 `false` 即可切真接口，页面代码不用动**。

`SHOP`（门店名 / 电话 / 地址 / 经纬度）目前**硬编码在 `config.ts`** —— 注释里写明"应该来自后端"，但 app 域还没有门店档案接口。

## 命令速查表

### 后端（仓库根）

| 命令 | 实际执行 | 一句话说明 |
| --- | --- | --- |
| `bun run dev` | `bun --watch src/main.ts` | 开发模式，改文件自动重启 |
| `bun run start` | `bun src/main.ts` | 直接启动（不 watch） |
| `bun run build` | `nest build` | SWC 编译到 `output/server`（`deleteOutDir: true`） |
| `bun run typecheck` | `tsc --noEmit` | 全量类型检查（已排除 `src/modules/generated` 与 `*.spec.ts`） |
| `bun run lint` | `oxlint .` | 只开 `correctness: error`，配置在 `.oxlintrc.json` |
| `bun run lint:fix` | `oxlint . --fix` | 同上，自动修 |
| `bun run format` | `oxfmt --write .` | 格式化 |
| `bun run format:check` | `oxfmt --check .` | 只检查不写（CI 用） |
| `bun run test` | `bun test` | 单元 + 集成全量（约 105 个文件） |
| `bun run test:watch` | `bun test --watch` | 监听模式 |
| `bun run test:coverage` | `bun test --coverage` | 带覆盖率 |
| `bun run db:generate` | `drizzle-kit generate` | 由 `src/database/schema/index.ts` 生成迁移 SQL |
| `bun run db:migrate` | `bun src/database/migrate.ts` | 执行迁移 |
| `bun run db:seed` | `bun src/database/seed/index.ts` | 管理员 + menus + biz + nail |
| `bun run db:seed:menus` | `bun src/database/seed/menus.ts` | 仅菜单与权限点 |
| `bun run db:seed:biz` | `bun src/database/seed/biz.ts` | 仅业务默认值与定时任务 |
| `bun run db:seed:nail` | `bun src/database/seed/nail.ts` | 仅美甲店基础资料 |
| `bun run db:seed:demo` | `bun src/database/seed/demo.ts` | 演示数据（**生产禁止**） |
| `bun run db:studio` | `drizzle-kit studio` | Drizzle Studio 可视化查库 |

### 后台前端（`web/`）

| 命令 | 实际执行 | 一句话说明 |
| --- | --- | --- |
| `bun run dev` | `vite --port 5173 --open` | 开发服务器 + 自动开浏览器 |
| `bun run build` | `vue-tsc --noEmit && vite build` | **先类型检查再打包**，产物 `../output/web` |
| `bun run preview` | `vite preview` | 本地预览构建产物 |
| `bun run typecheck` | `vue-tsc --noEmit` | 单跑类型检查 |
| `bun run lint` / `lint:fix` | `oxlint` / `oxlint --fix` | 前端 lint |
| `bun run fmt` / `fmt:check` | `oxfmt` / `oxfmt --check` | 前端格式化 |

### 小程序（仓库根）

| 命令 | 一句话说明 |
| --- | --- |
| `bunx tsc --noEmit -p miniapp/tsconfig.json` | 唯一的自动化入口；`miniapp/package.json` 的 `scripts` 是空的 |
| 微信开发者工具「导入项目」 | 目录选 `miniapp/`；编译走工具内置 TS 插件 |

## 本地没通道能跑吗

**能，而且这是默认状态。** 所有外部通道都是"配置齐全才算启用，缺了就降级"，不影响进程启动。

| 场景 | 行为 | 代码位置 |
| --- | --- | --- |
| 不配任何微信支付 / 支付宝变量 | 在线渠道接口返回「通道未启用」（`ConflictException`）；**线下收款（现金 / 微信线下 / 支付宝线下）、储值、次卡、挂账照常可用** | `src/modules/biz/payment/channels/*.provider.ts` 的 `configured` → `payments.service.ts` |
| 不配 `WX_MINIAPP_APPID/SECRET` | app 域登录返回 **503「小程序端未启用」**（设计内降级） | `AppConfigService.wxMiniapp.configured` → `AppAuthService.login` |
| 本地要调小程序但仍无凭据 | `.env` 里设 `WX_MINIAPP_FAKE=true` 走假微信实现 | `FakeWxMiniappProvider`（`app/auth/wx-miniapp.provider.ts`） |
| 不配 `REDIS_URL` | `RedisService.enabled = false`，各方法返回空值；在线用户 / 缓存监控降级 | `src/common/cache/redis.service.ts` |
| `SMS_PROVIDER=none`（默认）或凭据不全 | 只写站内消息 + failed 日志，**不阻塞业务** | `AppConfigService.sms.configured` → `notices.service.ts` |
| `AI_ENABLED=false`（默认） | AI 操作助手不可用，其余不受影响 | `AppConfigService.ai` |
| `SWAGGER_ENABLED=false` | 不挂载 `/api/v1/docs` | `src/main.ts` |

::: danger `WX_MINIAPP_FAKE=true` 生产强制失效
这不是"图方便的开关"而是安全底线：假实现下**任意手机号都能登录成任意顾客 / 美甲师**。

两道防护：`AppConfigService.wxMiniappFake` 在 `environment === 'production'` 时**一律返回 false**；`FakeWxMiniappProvider` 的构造函数还有第二道拒绝。
:::

## 常见环境问题排查

### 端口被占用（`EADDRINUSE`）

```powershell
# Windows：查谁占了 3000 / 5173
Get-NetTCPConnection -LocalPort 3000 -State Listen |
  Select-Object OwningProcess, @{n='Proc';e={ (Get-Process -Id $_.OwningProcess).ProcessName }}
```

改后端端口：`.env` 的 `PORT`。改前端端口：`web/vite.config.ts` 的 `server.port`（同时要改 `.env` 的 `CORS_ORIGINS`，否则浏览器被 CORS 拦）。

::: warning 改端口要改三处
后端 `PORT` ↔ 前端 `vite.config.ts` 的 `proxy.target` ↔ `.env` 的 `CORS_ORIGINS`。小程序还要改 `miniapp/miniprogram/config.ts` 的 `API_BASE`。
:::

### MySQL 连不上

| 现象 | 原因 |
| --- | --- |
| 启动即抛 `ZodError`，提到 `DATABASE_URL` | 变量没填或格式不是合法 URL |
| `connect ECONNREFUSED 127.0.0.1:3306` | MySQL 没起 / 端口不对 / 用了 `localhost` 而 mysqld 只监听 IPv6 |
| `ER_ACCESS_DENIED_ERROR` | 账号密码错；注意 `.env.example` 里是 `root:root`，很多人本地 root 密码不是 root |
| `ER_BAD_DB_ERROR: Unknown database` | 库还没建。`db:migrate` **不会建库**，只建表 |
| 时间差 8 小时 | 连接池已经强制 UTC（`timezone: 'Z'` + `SET time_zone='+00:00'`）。若仍偏，检查自己是不是用了 `new Date('2026-09-11')` —— 见 [项目总览与技术基线](/overview/) 的「代码铁律」一节 |

### 迁移冲突 / 迁移失败

- **`db:generate` 生成后必须人工看一遍 SQL**：`auditColumns` 的 `CURRENT_TIMESTAMP` 可能被渲染成 `DEFAULT (CURRENT_TIMESTAMP)`，带括号的写法会让后续 `CREATE INDEX` / `ALTER` 报 `Invalid default value for 'created_at'`（详见 [目录结构与代码地图](/overview/structure)）。手工去掉括号，`drizzle-kit` 不会因此认为有漂移。
- **不要手写迁移 SQL**：`src/database/migrations/` 下的 `snapshot.json` 与 SQL 是一对，手改 SQL 不改快照，下次 `generate` 会产生"幽灵 diff"。
- **不要手改已提交的迁移文件**：迁移是按目录名时间戳顺序执行的，改历史迁移会让已部署环境的 `__drizzle_migrations` 与实际结构不一致。
- 集成测试库表结构不对：harness 每次会自己跑一遍迁移，但如果测试库残留旧表，先手动 drop 掉重跑。

### `bun install` 之后 node_modules 不一致

| 现象 | 处理 |
| --- | --- |
| `Cannot find module '@nestjs/core'` | 在**仓库根**跑 `bun install`。`web/` 与 `miniapp/` 是各自独立的安装 |
| 前端报找不到 `vue` / `lew-ui` | 在 `web/` 目录里跑 `bun install` |
| 类型报 `TS2304: 找不到名称 "h"` | `web/types/auto-imports.d.ts` 缺失。它由 `unplugin-auto-import` 生成，**需要提交**（`web/.gitignore` 注释写明：`vue-tsc` 在 vite 生成它之前先运行，干净环境缺了会报错） |
| 全局装了 Node 版依赖互相污染 | 删掉 `node_modules/` 与 `bun.lock` 重装；确认 `bun --version` ≥ 1.4 |
| 换 Bun 版本后 `Bun.RedisClient` 不存在 | 升级到 ≥ 1.4 |

### 集成测试相关

- 测试库推导顺序：`TEST_DATABASE_URL` → `.env.test` 的 `TEST_DATABASE_URL` → `.env` 主库名 + `_test` → 兜底 `mysql://root:123456@127.0.0.1/manicure_test`（`tests/integration/harness.ts` 的 `resolveTestDatabaseUrl()`）；
- `applyTestEnv()` 会强制 `NODE_ENV=test`、`SWAGGER_ENABLED=false`、`AI_ENABLED=false`、`SMS_PROVIDER=none`、`WX_MINIAPP_FAKE=true`，并注入一套**测试用的微信支付密钥**（离线也能跑真验签），同时 `delete process.env.REDIS_URL`；
- **不要把这些开关写进 `.env.test`**：`.env.test` 被 `.gitignore` 忽略，只有写进 `harness.ts` 才能保证任何机器行为一致（注释里就是这么说的）；
- 清表用的是 **`DELETE` 而不是 `TRUNCATE`**（harness 注释实测：37 张表 `TRUNCATE` 合计 4067ms vs `DELETE` 56ms，差 73 倍，因为 InnoDB 的 `TRUNCATE` 是 DDL）。所以 `bunfig.toml` 里那句"逐个 `TRUNCATE`"是**旧描述**；
- hook 超时已由 `bunfig.toml` 提到 60s，新写的 spec 仍建议显式传超时（与既有 `beforeAll(async () => {...}, 120_000)` 的约定一致）。

## 相关页面

- [项目总览与技术基线](/overview/) · [配置与环境变量](/overview/config)
- [目录结构与代码地图](/overview/structure) · [三端架构与请求生命周期](/overview/architecture)
