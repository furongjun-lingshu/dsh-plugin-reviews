# API 端点与路径

> 本文是**唯一的**接口与路由清单：改接口时同步改这里。
> 最后核对：2026-10-17，对着 `src/app/**/route.ts` 逐条核过（共 29 个路由文件）。

## 1. 通用约定

### 1.1 响应信封

```
成功  { "ok": true,  "data": <载荷>, "request_id": "<uuid>" }
失败  { "ok": false, "error": { "code": "…", "message": "…", "fields": […], "context": {…} },
        "request_id": "<uuid>" }
```

- **结果由 HTTP 状态码表达**，body 里的 `ok` 只是给前端分支用的。
- `message` 是可直接展示的中文，**不含堆栈、SQL、凭据或第三方原始响应**。
- `fields` 用稳定字段路径（`title`、`plugin_version`、`items[2].plugin_version`）。
- 前端按 `code` 处理流程，**不靠匹配中文文案判断**，所以文案可改、`code` 与状态码不可随手改。
- `request_id` 只用于日志关联：**不能**当幂等键（幂等键是请求体里的 `requestKey`），
  也不参与业务审计去重（那是 `operation_key`）。

### 1.2 请求头

| 头 | 方向 | 用途 |
|---|---|---|
| `x-request-id` | 入站（可选）/ 出站 | 日志关联。缺省时服务端生成，并在响应头回写同值 |
| `x-health-token` | 入站 | 仅 `/api/health?detail=1`；须等于 `DSH_REVIEW_HEALTH_TOKEN`（≥16 位），未配置则详情一律不下发 |
| `x-real-ip` / `x-forwarded-for` | 入站 | **仅在 `DSH_REVIEW_TRUST_PROXY=1` 时被信任**，用于访问日志的 `client_ip`。头可伪造，故默认不信任 |
| `cookie` | 双向 | 会话凭据。生产环境用 `__Host-` 前缀 + `Secure`（必须 HTTPS），见第 5 节 |

### 1.3 错误码与状态码

| code | HTTP | 什么时候出现 |
|---|---|---|
| `input_invalid` | 400 | 字段类型/必填/格式不合法（配 `fields` 指明哪一项） |
| `unauthenticated` | 401 | 未登录或会话失效 |
| `forbidden` | 403 | 已登录但权限不足（**不**清会话、**不**引导重新登录） |
| `account_disabled` | 403 | 账户被禁用：不阻止匿名浏览，但阻止登录与写入 |
| `version_conflict` | 409 | 草稿 `save_version`、提交 `state_version`、可见性控制版本冲突 |
| `target_unavailable` | 404 | 不存在、未发布、已撤回、已隐藏。**对无权获知的私有对象同样返回**，不泄露其存在 |
| `rate_limited` | 429 | 超限，`context.retry_after_seconds` 给到秒级等待 |
| `request_key_reused` | 409 | 同一 `requestKey` 对应了不同内容 |
| `provider_not_configured` | 503 | 外部依赖未配置（GitHub OAuth / 内容筛查）。**不伪装可用** |
| `provider_unavailable` | 503 | 外部依赖故障（超时/限流/网络） |
| `internal` | 500 | 未登记异常。堆栈只进服务端日志 |

### 1.4 分页

- `page` 从 **1** 开始；`page_size` 只允许 **10 / 20 / 50**，默认 **20**（`PaginationDefaults`）。
- 结果形状：`{ items, page, page_size, total, total_pages, has_previous, has_next }`。
- 非法取值 → 400 `input_invalid`（不是"返回空列表"）。

### 1.5 频控（按**服务端确认的用户**计，前端传什么都不影响）

| 动作 | 额度 | 覆盖的写入 |
|---|---|---|
| `comment_change` | 5 次/分/用户 | 新评论、回复、评论正文修改（**合并计数**） |
| `plugin_submission` | 10 次/时/用户 | 指定插件的收录检查 |

- 超限 → 429 + `retry_after_seconds`。
- **幂等重放不另算一次**（同 `requestKey` 返回原结果时额度会退还）；操作抛错也退还。
- 计数存在 SQLite 里，换标签页/刷新/改前端都无法绕过。

### 1.6 鉴权级别（下文表格用这套叫法）

| 叫法 | 含义 |
|---|---|
| 公开 | 匿名可访问（仍受可见性约束） |
| 登录 | 需要有效会话；写操作还要求账户非禁用（401 / 403） |
| 管理员 | 登录且 `role = admin`，否则 403 `forbidden` |
| 作者 | 资源所有者（如撤回自己的评测） |

## 2. 页面路径

| 路径 | 页面 |
|---|---|
| `/` | 首页（搜索入口、最新评测、近期更新插件） |
| `/plugins` | 插件目录（搜索 / 用途分类 / 是否有评测 / 排序 / 分页） |
| `/plugins/new` | 提交插件 |
| `/plugins/{pluginId}` | 插件详情 |
| `/reviews` | 评测列表 |
| `/reviews/{reviewId}` | 评测文章（修订历史 + 评论） |
| `/me` | 我的（草稿、评测、通知入口） |
| `/me/drafts/{draftId}` | 草稿编辑 |
| `/me/notifications` | 通知 |
| `/me/settings` | 个人设置（昵称、账户信息） |
| `/onboarding` | 新用户资料确认（GitHub 首次登录的回跳目标） |
| `/admin` | 后台（待办审核、用户、配置、自动发现） |
| `/error`、`/global-error`、`/_not-found` | 统一错误页 / 404 |

> 手机端（≤900px）在顶栏显示菜单图标 + 右侧抽屉，底部导航只保留「插件」「评测」。

## 3. API 端点

### 3.1 会话与登录

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/api/session` | 公开 | 会话状态：`authenticated` / `nickname` / `role` / `accountStatus` / `isSuperAdmin` / `superAdminConfigured` / `githubLoginConfigured` / `testLoginEnabled`（+`testSuperAdminIdentity`，仅开发通道打开时下发） |
| DELETE | `/api/session` | 登录 | 退出登录（清会话 Cookie）。**不接受请求体身份**：早期那条 HTTP 登录旁路已删除 |
| GET | `/api/auth/github/start` | 公开 | 发起 GitHub 登录（PKCE S256 + state；未配置凭据时明确报 503，不伪装可用） |
| GET | `/api/auth/github/callback` | 公开 | 登录回调；新用户 302 到 `/onboarding?returnTo=…` |
| POST | `/api/testing/session` | 测试通道 | **仅 `DSH_REVIEW_ALLOW_TEST_LOGIN=1` 且非生产**时可用，否则 404。nginx 侧另有 `deny all` |

### 3.2 插件目录

| 方法 | 路径 | 鉴权 | 频控 | 说明 |
|---|---|---|---|---|
| GET | `/api/plugins` | 公开 | — | 目录查询：`q` / `tag` / `has_reviews=all\|yes\|no` / `sort=info\|reviews` / 分页 |
| POST | `/api/plugins` | 登录 | `plugin_submission` | 提交 GitHub 仓库链接做收录检查（核验失败即拒绝，不"先收录再说"） |
| GET | `/api/plugins/{pluginId}` | 公开 | — | 插件详情（含 `listingNote`：收录 ≠ 已实测可用） |

### 3.3 评测

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/api/reviews` | 公开 | 公开评测列表（分页） |
| GET | `/api/reviews/{reviewId}` | 公开 | 公开评测详情（正文取自当前公开修订） |
| GET | `/api/reviews/{reviewId}/revisions` | 登录 | 修订历史。**只有作者与管理员**的响应里含标题/正文（`canReadBodies`） |
| POST | `/api/reviews/{reviewId}/withdraw` | 作者 | 撤回评测（幂等：同 `requestKey` 重放返回原结果） |

### 3.4 草稿与附件

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| POST | `/api/drafts` | 登录 | 建草稿 |
| PUT | `/api/drafts` | 登录 | 全量保存（带 `saveVersion` 做乐观并发） |
| PATCH | `/api/drafts` | 登录 | 局部保存（自动保存用） |
| GET | `/api/drafts` | 登录 | 读草稿 |
| POST | `/api/drafts/{draftId}/attachments` | 登录 | 登记附件（拿 ID 与上传目标） |
| PUT | `/api/attachments/{attachmentId}/file` | 登录 | 上传字节（单张上限 10MB；**按真实字节鉴定类型**，不看扩展名） |
| GET | `/api/attachments/{attachmentId}` | 登录 | 附件状态（`pending` / `ready` / `failed`） |

### 3.5 媒体

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/media/{attachmentId}/{variantKey}` | 按可见性 | `variantKey` 取 `display`（展示图）或 `original`（原图）。**`original` 只有本人可读**；公开引用失效（撤回）后立刻不可读，不靠缓存绕过 |

> 反代侧只做转发、**禁止中间缓存**：可见性由应用按会话判定，nginx 直读磁盘等于把私有图全公开。

### 3.6 评论

| 方法 | 路径 | 鉴权 | 频控 | 说明 |
|---|---|---|---|---|
| GET | `/api/content/{contentId}/comments` | 公开 | — | 顶层讨论组分页；目标不公开时 404 |
| POST | `/api/content/{contentId}/comments` | 登录 | `comment_change` | 新评论或回复（`replyToCommentId` 区分） |
| PUT | `/api/content/{contentId}/comments/{commentId}` | 作者 | `comment_change` | 修改自己的评论 |
| DELETE | `/api/content/{contentId}/comments/{commentId}` | 作者 | `comment_change` | 删除自己的评论 |
| GET | `/api/content/{contentId}/comments/{commentId}/replies` | 公开 | — | 组内回复分页。校验"评论属于该内容"，防越权读隐藏内容下的讨论 |

### 3.7 个人

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| PATCH | `/api/me/profile` | 登录 | 保存展示昵称（本站**唯一**公开身份，文章与评论署名都用它） |
| GET | `/api/me/notifications` | 登录 | 通知列表 + `unreadCount` |
| POST | `/api/me/notifications/read` | 登录 | 标记已读 |

### 3.8 后台（全部要求管理员）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/admin/submissions` | 待审提交列表 |
| POST | `/api/admin/submissions/{submissionId}/decisions` | 人工审核决定（批准 / 要求修改），带 `expectedStateVersion` 防并发覆盖 |
| POST | `/api/admin/content/{contentId}/visibility` | 隐藏 / 取消隐藏内容（记原因） |
| GET | `/api/admin/users` | 用户列表（管理员在前） |
| PATCH | `/api/admin/users/{userId}` | 改角色或账户状态（body 里区分）。**改角色（授予/撤销管理员）是超级管理员专属**：非超管 403（`context.guard=super_admin_required`），且必须带 `confirm_target_nickname`（原样重复目标昵称），缺失或不一致 400；**超级管理员本人不可被降级/禁用**（403 `super_admin_immutable`） |
| GET | `/api/admin/settings` | 读业务配置（频控额度、自动发现开关等） |
| PUT | `/api/admin/settings` | 改业务配置（记修改记录） |
| GET | `/api/admin/discovery` | 自动发现状态 |
| POST | `/api/admin/discovery` | 立即同步一轮 |

### 3.9 运维

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/api/health` | 公开 | 存活/就绪检查。见第 4 节 |

## 4. 健康检查契约

```
GET /api/health              公网可见：{ ok, data: { status, checked_at, schema_version } }
GET /api/health?worker=1     把 worker 心跳算进结论（worker 卡死 → 503）
GET /api/health?detail=1     需要 x-health-token = DSH_REVIEW_HEALTH_TOKEN（≥16 位）
                             未配置该变量时，detail 一律不下发
```

- **状态码表达结论**：200 = 可继续服务；503 = 结构性故障（这与业务接口"body 表达结果"的约定有意相反，
  因为读者是编排器与 curl，它们只看状态码）。
- 默认**不含** worker 心跳：web 的存活检查不该因 worker 挂了而被编排器重启。

## 5. 反代与真实 IP

容器部署（见 [`docker约定.md`](./docker约定.md)）里 **nginx 是唯一对外入口**，web 容器不发布端口：

```
客户端 ──► nginx :80/:443 ──► web :3000（容器网络内）
```

- nginx 用 `$remote_addr` **覆盖**写 `X-Real-IP` 与 `X-Forwarded-For`（而不是追加）：
  追加会把客户端伪造的值留在最左侧，应用若取最左值就等于"谁都能改自己的地址记录"。
- 应用**只在 `DSH_REVIEW_TRUST_PROXY=1` 时**读这些头（默认只用 TCP 对端地址），
  并把结果写进访问日志的 `client_ip` 字段 —— 这样透传是否生效可以直接看日志验证：
  未开启时 `client_ip` 是 nginx 的容器地址（如 `172.18.0.1`），开启后才是访客地址。
- 直接把 web 端口发布到公网时**必须**把该开关改回 `0`。
- 将来在前面再加 CDN/负载均衡：要改成 `set_real_ip_from <网段>` + `real_ip_header` + 追加语义，
  并让应用信任"最右侧的非代理地址"。**不要**在原样覆盖的情况下直接把 CDN 加进来。

## 6. 还没做的接口

以下都是规划里明确"未实现"的部分，**没有**预留空端点（宁可 404 也不给假接口）：
全文检索（FTS5）、收藏/有用投票、整合包（`/packs`）、批量导入投稿、备份恢复、媒体多尺寸、真实 AI 审核。
详见 [`HANDOFF.md`](./HANDOFF.md) 的"已知缺口"。