#!/usr/bin/env bash
# 服务器端部署脚本：由 GitHub Actions 通过
#   ssh root@5.231.26.36 "bash -s -- /tmp/dsh-deploy-<sha>.tar.gz <short-sha>" < deploy/deploy-remote.sh
# 执行。也可以手动执行（把已上传的 git archive 包作为第一个参数）。
#
# 服务器布局（与 docs/docker约定.md 一致）：
#   /root/dsh-plugin-review/repo        ← 源码（不是 git clone，由发布包解出来）
#   /root/dsh-plugin-review/repo/docker/.env  ← 部署参数（**不在 git 里，切目录时要带过去**）
#   /root/dsh-plugin-review/data        ← SQLite + 媒体
#   /root/dsh-plugin-review/backups     ← 数据库热备
#   /root/dsh-plugin-review/certs       ← TLS 证书
#
# 步骤：热备 → 解包到 repo.new → 原子切换 → docker compose up -d --build → 等 healthy → 验收。
# 任何一步失败都会自动把上一版源码切回来并重建（数据由开头的热备兜底）。

set -euo pipefail

TARBALL="${1:?usage: deploy-remote.sh <tarball> <label>}"
LABEL="${2:-unknown}"

ROOT_DIR="/root/dsh-plugin-review"
REPO_DIR="$ROOT_DIR/repo"
COMPOSE_DIR="$REPO_DIR/docker"
NEW_DIR="$ROOT_DIR/repo.new"
TS="$(date +%Y%m%d-%H%M%S)"
OLD_DIR="$ROOT_DIR/repo.old-$TS"

log() { printf '\n[deploy %s] %s\n' "$(date +%H:%M:%S)" "$*"; }
die() { log "FAILED: $*"; exit 1; }

DOMAIN="review.lingshulab.com"
SWAPPED=0

rollback() {
  trap - ERR
  set +e
  log "ROLLBACK：把上一版源码切回来并重建"
  rm -rf "$REPO_DIR"
  if [ -d "$OLD_DIR" ]; then mv "$OLD_DIR" "$REPO_DIR"; fi
  ( cd "$REPO_DIR/docker" && docker compose up -d --build ) || log "回滚重建失败，需要手动处理"
}

on_exit() {
  code=$?
  trap - EXIT
  if [ "$code" -ne 0 ] && [ "$SWAPPED" -eq 1 ]; then
    rollback
  fi
  exit "$code"
}
trap on_exit EXIT

[ -f "$TARBALL" ] || die "tarball not found: $TARBALL"
[ -f "$COMPOSE_DIR/.env" ] || die "missing $COMPOSE_DIR/.env（部署参数不能丢，先确认服务器布局）"
[ -d "$REPO_DIR" ] || die "missing $REPO_DIR"

cd "$COMPOSE_DIR"

log "1/5 部署前数据库热备（label=pre-deploy-$LABEL）"
docker compose run --rm --no-deps web \
  node scripts/backup.mjs --label "pre-deploy-$LABEL" --keep 14 \
  || die "pre-deploy backup failed；在改动代码之前中止"

log "2/5 解包新源码到 $NEW_DIR"
rm -rf "$NEW_DIR"
mkdir -p "$NEW_DIR"
tar xzf "$TARBALL" -C "$NEW_DIR"
[ -f "$NEW_DIR/docker/compose.yaml" ] || die "tarball 不像本仓库的发布包（缺 docker/compose.yaml）"
cp -p "$COMPOSE_DIR/.env" "$NEW_DIR/docker/.env" || die "复制 docker/.env 失败"

log "3/5 原子切换源码目录"
mv "$REPO_DIR" "$OLD_DIR"
mv "$NEW_DIR" "$REPO_DIR"
SWAPPED=1

cd "$REPO_DIR/docker"
log "4/5 构建并启动（migrate → web/worker → nginx）"
docker compose up -d --build

log "5/5 等待 web healthy"
WEB_ID=""
STATUS=""
for _ in $(seq 1 120); do
  WEB_ID="$(docker compose ps -q web 2>/dev/null || true)"
  if [ -n "$WEB_ID" ]; then
    STATUS="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$WEB_ID" 2>/dev/null || echo unknown)"
    [ "$STATUS" = "healthy" ] && break
    [ "$STATUS" = "unhealthy" ] && break
  fi
  sleep 5
done

if [ "$STATUS" != "healthy" ]; then
  docker compose logs --tail=80 migrate web 2>&1 || true
  die "web 没有变为 healthy（最后状态：${STATUS:-none}）"
fi

# 走 nginx 的 HTTPS 入口验收（HTTP 80 是 301 跳转，不能当作失败）
curl -fsS --max-time 10 --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/api/health" >/dev/null || die "/api/health 验收失败"
CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/")"
[ "$CODE" = "200" ] || die "首页返回 HTTP $CODE"

# 线上源码快照保留最近 2 份，避免磁盘无限增长
ls -1dt "$ROOT_DIR"/repo.old-* 2>/dev/null | tail -n +3 | xargs -r rm -rf
# 发布包保留 7 天
find /tmp -maxdepth 1 -name 'dsh-deploy-*.tar.gz' -mtime +7 -delete 2>/dev/null || true

log "DONE：$LABEL 已上线（repo=$REPO_DIR）"
