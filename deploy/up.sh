#!/bin/sh
#
# 一键部署（Linux / macOS）
#
#   ./deploy/up.sh
#
# 做三件事：
#   1. 首次运行时从 deploy/env.example 生成 deploy/.env，并自动填入随机密钥与随机管理员密码
#   2. 构建镜像并后台启动全套服务（MySQL + Redis + API + nginx 前端）
#   3. 打印访问地址、初始账号与常用运维命令
#
# 重复执行是安全的：已存在 deploy/.env 时不会覆盖，等价于「重新构建并滚动更新」。

set -e

cd "$(dirname "$0")/.."

ENV_FILE=deploy/.env
TEMPLATE=deploy/env.example

command -v docker >/dev/null 2>&1 || {
  echo "[up] 未找到 docker。请先安装 Docker Engine（服务器）或 Docker Desktop（本机）" >&2
  exit 1
}

# 只用 /dev/urandom，避免依赖 openssl
rand() {
  LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom | head -c "$1"
}

FIRST_RUN=0
if [ ! -f "$ENV_FILE" ]; then
  [ -f "$TEMPLATE" ] || {
    echo "[up] 模板文件 $TEMPLATE 缺失" >&2
    exit 1
  }
  echo "[up] 未找到 $ENV_FILE，正在从模板生成（随机密钥 + 随机管理员密码）..."
  ADMIN_PW="$(rand 16)"
  while IFS= read -r line; do
    case "$line" in
      MYSQL_ROOT_PASSWORD=*) printf 'MYSQL_ROOT_PASSWORD=%s\n' "$(rand 32)" ;;
      JWT_ACCESS_SECRET=*) printf 'JWT_ACCESS_SECRET=%s\n' "$(rand 48)" ;;
      JWT_REFRESH_SECRET=*) printf 'JWT_REFRESH_SECRET=%s\n' "$(rand 48)" ;;
      SEED_ADMIN_PASSWORD=*) printf 'SEED_ADMIN_PASSWORD=%s\n' "$ADMIN_PW" ;;
      *) printf '%s\n' "$line" ;;
    esac
  done < "$TEMPLATE" > "$ENV_FILE"
  # 里面有数据库口令与 JWT 密钥
  chmod 600 "$ENV_FILE" 2>/dev/null || true
  FIRST_RUN=1
else
  echo "[up] 复用已有的 $ENV_FILE"
fi

echo "[up] 构建并启动（首次构建需要几分钟）..."
docker compose --env-file "$ENV_FILE" up -d --build

WEB_PORT="$(grep -E '^WEB_PORT=' "$ENV_FILE" | cut -d= -f2- || true)"
WEB_PORT="${WEB_PORT:-80}"

echo
echo "──────────────────────────────────────────────────────────────"
if [ "$FIRST_RUN" = "1" ]; then
  echo " 初始管理员：admin / $(grep -E '^SEED_ADMIN_PASSWORD=' "$ENV_FILE" | cut -d= -f2-)"
  echo " ⚠️ 登录后请立即修改密码（改完不会再被重置）"
  echo "──────────────────────────────────────────────────────────────"
fi
echo " 后台入口：   http://<服务器IP>:${WEB_PORT}/"
echo " 接口文档：   http://<服务器IP>:${WEB_PORT}/api/v1/docs（需 SWAGGER_ENABLED=true）"
echo
echo " 看日志：     docker compose --env-file deploy/.env logs -f api"
echo " 看状态：     docker compose --env-file deploy/.env ps"
echo " 重启 API：   docker compose --env-file deploy/.env restart api"
echo " 停止：       docker compose --env-file deploy/.env down"
echo " 停止并清库： docker compose --env-file deploy/.env down -v   # ⚠️ 会删掉数据卷"
echo "──────────────────────────────────────────────────────────────"
