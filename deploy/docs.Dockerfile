# 文档站镜像：把 docs/（对客操作手册）与 dev-docs/（开发者文档）两套 VitePress 2
# 站点构建成静态产物，用 nginx 托管，靠子路径区分：
#
#   http://<host>:<DOCS_PORT>/docs/       对客操作手册（门店人员看）
#   http://<host>:<DOCS_PORT>/dev-docs/   开发者文档
#
# ⚠️ 这个服务**默认不启动**（compose 里挂了 `profiles: ['docs']`）。
#    文档是构建期资料、不是运行时依赖，生产默认不该背这个包袱。要用就加 --profile docs。
#
# 构建上下文是**仓库根**（和根 Dockerfile / web/Dockerfile 一致）：
#   docker build -f deploy/docs.Dockerfile -t manicure-docs .

# ── 构建阶段 ──────────────────────────────────────────────────────────────
FROM oven/bun:1.4-alpine AS build
WORKDIR /repo

# ⚠️ 两个站点都开了 `lastUpdated: true`，VitePress 会调 `git log` 取每个页面的最后修改时间。
#    而 `oven/bun:*-alpine` 基础镜像**不带 git** —— 缺了会在构建时报
#    `build error: Executable not found in $PATH: "git"` 直接失败，
#    而本地却正常（宿主机有 git），很容易误判成“配置写错了”。
#    只装在构建阶段；运行镜像是 nginx，不带 git。
RUN apk add --no-cache git

# 两套站点各自锁依赖（docs/bun.lock 与 dev-docs/bun.lock 相互独立），所以分两次装
COPY docs/package.json docs/bun.lock ./docs/
COPY dev-docs/package.json dev-docs/bun.lock ./dev-docs/
RUN cd docs && bun install --frozen-lockfile \
 && cd ../dev-docs && bun install --frozen-lockfile

COPY docs ./docs
COPY dev-docs ./dev-docs

# ⚠️ 必须显式拷 .git（且 .dockerignore 里不能排除它）：
#    `git log` 要靠仓库历史算“最后更新”，没有 .git 就只是一堆文件。
#    体积 14.5MB 左右，只存在于构建层，不进最终镜像。
COPY .git ./.git

# ⚠️ DOCS_BASE 决定站点落在哪个子路径，**结尾必须带 `/`**。
#    由 .vitepress/config.mts 读取（`process.env.DOCS_BASE ?? '/'`），
#    它同时决定产物内部的 CSS/JS/站内链接前缀 —— 忘了设、或漏了尾斜杠，
#    结果是「页面打得开但资源全 404」。详见 dev-docs/quality/deploy.md 第 5.1 节。
RUN cd docs && DOCS_BASE=/docs/ bun run build \
 && cd ../dev-docs && DOCS_BASE=/dev-docs/ bun run build

# 构建期自检：产物必须在。否则镜像照建不误，但站是空的 —— 比直接构建失败更难查。
RUN test -f /repo/docs/.vitepress/dist/index.html \
 && test -f /repo/dev-docs/.vitepress/dist/index.html \
 && echo "[docs] 两套站点产物齐备"

# ── 运行阶段 ──────────────────────────────────────────────────────────────
FROM nginx:1.27-alpine
ENV TZ=Asia/Shanghai

COPY deploy/docs.nginx.conf /etc/nginx/conf.d/default.conf

# ⚠️ 产物放到与 URL **同名**的目录下（/docs/、/dev-docs/），配合 nginx 的 root + try_files。
#    这样就不必用 alias —— alias 与 try_files 一起用时行为很反直觉，是个经典坑。
COPY --from=build /repo/docs/.vitepress/dist /usr/share/nginx/html/docs
COPY --from=build /repo/dev-docs/.vitepress/dist /usr/share/nginx/html/dev-docs

EXPOSE 80
