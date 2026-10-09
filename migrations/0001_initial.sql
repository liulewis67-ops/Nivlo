-- 0001_initial：Phase 0 的核心表（架构文档 §31）。
--
-- 约定（实施计划 D-03 / D-04，后端规范 §8.3）：
--   * 主键为 UUIDv7 文本。
--   * 审计时间戳（created_at 等）与 reminder_at 为 UTC，固定格式的 RFC 3339 文本
--     （YYYY-MM-DDTHH:MM:SS.sssZ），因此字符串排序即时间排序。
--   * 计划 / 截止采用本地日历语义：日期 YYYY-MM-DD，时间 HH:MM:SS，均不带时区。
--   * 全部使用 STRICT 表，让 SQLite 拒绝类型不符的写入。

CREATE TABLE projects (
    id          TEXT PRIMARY KEY NOT NULL,
    name        TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    archived_at TEXT
) STRICT;

CREATE TABLE items (
    id             TEXT PRIMARY KEY NOT NULL,
    type           TEXT NOT NULL CHECK (type IN ('todo', 'note', 'tip')),
    title          TEXT NOT NULL,
    content        TEXT,
    content_format TEXT NOT NULL DEFAULT 'plain' CHECK (content_format IN ('plain', 'markdown')),
    status         TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
    priority       TEXT NOT NULL DEFAULT 'none' CHECK (priority IN ('none', 'low', 'medium', 'high')),
    scheduled_date TEXT,
    scheduled_time TEXT,
    due_date       TEXT,
    due_time       TEXT,
    reminder_at    TEXT,
    -- 项目被删除时 Item 保留，只是不再属于任何项目。
    project_id     TEXT REFERENCES projects (id) ON DELETE SET NULL,
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL,
    completed_at   TEXT,
    archived_at    TEXT,
    -- 有时间必须有日期（与 Domain 的 DatePoint 不变量一致）。
    CHECK (scheduled_time IS NULL OR scheduled_date IS NOT NULL),
    CHECK (due_time IS NULL OR due_date IS NOT NULL)
) STRICT;

-- Today / Calendar 按计划日期查询。
CREATE INDEX idx_items_scheduled_date ON items (scheduled_date) WHERE scheduled_date IS NOT NULL;
-- Calendar 的截止日期覆盖层。
CREATE INDEX idx_items_due_date ON items (due_date) WHERE due_date IS NOT NULL;
-- 项目视图。
CREATE INDEX idx_items_project_id ON items (project_id) WHERE project_id IS NOT NULL;
-- Notes 列表按更新时间排序。
CREATE INDEX idx_items_updated_at ON items (updated_at);

CREATE TABLE tags (
    id       TEXT PRIMARY KEY NOT NULL,
    name     TEXT NOT NULL,
    -- 小写比较键，保证标签名大小写不敏感地唯一。
    name_key TEXT NOT NULL UNIQUE
) STRICT;

CREATE TABLE item_tags (
    item_id TEXT NOT NULL REFERENCES items (id) ON DELETE CASCADE,
    tag_id  TEXT NOT NULL REFERENCES tags (id) ON DELETE CASCADE,
    PRIMARY KEY (item_id, tag_id)
) STRICT;

CREATE INDEX idx_item_tags_tag_id ON item_tags (tag_id);

-- Today 的手动执行顺序，独立于 priority / created_at / due（Priority != Today Execution Order）。
CREATE TABLE daily_item_order (
    date     TEXT NOT NULL,
    item_id  TEXT NOT NULL REFERENCES items (id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    PRIMARY KEY (date, item_id)
) STRICT;

CREATE INDEX idx_daily_item_order_position ON daily_item_order (date, position);

CREATE TABLE settings (
    key        TEXT PRIMARY KEY NOT NULL,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL
) STRICT;
