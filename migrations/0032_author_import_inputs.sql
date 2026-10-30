-- 0032_author_import_inputs.sql
--
-- 作者侧「文件夹导入」的输入与上传事实（架构 §49 / 数据库模型 §7）。
--
-- 与 0031 的关系：0031 是**管理员清单导入**（条目只有 URL，没有文件）；这里补的是
-- **作者上传 Markdown + 图片文件夹**那条线——批次同样落在 batch_jobs / batch_job_items，
-- 只是 batch_type='review_import'，并把"上传了哪些文件、传了多少、续传从哪继续"记在输入表里。
--
-- 三个必须分开的事实（规范 §49.2 L1211）：
--   1. `upload_state`（传完了没有）与 `processing_state`（业务处理到哪）是两件事；
--   2. 一个输入可以有多次上传尝试（断网、关页面），**每次尝试独立记账**；
--   3. 续传按「已接收字节数」继续，不是重新传整个文件；恢复时校验摘要，
--      同名但内容不同的文件**不被当成原输入**。
--
-- 分片续传的口径（规范把这一条留给上传接口设计）：本站采用**同一尝试内按 offset 追加**，
-- 尝试过期（租约 300s / 绝对期限 1800s）后新建尝试，已接收字节保留、从断点继续。

-- 输入文件：一个批次里登记的所有 .md 与图片
CREATE TABLE batch_input_files (
  id                TEXT    PRIMARY KEY,
  batch_id          TEXT    NOT NULL REFERENCES batch_jobs(id) ON UPDATE RESTRICT ON DELETE CASCADE,
  -- 批次内固定键：规范化相对路径（小写比较用 upload_key？不，保留原大小写，规范 §49.2 说路径只作匹配信息）
  input_key         TEXT    NOT NULL CHECK (trim(input_key) <> ''),
  file_kind         TEXT    NOT NULL CHECK (file_kind IN ('markdown', 'image')),
  relative_path     TEXT    NOT NULL CHECK (trim(relative_path) <> ''),
  declared_byte_size INTEGER NOT NULL CHECK (declared_byte_size >= 0),
  declared_sha256   TEXT    NOT NULL CHECK (declared_sha256 GLOB '[0-9a-f]*' AND length(declared_sha256) = 64),
  -- pending 未传完 / ready 已完整接收且摘要一致 / failed 明确失败
  upload_state      TEXT    NOT NULL DEFAULT 'pending' CHECK (upload_state IN ('pending', 'ready', 'failed')),
  received_byte_size INTEGER NOT NULL DEFAULT 0 CHECK (received_byte_size >= 0),
  received_sha256   TEXT,
  attempt_counter   INTEGER NOT NULL DEFAULT 0 CHECK (attempt_counter >= 0),
  state_version     INTEGER NOT NULL DEFAULT 0 CHECK (state_version >= 0),
  created_at        INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at        INTEGER NOT NULL CHECK (updated_at >= 0),
  received_at       INTEGER CHECK (received_at IS NULL OR received_at >= 0),
  UNIQUE (batch_id, input_key),
  UNIQUE (batch_id, id)
);
CREATE INDEX idx_batch_inputs_batch ON batch_input_files(batch_id, file_kind, input_key);

-- 上传尝试：一次"从开始传到传完/过期"的租约
CREATE TABLE batch_input_upload_attempts (
  id                 TEXT    PRIMARY KEY,
  batch_id           TEXT    NOT NULL REFERENCES batch_jobs(id) ON UPDATE RESTRICT ON DELETE CASCADE,
  input_id           TEXT    NOT NULL REFERENCES batch_input_files(id) ON UPDATE RESTRICT ON DELETE CASCADE,
  attempt_number     INTEGER NOT NULL CHECK (attempt_number > 0),
  lease_owner        TEXT    NOT NULL CHECK (trim(lease_owner) <> ''),
  lease_expires_at   INTEGER NOT NULL CHECK (lease_expires_at >= 0),
  absolute_deadline_at INTEGER NOT NULL CHECK (absolute_deadline_at >= 0),
  last_transfer_at   INTEGER NOT NULL CHECK (last_transfer_at >= 0),
  observed_byte_size INTEGER NOT NULL DEFAULT 0 CHECK (observed_byte_size >= 0),
  -- 分片清单：[{offset,size}]，续传结束时按它顺序读回拼接（对象存储没有"追加"语义）
  chunk_manifest    TEXT    NOT NULL DEFAULT '[]' CHECK (json_valid(chunk_manifest)),
  -- in_progress 进行中 / ok 完成且摘要一致 / failed 明确失败 / expired 租约过期（可新建尝试续传）
  result             TEXT    NOT NULL DEFAULT 'in_progress'
                       CHECK (result IN ('in_progress', 'ok', 'failed', 'expired')),
  error_code         TEXT,
  started_at         INTEGER NOT NULL CHECK (started_at >= 0),
  finished_at        INTEGER CHECK (finished_at IS NULL OR finished_at >= 0),
  UNIQUE (input_id, attempt_number),
  UNIQUE (input_id, id)
);
CREATE INDEX idx_batch_attempts_live ON batch_input_upload_attempts(result, lease_expires_at);

-- 条目与输入的用途关系：哪篇 Markdown 是条目的正文，哪些图片被它引用
CREATE TABLE batch_item_input_links (
  batch_id   TEXT    NOT NULL,
  item_id    TEXT    NOT NULL,
  input_id   TEXT    NOT NULL,
  usage      TEXT    NOT NULL CHECK (usage IN ('source_markdown', 'referenced_image')),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  PRIMARY KEY (item_id, input_id, usage),
  FOREIGN KEY (batch_id, item_id) REFERENCES batch_job_items(batch_id, id) ON UPDATE RESTRICT ON DELETE CASCADE,
  FOREIGN KEY (batch_id, input_id) REFERENCES batch_input_files(batch_id, id) ON UPDATE RESTRICT ON DELETE CASCADE
);
-- 每个条目只能有一篇正文
CREATE UNIQUE INDEX uq_batch_item_source ON batch_item_input_links(item_id) WHERE usage = 'source_markdown';
CREATE INDEX idx_batch_item_inputs_input ON batch_item_input_links(input_id, item_id);

-- 条目结果扩展：草稿外键（作者侧导入的产物是草稿，不是插件）
