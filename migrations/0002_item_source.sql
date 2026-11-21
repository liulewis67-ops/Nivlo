-- 0002_item_source：Source / Attachment 与 Inbox 标记（实施计划 2.2、D-02）。
--
-- * items.in_inbox：显式的「待整理」标记。Capture 产生的 Item 置 1；安排日期、归入项目、
--   转换类型、手动移出会置 0；「推迟到 Inbox」置 1 并清除计划日期。不用「无日期且无项目」
--   推导，避免 Note 永远滞留在 Inbox。
-- * item_sources：每个 Item 可以记住它来自哪里（网页、文件、选中的文本、Jira……）。
-- * attachments：文件默认只保存**引用**（原始路径），不复制；只有没有原始路径的内容
--   （如粘贴的截图）才复制进应用的 attachments/ 目录（kind = 'stored'）。
--
-- 两张表都随 Item 级联删除——但级联只删除**记录**：被引用的用户文件永远不会被 Nivlo 删除。

ALTER TABLE items ADD COLUMN in_inbox INTEGER NOT NULL DEFAULT 0 CHECK (in_inbox IN (0, 1));

-- Inbox 视图按捕获时间倒序列出待整理的 Item。
CREATE INDEX idx_items_inbox ON items (created_at) WHERE in_inbox = 1;

CREATE TABLE item_sources (
    id             TEXT PRIMARY KEY NOT NULL,
    item_id        TEXT NOT NULL REFERENCES items (id) ON DELETE CASCADE,
    source_type    TEXT NOT NULL,
    source_app     TEXT,
    source_url     TEXT,
    source_path    TEXT,
    original_title TEXT,
    -- Integration 专属信息（JSON 文本），避免把 Jira / GitHub 的字段污染通用列。
    metadata_json  TEXT,
    captured_at    TEXT NOT NULL
) STRICT;

CREATE INDEX idx_item_sources_item_id ON item_sources (item_id);

CREATE TABLE attachments (
    id         TEXT PRIMARY KEY NOT NULL,
    item_id    TEXT NOT NULL REFERENCES items (id) ON DELETE CASCADE,
    -- reference：引用用户磁盘上的文件；stored：已复制到 attachments/，由 Nivlo 负责清理。
    kind       TEXT NOT NULL CHECK (kind IN ('reference', 'stored')),
    -- reference 为用户的原始路径；stored 为 attachments/ 下的相对路径。
    path       TEXT NOT NULL,
    name       TEXT NOT NULL,
    mime       TEXT,
    size_bytes INTEGER,
    added_at   TEXT NOT NULL
) STRICT;

CREATE INDEX idx_attachments_item_id ON attachments (item_id);
