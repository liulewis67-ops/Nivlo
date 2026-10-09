//! Item 的 SQLite Repository 与事务实现。
//!
//! 数据库行类型 [`ItemRow`] 与 Domain 的 `Item` 分离：读取时经 `ItemSnapshot` 交给
//! `Item::restore` 重新校验，写入时从 `Item::snapshot` 取字段，Domain 类型不感知存储格式。

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use nivlo_application::ports::{
    ItemFilter, ItemRepository, SettingsRepository, StorageError, Transaction,
};
use nivlo_domain::id::{ItemId, ProjectId};
use nivlo_domain::item::{Item, ItemSnapshot};
use sqlx::Sqlite;

use crate::codec::{
    format_date, format_time, format_timestamp, parse_date, parse_time, parse_timestamp,
};
use crate::error::map_sqlx;

/// `items` 表的一行，字段类型与列一一对应（均为文本）。
struct ItemRow {
    /// 主键。
    id: String,
    /// 类型。
    item_type: String,
    /// 标题。
    title: String,
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
    let corrupt = |e: nivlo_domain::error::DomainError| StorageError::Corrupt(e.to_string());
    let snapshot = ItemSnapshot {
        id: row
            .id
            .parse::<ItemId>()
            .map_err(|e| StorageError::Corrupt(e.to_string()))?,
        item_type: row.item_type.parse().map_err(corrupt)?,
        title: row.title,
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
    tx: sqlx::Transaction<'static, Sqlite>,
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

    /// 返回设置 Repository 视图（即本事务自身）。
    fn settings(&mut self) -> &mut dyn SettingsRepository {
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
        let created_at = format_timestamp(s.created_at);
        let updated_at = format_timestamp(s.updated_at);
        let completed_at = s.completed_at.map(format_timestamp);
        let archived_at = s.archived_at.map(format_timestamp);
        sqlx::query!(
            "INSERT INTO items (
                id, type, title, content, content_format, status, priority,
                scheduled_date, scheduled_time, due_date, due_time, reminder_at,
                project_id, created_at, updated_at, completed_at, archived_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            id,
            item_type,
            s.title,
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
            created_at,
            updated_at,
            completed_at,
            archived_at,
        )
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
        let updated_at = format_timestamp(s.updated_at);
        let completed_at = s.completed_at.map(format_timestamp);
        let archived_at = s.archived_at.map(format_timestamp);
        // created_at 创建后不可变，因此不在 SET 列表中。
        let result = sqlx::query!(
            "UPDATE items SET
                type = ?, title = ?, content = ?, content_format = ?, status = ?, priority = ?,
                scheduled_date = ?, scheduled_time = ?, due_date = ?, due_time = ?,
                reminder_at = ?, project_id = ?, updated_at = ?, completed_at = ?, archived_at = ?
            WHERE id = ?",
            item_type,
            s.title,
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
        Ok(())
    }

    /// 按 ID 读取 Item。
    async fn get(&mut self, id: ItemId) -> Result<Option<Item>, StorageError> {
        let id = id.to_string();
        let row = sqlx::query_as!(
            ItemRow,
            "SELECT id, type AS item_type, title, content, content_format, status, priority,
                    scheduled_date, scheduled_time, due_date, due_time, reminder_at,
                    project_id, created_at, updated_at, completed_at, archived_at
             FROM items WHERE id = ?",
            id
        )
        .fetch_optional(&mut *self.tx)
        .await
        .map_err(map_sqlx)?;
        row.map(row_to_item).transpose()
    }

    /// 按过滤条件列出 Item，创建时间倒序。
    async fn list(&mut self, filter: &ItemFilter) -> Result<Vec<Item>, StorageError> {
        let item_type = filter.item_type.map(|t| t.as_str());
        let include_archived = i64::from(filter.include_archived);
        // SQLite 中 LIMIT -1 表示不限制。
        let limit = filter.limit.map_or(-1_i64, i64::from);
        // created_at 为固定宽度文本，排序即时间序；id（UUIDv7）作为同一毫秒内的稳定次序。
        let rows = sqlx::query_as!(
            ItemRow,
            "SELECT id, type AS item_type, title, content, content_format, status, priority,
                    scheduled_date, scheduled_time, due_date, due_time, reminder_at,
                    project_id, created_at, updated_at, completed_at, archived_at
             FROM items
             WHERE (?1 IS NULL OR type = ?1)
               AND (?2 = 1 OR archived_at IS NULL)
             ORDER BY created_at DESC, id DESC
             LIMIT ?3",
            item_type,
            include_archived,
            limit
        )
        .fetch_all(&mut *self.tx)
        .await
        .map_err(map_sqlx)?;
        rows.into_iter().map(row_to_item).collect()
    }
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
