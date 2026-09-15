# syntax=docker/dockerfile:1
#
# 后台前端镜像（Vue 3 + Vite → nginx 托管）
#
# ⚠️ 构建上下文是**仓库根目录**，不是 `web/`。原因是 vite.config.ts 把产物写到了
#    仓库根的 output/web（`outDir: path.resolve(import.meta.dirname, '../output/web')`），
#    context 若只给 `web/` 就 COPY 不到产物。
#
#   docker build -f web/Dockerfile -t manicure-web .

# ---------- 1. 构建 ----------
FROM oven/bun:1.4-alpine AS build
# 工作目录取仓库根，这样 `../output/web` 解析成 /repo/output/web
WORKDIR /repo

COPY web/package.json web/bun.lock ./
RUN bun install --frozen-lockfile

COPY web ./web

# 前端只请求同源 `/api/v1`（web/src/request.ts 用 VITE_API_BASE_URL），
# 由 nginx 反代到 api 服务，因此默认值就是相对路径，无需知道后端域名。
# ⚠️ web/.env.production 没入库（.gitignore 忽略 .env.*），因此这里必须显式给默认值：
#    否则从 git clone 出来的源码构建时该变量为空，前端会请求到错误地址。
ARG VITE_API_BASE_URL=/api/v1
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}

# ⚠️ 这里直接调 vite，而不用 `bun run build`（它的第一步是 `vue-tsc --noEmit`）。
#    原因：`web/tsconfig.json` 的 include 只覆盖 `src/**` 与 `types/**`，
#    类型检查实际依赖仓库根的 node_modules 兜底（vitest 声明在根 package.json、
#    .vue 语言服务依赖完整的依赖树）。镜像里只装了 web 的依赖，vue-tsc 会把
#    所有 `.vue` 报成 TS2307；但 `vite build` 本身完全正常（实测 exit=0）。
#    类型门禁请走本地/CI 的 `bun run typecheck`，镜像只负责产出可部署产物。
RUN cd web && bunx vite build

# ---------- 2. 运行时 ----------
FROM nginx:1.27-alpine AS runtime

ENV TZ=Asia/Shanghai

# SPA 路由 + /api 反向代理（含上传体积、超时、gzip 与缓存头策略）
COPY web/nginx.conf /etc/nginx/conf.d/default.conf

COPY --from=build /repo/output/web /usr/share/nginx/html

EXPOSE 80
