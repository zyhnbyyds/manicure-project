#!/bin/sh
#
# api 容器入口：迁移 → 首次播种 → 起服务
#
# 为什么要单独一个入口脚本：
#   1. 迁移必须**在服务起来之前**跑完，否则第一个请求会打到不存在的表上；
#   2. 播种（db:seed）会**重置 admin 密码**（seed/index.ts 里是 onDuplicateKeyUpdate），
#      所以绝不能每次启动都跑 —— 这里靠「admin 账号是否已存在」判断，只在首次执行；
#   3. 迁移与播种是项目既有的 package.json 脚本（走 TS 源码，见 Dockerfile 头部说明）。

set -e

echo "[entrypoint] 检查数据库连接 ..."
i=0
until bun -e 'import mysql from "mysql2/promise"; try { const c = await mysql.createConnection(process.env.DATABASE_URL); await c.end(); } catch { process.exit(1); }'; do
  i=$((i + 1))
  if [ "$i" -ge 30 ]; then
    echo "[entrypoint] 等待数据库超时（60s）。请检查 deploy/.env 里的 DATABASE_URL 以及 db 容器状态：" >&2
    echo "             docker compose --env-file deploy/.env ps" >&2
    exit 1
  fi
  sleep 2
done

echo "[entrypoint] 执行数据库迁移 ..."
bun run db:migrate

# SEED_ON_START 三种取值：
#   auto（默认）—— admin 不存在且设置了 SEED_ADMIN_PASSWORD 时才播种（正常部署走这条）
#   force       —— 无条件播种（会把管理员密码重置为 SEED_ADMIN_PASSWORD，慎用）
#   false       —— 完全不播种
case "${SEED_ON_START:-auto}" in
  false)
    echo "[entrypoint] 跳过播种（SEED_ON_START=false）"
    ;;
  force)
    echo "[entrypoint] 按 SEED_ON_START=force 强制播种（管理员密码将被重置）..."
    bun run db:seed
    ;;
  *)
    # 已初始化过就跳过：否则每次重启都会把管理员密码改回 SEED_ADMIN_PASSWORD
    if bun -e 'import mysql from "mysql2/promise"; try { const c = await mysql.createConnection(process.env.DATABASE_URL); const [r] = await c.query("SELECT 1 FROM sys_user WHERE username = ? LIMIT 1", ["admin"]); await c.end(); process.exit(r.length > 0 ? 0 : 1); } catch { process.exit(1); }'; then
      echo "[entrypoint] 已检测到初始化数据，跳过播种（要重跑请设 SEED_ON_START=force）"
    elif [ -n "${SEED_ADMIN_PASSWORD:-}" ]; then
      echo "[entrypoint] 首次启动：写入初始数据（管理员 / 菜单权限 / 业务基础资料）..."
      bun run db:seed
    else
      echo "[entrypoint] 数据库为空，但 SEED_ADMIN_PASSWORD 未设置 —— 无法创建管理员账号。" >&2
      echo "             请在 deploy/.env 设置后重启：docker compose --env-file deploy/.env restart api" >&2
      exit 1
    fi
    ;;
esac

echo "[entrypoint] 启动 API 服务 ..."
exec bun output/server/main.js
