-- 0019_favorite_folders.sql
--
-- 收藏夹（类似 B 站的收藏夹）：收藏从「散开的一列」改为「默认/自建收藏夹」。
--
-- 设计取舍：
--   * 每个用户恰好一个默认收藏夹（部分唯一索引兜底）；首次收藏时懒创建。
--   * plugin_favorites 增加 folder_id，可空：历史收藏为 NULL，读取时归入默认夹，
--     首次 ensureDefaultFolder 时回填。一个插件在一位用户下只能出现在一个收藏夹
--     （主键 user_id + plugin_id），「换夹」= 更新 folder_id。
--   * 收藏夹名 1-40 字；(user_id, name) 唯一，重名在服务层转成字段错误。
--   * 收藏夹删除未开放；外键用 CASCADE，未来开放删除时收藏随夹清理。

CREATE TABLE favorite_folders (
  id         TEXT    PRIMARY KEY,
  user_id    TEXT    NOT NULL REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  name       TEXT    NOT NULL CHECK (trim(name) <> '' AND length(name) <= 40),
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  UNIQUE (user_id, name)
);

CREATE UNIQUE INDEX uq_favorite_folders_default
  ON favorite_folders(user_id) WHERE is_default = 1;

ALTER TABLE plugin_favorites
  ADD COLUMN folder_id TEXT REFERENCES favorite_folders(id) ON UPDATE RESTRICT ON DELETE CASCADE;

CREATE INDEX idx_plugin_favorites_by_folder
  ON plugin_favorites(folder_id, created_at DESC, plugin_id);
