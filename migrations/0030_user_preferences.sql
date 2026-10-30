-- 0030_user_preferences.sql
--
-- 每用户偏好（个人设置里可改的开关与数值）。
--
-- 起因：草稿"停止编辑 N 秒自动保存"的间隔写死在组件常量里（5 秒），作者既不能关掉
-- （有人习惯手动保存），也不能调长（正文长、输入慢的人会被频繁写库打断）。要求是
-- **默认 5 秒、个人设置里可调**。
--
-- 为什么单独建表而不是塞进 users 或 site_settings：
--   * users 是身份表，加一个 preferences JSON 列会让"身份"与"界面偏好"耦合，
--     备份/迁移/权限都跟着变；
--   * site_settings 是**全站**配置（管理员改、所有人受影响），与"每个人自己的间隔"不是一回事。
--
-- 取值一律存 JSON 文本（json_valid 约束），读取侧合并默认值：
-- 缺键 = 用默认值，**不写一行"默认值行"** —— 这样将来改默认值时，没主动设置过的人自动跟随。
--
-- 键名用点命名（`editor.autosave_seconds`），与 site_settings 的风格一致。

CREATE TABLE user_preferences (
  user_id    TEXT    NOT NULL REFERENCES users(id) ON UPDATE RESTRICT ON DELETE CASCADE,
  key        TEXT    NOT NULL CHECK (trim(key) <> ''),
  value      TEXT    NOT NULL CHECK (json_valid(value)),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  PRIMARY KEY (user_id, key)
);
