-- 0007_item_opened：记录条目最近一次被打开的时间（交互优化计划 P2「搜索质量」第 2 项）。
--
-- * items.opened_at：最近一次在详情面板里打开的时间。只服务于「最近使用」排序
--   （搜索框空输入时的列表），不是领域状态：打开不改 updated_at、不发事件、不进 Item 快照。
-- * 「最近使用」= max(opened_at, updated_at)；列表最多取几条，数据量下全表排序足够快，暂不建索引。

ALTER TABLE items ADD COLUMN opened_at TEXT;
