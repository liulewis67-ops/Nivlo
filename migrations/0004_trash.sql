-- 0004_trash：软删除与回收站（实施计划 3.5、D-08）。
--
-- * items.deleted_at：删除时间。有值的 Item 进入回收站：不出现在任何日常视图、搜索与统计里，
--   但数据（含来源、附件记录、标签）原样保留，恢复后一切如初。
-- * 与 archived_at 的区别：归档是长期保留、随时可翻出来的整理动作；删除是「我不要了」，
--   在回收站里停留 30 天后自动永久清除（也可以手动彻底删除或清空）。
-- * 永久删除沿用既有的外键级联（来源、附件记录、标签关联、Today 顺序随 Item 一起删除），
--   被引用的用户文件永远不会被 Nivlo 删除。

ALTER TABLE items ADD COLUMN deleted_at TEXT;

-- 回收站列表与自动清除只看已删除的行。
CREATE INDEX idx_items_deleted_at ON items (deleted_at) WHERE deleted_at IS NOT NULL;
