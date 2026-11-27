//! 回收站（软删除）的 SQLite Repository（实施计划 3.5、D-08）。

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use starat_application::ports::{ItemRepository, StorageError, TrashRepository};
use starat_domain::id::ItemId;
use starat_domain::item::Item;

use crate::codec::{format_timestamp, parse_timestamp};
use crate::error::map_sqlx;
use crate::item_repository::SqliteTransaction;

#[async_trait]
impl TrashRepository for SqliteTransaction {
    /// 标记为已删除；已经在回收站里的保持原来的删除时间。
    async fn mark_deleted(&mut self, id: ItemId, at: DateTime<Utc>) -> Result<(), StorageError> {
        let id_text = id.to_string();
        let at_text = format_timestamp(at);
        let exists = sqlx::query!("SELECT id FROM items WHERE id = ?", id_text)
            .fetch_optional(&mut *self.tx)
            .await
            .map_err(map_sqlx)?;
        if exists.is_none() {
            return Err(StorageError::NotFound {
                entity: "item",
                id: id_text,
            });
        }
        sqlx::query!(
            "UPDATE items SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL",
            at_text,
            id_text
        )
        .execute(&mut *self.tx)
        .await
        .map_err(map_sqlx)?;
        Ok(())
    }

    /// 从回收站恢复；不在回收站里是空操作。
    async fn restore(&mut self, id: ItemId) -> Result<(), StorageError> {
        let id_text = id.to_string();
        sqlx::query!("UPDATE items SET deleted_at = NULL WHERE id = ?", id_text)
            .execute(&mut *self.tx)
            .await
            .map_err(map_sqlx)?;
        Ok(())
    }

    /// 某个 Item 被删除的时间；不在回收站里为 `None`。
    async fn deleted_at(&mut self, id: ItemId) -> Result<Option<DateTime<Utc>>, StorageError> {
        let id_text = id.to_string();
        let row = sqlx::query!("SELECT deleted_at FROM items WHERE id = ?", id_text)
            .fetch_optional(&mut *self.tx)
            .await
            .map_err(map_sqlx)?;
        row.and_then(|r| r.deleted_at)
            .map(|text| parse_timestamp(&text))
            .transpose()
    }

    /// 回收站里的全部 Item，最近删除的在前。
    async fn list_deleted(&mut self) -> Result<Vec<(Item, DateTime<Utc>)>, StorageError> {
        let rows = sqlx::query!(
            "SELECT id, deleted_at AS \"deleted_at!\" FROM items
             WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC, id DESC"
        )
        .fetch_all(&mut *self.tx)
        .await
        .map_err(map_sqlx)?;
        let mut entries = Vec::with_capacity(rows.len());
        for row in rows {
            let id = row
                .id
                .parse::<ItemId>()
                .map_err(|e| StorageError::Corrupt(e.to_string()))?;
            let deleted_at = parse_timestamp(&row.deleted_at)?;
            // 回收站里的条目数量很少（保留期 30 天），逐条读取比复制一份行映射更简单。
            if let Some(item) = ItemRepository::get(self, id).await? {
                entries.push((item, deleted_at));
            }
        }
        Ok(entries)
    }

    /// 删除时间早于 `cutoff` 的 Item ID（已超过保留期）。
    async fn deleted_before(&mut self, cutoff: DateTime<Utc>) -> Result<Vec<ItemId>, StorageError> {
        let cutoff = format_timestamp(cutoff);
        let rows = sqlx::query!(
            "SELECT id FROM items WHERE deleted_at IS NOT NULL AND deleted_at < ? ORDER BY deleted_at ASC",
            cutoff
        )
        .fetch_all(&mut *self.tx)
        .await
        .map_err(map_sqlx)?;
        rows.into_iter()
            .map(|r| {
                r.id.parse::<ItemId>()
                    .map_err(|e| StorageError::Corrupt(e.to_string()))
            })
            .collect()
    }
}
