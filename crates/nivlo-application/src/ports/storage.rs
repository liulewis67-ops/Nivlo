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
use chrono::{DateTime, NaiveDate, Utc};
use nivlo_domain::attachment::Attachment;
use nivlo_domain::id::ItemId;
use nivlo_domain::item::{Item, ItemType};
use nivlo_domain::source::Source;

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

    /// 设置（键值）的 Repository 视图，与本事务共享同一个连接。
    fn settings(&mut self) -> &mut dyn SettingsRepository;

    /// Today 手动顺序的 Repository 视图，与本事务共享同一个连接。
    fn today_order(&mut self) -> &mut dyn TodayOrderRepository;

    /// Item 来源（Source）的 Repository 视图，与本事务共享同一个连接。
    fn sources(&mut self) -> &mut dyn SourceRepository;

    /// 附件（Attachment）的 Repository 视图，与本事务共享同一个连接。
    fn attachments(&mut self) -> &mut dyn AttachmentRepository;

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

    /// 列出计划日期**不晚于** `date` 的未完成、未归档 Todo（含逾期的），按计划日期、创建时间从早到晚排序。
    ///
    /// 这是 Today 的数据来源之一（实施计划 D-01：逾期未完成的 Todo 自动滚入 Today）。
    /// Repository 只表达"计划日期 ≤ date"这个查询条件，"这些就是 Today"的语义由
    /// `TodayService` 负责并测试。
    ///
    /// # Errors
    ///
    /// 任一记录无法还原为合法 Item 时返回 [`StorageError::Corrupt`]。
    async fn list_open_todos_scheduled_on_or_before(
        &mut self,
        date: NaiveDate,
    ) -> Result<Vec<Item>, StorageError>;

    /// 列出计划日期**恰好**为 `date` 的未归档 Tip。
    ///
    /// # Errors
    ///
    /// 任一记录无法还原为合法 Item 时返回 [`StorageError::Corrupt`]。
    async fn list_tips_scheduled_on(&mut self, date: NaiveDate) -> Result<Vec<Item>, StorageError>;

    /// 列出完成时间落在 `[from, to)` 内的未归档 Todo，按完成时间从早到晚排序。
    ///
    /// 用于"今天完成的 Todo"（实施计划 D-07）；调用方负责把本地日期换算成 UTC 区间。
    ///
    /// # Errors
    ///
    /// 任一记录无法还原为合法 Item 时返回 [`StorageError::Corrupt`]。
    async fn list_todos_completed_between(
        &mut self,
        from: DateTime<Utc>,
        to: DateTime<Utc>,
    ) -> Result<Vec<Item>, StorageError>;

    /// 按过滤条件列出 Item，按创建时间从新到旧排序。
    ///
    /// # Errors
    ///
    /// 任一记录无法还原为合法 Item 时返回 [`StorageError::Corrupt`]。
    async fn list(&mut self, filter: &ItemFilter) -> Result<Vec<Item>, StorageError>;
}

/// 业务设置的持久化操作（键值对，值为字符串，通常是 JSON）。
///
/// 对应 `settings` 表；窗口位置、置顶、快捷键等设置都存放在这里。
#[async_trait]
pub trait SettingsRepository: Send {
    /// 读取一个设置；不存在时返回 `Ok(None)`。
    ///
    /// # Errors
    ///
    /// 数据库不可用时返回 [`StorageError::Unavailable`]。
    async fn get(&mut self, key: &str) -> Result<Option<String>, StorageError>;

    /// 写入（覆盖）一个设置，并记录更新时间。
    ///
    /// # Errors
    ///
    /// 数据库不可用或违反约束时返回对应的 [`StorageError`]。
    async fn set(
        &mut self,
        key: &str,
        value: &str,
        updated_at: DateTime<Utc>,
    ) -> Result<(), StorageError>;
}

/// Today 手动执行顺序的持久化（`daily_item_order` 表）。
///
/// 顺序独立于 priority / created_at / due（Priority != Today Execution Order，架构文档 §31.3）。
#[async_trait]
pub trait TodayOrderRepository: Send {
    /// 读取某个本地日期的手动顺序（Item ID，按 position 升序）；没有记录时返回空列表。
    ///
    /// # Errors
    ///
    /// 数据库不可用或记录中的 ID 无法解析时返回对应的 [`StorageError`]。
    async fn get(&mut self, date: NaiveDate) -> Result<Vec<ItemId>, StorageError>;

    /// 用 `ids` 整体替换某个本地日期的手动顺序（position 从 0 开始连续编号）。
    ///
    /// 在调用方的事务内执行：删除旧记录与写入新记录要么一起生效要么一起回滚。
    ///
    /// # Errors
    ///
    /// 数据库不可用或违反约束（如 Item 不存在）时返回对应的 [`StorageError`]。
    async fn set(&mut self, date: NaiveDate, ids: &[ItemId]) -> Result<(), StorageError>;

    /// 删除某个 Item 在**所有日期**的顺序记录（它离开了 Today：推迟、改期……）。
    ///
    /// # Errors
    ///
    /// 数据库不可用时返回对应的 [`StorageError`]。
    async fn remove_item(&mut self, id: ItemId) -> Result<(), StorageError>;
}

/// Item 来源的持久化（`item_sources` 表）。记录随 Item 级联删除。
#[async_trait]
pub trait SourceRepository: Send {
    /// 插入一条来源记录。
    ///
    /// # Errors
    ///
    /// Item 不存在（外键）或数据库不可用时返回对应的 [`StorageError`]。
    async fn insert(&mut self, source: &Source) -> Result<(), StorageError>;

    /// 某个 Item 的全部来源，按捕获时间升序。
    ///
    /// # Errors
    ///
    /// 数据库不可用或记录损坏时返回对应的 [`StorageError`]。
    async fn list_for_item(&mut self, item_id: ItemId) -> Result<Vec<Source>, StorageError>;
}

/// 附件的持久化（`attachments` 表）。记录随 Item 级联删除，但**绝不**触碰磁盘上被引用的文件。
#[async_trait]
pub trait AttachmentRepository: Send {
    /// 插入一条附件记录。
    ///
    /// # Errors
    ///
    /// Item 不存在（外键）或数据库不可用时返回对应的 [`StorageError`]。
    async fn insert(&mut self, attachment: &Attachment) -> Result<(), StorageError>;

    /// 某个 Item 的全部附件，按添加时间升序。
    ///
    /// # Errors
    ///
    /// 数据库不可用或记录损坏时返回对应的 [`StorageError`]。
    async fn list_for_item(&mut self, item_id: ItemId) -> Result<Vec<Attachment>, StorageError>;
}
