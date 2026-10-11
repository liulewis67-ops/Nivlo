-- 0006_workflow：Workflow 定义与运行记录（实施计划 5.1、5.6）。
--
-- * workflows：完整定义以 JSON 文本保存在 definition 里（Schema 校验过的唯一事实来源），
--   name / source / version / enabled / priority 是为列表与匹配冗余出来的列，读取时以列为准
--   （启用开关与优先级的修改只改列和 definition 里对应的字段，不重写整个定义）。
--   没有单独的 workflow_steps 表：Step 只在 Workflow 内部有意义，拆表只会带来同步问题。
-- * workflow_runs：每次捕获经过 Workflow 的运行记录。只存**脱敏摘要**（输入种类 + 一句摘要），
--   不存输入全文、网址查询串、文件所在目录。workflow_id 不设外键：Workflow 被删除 / 改名后历史仍然可读。
-- * workflow_run_steps：每个 Step 的状态与耗时，随运行记录级联删除。
-- 运行记录有界保留（最近 500 条且不超过 30 天），由应用定期清理。

CREATE TABLE workflows (
    id         TEXT PRIMARY KEY NOT NULL,
    name       TEXT NOT NULL,
    source     TEXT NOT NULL CHECK (source IN ('builtin', 'user', 'imported', 'marketplace')),
    version    INTEGER NOT NULL CHECK (version >= 1),
    enabled    INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    priority   INTEGER NOT NULL,
    definition TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE workflow_runs (
    id            TEXT PRIMARY KEY NOT NULL,
    workflow_id   TEXT NOT NULL,
    workflow_name TEXT NOT NULL,
    input_kind    TEXT NOT NULL,
    input_summary TEXT NOT NULL,
    status        TEXT NOT NULL CHECK (status IN ('succeeded', 'failed', 'skipped')),
    error_kind    TEXT,
    error_message TEXT,
    items_created INTEGER NOT NULL DEFAULT 0,
    duration_ms   INTEGER NOT NULL,
    started_at    TEXT NOT NULL
) STRICT;

CREATE INDEX idx_workflow_runs_started_at ON workflow_runs (started_at);

CREATE TABLE workflow_run_steps (
    run_id      TEXT NOT NULL REFERENCES workflow_runs (id) ON DELETE CASCADE,
    step_index  INTEGER NOT NULL,
    kind        TEXT NOT NULL,
    status      TEXT NOT NULL CHECK (status IN ('ok', 'skipped', 'failed')),
    duration_ms INTEGER NOT NULL,
    message     TEXT,
    PRIMARY KEY (run_id, step_index)
) STRICT;
