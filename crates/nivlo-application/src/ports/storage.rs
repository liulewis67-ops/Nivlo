//! 存储 Port：`UnitOfWork`、`Transaction` 与各 Repository。
//!
//! 用法示意（事务范围由 Use Case 决定，参见后端规范 §15.4）：
//!
//! ```ignore
//! let mut tx = uow.begin().await?;
//! tx.items().insert(&item).await?;
//! tx.commit().await?;
//! // 只有提交成功后才发布事件。
//! ```
//!
//! 事务被丢弃而未提交时必须回滚。

use async_trait::async_trait;
use nivlo_domain::id::ItemId;
use nivlo_domain::item::{Item, ItemType};

/// 存储 Adapter 返回的错误。
///
/// Adapter 必须把底层库的错误（如 `sqlx::Error`）转换为本类型，不向上泄漏具体实现。
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum StorageError {
    /// 要更新或读取的记录不存在。
    #[error("记录不存在：{entity} {id}")]
    NotFound {
        /// 实体名称，如 `"item"`。
        entity: &'static str,
        /// 记录 ID 的文本形式。
        id: String,
    },
    /// 违反数据库约束（外键、唯一、CHECK 等）。
    #[error("违反数据库约束：{0}")]
    Constraint(String),
    /// 数据库暂时不可用或 IO 失败。
    #[error("数据库不可用：{0}")]
    Unavailable(String),
    /// 数据库中的记录无法还原为合法的领域对象。
    #[error("存储的数据已损坏：{0}")]
    Corrupt(String),
    /// 数据库迁移失败；此时不得启动业务 Runtime（架构文档 §30）。
    #[error("数据库迁移失败：{0}")]
    Migration(String),
}

/// 事务工厂。
#[async_trait]
pub trait UnitOfWork: Send + Sync {
    /// 开启一个新事务。
    ///
    /// # Errors
    ///
    /// 数据库不可用时返回 [`StorageError::Unavailable`]。
    async fn begin(&self) -> Result<Box<dyn Transaction>, StorageError>;
}

/// 一个进行中的事务，聚合了各 Repository 的访问入口。
///
/// 事务被丢弃而未调用 [`Transaction::commit`] 时，所有写入都会回滚。
#[async_trait]
pub trait Transaction: Send {
    /// Item 的 Repository 视图，与本事务共享同一个连接。
    fn items(&mut self) -> &mut dyn ItemRepository;

    /// 提交事务。
    ///
    /// # Errors
    ///
    /// 提交失败（如磁盘已满）时返回错误，此时所有写入都已回滚。
    async fn commit(self: Box<Self>) -> Result<(), StorageError>;

    /// 显式回滚事务。
    ///
    /// # Errors
    ///
    /// 回滚失败时返回 [`StorageError::Unavailable`]。
    async fn rollback(self: Box<Self>) -> Result<(), StorageError>;
}

/// [`ItemRepository::list`] 的过滤条件。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ItemFilter {
    /// 只返回该类型；`None` 表示全部类型。
    pub item_type: Option<ItemType>,
    /// 是否包含已归档的 Item。
    pub include_archived: bool,
    /// 最多返回的条数；`None` 表示不限制。
    pub limit: Option<u32>,
}

/// Item 的持久化操作。
///
/// Repository 只做数据映射与读写，不包含业务判断（后端规范 §4.3）。
#[async_trait]
pub trait ItemRepository: Send {
    /// 插入一个新 Item。
    ///
    /// # Errors
    ///
    /// ID 重复或外键不满足时返回 [`StorageError::Constraint`]。
    async fn insert(&mut self, item: &Item) -> Result<(), StorageError>;

    /// 用 `item` 的当前状态整体覆盖已存在的记录。
    ///
    /// # Errors
    ///
    /// 记录不存在时返回 [`StorageError::NotFound`]；违反约束时返回 [`StorageError::Constraint`]。
    async fn update(&mut self, item: &Item) -> Result<(), StorageError>;

    /// 按 ID 读取 Item；不存在时返回 `Ok(None)`。
    ///
    /// # Errors
    ///
    /// 记录无法还原为合法 Item 时返回 [`StorageError::Corrupt`]。
    async fn get(&mut self, id: ItemId) -> Result<Option<Item>, StorageError>;

    /// 按过滤条件列出 Item，按创建时间从新到旧排序。
    ///
    /// # Errors
    ///
    /// 任一记录无法还原为合法 Item 时返回 [`StorageError::Corrupt`]。
    async fn list(&mut self, filter: &ItemFilter) -> Result<Vec<Item>, StorageError>;
}
