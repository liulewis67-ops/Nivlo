//! `TrashService`：删除、回收站、恢复与永久清除（实施计划 3.5、D-08）。
//!
//! * 「删除」是软删除：Item 进入回收站，不出现在任何日常视图与搜索里，数据原样保留，可以恢复；
//! * 回收站里的 Item 停留 [`TRASH_RETENTION_DAYS`] 天后自动永久清除，也可以手动彻底删除 / 清空；
//! * 永久清除只删除**数据库记录**与 Nivlo 自己保存的文件（粘贴的截图）；
//!   被引用的用户文件**绝不**被删除（实施计划 2.2）。

use std::sync::Arc;

use chrono::{DateTime, Duration, Utc};
use nivlo_common::clock::Clock;
use nivlo_domain::event::DomainEvent;
use nivlo_domain::id::ItemId;
use nivlo_domain::item::Item;

use crate::error::AppError;
use crate::event::EventPublisher;
use crate::ports::{AttachmentFiles, Transaction, UnitOfWork};

/// 回收站里的 Item 保留多少天，之后自动永久清除（D-08）。
pub const TRASH_RETENTION_DAYS: i64 = 30;

/// 回收站里的一项。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrashEntry {
    /// 被删除的 Item。
    pub item: Item,
    /// 删除时间。
    pub deleted_at: DateTime<Utc>,
    /// 到期（自动永久清除）的时间。
    pub expires_at: DateTime<Utc>,
}

/// 回收站的 Use Case 集合。
#[derive(Clone)]
pub struct TrashService {
    /// 事务工厂。
    uow: Arc<dyn UnitOfWork>,
    /// 时钟：提供"现在"。
    clock: Arc<dyn Clock>,
    /// 提交成功后发布领域事件。
    events: Arc<dyn EventPublisher>,
    /// Nivlo 自己保存的附件文件。
    files: Arc<dyn AttachmentFiles>,
}

impl TrashService {
    /// 创建服务。
    pub fn new(
        uow: Arc<dyn UnitOfWork>,
        clock: Arc<dyn Clock>,
        events: Arc<dyn EventPublisher>,
        files: Arc<dyn AttachmentFiles>,
    ) -> Self {
        Self {
            uow,
            clock,
            events,
            files,
        }
    }

    /// 把一批 Item 移进回收站（一个事务：任何一条不存在，整批不变）。
    /// 已经在回收站里的保持原来的删除时间。
    ///
    /// # Errors
    ///
    /// * `ITEM_NOT_FOUND` - 某个 Item 不存在。
    /// * 存储错误，事务已回滚。
    pub async fn delete(&self, ids: &[ItemId]) -> Result<(), AppError> {
        let now = self.clock.now_utc();
        let mut tx = self.uow.begin().await?;
        for id in ids {
            tx.trash().mark_deleted(*id, now).await?;
            // 离开 Today 的手动顺序；恢复后由 Today 按默认规则重新排位。
            tx.today_order().remove_item(*id).await?;
        }
        tx.commit().await?;
        for id in ids {
            self.events
                .publish(DomainEvent::ItemDeleted { item_id: *id });
        }
        Ok(())
    }

    /// 把一批 Item 从回收站恢复，回到删除之前的样子。不在回收站里的被忽略（重复恢复是安全的）。
    ///
    /// # Errors
    ///
    /// 存储错误，事务已回滚。
    pub async fn restore(&self, ids: &[ItemId]) -> Result<(), AppError> {
        let mut tx = self.uow.begin().await?;
        let mut restored = Vec::new();
        for id in ids {
            if tx.trash().deleted_at(*id).await?.is_some() {
                tx.trash().restore(*id).await?;
                restored.push(*id);
            }
        }
        tx.commit().await?;
        for item_id in restored {
            self.events.publish(DomainEvent::ItemUpdated { item_id });
        }
        Ok(())
    }

    /// 回收站里的全部 Item，最近删除的在前。
    ///
    /// # Errors
    ///
    /// 存储错误。
    pub async fn list(&self) -> Result<Vec<TrashEntry>, AppError> {
        let mut tx = self.uow.begin_read().await?;
        Ok(tx
            .trash()
            .list_deleted()
            .await?
            .into_iter()
            .map(|(item, deleted_at)| TrashEntry {
                item,
                deleted_at,
                expires_at: deleted_at + Duration::days(TRASH_RETENTION_DAYS),
            })
            .collect())
    }

    /// 永久删除回收站里的这些 Item（及其来源、附件记录、标签关联）。
    ///
    /// 不在回收站里的 Item **不会**被删除：永久删除只能作用于已经删除过的东西，
    /// 避免一次误传的 ID 绕过回收站。返回实际删除的数量。
    ///
    /// # Errors
    ///
    /// 存储错误，此时没有删除任何东西。
    pub async fn purge(&self, ids: &[ItemId]) -> Result<usize, AppError> {
        let mut tx = self.uow.begin().await?;
        let mut targets = Vec::new();
        for id in ids {
            if tx.trash().deleted_at(*id).await?.is_some() {
                targets.push(*id);
            }
        }
        self.purge_in(tx, &targets).await
    }

    /// 清空回收站。返回删除的数量。
    ///
    /// # Errors
    ///
    /// 存储错误，此时没有删除任何东西。
    pub async fn empty(&self) -> Result<usize, AppError> {
        let mut tx = self.uow.begin().await?;
        let ids: Vec<ItemId> = tx
            .trash()
            .list_deleted()
            .await?
            .into_iter()
            .map(|(item, _)| item.id())
            .collect();
        self.purge_in(tx, &ids).await
    }

    /// 永久清除已经超过保留期的 Item（启动时与每天跨日时调用）。返回删除的数量。
    ///
    /// # Errors
    ///
    /// 存储错误，此时没有删除任何东西。
    pub async fn purge_expired(&self) -> Result<usize, AppError> {
        let cutoff = self.clock.now_utc() - Duration::days(TRASH_RETENTION_DAYS);
        let mut tx = self.uow.begin().await?;
        let ids = tx.trash().deleted_before(cutoff).await?;
        self.purge_in(tx, &ids).await
    }

    /// 在已开启的事务里永久删除 `ids`：提交之后才清理磁盘文件与发布事件。
    async fn purge_in(
        &self,
        mut tx: Box<dyn Transaction>,
        ids: &[ItemId],
    ) -> Result<usize, AppError> {
        if ids.is_empty() {
            return Ok(0);
        }
        let mut owned_files: Vec<String> = Vec::new();
        for id in ids {
            for attachment in tx.attachments().list_for_item(*id).await? {
                if attachment.owns_file() {
                    owned_files.push(attachment.path);
                }
            }
            tx.items().delete(*id).await?;
        }
        tx.commit().await?;
        for path in &owned_files {
            self.files.remove(path).await;
        }
        for id in ids {
            self.events
                .publish(DomainEvent::ItemDeleted { item_id: *id });
        }
        Ok(ids.len())
    }
}

#[cfg(test)]
mod tests;
