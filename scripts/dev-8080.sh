#!/usr/bin/env bash
# 本地 dev 服务一键启动（0.0.0.0:8080）。
#
# 为什么要有这个脚本：命令手敲容易错，而且踩过一个坑 ——
#   **把 dev 的日志写在项目目录里，会让 Next dev 的整页重载陷入死循环**：
#   每个请求都会往日志里写一行 → 文件监视器当成"代码变了" → 重新编译 → 整页重载
#   → 又发一个请求 → 又写一行 …… 表现为页面一直闪、导航永远停在"正在读取登录状态…"。
#   实测：日志在项目内时，空闲 8 秒日志增长 76 行；挪到项目外后，空闲 20 秒 0 行。
#   所以本脚本**默认把日志写到项目外**，并且会拒绝"日志落在项目内"的配置。
#
# 用法：
#   bash scripts/dev-8080.sh                          # 起服务（已在跑则拒绝重复启动）
#   DSH_REVIEW_DEV_LOG=/tmp/dev.log bash scripts/dev-8080.sh
#
# 停止：脚本会把 PID 打出来，用 kill 精确停（先 ps 核对身份；不要按名字批量杀 —— 那是红线）。

set -eu

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PORT="${PORT:-8080}"
LOG="${DSH_REVIEW_DEV_LOG:-/root/dsh-review-dev-8080.log}"

# —— 守卫：日志不许落在项目目录内（否则触发整页重载死循环）
case "$LOG" in
  "$ROOT"/*)
    echo "[拒绝启动] 日志路径落在项目目录内：$LOG" >&2
    echo "           Next dev 的文件监视会把它当成代码变更，导致整页重载死循环。" >&2
    echo "           换个项目外的路径，例如 DSH_REVIEW_DEV_LOG=/root/dsh-review-dev-8080.log" >&2
    exit 1
    ;;
esac

# —— 已经在跑就不重复起（本脚本不杀任何进程）
if curl -sS -m 2 -o /dev/null "http://127.0.0.1:${PORT}/api/health" 2>/dev/null; then
  echo "[已在运行] 127.0.0.1:${PORT} 已经有服务在响应，不重复启动。"
  echo "           要重启：ps -eo pid,cmd | grep next-dev 找到 PID，核对身份后再 kill。"
  exit 0
fi

# —— dev 环境（生产走 docker compose，不要用这个脚本）
export NODE_ENV=development
export PORT
export DSH_REVIEW_HOST="${DSH_REVIEW_HOST:-0.0.0.0}"
export DSH_REVIEW_DB_PATH="${DSH_REVIEW_DB_PATH:-.data/app.sqlite}"
export DSH_REVIEW_MEDIA_ROOT="${DSH_REVIEW_MEDIA_ROOT:-.data/media}"
export BACKUP_ROOT="${BACKUP_ROOT:-.data/backups}"
export BACKUP_KEEP="${BACKUP_KEEP:-14}"
export DSH_REVIEW_ALLOW_TEST_LOGIN="${DSH_REVIEW_ALLOW_TEST_LOGIN:-1}"
export DSH_REVIEW_INSECURE_COOKIES="${DSH_REVIEW_INSECURE_COOKIES:-1}"
export DSH_REVIEW_TRUST_PROXY="${DSH_REVIEW_TRUST_PROXY:-0}"
# 超级管理员：dev 默认绑到一个测试身份；**生产必须填真实 GitHub 数字 ID**。
export SUPER_ADMIN_GITHUB_ID="${SUPER_ADMIN_GITHUB_ID:-super-admin}"

echo "== 启动 dev =="
echo "  项目根   $ROOT"
echo "  监听     $DSH_REVIEW_HOST:$PORT"
echo "  日志     $LOG  （项目外 —— 放项目内会触发整页重载死循环）"
echo "  超管身份 $SUPER_ADMIN_GITHUB_ID  （登录 → 开发 → 测试登录（开发）· 超级管理员）"

mkdir -p "$(dirname "$LOG")"
echo "===== dev-8080.sh 启动 $(date "+%F %T") =====" >> "$LOG"
setsid nohup npx next dev -H "$DSH_REVIEW_HOST" -p "$PORT" >> "$LOG" 2>&1 < /dev/null &
PID=$!
echo "  进程 PID $PID"

for _ in $(seq 1 40); do
  sleep 1
  # 先确认"我们拉起的进程"还活着：端口被占时 next dev 会立刻退出，
  # 而健康检查可能命中别的服务 —— 那样会误报"启动成功"。
  if ! kill -0 "$PID" 2>/dev/null; then
    echo "[失败] 进程 $PID 已退出（常见原因：端口 ${PORT} 被占用）。日志尾部：" >&2
    tail -20 "$LOG" >&2
    exit 1
  fi
  if curl -sS -m 2 -o /dev/null "http://127.0.0.1:${PORT}/api/health" 2>/dev/null; then
    LAN="$(hostname -I 2>/dev/null | awk '{print $1}')"
    echo "  就绪 ✓  本机 http://127.0.0.1:${PORT}/   局域网 http://${LAN}:${PORT}/"
    echo "  停止：kill $PID   （先 ps -o pid,cmd -p $PID 核对身份）"
    exit 0
  fi
done
echo "[超时] 40 秒内没起来，看日志：tail -40 $LOG" >&2
exit 1
