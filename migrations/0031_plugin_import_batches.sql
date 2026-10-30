-- 0031_plugin_import_batches.sql
--
-- 管理员「插件清单批量导入」：批次 + 条目（架构 §49，需求 §25 第 370 行）。
--
-- 与规划的差异（如实记录，其余照规范）：
--   1. 只建 `batch_jobs` 与 `batch_job_items` 两张表。规划还有 batch_input_files /
--      batch_input_upload_attempts / batch_item_input_links 三张——它们服务的是"作者上传
--      Markdown + 图片文件夹"的断点续传；管理员插件导入是**清单里的 URL**，没有本地上传文件，
--      这三张表在这里没有可写的东西。等做作者侧文件夹导入时再补，不先建空表。
--   2. 新增 `mode`（dry_run / apply）：规划写的是"启动导入任务"，没有单独列"预演"。
--      产品决定要"先检查不入库、看结果再确认"，所以把模式写进批次而不是另开一张表——
--      预演批次同样有逐条结果，只是 item.plugin_id 只是"将要关联"而不是已写入。
--   3. 条目表省掉规划里的 upload_state / task_id：没有文件上传阶段，处理是同步的（不排队）。
--      字段保留 `input_metadata`（url / plugin_path / note）与 `issues`（失败原因）。
--
-- 查重口径（规划 §49.2）：目录条目按「仓库 + 子路径」查重；命中已有插件算**已处理结果**
-- （item.plugin_id 指向既有插件），不是失败。

CREATE TABLE batch_jobs (
  id                TEXT    PRIMARY KEY,
  requested_by      TEXT    NOT NULL REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  -- plugin_import：管理员清单导入（条目只有 URL）；review_import：作者文件夹导入（条目是 .md）
  batch_type        TEXT    NOT NULL CHECK (batch_type IN ('plugin_import', 'review_import')),
  -- 预演：逐条检查但不写插件；导入：检查通过即收录。
  mode              TEXT    NOT NULL CHECK (mode IN ('dry_run', 'apply')),
  request_key       TEXT    NOT NULL CHECK (trim(request_key) <> ''),
  request_digest    TEXT    NOT NULL CHECK (length(request_digest) = 64),
  -- 原始清单文本 + 解析结果摘要（定位用；不保存客户端绝对路径——这里本来也没有路径）
  input_manifest    TEXT    NOT NULL CHECK (json_valid(input_manifest)),
  created_at        INTEGER NOT NULL CHECK (created_at >= 0),
  UNIQUE (requested_by, request_key)
);
CREATE INDEX idx_batch_jobs_requester ON batch_jobs(requested_by, created_at DESC, id);

CREATE TABLE batch_job_items (
  id                TEXT    PRIMARY KEY,
  batch_id          TEXT    NOT NULL REFERENCES batch_jobs(id) ON UPDATE RESTRICT ON DELETE CASCADE,
  -- 批次内固定条目键 = 规范化后的 "owner/repo[/path]"，同一 URL 写法差异不会分裂成两条
  item_key          TEXT    NOT NULL CHECK (trim(item_key) <> ''),
  position          INTEGER NOT NULL CHECK (position >= 0),
  input_metadata    TEXT    NOT NULL CHECK (json_valid(input_metadata)),
  -- pending：还没处理；done：已检查（必要时已入库）；failed：检查未通过（可单条重试）
  processing_state  TEXT    NOT NULL DEFAULT 'pending' CHECK (processing_state IN ('pending', 'done', 'failed')),
  -- 命中的插件（apply 模式写入；dry_run 模式只在"已存在"时填既有插件）
  plugin_id         TEXT    REFERENCES plugins(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  -- 作者侧导入的产物是草稿（管理员清单导入为空）
  draft_id          TEXT    REFERENCES content_drafts(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  issues            TEXT    NOT NULL CHECK (json_valid(issues)),
  state_version     INTEGER NOT NULL DEFAULT 0 CHECK (state_version >= 0),
  created_at        INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at        INTEGER NOT NULL CHECK (updated_at >= 0),
  UNIQUE (batch_id, item_key),
  UNIQUE (batch_id, id)
);
CREATE INDEX idx_batch_items_batch ON batch_job_items(batch_id, position, id);
CREATE INDEX idx_batch_items_state ON batch_job_items(batch_id, processing_state, id);
