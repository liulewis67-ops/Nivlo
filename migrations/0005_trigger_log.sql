-- 0005_trigger_log：Scheduler 的「已触发」记录（实施计划 4.4、4.5）。
--
-- 提醒 / Tip / 截止的触发点由 Item 的字段推导出来，本身不落库；这张表只记录**哪些触发点已经
-- 通知过用户**，因此：
--   * 重启、休眠唤醒后 Reconcile 不会把同一个触发点再通知一遍；
--   * 系统时间被向后调整时，已触发的触发点仍然在表里，不会重复；
--   * 用户修改了提醒时间，新的触发点（fire_at 不同）是一条全新的记录，会再次按时触发。
-- 记录随 Item 级联删除；超过保留期的由 Scheduler 定期清理。

CREATE TABLE trigger_log (
    item_id  TEXT NOT NULL REFERENCES items (id) ON DELETE CASCADE,
    -- reminder | tip | due
    kind     TEXT NOT NULL CHECK (kind IN ('reminder', 'tip', 'due')),
    -- 触发点本身（UTC，固定格式 RFC 3339 文本）。
    fire_at  TEXT NOT NULL,
    -- 实际通知的时间；错过的触发在唤醒后补发时晚于 fire_at。
    fired_at TEXT NOT NULL,
    -- 1 表示补发（错过了计划的触发时间）。
    missed   INTEGER NOT NULL DEFAULT 0 CHECK (missed IN (0, 1)),
    PRIMARY KEY (item_id, kind, fire_at)
) STRICT;

CREATE INDEX idx_trigger_log_fire_at ON trigger_log (fire_at);
