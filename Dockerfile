# syntax=docker/dockerfile:1
#
# 后端 API 镜像（NestJS + Fastify + Drizzle）
#
# 构建上下文是**仓库根目录**（需要 src/ 与 package.json）：
#   docker build -t manicure-api .
#
# 三段式：
#   deps    只装依赖（利用 layer 缓存：改源码不重装依赖）
#   build   nest build → output/server
#   runtime 只带运行期真正需要的东西
#
# ⚠️ 运行期镜像里**必须同时有 `src/`**：迁移与播种走的就是 TS 源码
#    （`bun src/database/migrate.ts` / `bun src/database/seed/index.ts`），
#    它们是项目既有的 package.json 脚本，不从编译产物里跑。
#    因此这里的做法是「编译产物跑服务 + TS 源码跑迁移」，两者都进镜像。

# ---------- 1. 依赖 ----------
FROM oven/bun:1.4-alpine AS deps
WORKDIR /app
# 只先拷依赖清单：源码改动不会让这一层失效
COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile

# ---------- 2. 构建 ----------
FROM oven/bun:1.4-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# nests build：SWC 编译 + typeCheck（见 nest-cli.json），产物在 tsconfig.build.json 指定的 output/server
RUN bun run build

# ---------- 3. 运行时 ----------
FROM oven/bun:1.4-alpine AS runtime
WORKDIR /app

# 时区必须显式设置：业务大量按「店内本地日」切分（营业日、可约时段、报表日界），
# 容器默认 UTC 会让整个系统的时间口径偏 8 小时。
ENV NODE_ENV=production \
    TZ=Asia/Shanghai \
    PORT=3000

# 运行期依赖：drizzle-kit 在 dependencies 里（迁移要用），devDependencies 全部不要
COPY package.json bun.lock bunfig.toml ./
RUN bun install --production --frozen-lockfile

# 服务用编译产物；迁移/播种用源码（见文件头说明）
COPY --from=build /app/output ./output
COPY --from=build /app/src ./src
COPY --from=build /app/tsconfig.json ./tsconfig.json

# 入口脚本：先迁移 → 首次才播种 → 起服务
COPY deploy/api-entrypoint.sh ./deploy/api-entrypoint.sh
RUN chmod +x ./deploy/api-entrypoint.sh

# 上传目录：镜像内先建好并交给容器，部署时用 volume 挂上来持久化
RUN mkdir -p /app/uploads
VOLUME ["/app/uploads"]

EXPOSE 3000

# 迁移 + 播种 + 启动都在脚本里（首启自动初始化，重启不会重置管理员密码）
ENTRYPOINT ["sh", "./deploy/api-entrypoint.sh"]
