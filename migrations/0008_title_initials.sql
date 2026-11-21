-- 0008_title_initials：标题的拼音首字母（交互优化计划 P2「搜索质量」第 3 项）。
--
-- * items.title_initials：标题里汉字的拼音首字母（小写，如「整理本周周报」→ zlbzzb）。
--   由存储层在写入 Item 时计算（SQLite 里算不了拼音）；没有汉字的标题存空字符串。
-- * NULL 表示「还没算过」：已有数据在打开数据库、迁移完成后由 `Database::migrate` 一次性回填。
-- * 搜索：纯字母、2 个字母以上的查询额外按它做子串匹配，结果排在正常命中之后。
--   单独一列，不进 FTS 的 trigram 索引，不影响原有的全文搜索。

ALTER TABLE items ADD COLUMN title_initials TEXT;
