# HANDOFF · 交接说明

> 最后更新：2026-10-18（线上按 docker compose 重建，见 §12）。这份文档描述**当前真实状态**：能跑什么、验过什么、没做什么。
> 配套文档：[`API端点与路径.md`](./API端点与路径.md)（接口清单）、[`docker约定.md`](./docker约定.md)（容器部署）。

## 1. 这是什么，现在什么状态

**DSH 插件测评站**：收录 DSH 插件、写/审/发评测、评论讨论的站内应用。
一条垂直薄片已经打通：**登录 → 收录插件 → 写评测 → 人工审核 → 发布 → 评论 → 通知**，
外加后台管理（待办审核、用户、配置、自动发现）、媒体（原图/展示图）、任务队列与 worker 自动发现。

| 项 | 现状 |
|---|---|
| 技术栈 | Next.js 16（App Router）+ React 19 + better-sqlite3（SQLite/WAL）+ TypeScript 7 |
| 运行形态 | 本地 `next dev`；生产 **Docker 四个角色**（migrate / web / worker / nginx 反代） |
| 代码规模 | 前端 42 文件、后端 80 文件、worker 4 文件、公共 7 文件、测试 29 文件 |
| 测试 | **30 文件 / 519 条全绿**（`npm test`） |
| 类型检查 | `pnpm typecheck` 通过，且开着 `noUnusedLocals` / `noUnusedParameters` |
| 迁移 | 到 `0009_review_verdict.sql`（编号执行、事务内、外键校验） |
| 已知线上 | **https://review.lingshulab.com**（Let’s Encrypt 证书，80 只做 301 跳转）。2026-10-18 跑 Docker 四角色（migrate / web / worker / nginx），数据在宿主 `/root/dsh-plugin-review/data`。⚠️ 该机 2026-10-17 被重装：**旧库、旧 `.env`、旧部署目录全部丢失**，现网从空库重建（见 §12） |
| 未上 | 备份（每日 03:00 恢复点）、只读 `GITHUB_TOKEN`、favicon 与错误页之类的细节 |

## 2. 关键路径

```
src/app/            页面与 API（App Router；29 个 route.ts）
src/components/     客户端组件（UI 全部走 globals.css，组件里不写硬编码颜色）
src/app/globals.css 全站视觉层：M3 令牌 → 基础 → 组件 → 手机端
src/server/packages 后端：platform（库/事务/日志/限流/媒体/健康检查）· modules（领域）· workflows
src/worker/         任务队列消费、自动发现排程、内容筛查
migrations/         带编号的 SQL 迁移
scripts/            验收脚本与运维小工具（自检、授权、发现、验收）
tests/              vitest（真实临时库 + 真实迁移，不用 :memory: 冒充）
docker/             容器资产（见 docker约定.md）
```

## 3. 跑起来

### 本地（开发）

```bash
cp .env.example .env.local          # 至少填 SESSION_SECRET（生产必须；本地可空）
pnpm install
pnpm dev                            # http://127.0.0.1:3100
pnpm test                           # 29 文件 / 506 条
pnpm typecheck
pnpm worker                         # 另开一个终端：任务与自动发现
```

本地要跑 HTTP 验收脚本时，需要测试登录通道：`.env.local` 里 `DSH_REVIEW_ALLOW_TEST_LOGIN=1`
（`next dev` 会强制 `NODE_ENV=development`，所以 `NODE_ENV=test` 那套判断拿不到值——这是踩过的坑）。

### 容器（部署）

见 [`docker约定.md`](./docker约定.md)。一句话：`cd docker && cp .env.example .env && docker compose up -d --build`，
对外只有 nginx（80/443），web/worker 在容器网络内。

### 常用运维

```bash
pnpm db:check                                        # 结构自检（表/索引/外键）
pnpm db:migrate                                      # 跑到最新迁移
node scripts/set-super-admin.mjs --list             # 看部署绑定的超级管理员与现有用户
DSH_ACCEPTANCE_BASE=http://127.0.0.1:3100 node scripts/acceptance-http.mjs
DSH_ACCEPTANCE_BASE=http://127.0.0.1:3100 node scripts/acceptance-catalog-browse.mjs
```

## 4. 已实现（按域，简表）

| 域 | 已做 |
|---|---|
| 身份 | GitHub OAuth（PKCE S256 + state + 浏览器绑定、一次性消费、return_path 限站内）、会话 Cookie、首个管理员引导、测试登录通道（双闸门）；**管理员分两级**：超级管理员（由 `SUPER_ADMIN_GITHUB_ID` 部署绑定、唯一、站内不可剥夺）与普通管理员（只能由超级管理员授予/撤销，且需手打对方昵称确认） |
| 目录 | 收录检查（仓库可访问 **且** `dsh.bundle` **且** 配置文件存在）、按 (仓库, 路径) 幂等、`request_key` 去重、搜索/用途标签/是否有评测/排序/分页 |
| 评测 | 草稿（乐观并发 `saveVersion`）、提交 → 规则校验 → 内容筛查 → 人工审核 → 发布、修订快照不可改写、撤回、公开性判定单一真相 |
| 评论 | 顶层讨论组 + 回复、盖楼规则、可见性跟随内容、作者可改可删、频控（5 次/分/用户，合并计数） |
| 媒体 | 按真实字节鉴定类型、单张 ≤10MB、展示图（限长边、不放大）、原图仅本人可读、撤回后立刻不可读 |
| 通知 | 站内通知 + 未读数 + 标记已读 |
| 后台 | 待办审核（批准/要求修改，带 `stateVersion` 防覆盖）、用户角色与禁用、业务配置、自动发现手动触发 |
| 任务 | 执行权 CAS（token + running + 租约未过期）、重试周期、回收超期租约、按天幂等排程 |
| 可观测 | 结构化日志（含 `request_id`、真实 `client_ip`）、每请求一行访问日志、启动自检、worker 心跳、`/api/health`（可选含 worker） |
| 前端 | Material Design 3 设计体系（颜色/形状/动效/排版令牌）、桌面 + 手机两套版式、手机端侧边抽屉与底部导航、评测文章页（头图+标题融合、修订时间线、评论） |

## 5. 怎么验证"真的做完了"

本项目的验收纪律（这是从旧文档里保留下来的部分）：

1. **自己跑一遍，不信汇报里的数字**：`pnpm test` 的实际条数要跟文档一致。
2. **抽查最高风险声明**（挑"错了最致命"的那条，去**源码**里看，不只看测试）。例：
   - 明文凭证不入库 → 读 `identity/service.ts`：`newOpaqueToken()` → `digestText()`，查询按摘要进行；
   - 按 (仓库, 路径) 幂等 → 读 `catalog/service.ts`：先查后插。
3. **变异验证（anti-tautology）**：故意破坏一处实现，确认对应用例变红，再还原、复跑确认变绿。
   已固化为 `scripts/verify-tests-bite.mjs`（还有一组 `verify-*-bite.mjs`）。
   ⚠️ 教训：**破坏性实验的还原要逐条回读验证**，不能信 exit code（曾有还原静默失败、破坏代码留在文件里）。
4. **扫残留**：全仓找 `&& false`、`.bak`、`*mutation*`、临时破坏注释。
5. **不装作成功**：未做的功能不回 200、不给假数据；未验证的事在文档里写明"未验证"（见 `docker约定.md` §8）。

最近一次（2026-10-17）的实测结果：

| 检查 | 结果 |
|---|---|
| `pnpm test` | 29 文件 / **506 条通过** |
| `pnpm typecheck` | 通过（含未使用声明检查） |
| HTTP 验收 | **16/16** |
| 目录浏览验收 | **10/10** |
| 生产构建 | 在隔离目录 `next build`（webpack）通过，路由清单与开发一致 |
| 页面视觉 | 13 类页面 × 5 档宽度共 65 组布局/样式快照逐项一致；截图仅"上次登录时间"这类真实数据差异 |
| 动效 | 入场/一次性摘类/按压涟漪/减少动效四项行为符合预期 |

## 6. 已知缺口（**没做**的，别误以为有）

| 缺口 | 说明 |
|---|---|
| 全文检索 | 现在只有 `LIKE` 搜索（已做通配符转义）。规划里的 FTS5 未做 |
| 收藏 / 有用投票 | 连表都没有 |
| 整合包（packs）/ 批量导入投稿 | 连表都没有；`/packs` 不存在 |
| 备份恢复界面 | 只能用命令行备份（见 `docker约定.md` §6） |
| 媒体多尺寸 | 只有 `original` + `display` 两个变体 |
| 真实内容审核 | `basic` 是本地确定性词表，**仅演示**；生产必须换真实供应商 |
| 后台剩余组 | 站点设置还有项未接进后台（部分参数仍写在代码常量里） |
| TLS | 未配置；相关降级项必须在上 HTTPS 后删除 |
| worker 编译产物 | worker 直接跑 TS（`tsx`），所以镜像含着 devDependencies（约 1.3GB）。要瘦身得先给它做编译产物 |
| 审计/风控 | 频控按用户计，**不按 IP**；`client_ip` 只进日志，未参与任何判定 |

## 7. 几条不改的规矩（改之前先看理由）

- **组件里不出现硬编码颜色**：一律 `var(--…)`，换肤只改 `globals.css`。
- **正文必须过 `rehype-sanitize`**：用户输入永不直接进 HTML（`markdown.ts`）。
- **可见性只有一个真相**：`resolveVisibilityInTx`（撤回/隐藏/未发布都在那里判定）。
- **错误码与状态码稳定**，中文文案可改；前端按 `code` 分支，不匹配文案。
- **迁移是向前、编号、事务内**；不写"先收录再说"这类宽松路径。
- **未配置外部依赖时明确报错，不伪装可用**（GitHub 登录、内容筛查都是这个口径）。
- **dev 的日志/临时文件不要放项目目录内**：Next dev 的文件监视会把它们当成代码变更，
  触发整页重载死循环（现象是页面一直闪、导航停在"正在读取登录状态…"，详见 §14）。
  本地起服务用 `bash scripts/dev-8080.sh`：它默认写项目外，并会拒绝落在项目内的路径。

## 8. 关于旧文档

主人的要求是清空 `docs/`，现在这里只剩三份：本文、`API端点与路径.md`、`docker约定.md`。

- 旧的设计稿（《架构设计》《模块签名契约》《并行工作包》《切片说明》《验收纪律》《部署-README》等）
  **已删除**，需要时用 git 历史找回：`git log --diff-filter=D --name-only -- docs` 或
  `git show <删除前的提交>:docs/架构设计.md`。
- 源码注释里仍会看到 `架构第 N 节`、`docs/…` 这类**历史引用**，它们指向的就是上面那些已删除的设计稿；
  正文的"为什么"都写在代码注释里，不依赖那些文档才能读懂。
---

## 12. 2026-10-18：线上按 docker compose 重建（含当日 4 个修复）

### 12.1 发生了什么

这台 VPS 在 **2026-10-17 07:46 被重装过**（`/` 的时间戳、`/srv` 为空、无 `dsh-review-*` systemd
单元、无容器无镜像、磁盘只用 1.4G）。判断依据是实测：`/srv/dsh-plugin-review` 不存在、
`find / -name app.sqlite` 只找到当天新建的那个。

**因此：旧的数据库（17 个插件、评测、评论、用户）、旧 `.env`（OAuth/SESSION_SECRET）全部丢失。**
现网是**从空库重新建的**。若 VPS 服务商有 10-17 之前的快照，可以按 §12.4 的步骤把旧库接回来。

### 12.2 当天修的四个缺陷（都已入库）

| # | 缺陷 | 症状 | 修法 |
|---|---|---|---|
| 1 | `scripts/acceptance-http-write.mjs` 提交不带判定 | PR#4 合入后 `input_invalid`，随后 `:152` TypeError，后面十几条检查全跑不到 | 提交体补 `verdict: 'undetermined'` |
| 2 | `scripts/seed-demo.mjs` 同上 | 演示数据造不出来 | 补 `verdict: 'helpful'` + 一条 `evidenceRefs` |
| 3 | `docker/daemon.json` 带 `_comment` 键 | `dockerd` **起不来**：`directives don't match any configuration option: _comment` | 改成纯配置；说明移进 `docs/docker约定.md` 并加警告 |
| 4 | `docker/web.Dockerfile` 的 builder 没 COPY `server.mjs` | 镜像构建必失败：`"/app/server.mjs": not found`（只有 nginx 镜像能成） | builder 补 `COPY server.mjs ./` |

> 3、4 是"照着 `docker约定.md` 与 `compose.yaml` 走一遍就必然撞到"的问题 —— **容器化这套此前从未真正构建过**。

### 12.3 当前线上形态

```
/root/dsh-plugin-review/
├─ repo/            ← git archive 上传解包（不是 git clone；私库不便在服务器留凭据）
│  └─ docker/.env   ← 600，含 SESSION_SECRET（新生成）/ OAuth / BOOTSTRAP_ADMIN_GITHUB_ID
├─ data/            ← app.sqlite + media（属主 10001:10001）
└─ certs/           ← 空（TLS 未配）
```

* 容器：`migrate`（Exited 0）/ `web`（healthy）/ `worker`（healthy）/ `nginx`（healthy，80+443 已发布）
* 库结构：`0009_review_verdict.sql`；`selfcheck` → `missingTables: []`、`problems: []`
* TLS：`https://review.lingshulab.com`（Let’s Encrypt，2027-01-16 到期，`certbot.timer` 自动续期；
  续期后由 `/etc/letsencrypt/renewal-hooks/deploy/dsh-review-nginx.sh` 把证书搬进
  `/root/dsh-plugin-review/certs` 并 reload nginx）。80 全量 301 到 HTTPS。
* 部署参数：`DSH_REVIEW_ALLOW_TEST_LOGIN=0`（**公网必须关**）、`DSH_REVIEW_CONTENT_SCREEN=basic`、
  `DSH_REVIEW_TRUST_PROXY=1`（compose 里给 web）、无 `GITHUB_TOKEN`（未决，见 §12.5）
* 首轮自动发现：worker 启动即排当天任务，`searched_repos=60 plugins_found=4 accepted=4`，
  因**未认证 60 次/小时**而上限收尾（`requests_used=58`）

### 12.4 如果要接回旧库

1. 从服务商快照/备份取回旧 `app.sqlite`（旧结构是 `0008`）；
2. 停 `web`/`worker`：`docker compose stop web worker`；
3. 覆盖 `/root/dsh-plugin-review/data/app.sqlite`（连带删掉 `-wal`/`-shm`），`chown 10001:10001`；
4. `docker compose run --rm migrate`（会把 0008 → 0009 补齐并自检）；
5. `docker compose up -d`，核对 `/api/health` 的 `schema_version` 与站内数据。

### 12.5 待主人做的两件事

1. **GitHub OAuth 回调（唯一还挡着登录的一步，只能在 GitHub 后台改）**：
   站点发出的 `redirect_uri` 已经是 `https://review.lingshulab.com/api/auth/github/callback`
   （Client ID `Ov23liMF9kujrLNxhBZ3`，App 名 `dsh-plugin-review-dev`）。
   请到 GitHub → Settings → Developer settings → OAuth Apps → 该 App，把
   **Authorization callback URL** 改成这个地址（Homepage URL 建议同步改成 `https://review.lingshulab.com`）。
   改完直接点站点右上角「登录」即可。
2. **超级管理员**：`SUPER_ADMIN_GITHUB_ID` 填部署者的 GitHub **数字 ID** 即可 ——
   该身份首次登录会被自动提升为管理员，之后**只有他**能授予/撤销管理员（要手打对方昵称确认）。
   他的权限站内不可剥夺、不可转移；换人只能改这一行 + 重启。
   （`BOOTSTRAP_ADMIN_GITHUB_ID` 仍保留，但只是"一个管理员都没有"时的一次性引导。）
3. （可选）加只读 `GITHUB_TOKEN`：单轮发现从约 4 个提到约 30 个候选、请求预算 58 → 400。

---

## 13. 2026-10-18（第三轮）：备份恢复点 + 首次填充插件库

### 13.1 备份（`参数与管理规则.md §81`，此前"一份备份都没有"）

* `scripts/backup.mjs`：SQLite **在线热备**（`db.backup()`；WAL 下 `cp` 会漏未 checkpoint 的事务）
  + 媒体打包 + `manifest.json`（schema / 各表行数 / integrity / sha256 / 耗时），**生成后当场自检**，
  不合格退出码非 0；保留最近 14 份。
* `scripts/restore-backup.mjs`：**先验后写** —— sha256 不符 / 副本完整性不过 → 拒绝；
  写回前把现库改名 `app.sqlite.before-restore-<ts>`（不删）；媒体需显式 `--media`。
* 落点：`/root/dsh-plugin-review/backups/`（**与数据目录分开挂载**，数据出问题时备份还在）。
* 定时：`dsh-review-backup.timer`（`OnCalendar=03:00` + `Persistent=true` + 5min 随机偏移），
  执行 `docker compose run --rm --no-deps web node scripts/backup.mjs --label auto --keep 14`。
* 手动：后台「存储与备份」组 → 「立即备份」（`POST /api/admin/backups`，与定时同一脚本）。
* 演练：`tests/backup.test.ts` 6 条（真跑脚本）—— 清单与行数一致、篡改一个字节被 sha256 拒绝、
  未加 `--force` 不覆盖、保留策略、库缺失时明确失败；线上首次手动备份实测
  `592 KB / integrity ok / users=13 plugins=9`。
* ⚠️ 同机备份**不防整机丢失**；异地副本仍要自己定期拉走（见 `docs/备份与恢复.md` §6）。

### 13.2 首次填充插件库

* 现状：9 → **21** 个插件（一轮 `dsh plugin in:description` 捞出 12 个，单轮只花 26 次核心请求）。
* 机制：`dsh-review-discovery-drip.timer` 每 **40 分钟**排一轮，轮换 5 个搜索词
  （`topic:dsh-plugin` / `dsh-plugin in:name` / `topic:deepseek-harness` / `dsh plugin in:description` / `topic:dsh`）。
  40 分钟节拍 ≈ 39 次核心请求/小时，安全压在未认证的 60/h 之下。
* 只**排任务**，探测与收录仍由常驻 worker 执行（与每日定时同一条路径）。填满后：
  `systemctl disable --now dsh-review-discovery-drip.timer`。
* 未认证上限仍在：如果加一个只读 `GITHUB_TOKEN`，可以一次性批量跑完（无需等 40 分钟节拍）。
* 实测：第二轮 `topic:deepseek-harness` 因配额被第一轮吃满而 `HTTP 403` —— 处理器把它判为
  **限流**并保留已收录结果（不是失败、也不会清空数据）。

### 13.3 当日踩坑：`.gitignore` 的 `backups/` 把接口目录一起忽略了

加备份功能时在 `.gitignore` 写了 `backups/`（想忽略备份产物），没带前导斜杠 ——
gitignore 的目录规则匹配**任意层级**，于是 `src/app/api/admin/backups/route.ts` 被静默忽略：
本地 typecheck / build 全过（文件在磁盘上），提交里却没有它，部署后 `/api/admin/backups` 直接 **404**。

修法：改成 `/backups/`（只忽略仓库根那一个），并在 `.gitignore` 里留注释说明。
教训：`git status` 里**没看到**新文件时别默认"忘了 add"，先 `git check-ignore -v <path>` 问一句。

---

## 14. 2026-10-19：dev 日志写在项目内 → 整页重载死循环（页面一直闪）

### 14.1 现象

页面卡在「正在读取登录状态…」并且不停闪。**服务端一切正常**：接口全 200、日志没有任何报错、
`/_next/*` 资源也能取到 —— 从服务端自检完全看不出问题。

### 14.2 根因

本地 dev 服务的 stdout/stderr 被重定向到了**项目目录内**的 `.data/server-8080.log`。
Next dev（Turbopack）监视项目文件，于是形成自激循环：

> 请求进来 → 访问日志多一行 → 监视器判定"文件变了" → 重新编译（`✓ Compiled in 1ms`）
> → **整页重载** → 浏览器又发一个请求 → 日志又多一行 → ……

周期约 1~2 秒，表现就是"一直闪"。

### 14.3 实测证据

| 日志位置 | 完全空闲时的观察 |
|---|---|
| 项目内 `.data/server-8080.log` | 8 秒新增 **76 行**（`GET /` + `/api/session` + `Compiled` 反复出现） |
| 项目外 `/root/dsh-review-dev-8080.log` | 20 秒新增 **0 行** |

中途重启过一次 dev（日志仍在项目内），循环照旧 —— 差异在**日志位置**，不是"重启治百病"。
注意 `.data/` 虽然被 gitignore，**仍然会触发监视**。

### 14.4 规矩

1. dev 的日志、临时文件、探针文件**一律放项目外**。
2. 本地起服务用 `bash scripts/dev-8080.sh`：默认写 `/root/dsh-review-dev-8080.log`，
   并且**拒绝**日志路径落在项目内的配置（把这条教训写进了脚本里）。
3. 判据：**在完全空闲的窗口里，dev 日志还在长，就说明有东西在自激**。
4. 这类问题**只在浏览器侧显现**，服务端接口永远是 200；排查顺序是先看"无人操作却持续增长的
   请求/编译"，再看浏览器 Console。