-- 0009_item_brief：Todo 与 Tip 的简述。
--
-- * items.brief：标题之外的一句话概要（最多 200 个字符、单行），比描述 / 正文短得多。
--   只有 Todo 与 Tip 有，由 Domain 校验；NULL 表示没有简述。
-- * 搜索：简述并入 items_fts 的 content 列（排在正文前面），不新增 FTS 列，
--   bm25 权重与 LIKE 退化扫描都不用改。已有数据都没有简述，无需回填。

ALTER TABLE items ADD COLUMN brief TEXT;

DROP TRIGGER items_fts_after_insert;
DROP TRIGGER items_fts_after_update;

CREATE TRIGGER items_fts_after_insert AFTER INSERT ON items
BEGIN
    INSERT INTO items_fts (item_id, title, content, source_text)
    VALUES (
        new.id,
        new.title,
        COALESCE(new.brief || char(10), '') || COALESCE(new.content, ''),
        ''
    );
END;

CREATE TRIGGER items_fts_after_update AFTER UPDATE OF title, brief, content ON items
BEGIN
    UPDATE items_fts
    SET title = new.title,
        content = COALESCE(new.brief || char(10), '') || COALESCE(new.content, '')
    WHERE item_id = old.id;
END;
