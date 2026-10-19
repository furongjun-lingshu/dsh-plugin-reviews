# Docker 约定

> 这套约定的目标是三件事：**全部打包成容器**、**nginx 反代且真实 IP 可用**、
> **除 `/root` 外不在宿主机留痕**。操作命令都在本文里，配置全部在 `docker/` 下。

## 1. 不变量（改配置时不要破坏）

| 不变量 | 为什么 |
|---|---|
| **nginx 是唯一对外入口**，web 容器不发布端口 | 否则客户端可绕过 nginx 直接伪造 `X-Real-IP`（见 §5） |
| **站点配置烘焙进镜像**，宿主不放 `/etc/nginx` | "除 /root 外不留痕"；且保证线上配置 = 仓库配置 |
| 数据（库 + 媒体）**只在宿主 `/root` 下的一个目录** | 备份、迁移、回滚都只涉及这一个目录 |
| 容器内业务**不用 root** 跑（UID/GID 10001，可覆盖） | 最小权限 |
| 迁移是**独立的一次性进程**，web/worker 不自己迁移 | 避免两个进程同时改结构 |
| 媒体**只反代、不直读磁盘、不缓存** | 可见性由应用按会话判定，nginx 直读等于公开私有图 |

## 2. 目录布局

```
docker/                        ← 容器相关的全部资产（宿主机不需要别的东西）
├─ web.Dockerfile              ← 应用镜像（web / worker / migrate 共用一份）
├─ nginx.Dockerfile            ← 入口镜像（nginx）
├─ compose.yaml                ← 四个角色：migrate / web / worker / nginx
├─ .env.example                ← 部署参数模板（复制为 .env）
├─ daemon.json                 ← 让 Docker 把数据放到 /root/docker
├─ nginx/
│  ├─ nginx.conf               ← 日志格式（含真实 IP 字段）、gzip、超时
│  ├─ conf.d/default.conf      ← 站点：反代、静态缓存、媒体不缓存、/healthz
│  └─ snippets/proxy-common.conf ← 真实 IP 透传 + 安全头（片段，必须按需 include）
└─ bin/                        ← 随镜像携带的二进制附加物（见 bin/README.md）
```

### 关于二进制文件

- **随镜像携带**的二进制（预编译 `.node`、离线 seed 等）放 `docker/bin/`，构建时复制到容器内 `/app/bin`。
- **不该放**的：证书/私钥（挂载 `/root` 下的证书目录）、数据库与媒体（运行期数据，挂 `/app/.data`）、
  `node_modules` 与 `.next`（构建阶段生成）、密钥与 `.env`（运行时注入）。逐条对照见 `docker/bin/README.md`。
- **Docker 自身的二进制数据**（镜像层、容器、卷、构建缓存、容器日志）通过 `daemon.json` 挪到 `/root/docker`。

## 3. 宿主机痕迹约定（"除 /root 外不留痕"）

| 内容 | 位置 |
|---|---|
| 仓库/编排文件 | 任意（建议 `/root/dsh-plugin-review/repo`） |
| 数据库 + 媒体 | `/root/dsh-plugin-review/data`（`DSH_REVIEW_DATA_DIR`） |
| TLS 证书 | `/root/dsh-plugin-review/certs`（只读挂进 nginx） |
| 部署参数与密钥 | `docker/.env`（`chmod 600`，不进 git） |
| 镜像/容器/卷/容器日志 | `/root/docker`（`daemon.json` 的 `data-root`） |

**一个必须如实说明的例外**：安装 Docker 本身会写 `/etc`、`/usr/bin`、`/lib/systemd` 等位置
（`docker.service` 也在 `/etc/systemd/system`）——这是装 Docker 的代价，无法避免。
本约定能保证的是：**部署产物**（镜像、容器、卷、日志、数据、证书）全部在 `/root` 下。

`daemon.json` 怎么生效：

```bash
install -m 644 docker/daemon.json /etc/docker/daemon.json   # 这一步会写到 /etc，属上面的例外
systemctl restart docker
docker info --format '{{.DockerRootDir}}'                   # 应输出 /root/docker
```

> ⚠️ **`daemon.json` 必须是纯配置，一个注释键都不能带。** Docker 会拒绝任何未知字段
> （`unable to configure the Docker daemon ... directives don't match any configuration option: _comment`），
> 后果是 **dockerd 直接起不来**。这份文件早先确实带过一个 `_comment` 文档数组 ——
> 照上面那条命令装下去，docker.service 会当场躺平（2026-10-18 实测踩到）。说明只能写在本文件里。

> 已经有镜像/容器时改 `data-root` 等于换了一块存储：它们仍在 `/var/lib/docker` 里。
> 维护窗口里做，或者先 `docker system prune -a`。

## 4. 首次部署

```bash
# 1) 代码与编排
mkdir -p /root/dsh-plugin-review
cd /root/dsh-plugin-review && git clone <仓库> repo && cd repo/docker

# 2) 部署参数（至少填 SESSION_SECRET）
cp .env.example .env
chmod 600 .env
openssl rand -base64 48            # 填进 SESSION_SECRET

# 3) （可选但推荐）Docker 数据放到 /root
install -m 644 daemon.json /etc/docker/daemon.json && systemctl restart docker

# 4) 一次把四个角色拉起来
docker compose up -d --build
docker compose ps                  # migrate 应 Exited(0)，其余 healthy/running

# 5) 验收
curl -fsS http://127.0.0.1/api/health
curl -fsSI http://127.0.0.1/ | head -1
```

数据目录属主与容器内 UID 必须一致（否则容器里的 `dsh` 用户写不进库）：

```bash
mkdir -p /root/dsh-plugin-review/data
chown -R 10001:10001 /root/dsh-plugin-review/data
# 宿主目录属主若是别的号（例如已有数据属于 989:989），改用覆盖：
#   DSH_REVIEW_UID=989 DSH_REVIEW_GID=989 docker compose up -d
```

## 5. 真实 IP 透传（怎么工作、怎么验证、什么时候不成立）

**链路**：`客户端 → nginx(80/443) → web(3000，容器网络内，不发布端口)`

nginx 侧（`nginx/snippets/proxy-common.conf`）：

```nginx
proxy_set_header X-Real-IP $remote_addr;          # 权威：nginx 用对端地址覆盖
proxy_set_header X-Forwarded-For $remote_addr;    # 刻意覆盖，而非 $proxy_add_x_forwarded_for 追加
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header X-Forwarded-Host  $host;
proxy_set_header X-Forwarded-Port  $server_port;
proxy_set_header Host $host;
proxy_set_header X-Request-Id $http_x_request_id; # 与应用日志关联
```

**为什么是"覆盖"而不是"追加"**：追加会把客户端自己写的 `X-Forwarded-For` 保留在最左侧，
应用若取最左值当客户端地址，等于让访客自己决定日志与风控依据。本部署里 nginx 是唯一入口，
覆盖后该头只有一个值且不可伪造。

**应用侧**（`src/server/platform/client-ip.mjs` + `server.mjs`）：

- 只有 `DSH_REVIEW_TRUST_PROXY=1` 时才读 `X-Real-IP`（其次 `X-Forwarded-For` 最左值）；
  默认只用 TCP 对端地址（内核给的，不可伪造）。compose 里 web 已设为 `1`。
- 解析结果写进访问日志的 `client_ip`，并归一化 `::ffff:127.0.0.1` → `127.0.0.1`。
- 启动日志会打一行 `trust_proxy_enabled`，提醒"开了这个就不能把端口直接暴露给公网"。

**怎么验证**（这是透传是否真的生效的判据）：

```bash
docker compose logs --tail=20 web | grep http_request      # 看 client_ip
# 未开 TRUST_PROXY：client_ip 是 nginx 的容器地址（172.x），不是访客地址
# 开了 TRUST_PROXY：client_ip 是真实访客地址（外网访问时应等于你的出口 IP）
```

**什么时候不成立**：

- 把 web 端口发布到公网（`ports:` 里加了 `3000:3000`）→ 必须同时把 `DSH_REVIEW_TRUST_PROXY` 改成 `0`；
- 前面再加 CDN / 负载均衡 → 改成 `set_real_ip_from <网段>` + `real_ip_header X-Forwarded-For`
  + 追加语义，并让应用信任"最右侧的非代理地址"。原样覆盖 + CDN 会把 CDN 的地址当成访客地址。

## 6. 日常操作

```bash
cd /root/dsh-plugin-review/repo/docker

docker compose ps                      # 状态（含健康）
docker compose logs -f web             # 访问日志（每请求一行 JSON，含 client_ip/status/duration_ms）
docker compose logs -f worker          # 任务日志
docker compose exec web sh             # 进容器排查（node/npx 都在）

docker compose up -d --build           # 更新代码后重建
docker compose restart web             # 只重启 web
docker compose run --rm web npx tsx src/server/platform/selfcheck-cli.ts   # 结构自检
docker compose run --rm web node scripts/set-super-admin.mjs --list      # 看超级管理员绑定与用户
```

**备份**（只需一个目录）：

```bash
sqlite3 /root/dsh-plugin-review/data/app.sqlite ".backup '/root/dsh-plugin-review/backup-$(date +%F).sqlite'"
tar -C /root/dsh-plugin-review -czf backup-media-$(date +%F).tar.gz data/media
```

**回滚**：`git checkout <旧提交> && docker compose up -d --build`。
注意迁移是**向前**的：库结构升上去之后，回滚代码不会自动降结构（多出来的表/列无害）。

## 7. 安全边界

- 容器内非 root（10001）、每个服务 `no-new-privileges`、日志有大小上限（不会涨满磁盘）。
- `docker/.env` 只挂给需要的服务（`env_file`），**绝不烘进镜像**；`.dockerignore` 排除了 `.env*`。
- nginx **拒绝** `/api/testing/session`（应用里也有一道：非 1 或生产环境一律 404）。
- `/media/` 只反代、加 `Cache-Control: private, no-store`，**不允许**改成 `alias`/`root` 直读磁盘。
- 健康检查详情（`?detail=1`）需 `x-health-token`，未配 `DSH_REVIEW_HEALTH_TOKEN` 时不下发。
- 未上 TLS 前，会话 Cookie 靠 `DSH_REVIEW_INSECURE_COOKIES=1` 降级（**明文过网**）；
  上了 HTTPS 必须删掉这一行，否则等于长期用不安全 Cookie。

### TLS（2026-10-18 已在 review.lingshulab.com 落地，按这个顺序做）

> 现在的 `nginx/conf.d/default.conf` **已经启用了 443 并把 80 改成 301 跳转**。
> 也就是说：**证书不在位时 nginx 起不来**（`cannot load certificate`）。这是刻意的 ——
> 入口起不来，比悄悄退化成明文 HTTP 好查（会话 Cookie 带 `Secure`，明文下浏览器直接丢弃，
> 表现是"登录接口 200，下一次请求又变匿名"）。

1. **签证书**（宿主机；nginx 占着 80，所以先停它）：
   ```bash
   apt-get install -y certbot
   cd /root/dsh-plugin-review/repo/docker && docker compose stop nginx
   certbot certonly --standalone -d review.lingshulab.com \
     --register-unsafely-without-email --agree-tos --non-interactive
   ```
2. **把证书放进挂载目录**（compose 只挂这一个目录，私钥不进镜像、不进 git）：
   ```bash
   mkdir -p /root/dsh-plugin-review/certs
   cp /etc/letsencrypt/live/review.lingshulab.com/{fullchain,privkey}.pem /root/dsh-plugin-review/certs/
   chmod 644 /root/dsh-plugin-review/certs/fullchain.pem
   chmod 600 /root/dsh-plugin-review/certs/privkey.pem
   ```
3. **续期自动搬运**（certbot 的定时器只续期，不会帮你复制进挂载目录）：
   在 `/etc/letsencrypt/renewal-hooks/deploy/dsh-review-nginx.sh` 里复制两个文件并
   `docker compose exec -T nginx nginx -s reload`（仓库 `deploy/` 下有同内容脚本）。
4. **应用侧同步改三处**（缺一处就会"能开首页、登录却失败"）：
   `docker/.env` 的 `GITHUB_REDIRECT_URI` / `SITE_ORIGIN` 换成 `https://<域名>/…`；
   GitHub OAuth App 的 **Authorization callback URL** 换成 `https://<域名>/api/auth/github/callback`；
   nginx 的 `server_name` 与 80 的跳转地址换成同一个域名。
5. **验证**：
   ```bash
   curl -sI https://review.lingshulab.com/ | head -1      # 200
   curl -sI http://review.lingshulab.com/ | head -1       # 301
   echo | openssl s_client -connect review.lingshulab.com:443 -servername review.lingshulab.com 2>/dev/null | grep 'Verify return code'
   docker compose logs --tail=20 web | grep http_request   # client_ip 应是真实访客地址
   ```
   最后真点一次登录，确认 `__Host-dsh_session` 落下、`/onboarding` 可达。

> ⚠️ 明文部署时用来降级的 `DSH_REVIEW_INSECURE_COOKIES=1`（见 §7）**上了 HTTPS 必须删掉**，
> 否则等于长期用不安全 Cookie。当前线上没有这一行。

### 已知故障：重建 web 之后全站 502（已修）

`docker compose up -d web`（例如换 `.env` 里的凭据）会**重建容器 → 换一个新 IP**。
nginx 默认只在启动时解析 `upstream` 里的 `web` 域名，之后一直往旧 IP 发请求：

* 现象：全站 **502**，但 `docker compose ps` 里 web 显示 `healthy`、容器内 `curl 127.0.0.1:3000/api/health` 也正常；
* 旧做法：每次重建 web 都得顺手 `docker compose restart nginx`（容易忘，忘了就是线上挂着）；
* 现做法：`nginx.conf` 里显式 `resolver 127.0.0.11 valid=10s ipv6=off;`，
  `upstream dsh_web { zone dsh_web 64k; server web:3000 resolve; }` —— nginx 按 Docker 内置 DNS
  定期重解析，**重建 web 不再需要动 nginx**（2026-10-18 实测：`--force-recreate web` 后直接 200）。
### 可选加固（未默认开启，避免在未实测环境里引入启动失败）

- nginx 容器 `read_only: true` + `tmpfs: [/var/cache/nginx, /var/run]`；
- 给每个服务加 `deploy.resources.limits`（内存/CPU）；
- 把 `nginx:stable-alpine` 固定到 `@sha256:…` 摘要，令构建完全可复现。

## 8. 本次未能验证的部分（如实说明）

做这套配置的环境里 **没有 docker / podman / nginx**（`docker --version` 不可用），所以：

- **没有**实际执行过 `docker compose build` / `up`，**没有**跑过 `nginx -t`；
- 已做的静态核对：`server.mjs` 与 `client-ip.mjs` 过 `node --check`；
  `package-lock.json` 与 `package.json` 完全同步（`npm ci --include=dev` 不会因依赖不一致失败）；
  nginx 配置里引用的 `$connection_upgrade` 等未定义变量、以及 `add_header` 覆盖安全头的坑已修掉；
- 首次上线请按 §4 的命令逐步执行，先看 `docker compose ps` 与 `/healthz`、`/api/health`，
  再切生产端口。若 `nginx -t` 报错，优先检查 `docker/nginx/` 下的 `include` 路径。