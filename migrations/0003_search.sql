-- 0003_search：全文搜索（实施计划 3.4、D-09）。
--
-- * items_fts 是 FTS5 虚拟表，使用 trigram 分词器：不依赖分词词典，中文也能按子串匹配
--   （「登录」能找到「修复登录超时」），默认忽略大小写。
-- * 索引内容：标题、正文、来源文本（来源的原始标题 + 网址 + 文件路径）。
-- * 用 Trigger 与业务写入在同一个事务里同步，不会出现「Item 已改、索引还是旧的」。
-- * item_id 只做存储、不参与匹配；Item 的主键是 TEXT，没有稳定的 rowid 可用，
--   所以用 item_id 关联。
-- * trigram 要求查询至少 3 个字符；更短的查询由应用层退化为 LIKE 扫描（见 search 实现）。

CREATE VIRTUAL TABLE items_fts USING fts5 (
    item_id UNINDEXED,
    title,
    content,
    source_text,
    tokenize = 'trigram'
);

-- 已有数据补建索引。
INSERT INTO items_fts (item_id, title, content, source_text)
SELECT
    items.id,
    items.title,
    COALESCE(items.content, ''),
    COALESCE((
        SELECT group_concat(
            COALESCE(s.original_title, '') || ' ' || COALESCE(s.source_url, '') || ' ' || COALESCE(s.source_path, ''),
            ' '
        )
        FROM item_sources AS s WHERE s.item_id = items.id
    ), '')
FROM items;

CREATE TRIGGER items_fts_after_insert AFTER INSERT ON items
BEGIN
    INSERT INTO items_fts (item_id, title, content, source_text)
    VALUES (new.id, new.title, COALESCE(new.content, ''), '');
END;

CREATE TRIGGER items_fts_after_update AFTER UPDATE OF title, content ON items
BEGIN
    UPDATE items_fts
    SET title = new.title, content = COALESCE(new.content, '')
    WHERE item_id = old.id;
END;

CREATE TRIGGER items_fts_after_delete AFTER DELETE ON items
BEGIN
    DELETE FROM items_fts WHERE item_id = old.id;
END;

-- 来源只会追加（没有更新），随 Item 级联删除时索引已随 Item 一起清掉。
CREATE TRIGGER item_sources_fts_after_insert AFTER INSERT ON item_sources
BEGIN
    UPDATE items_fts
    SET source_text = source_text || ' ' || COALESCE(new.original_title, '') || ' '
        || COALESCE(new.source_url, '') || ' ' || COALESCE(new.source_path, '')
    WHERE item_id = new.item_id;
END;
