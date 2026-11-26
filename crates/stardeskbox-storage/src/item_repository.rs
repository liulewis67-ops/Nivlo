//! Item 的 SQLite Repository 与事务实现。
//!
//! 数据库行类型 [`ItemRow`] 与 Domain 的 `Item` 分离：读取时经 `ItemSnapshot` 交给
//! `Item::restore` 重新校验，写入时从 `Item::snapshot` 取字段，Domain 类型不感知存储格式。

use async_trait::async_trait;
use chrono::{DateTime, NaiveDate, Utc};
use sqlx::Sqlite;
use stardeskbox_application::ports::{
    AttachmentRepository, ItemFilter, ItemOrder, ItemRepository, ProjectRepository,
    SettingsRepository, SourceRepository, StorageError, TagRepository, TodayOrderRepository,
    Transaction, TrashRepository, TriggerRepository, WorkflowRepository,
};
use stardeskbox_domain::attachment::{Attachment, AttachmentKind};
use stardeskbox_domain::id::{AttachmentId, ItemId, ProjectId, SourceId};
use stardeskbox_domain::item::{Item, ItemSnapshot};
use stardeskbox_domain::source::{Source, SourceType};

use crate::codec::{
    format_date, format_time, format_timestamp, parse_date, parse_time, parse_timestamp,
};
use crate::error::map_sqlx;
use crate::pinyin_initials::{initials_query, title_initials};

impl SqliteTransaction {
    /// 写入 Item 后同步标题的拼音首字母（同一事务，见 `0008_title_initials.sql`）。
    async fn write_initials(&mut self, id: &str, title: &str) -> Result<(), StorageError> {
        let initials = title_initials(title);
        sqlx::query!(
            "UPDATE items SET title_initials = ? WHERE id = ?",
            initials,
            id
        )
        .execute(&mut *self.tx)
        .await
        .map_err(map_sqlx)?;
        Ok(())
    }
}

/// `items` 表的一行，字段类型与列一一对应（均为文本）。
struct ItemRow {
    /// 主键。
    id: String,
    /// 类型。
    item_type: String,
    /// 标题。
    title: String,
    /// 简述。
    brief: Option<String>,
    /// 内容。
    content: Option<String>,
    /// 内容格式。
    content_format: String,
    /// 状态。
    status: String,
    /// 优先级。
    priority: String,
    /// 计划日期。
    scheduled_date: Option<String>,
    /// 计划时间。
    scheduled_time: Option<String>,
    /// 截止日期。
    due_date: Option<String>,
    /// 截止时间。
    due_time: Option<String>,
    /// 提醒时间点。
    reminder_at: Option<String>,
    /// 所属项目。
    project_id: Option<String>,
    /// 是否在 Inbox（0 / 1）。
    in_inbox: i64,
    /// 创建时间。
    created_at: String,
    /// 更新时间。
    updated_at: String,
    /// 完成时间。
    completed_at: Option<String>,
    /// 归档时间。
    archived_at: Option<String>,
}

/// 解析可空的文本列。
fn parse_opt<T>(
    text: Option<&str>,
    parse: impl FnOnce(&str) -> Result<T, StorageError>,
) -> Result<Option<T>, StorageError> {
    text.map(parse).transpose()
}

/// 把行还原为 Domain 的 `Item`；任何字段无法解析或不满足领域不变量都视为数据损坏。
fn row_to_item(row: ItemRow) -> Result<Item, StorageError> {
    let corrupt = |e: stardeskbox_domain::error::DomainError| StorageError::Corrupt(e.to_string());
    let snapshot = ItemSnapshot {
        id: row
            .id
            .parse::<ItemId>()
            .map_err(|e| StorageError::Corrupt(e.to_string()))?,
        item_type: row.item_type.parse().map_err(corrupt)?,
        title: row.title,
        brief: row.brief,
        content: row.content,
        content_format: row.content_format.parse().map_err(corrupt)?,
        status: row.status.parse().map_err(corrupt)?,
        priority: row.priority.parse().map_err(corrupt)?,
        scheduled_date: parse_opt(row.scheduled_date.as_deref(), parse_date)?,
        scheduled_time: parse_opt(row.scheduled_time.as_deref(), parse_time)?,
        due_date: parse_opt(row.due_date.as_deref(), parse_date)?,
        due_time: parse_opt(row.due_time.as_deref(), parse_time)?,
        reminder_at: parse_opt(row.reminder_at.as_deref(), parse_timestamp)?,
        project_id: row
            .project_id
            .map(|text| text.parse::<ProjectId>())
            .transpose()
            .map_err(|e| StorageError::Corrupt(e.to_string()))?,
        in_inbox: row.in_inbox != 0,
        created_at: parse_timestamp(&row.created_at)?,
        updated_at: parse_timestamp(&row.updated_at)?,
        completed_at: parse_opt(row.completed_at.as_deref(), parse_timestamp)?,
        archived_at: parse_opt(row.archived_at.as_deref(), parse_timestamp)?,
    };
    Item::restore(snapshot).map_err(corrupt)
}

/// 基于 sqlx 事务的 [`Transaction`] 实现。
///
/// 同时实现各 Repository trait，`items()` 等入口直接返回自身，因此所有 Repository 共享同一个连接
/// 与同一个事务。未调用 `commit` 就被丢弃时，sqlx 会回滚。
pub(crate) struct SqliteTransaction {
    /// 进行中的 sqlx 事务。
    pub(crate) tx: sqlx::Transaction<'static, Sqlite>,
}

impl SqliteTransaction {
    /// 包装一个已开启的 sqlx 事务。
    pub(crate) fn new(tx: sqlx::Transaction<'static, Sqlite>) -> Self {
        Self { tx }
    }
}

#[async_trait]
impl Transaction for SqliteTransaction {
    /// 返回 Item Repository 视图（即本事务自身）。
    fn items(&mut self) -> &mut dyn ItemRepository {
        self
    }

    /// 返回 Today 顺序 Repository 视图（即本事务自身）。
    fn today_order(&mut self) -> &mut dyn TodayOrderRepository {
        self
    }

    /// 返回设置 Repository 视图（即本事务自身）。
    fn settings(&mut self) -> &mut dyn SettingsRepository {
        self
    }

    /// 返回来源 Repository 视图（即本事务自身）。
    fn sources(&mut self) -> &mut dyn SourceRepository {
        self
    }

    /// 返回附件 Repository 视图（即本事务自身）。
    fn attachments(&mut self) -> &mut dyn AttachmentRepository {
        self
    }

    /// 返回项目 Repository 视图（即本事务自身）。
    fn projects(&mut self) -> &mut dyn ProjectRepository {
        self
    }

    /// 返回标签 Repository 视图（即本事务自身）。
    fn tags(&mut self) -> &mut dyn TagRepository {
        self
    }

    /// 返回回收站 Repository 视图（即本事务自身）。
    fn trash(&mut self) -> &mut dyn TrashRepository {
        self
    }

    /// 返回触发记录 Repository 视图（即本事务自身）。
    fn triggers(&mut self) -> &mut dyn TriggerRepository {
        self
    }

    /// 返回 Workflow Repository 视图（即本事务自身）。
    fn workflows(&mut self) -> &mut dyn WorkflowRepository {
        self
    }

    /// 提交事务。
    async fn commit(self: Box<Self>) -> Result<(), StorageError> {
        self.tx.commit().await.map_err(map_sqlx)
    }

    /// 回滚事务。
    async fn rollback(self: Box<Self>) -> Result<(), StorageError> {
        self.tx.rollback().await.map_err(map_sqlx)
    }
}

#[async_trait]
impl ItemRepository for SqliteTransaction {
    /// 插入新 Item。
    async fn insert(&mut self, item: &Item) -> Result<(), StorageError> {
        let s = item.snapshot();
        let id = s.id.to_string();
        let item_type = s.item_type.as_str();
        let content_format = s.content_format.as_str();
        let status = s.status.as_str();
        let priority = s.priority.as_str();
        let scheduled_date = s.scheduled_date.map(format_date);
        let scheduled_time = s.scheduled_time.map(format_time);
        let due_date = s.due_date.map(format_date);
        let due_time = s.due_time.map(format_time);
        let reminder_at = s.reminder_at.map(format_timestamp);
        let project_id = s.project_id.map(|p| p.to_string());
        let in_inbox = i64::from(s.in_inbox);
        let created_at = format_timestamp(s.created_at);
        let updated_at = format_timestamp(s.updated_at);
        let completed_at = s.completed_at.map(format_timestamp);
        let archived_at = s.archived_at.map(format_timestamp);
        sqlx::query!(
            "INSERT INTO items (
                id, type, title, brief, content, content_format, status, priority,
                scheduled_date, scheduled_time, due_date, due_time, reminder_at,
                project_id, in_inbox, created_at, updated_at, completed_at, archived_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            id,
            item_type,
            s.title,
            s.brief,
            s.content,
            content_format,
            status,
            priority,
            scheduled_date,
            scheduled_time,
            due_date,
            due_time,
            reminder_at,
            project_id,
            in_inbox,
            created_at,
            updated_at,
            completed_at,
            archived_at,
        )
        .execute(&mut *self.tx)
        .await
        .map_err(map_sqlx)?;
        self.write_initials(&id, &s.title).await
    }

    /// 记录打开时间；不存在或已删除的 Item 不受影响。
    async fn mark_opened(&mut self, id: ItemId, at: DateTime<Utc>) -> Result<(), StorageError> {
        let id = id.to_string();
        let at = format_timestamp(at);
        sqlx::query!(
            "UPDATE items SET opened_at = ? WHERE id = ? AND deleted_at IS NULL",
            at,
            id
        )
        .execute(&mut *self.tx)
        .await
        .map_err(map_sqlx)?;
        Ok(())
    }

    /// 永久删除一个 Item，关联记录由外键级联删除。
    async fn delete(&mut self, id: ItemId) -> Result<(), StorageError> {
        let id = id.to_string();
        sqlx::query!("DELETE FROM items WHERE id = ?", id)
            .execute(&mut *self.tx)
            .await
            .map_err(map_sqlx)?;
        Ok(())
    }

    /// 整体覆盖已存在的 Item。
    async fn update(&mut self, item: &Item) -> Result<(), StorageError> {
        let s = item.snapshot();
        let id = s.id.to_string();
        let item_type = s.item_type.as_str();
        let content_format = s.content_format.as_str();
        let status = s.status.as_str();
        let priority = s.priority.as_str();
        let scheduled_date = s.scheduled_date.map(format_date);
        let scheduled_time = s.scheduled_time.map(format_time);
        let due_date = s.due_date.map(format_date);
        let due_time = s.due_time.map(format_time);
        let reminder_at = s.reminder_at.map(format_timestamp);
        let project_id = s.project_id.map(|p| p.to_string());
        let in_inbox = i64::from(s.in_inbox);
        let updated_at = format_timestamp(s.updated_at);
        let completed_at = s.completed_at.map(format_timestamp);
        let archived_at = s.archived_at.map(format_timestamp);
        // created_at 创建后不可变，因此不在 SET 列表中。
        let result = sqlx::query!(
            "UPDATE items SET
                type = ?, title = ?, brief = ?, content = ?, content_format = ?, status = ?,
                priority = ?,
                scheduled_date = ?, scheduled_time = ?, due_date = ?, due_time = ?,
                reminder_at = ?, project_id = ?, in_inbox = ?, updated_at = ?, completed_at = ?,
                archived_at = ?
            WHERE id = ?",
            item_type,
            s.title,
            s.brief,
            s.content,
            content_format,
            status,
            priority,
            scheduled_date,
            scheduled_time,
            due_date,
            due_time,
            reminder_at,
            project_id,
            in_inbox,
            updated_at,
            completed_at,
            archived_at,
            id,
        )
        .execute(&mut *self.tx)
        .await
        .map_err(map_sqlx)?;
        if result.rows_affected() == 0 {
            return Err(StorageError::NotFound { entity: "item", id });
        }
        self.write_initials(&id, &s.title).await
    }

    /// 按 ID 读取 Item。
    async fn get(&mut self, id: ItemId) -> Result<Option<Item>, StorageError> {
        let id = id.to_string();
        let row = sqlx::query_as!(
            ItemRow,
            "SELECT id, type AS item_type, title, brief, content, content_format, status, priority,
                    scheduled_date, scheduled_time, due_date, due_time, reminder_at,
                    project_id, in_inbox, created_at, updated_at, completed_at, archived_at
             FROM items WHERE id = ?",
            id
        )
        .fetch_optional(&mut *self.tx)
        .await
        .map_err(map_sqlx)?;
        row.map(row_to_item).transpose()
    }

    /// 计划日期不晚于 `date` 的未完成、未归档 Todo。
    async fn list_open_todos_scheduled_on_or_before(
        &mut self,
        date: NaiveDate,
    ) -> Result<Vec<Item>, StorageError> {
        let date = format_date(date);
        // 日期是固定宽度的 YYYY-MM-DD 文本，字符串比较即日期比较；用到 idx_items_scheduled_date。
        // 计划日期相同的按创建时间、ID 排序，保证结果稳定。
        let rows = sqlx::query_as!(
            ItemRow,
            "SELECT id, type AS item_type, title, brief, content, content_format, status, priority,
                    scheduled_date, scheduled_time, due_date, due_time, reminder_at,
                    project_id, in_inbox, created_at, updated_at, completed_at, archived_at
             FROM items
             WHERE type = 'todo' AND status = 'open' AND archived_at IS NULL AND deleted_at IS NULL
               AND scheduled_date IS NOT NULL AND scheduled_date <= ?
             ORDER BY scheduled_date ASC, created_at ASC, id ASC",
            date
        )
        .fetch_all(&mut *self.tx)
        .await
        .map_err(map_sqlx)?;
        rows.into_iter().map(row_to_item).collect()
    }

    /// 计划日期恰为 `date` 的未归档 Tip。
    async fn list_tips_scheduled_on(&mut self, date: NaiveDate) -> Result<Vec<Item>, StorageError> {
        let date = format_date(date);
        let rows = sqlx::query_as!(
            ItemRow,
            "SELECT id, type AS item_type, title, brief, content, content_format, status, priority,
                    scheduled_date, scheduled_time, due_date, due_time, reminder_at,
                    project_id, in_inbox, created_at, updated_at, completed_at, archived_at
             FROM items
             WHERE type = 'tip' AND archived_at IS NULL AND deleted_at IS NULL AND scheduled_date = ?
             ORDER BY scheduled_time ASC, created_at ASC, id ASC",
            date
        )
        .fetch_all(&mut *self.tx)
        .await
        .map_err(map_sqlx)?;
        rows.into_iter().map(row_to_item).collect()
    }

    /// 完成时间在 `[from, to)` 内的未归档 Todo，按完成时间升序。
    async fn list_todos_completed_between(
        &mut self,
        from: DateTime<Utc>,
        to: DateTime<Utc>,
    ) -> Result<Vec<Item>, StorageError> {
        let from = format_timestamp(from);
        let to = format_timestamp(to);
        // 时间戳是固定宽度的 UTC 文本，字符串比较即时间比较。
        let rows = sqlx::query_as!(
            ItemRow,
            "SELECT id, type AS item_type, title, brief, content, content_format, status, priority,
                    scheduled_date, scheduled_time, due_date, due_time, reminder_at,
                    project_id, in_inbox, created_at, updated_at, completed_at, archived_at
             FROM items
             WHERE type = 'todo' AND archived_at IS NULL AND deleted_at IS NULL
               AND completed_at IS NOT NULL AND completed_at >= ? AND completed_at < ?
             ORDER BY completed_at ASC, id ASC",
            from,
            to
        )
        .fetch_all(&mut *self.tx)
        .await
        .map_err(map_sqlx)?;
        rows.into_iter().map(row_to_item).collect()
    }

    /// 按过滤条件列出 Item，创建时间倒序。
    async fn list(&mut self, filter: &ItemFilter) -> Result<Vec<Item>, StorageError> {
        let item_type = filter.item_type.map(|t| t.as_str());
        let include_archived = i64::from(filter.include_archived);
        let in_inbox_only = i64::from(filter.in_inbox_only);
        let order_mode = match filter.order {
            ItemOrder::CreatedDesc => 0_i64,
            ItemOrder::UpdatedDesc => 1,
            ItemOrder::ProjectView => 2,
            ItemOrder::RecentDesc => 3,
        };
        let project_id = filter.project_id.map(|id| id.to_string());
        let tag_id = filter.tag_id.map(|id| id.to_string());
        // SQLite 中 LIMIT -1 表示不限制。
        let limit = filter.limit.map_or(-1_i64, i64::from);
        // created_at 为固定宽度文本，排序即时间序；id（UUIDv7）作为同一毫秒内的稳定次序。
        let rows = sqlx::query_as!(
            ItemRow,
            "SELECT id, type AS item_type, title, brief, content, content_format, status, priority,
                    scheduled_date, scheduled_time, due_date, due_time, reminder_at,
                    project_id, in_inbox, created_at, updated_at, completed_at, archived_at
             FROM items
             WHERE (?1 IS NULL OR type = ?1)
               AND (?2 = 1 OR archived_at IS NULL)
               AND (?3 = 0 OR in_inbox = 1)
               AND deleted_at IS NULL
               AND (?6 IS NULL OR project_id = ?6)
               AND (?7 IS NULL OR EXISTS (
                    SELECT 1 FROM item_tags WHERE item_tags.item_id = items.id AND item_tags.tag_id = ?7))
             ORDER BY
               CASE WHEN ?4 = 2 THEN status = 'done' ELSE 0 END ASC,
               CASE WHEN ?4 = 2 THEN CASE priority
                    WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 ELSE 3 END
                    ELSE 0 END ASC,
               CASE WHEN ?4 = 2 THEN scheduled_date IS NULL ELSE 0 END ASC,
               CASE WHEN ?4 = 2 THEN scheduled_date END ASC,
               CASE WHEN ?4 = 1 THEN updated_at
                    WHEN ?4 = 3 THEN max(updated_at, coalesce(opened_at, updated_at))
                    ELSE created_at END DESC,
               id DESC
             LIMIT ?5",
            item_type,
            include_archived,
            in_inbox_only,
            order_mode,
            limit,
            project_id,
            tag_id
        )
        .fetch_all(&mut *self.tx)
        .await
        .map_err(map_sqlx)?;
        rows.into_iter().map(row_to_item).collect()
    }

    /// 计划日期或截止日期落在 `[from, to]` 内的 Item；用到 `idx_items_scheduled_date` / `idx_items_due_date`。
    async fn list_calendar(
        &mut self,
        from: NaiveDate,
        to: NaiveDate,
    ) -> Result<Vec<Item>, StorageError> {
        let from = format_date(from);
        let to = format_date(to);
        let rows = sqlx::query_as!(
            ItemRow,
            "SELECT id, type AS item_type, title, brief, content, content_format, status, priority,
                    scheduled_date, scheduled_time, due_date, due_time, reminder_at,
                    project_id, in_inbox, created_at, updated_at, completed_at, archived_at
             FROM items
             WHERE archived_at IS NULL AND deleted_at IS NULL
               AND ((scheduled_date >= ?1 AND scheduled_date <= ?2)
                    OR (due_date >= ?1 AND due_date <= ?2))
             ORDER BY created_at ASC, id ASC",
            from,
            to
        )
        .fetch_all(&mut *self.tx)
        .await
        .map_err(map_sqlx)?;
        rows.into_iter().map(row_to_item).collect()
    }

    /// 没有计划日期的未完成 Todo，最近创建的在前。
    async fn list_unscheduled_open_todos(&mut self, limit: u32) -> Result<Vec<Item>, StorageError> {
        let limit = i64::from(limit);
        let rows = sqlx::query_as!(
            ItemRow,
            "SELECT id, type AS item_type, title, brief, content, content_format, status, priority,
                    scheduled_date, scheduled_time, due_date, due_time, reminder_at,
                    project_id, in_inbox, created_at, updated_at, completed_at, archived_at
             FROM items
             WHERE type = 'todo' AND status = 'open' AND scheduled_date IS NULL
               AND archived_at IS NULL AND deleted_at IS NULL
             ORDER BY created_at DESC, id DESC
             LIMIT ?",
            limit
        )
        .fetch_all(&mut *self.tx)
        .await
        .map_err(map_sqlx)?;
        rows.into_iter().map(row_to_item).collect()
    }

    /// 全文搜索：词都不短时走 FTS5（trigram），否则退化为 LIKE 扫描；未完成的排在已完成之前。
    async fn search(
        &mut self,
        text: &str,
        include_archived: bool,
        limit: u32,
    ) -> Result<Vec<Item>, StorageError> {
        let include_archived = i64::from(include_archived);
        let limit = i64::from(limit);
        let terms: Vec<&str> = text.split_whitespace().collect();
        if terms.is_empty() {
            return Ok(Vec::new());
        }
        // trigram 至少要 3 个字符才能匹配；更短的词丢掉，剩下的词做 AND。
        let long_terms: Vec<&str> = terms
            .iter()
            .copied()
            .filter(|term| term.chars().count() >= 3)
            .collect();
        let rows = if long_terms.is_empty() {
            let pattern = like_pattern(&terms.join(" "));
            sqlx::query_as!(
                ItemRow,
                "SELECT items.id AS \"id!\", items.type AS \"item_type!\", items.title AS \"title!\",
                        items.brief, items.content, items.content_format AS \"content_format!\",
                        items.status AS \"status!\", items.priority AS \"priority!\",
                        items.scheduled_date, items.scheduled_time, items.due_date, items.due_time,
                        items.reminder_at, items.project_id, items.in_inbox AS \"in_inbox!\",
                        items.created_at AS \"created_at!\", items.updated_at AS \"updated_at!\",
                        items.completed_at, items.archived_at
                 FROM items_fts JOIN items ON items.id = items_fts.item_id
                 WHERE (items_fts.title LIKE ?1 ESCAPE '\\'
                        OR items_fts.content LIKE ?1 ESCAPE '\\'
                        OR items_fts.source_text LIKE ?1 ESCAPE '\\')
                   AND (?2 = 1 OR items.archived_at IS NULL)
                   AND items.deleted_at IS NULL
                 ORDER BY items.status = 'done', (items_fts.title LIKE ?1 ESCAPE '\\') DESC,
                          items.updated_at DESC, items.id DESC
                 LIMIT ?3",
                pattern,
                include_archived,
                limit
            )
            .fetch_all(&mut *self.tx)
            .await
        } else {
            // 每个词作为一个短语（引号内的引号翻倍），词之间 AND。
            let query = long_terms
                .iter()
                .map(|term| format!("\"{}\"", term.replace('"', "\"\"")))
                .collect::<Vec<_>>()
                .join(" AND ");
            sqlx::query_as!(
                ItemRow,
                "SELECT items.id AS \"id!\", items.type AS \"item_type!\", items.title AS \"title!\",
                        items.brief, items.content, items.content_format AS \"content_format!\",
                        items.status AS \"status!\", items.priority AS \"priority!\",
                        items.scheduled_date, items.scheduled_time, items.due_date, items.due_time,
                        items.reminder_at, items.project_id, items.in_inbox AS \"in_inbox!\",
                        items.created_at AS \"created_at!\", items.updated_at AS \"updated_at!\",
                        items.completed_at, items.archived_at
                 FROM items_fts JOIN items ON items.id = items_fts.item_id
                 WHERE items_fts MATCH ?1 AND (?2 = 1 OR items.archived_at IS NULL)
                   AND items.deleted_at IS NULL
                 ORDER BY items.status = 'done', bm25(items_fts, 0.0, 8.0, 1.0, 2.0),
                          items.updated_at DESC, items.id DESC
                 LIMIT ?3",
                query,
                include_archived,
                limit
            )
            .fetch_all(&mut *self.tx)
            .await
        }
        .map_err(map_sqlx)?;
        let mut items = rows
            .into_iter()
            .map(row_to_item)
            .collect::<Result<Vec<_>, _>>()?;

        // 拼音首字母（「bzzb」→「本周周报」）：只对纯字母的查询，结果接在正常命中之后、去重。
        let wanted = usize::try_from(limit).unwrap_or(usize::MAX);
        if let Some(initials) = initials_query(text)
            && items.len() < wanted
        {
            let pattern = like_pattern(&initials);
            let extra = sqlx::query_as!(
                ItemRow,
                "SELECT id, type AS item_type, title, brief, content, content_format, status, priority,
                        scheduled_date, scheduled_time, due_date, due_time, reminder_at,
                        project_id, in_inbox, created_at, updated_at, completed_at, archived_at
                 FROM items
                 WHERE title_initials LIKE ?1 ESCAPE '\\'
                   AND (?2 = 1 OR archived_at IS NULL)
                   AND deleted_at IS NULL
                 ORDER BY status = 'done', updated_at DESC, id DESC
                 LIMIT ?3",
                pattern,
                include_archived,
                limit
            )
            .fetch_all(&mut *self.tx)
            .await
            .map_err(map_sqlx)?;
            for row in extra {
                let item = row_to_item(row)?;
                if items.len() < wanted && !items.iter().any(|found| found.id() == item.id()) {
                    items.push(item);
                }
            }
        }
        Ok(items)
    }
}

/// 把用户输入变成 LIKE 的「包含」模式：转义 `\`、`%`、`_`。
fn like_pattern(text: &str) -> String {
    let mut pattern = String::with_capacity(text.len() + 2);
    pattern.push('%');
    for c in text.chars() {
        if matches!(c, '\\' | '%' | '_') {
            pattern.push('\\');
        }
        pattern.push(c);
    }
    pattern.push('%');
    pattern
}

#[async_trait]
impl SettingsRepository for SqliteTransaction {
    /// 按 key 读取设置。
    async fn get(&mut self, key: &str) -> Result<Option<String>, StorageError> {
        let row = sqlx::query!("SELECT value FROM settings WHERE key = ?", key)
            .fetch_optional(&mut *self.tx)
            .await
            .map_err(map_sqlx)?;
        Ok(row.map(|r| r.value))
    }

    /// 写入（覆盖）设置并记录更新时间。
    async fn set(
        &mut self,
        key: &str,
        value: &str,
        updated_at: DateTime<Utc>,
    ) -> Result<(), StorageError> {
        let updated_at = format_timestamp(updated_at);
        // UPSERT：同一个 key 只有一行，重复写入覆盖旧值。
        sqlx::query!(
            "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            key,
            value,
            updated_at
        )
        .execute(&mut *self.tx)
        .await
        .map_err(map_sqlx)?;
        Ok(())
    }
}

#[async_trait]
impl TodayOrderRepository for SqliteTransaction {
    /// 读取某日的手动顺序（按 position 升序）。
    async fn get(&mut self, date: NaiveDate) -> Result<Vec<ItemId>, StorageError> {
        let date = format_date(date);
        let rows = sqlx::query!(
            "SELECT item_id FROM daily_item_order WHERE date = ? ORDER BY position ASC",
            date
        )
        .fetch_all(&mut *self.tx)
        .await
        .map_err(map_sqlx)?;
        rows.into_iter()
            .map(|row| {
                row.item_id
                    .parse::<ItemId>()
                    .map_err(|e| StorageError::Corrupt(e.to_string()))
            })
            .collect()
    }

    /// 整体替换某日的手动顺序：先删后写，同在调用方事务内。
    async fn set(&mut self, date: NaiveDate, ids: &[ItemId]) -> Result<(), StorageError> {
        let date = format_date(date);
        sqlx::query!("DELETE FROM daily_item_order WHERE date = ?", date)
            .execute(&mut *self.tx)
            .await
            .map_err(map_sqlx)?;
        for (position, id) in (0_i64..).zip(ids) {
            let id = id.to_string();
            sqlx::query!(
                "INSERT INTO daily_item_order (date, item_id, position) VALUES (?, ?, ?)",
                date,
                id,
                position
            )
            .execute(&mut *self.tx)
            .await
            .map_err(map_sqlx)?;
        }
        Ok(())
    }

    /// 删除某个 Item 的全部顺序记录。
    async fn remove_item(&mut self, id: ItemId) -> Result<(), StorageError> {
        let id = id.to_string();
        sqlx::query!("DELETE FROM daily_item_order WHERE item_id = ?", id)
            .execute(&mut *self.tx)
            .await
            .map_err(map_sqlx)?;
        Ok(())
    }
}

#[async_trait]
impl SourceRepository for SqliteTransaction {
    /// 插入一条来源记录。
    async fn insert(&mut self, source: &Source) -> Result<(), StorageError> {
        let id = source.id.to_string();
        let item_id = source.item_id.to_string();
        let source_type = source.source_type.as_str();
        let captured_at = format_timestamp(source.captured_at);
        sqlx::query!(
            "INSERT INTO item_sources (
                id, item_id, source_type, source_app, source_url, source_path,
                original_title, metadata_json, captured_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            id,
            item_id,
            source_type,
            source.source_app,
            source.source_url,
            source.source_path,
            source.original_title,
            source.metadata_json,
            captured_at,
        )
        .execute(&mut *self.tx)
        .await
        .map_err(map_sqlx)?;
        Ok(())
    }

    /// 某个 Item 的全部来源，按捕获时间升序。
    async fn list_for_item(&mut self, item_id: ItemId) -> Result<Vec<Source>, StorageError> {
        let item_id = item_id.to_string();
        let rows = sqlx::query!(
            "SELECT id, item_id, source_type, source_app, source_url, source_path,
                    original_title, metadata_json, captured_at
             FROM item_sources WHERE item_id = ? ORDER BY captured_at ASC, id ASC",
            item_id
        )
        .fetch_all(&mut *self.tx)
        .await
        .map_err(map_sqlx)?;
        rows.into_iter()
            .map(|row| {
                let corrupt = |e: String| StorageError::Corrupt(e);
                Ok(Source {
                    id: row
                        .id
                        .parse::<SourceId>()
                        .map_err(|e| corrupt(e.to_string()))?,
                    item_id: row
                        .item_id
                        .parse::<ItemId>()
                        .map_err(|e| corrupt(e.to_string()))?,
                    source_type: SourceType::new(&row.source_type),
                    source_app: row.source_app,
                    source_url: row.source_url,
                    source_path: row.source_path,
                    original_title: row.original_title,
                    metadata_json: row.metadata_json,
                    captured_at: parse_timestamp(&row.captured_at)?,
                })
            })
            .collect()
    }
}

#[async_trait]
impl AttachmentRepository for SqliteTransaction {
    /// 插入一条附件记录。
    async fn insert(&mut self, attachment: &Attachment) -> Result<(), StorageError> {
        let id = attachment.id.to_string();
        let item_id = attachment.item_id.to_string();
        let kind = attachment.kind.as_str();
        let size_bytes = attachment
            .size_bytes
            .map(i64::try_from)
            .transpose()
            .map_err(|e| StorageError::Constraint(e.to_string()))?;
        let added_at = format_timestamp(attachment.added_at);
        sqlx::query!(
            "INSERT INTO attachments (id, item_id, kind, path, name, mime, size_bytes, added_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            id,
            item_id,
            kind,
            attachment.path,
            attachment.name,
            attachment.mime,
            size_bytes,
            added_at,
        )
        .execute(&mut *self.tx)
        .await
        .map_err(map_sqlx)?;
        Ok(())
    }

    /// 某个 Item 的全部附件，按添加时间升序。
    async fn list_for_item(&mut self, item_id: ItemId) -> Result<Vec<Attachment>, StorageError> {
        let item_id = item_id.to_string();
        let rows = sqlx::query!(
            "SELECT id, item_id, kind, path, name, mime, size_bytes, added_at
             FROM attachments WHERE item_id = ? ORDER BY added_at ASC, id ASC",
            item_id
        )
        .fetch_all(&mut *self.tx)
        .await
        .map_err(map_sqlx)?;
        rows.into_iter()
            .map(|row| {
                let corrupt = |e: String| StorageError::Corrupt(e);
                Ok(Attachment {
                    id: row
                        .id
                        .parse::<AttachmentId>()
                        .map_err(|e| corrupt(e.to_string()))?,
                    item_id: row
                        .item_id
                        .parse::<ItemId>()
                        .map_err(|e| corrupt(e.to_string()))?,
                    kind: AttachmentKind::parse(&row.kind)
                        .ok_or_else(|| corrupt(format!("未知的附件类型：{}", row.kind)))?,
                    path: row.path,
                    name: row.name,
                    mime: row.mime,
                    size_bytes: row
                        .size_bytes
                        .map(u64::try_from)
                        .transpose()
                        .map_err(|e| corrupt(e.to_string()))?,
                    added_at: parse_timestamp(&row.added_at)?,
                })
            })
            .collect()
    }
}
