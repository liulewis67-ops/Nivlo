//! Scheduler 触发记录的 SQLite Repository（实施计划 4.4）。

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use stardeskbox_application::ports::{ItemRepository, StorageError, TriggerRepository};
use stardeskbox_application::trigger::{TriggerKey, TriggerKind};
use stardeskbox_domain::id::ItemId;
use stardeskbox_domain::item::Item;

use crate::codec::{format_timestamp, parse_timestamp};
use crate::error::map_sqlx;
use crate::item_repository::SqliteTransaction;

#[async_trait]
impl TriggerRepository for SqliteTransaction {
    /// 可能产生触发点的 Item。
    async fn list_trigger_sources(&mut self) -> Result<Vec<Item>, StorageError> {
        let rows = sqlx::query!(
            "SELECT id FROM items
             WHERE status = 'open' AND archived_at IS NULL AND deleted_at IS NULL
               AND (reminder_at IS NOT NULL
                    OR (type = 'tip' AND scheduled_time IS NOT NULL)
                    OR (type = 'todo' AND due_time IS NOT NULL))"
        )
        .fetch_all(&mut *self.tx)
        .await
        .map_err(map_sqlx)?;
        let mut items = Vec::with_capacity(rows.len());
        for row in rows {
            let id = row
                .id
                .parse::<ItemId>()
                .map_err(|e| StorageError::Corrupt(e.to_string()))?;
            if let Some(item) = ItemRepository::get(self, id).await? {
                items.push(item);
            }
        }
        Ok(items)
    }

    /// 触发时刻不早于 `since` 的已通知触发点。
    async fn list_fired_since(
        &mut self,
        since: DateTime<Utc>,
    ) -> Result<Vec<TriggerKey>, StorageError> {
        let since = format_timestamp(since);
        let rows = sqlx::query!(
            "SELECT item_id, kind, fire_at FROM trigger_log WHERE fire_at >= ?",
            since
        )
        .fetch_all(&mut *self.tx)
        .await
        .map_err(map_sqlx)?;
        rows.into_iter()
            .map(|row| {
                Ok(TriggerKey {
                    fire_at: parse_timestamp(&row.fire_at)?,
                    item_id: row
                        .item_id
                        .parse::<ItemId>()
                        .map_err(|e| StorageError::Corrupt(e.to_string()))?,
                    kind: TriggerKind::parse(&row.kind).ok_or_else(|| {
                        StorageError::Corrupt(format!("未知的触发类型 {}", row.kind))
                    })?,
                })
            })
            .collect()
    }

    /// 记录已通知；重复记录是空操作。
    async fn record_fired(
        &mut self,
        key: &TriggerKey,
        fired_at: DateTime<Utc>,
        missed: bool,
    ) -> Result<(), StorageError> {
        let item_id = key.item_id.to_string();
        let kind = key.kind.as_str();
        let fire_at = format_timestamp(key.fire_at);
        let fired_at = format_timestamp(fired_at);
        let missed = i64::from(missed);
        sqlx::query!(
            "INSERT OR IGNORE INTO trigger_log (item_id, kind, fire_at, fired_at, missed)
             VALUES (?, ?, ?, ?, ?)",
            item_id,
            kind,
            fire_at,
            fired_at,
            missed
        )
        .execute(&mut *self.tx)
        .await
        .map_err(map_sqlx)?;
        Ok(())
    }

    /// 清理触发时刻早于 `cutoff` 的记录。
    async fn prune_fired_before(&mut self, cutoff: DateTime<Utc>) -> Result<u64, StorageError> {
        let cutoff = format_timestamp(cutoff);
        let result = sqlx::query!("DELETE FROM trigger_log WHERE fire_at < ?", cutoff)
            .execute(&mut *self.tx)
            .await
            .map_err(map_sqlx)?;
        Ok(result.rows_affected())
    }
}
