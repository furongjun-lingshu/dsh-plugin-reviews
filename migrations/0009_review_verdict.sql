-- 0009_review_verdict.sql
--
-- 评测修订增补「五状态判定 + 证据链」（对齐 dsh-bench 测评规范 v3.0）。
--
-- 设计取舍（如实写在这里）：
--   * 判定与证据是**修订快照的一部分**：每版评测各自带自己的判定——改了结论就要出新修订，
--     旧修订的判定留在账本里可复核，不做就地覆盖。
--   * 两列都可空：本迁移之前的历史修订没有判定。**不假装补写**——
--     老数据就是「没有判定」，读取方如实显示「未给出」。
--   * evidence_refs 存 JSON 数组文本（[{url, note}]），服务端写入前已按规范校验；
--     这里不做 CHECK（SQLite 的 json_valid 对历史数据不友好，校验在应用层 fail-closed）。
--   * verdict 加 CHECK 约束：五状态闭集写进库，应用层漏判时数据库拒绝写入。

ALTER TABLE review_revisions ADD COLUMN verdict TEXT
  CHECK (verdict IS NULL OR verdict IN ('helpful','harmful','no-difference','undetermined','untestable'));
ALTER TABLE review_revisions ADD COLUMN evidence_refs TEXT;
