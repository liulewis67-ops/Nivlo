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
//! 事务被丢弃而未提交时必须回滚。只读的 Use Case 用 `begin_read`：它不占写锁，不会让写入排队。

use async_trait::async_trait;
use chrono::{DateTime, NaiveDate, Utc};
use nivlo_domain::attachment::Attachment;
use nivlo_domain::id::{ItemId, ProjectId, TagId};
use nivlo_domain::item::{Item, ItemType};
use nivlo_domain::project::Project;
use nivlo_domain::source::Source;
use nivlo_domain::tag::{Tag, TagName};

use crate::trigger::TriggerKey;
use crate::workflow::{RunRecord, StoredWorkflow};
use nivlo_domain::workflow::{Workflow, WorkflowId};

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
    /// 开启一个**写**事务：一开始就拿到写锁，其他写事务排队等它提交。
    ///
    /// 会写入的 Use Case 必须用它。先读后写的事务如果在读之后才去拿写锁，别的连接在这期间提交过
    /// 写入时就会直接失败（SQLite WAL 的 `SQLITE_BUSY_SNAPSHOT`），不会等待。
    ///
    /// # Errors
    ///
    /// 数据库不可用（或等写锁超时）时返回 [`StorageError::Unavailable`]。
    async fn begin(&self) -> Result<Box<dyn Transaction>, StorageError>;

    /// 开启一个**只读**事务：多次查询看到同一个一致的快照，不占写锁（导出这类长时间的读取不会挡住写入）。
    ///
    /// 只读事务里不应写入；缺省实现直接用 [`UnitOfWork::begin`]。
    ///
    /// # Errors
    ///
    /// 数据库不可用时返回 [`StorageError::Unavailable`]。
    async fn begin_read(&self) -> Result<Box<dyn Transaction>, StorageError> {
        self.begin().await
    }
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

    /// 项目（Project）的 Repository 视图，与本事务共享同一个连接。
    fn projects(&mut self) -> &mut dyn ProjectRepository;

    /// 标签（Tag）及 Item-标签关联的 Repository 视图，与本事务共享同一个连接。
    fn tags(&mut self) -> &mut dyn TagRepository;

    /// 回收站（软删除）的 Repository 视图，与本事务共享同一个连接。
    fn trash(&mut self) -> &mut dyn TrashRepository;

    /// Workflow 与运行记录的 Repository 视图，与本事务共享同一个连接。
    fn workflows(&mut self) -> &mut dyn WorkflowRepository;

    /// Scheduler 触发记录的 Repository 视图，与本事务共享同一个连接。
    fn triggers(&mut self) -> &mut dyn TriggerRepository;

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

/// [`ItemRepository::list`] 的排序方式。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum ItemOrder {
    /// 创建时间从新到旧（默认）。
    #[default]
    CreatedDesc,
    /// 最近更新的在前（Notes 列表）。
    UpdatedDesc,
    /// 项目视图（D-05）：未完成的在前 → 优先级从高到低 → 计划日期从早到晚（没有计划的在后）→ 创建时间从新到旧。
    ProjectView,
    /// 最近使用的在前：最近一次打开（[`ItemRepository::mark_opened`]）与最近更新中较晚的那个。
    RecentDesc,
}

/// [`ItemRepository::list`] 的过滤条件。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ItemFilter {
    /// 只返回该类型；`None` 表示全部类型。
    pub item_type: Option<ItemType>,
    /// 是否包含已归档的 Item。
    pub include_archived: bool,
    /// 只返回仍在 Inbox 中等待整理的 Item（`in_inbox`，D-02）。
    pub in_inbox_only: bool,
    /// 只返回属于该项目的 Item。
    pub project_id: Option<ProjectId>,
    /// 只返回带有该标签的 Item。
    pub tag_id: Option<TagId>,
    /// 排序方式。
    pub order: ItemOrder,
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

    /// 永久删除一个 Item；它的来源、附件、标签关联、Today 顺序记录随外键级联删除。
    ///
    /// 只删除**数据库记录**，不触碰磁盘文件——哪些文件该清理由调用方决定
    /// （被引用的用户文件永远不删，见实施计划 2.2）。Item 不存在时是空操作。
    ///
    /// # Errors
    ///
    /// 数据库不可用时返回 [`StorageError::Unavailable`]。
    async fn delete(&mut self, id: ItemId) -> Result<(), StorageError>;

    /// 记录 Item 在 `at` 被打开过（只影响 [`ItemOrder::RecentDesc`] 排序）。
    ///
    /// 不改 `updated_at`，也不是领域状态。Item 不存在或在回收站里时是空操作。
    ///
    /// # Errors
    ///
    /// 数据库不可用时返回 [`StorageError::Unavailable`]。
    async fn mark_opened(&mut self, id: ItemId, at: DateTime<Utc>) -> Result<(), StorageError>;

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

    /// Calendar 的数据来源：计划日期**或**截止日期落在 `[from, to]`（闭区间）内的未归档、未删除 Item。
    ///
    /// 同时满足两者的 Item 只返回一次，由调用方拆成计划条目与截止标记。
    ///
    /// # Errors
    ///
    /// 记录无法还原为合法 Item 时返回 [`StorageError::Corrupt`]。
    async fn list_calendar(
        &mut self,
        from: NaiveDate,
        to: NaiveDate,
    ) -> Result<Vec<Item>, StorageError>;

    /// 没有计划日期的未完成、未归档、未删除 Todo（Calendar 的「待安排」），最近创建的在前。
    ///
    /// # Errors
    ///
    /// 记录无法还原为合法 Item 时返回 [`StorageError::Corrupt`]。
    async fn list_unscheduled_open_todos(&mut self, limit: u32) -> Result<Vec<Item>, StorageError>;

    /// 全文搜索（实施计划 3.4）：在标题、正文与来源（原始标题 / 网址 / 路径）里按子串匹配，
    /// 忽略大小写；中文也按子串匹配（「登录」能找到「修复登录超时」）。
    ///
    /// `text` 按空白拆成多个词，每个词都要出现（AND）；少于 3 个字符的词索引无法匹配，
    /// 会被忽略——除非所有词都很短，此时把整段文字当作一个子串扫描。
    /// 未完成的排在已完成的前面（已经做完的事很少是要找的那条）；同一档里标题命中的在前，
    /// 其次按相关度与最近更新。`text` 为空白时返回空列表。
    ///
    /// # Errors
    ///
    /// 记录无法还原为合法 Item 时返回 [`StorageError::Corrupt`]。
    async fn search(
        &mut self,
        text: &str,
        include_archived: bool,
        limit: u32,
    ) -> Result<Vec<Item>, StorageError>;
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

/// 项目的持久化（`projects` 表）。项目被删除时 Item 保留，只是不再属于任何项目。
#[async_trait]
pub trait ProjectRepository: Send {
    /// 插入一个新项目。
    ///
    /// # Errors
    ///
    /// ID 重复或数据库不可用时返回对应的 [`StorageError`]。
    async fn insert(&mut self, project: &Project) -> Result<(), StorageError>;

    /// 用 `project` 的当前状态覆盖已存在的记录。
    ///
    /// # Errors
    ///
    /// 记录不存在时返回 [`StorageError::NotFound`]（`entity` 为 `"project"`）。
    async fn update(&mut self, project: &Project) -> Result<(), StorageError>;

    /// 按 ID 读取项目；不存在时返回 `Ok(None)`。
    ///
    /// # Errors
    ///
    /// 记录损坏时返回 [`StorageError::Corrupt`]。
    async fn get(&mut self, id: ProjectId) -> Result<Option<Project>, StorageError>;

    /// 列出项目，按创建时间从早到晚；`include_archived` 为 `false` 时不含已归档的。
    ///
    /// # Errors
    ///
    /// 记录损坏时返回 [`StorageError::Corrupt`]。
    async fn list(&mut self, include_archived: bool) -> Result<Vec<Project>, StorageError>;

    /// 每个项目里「未归档且未完成」的 Item 数量；没有这样的 Item 的项目不出现。
    ///
    /// # Errors
    ///
    /// 数据库不可用时返回对应的 [`StorageError`]。
    async fn open_item_counts(&mut self) -> Result<Vec<(ProjectId, u32)>, StorageError>;
}

/// 标签及 Item-标签关联的持久化（`tags` / `item_tags` 表）。标签名按小写比较键大小写不敏感地唯一。
#[async_trait]
pub trait TagRepository: Send {
    /// 插入一个新标签。
    ///
    /// # Errors
    ///
    /// 同名（忽略大小写）标签已存在时返回 [`StorageError::Constraint`]。
    async fn insert(&mut self, tag: &Tag) -> Result<(), StorageError>;

    /// 按 ID 读取标签；不存在时返回 `Ok(None)`。
    ///
    /// # Errors
    ///
    /// 记录损坏时返回 [`StorageError::Corrupt`]。
    async fn get(&mut self, id: TagId) -> Result<Option<Tag>, StorageError>;

    /// 按名称（忽略大小写）查找标签。
    ///
    /// # Errors
    ///
    /// 记录损坏时返回 [`StorageError::Corrupt`]。
    async fn find_by_name(&mut self, name: &TagName) -> Result<Option<Tag>, StorageError>;

    /// 全部标签及各自关联的未归档 Item 数量，按名称排序。
    ///
    /// # Errors
    ///
    /// 记录损坏时返回 [`StorageError::Corrupt`]。
    async fn list_with_counts(&mut self) -> Result<Vec<(Tag, u32)>, StorageError>;

    /// 重命名标签。
    ///
    /// # Errors
    ///
    /// * [`StorageError::NotFound`]（`entity` 为 `"tag"`）- 标签不存在。
    /// * [`StorageError::Constraint`] - 新名称与另一个标签重名。
    async fn rename(&mut self, id: TagId, name: &TagName) -> Result<(), StorageError>;

    /// 把 `from` 的全部关联并入 `into`（已同时带有两者的 Item 只保留一条），然后删除 `from`。
    ///
    /// # Errors
    ///
    /// 任一标签不存在时返回 [`StorageError::NotFound`]。
    async fn merge(&mut self, from: TagId, into: TagId) -> Result<(), StorageError>;

    /// 某个 Item 的标签，按名称排序。
    ///
    /// # Errors
    ///
    /// 记录损坏时返回 [`StorageError::Corrupt`]。
    async fn for_item(&mut self, item_id: ItemId) -> Result<Vec<Tag>, StorageError>;

    /// 用 `tags` 整体替换某个 Item 的标签。
    ///
    /// # Errors
    ///
    /// Item 或标签不存在（外键）时返回 [`StorageError::Constraint`]。
    async fn set_for_item(&mut self, item_id: ItemId, tags: &[TagId]) -> Result<(), StorageError>;
}

/// 回收站（软删除）的持久化（`items.deleted_at`，D-08）。
///
/// 已删除的 Item 不会出现在 [`ItemRepository`] 的任何列表 / 搜索 / 统计里，
/// 但 [`ItemRepository::get`] 仍然能按 ID 读到它（恢复与彻底删除需要）。
#[async_trait]
pub trait TrashRepository: Send {
    /// 把 Item 标记为已删除；已经在回收站里的保持原来的删除时间。
    ///
    /// # Errors
    ///
    /// Item 不存在时返回 [`StorageError::NotFound`]。
    async fn mark_deleted(&mut self, id: ItemId, at: DateTime<Utc>) -> Result<(), StorageError>;

    /// 把 Item 移出回收站；本来就不在回收站里是空操作。
    ///
    /// # Errors
    ///
    /// 数据库不可用时返回对应的 [`StorageError`]。
    async fn restore(&mut self, id: ItemId) -> Result<(), StorageError>;

    /// Item 被删除的时间；不在回收站里（或不存在）为 `None`。
    ///
    /// # Errors
    ///
    /// 记录损坏时返回 [`StorageError::Corrupt`]。
    async fn deleted_at(&mut self, id: ItemId) -> Result<Option<DateTime<Utc>>, StorageError>;

    /// 回收站里的全部 Item 与删除时间，最近删除的在前。
    ///
    /// # Errors
    ///
    /// 记录损坏时返回 [`StorageError::Corrupt`]。
    async fn list_deleted(&mut self) -> Result<Vec<(Item, DateTime<Utc>)>, StorageError>;

    /// 删除时间早于 `cutoff` 的 Item ID（已超过保留期，等待自动清除）。
    ///
    /// # Errors
    ///
    /// 记录损坏时返回 [`StorageError::Corrupt`]。
    async fn deleted_before(&mut self, cutoff: DateTime<Utc>) -> Result<Vec<ItemId>, StorageError>;
}

/// Scheduler 的触发记录（`trigger_log` 表，实施计划 4.4）：只记录**哪些触发点已经通知过**。
#[async_trait]
pub trait TriggerRepository: Send {
    /// 可能产生触发点的 Item：未完成、未归档、未删除，并且有提醒时间、或是带具体时间的 Tip /
    /// 带具体截止时间的 Todo。是否真的会触发由 [`crate::trigger::triggers_of`] 推导。
    ///
    /// # Errors
    ///
    /// 记录无法还原为合法 Item 时返回 [`StorageError::Corrupt`]。
    async fn list_trigger_sources(&mut self) -> Result<Vec<Item>, StorageError>;

    /// 触发时刻不早于 `since` 的、已经通知过的触发点。
    ///
    /// # Errors
    ///
    /// 记录损坏时返回 [`StorageError::Corrupt`]。
    async fn list_fired_since(
        &mut self,
        since: DateTime<Utc>,
    ) -> Result<Vec<TriggerKey>, StorageError>;

    /// 记录一个触发点已经通知过；重复记录是空操作。`missed` 表示这是错过之后的补发。
    ///
    /// # Errors
    ///
    /// Item 不存在（外键）时返回 [`StorageError::Constraint`]。
    async fn record_fired(
        &mut self,
        key: &TriggerKey,
        fired_at: DateTime<Utc>,
        missed: bool,
    ) -> Result<(), StorageError>;

    /// 删除触发时刻早于 `cutoff` 的记录，返回删除的数量。
    ///
    /// # Errors
    ///
    /// 数据库不可用时返回对应的 [`StorageError`]。
    async fn prune_fired_before(&mut self, cutoff: DateTime<Utc>) -> Result<u64, StorageError>;
}

/// Workflow 定义与运行记录的持久化（`workflows` / `workflow_runs` / `workflow_run_steps` 表）。
#[async_trait]
pub trait WorkflowRepository: Send {
    /// 全部 Workflow。
    ///
    /// # Errors
    ///
    /// 定义无法解析时返回 [`StorageError::Corrupt`]。
    async fn list(&mut self) -> Result<Vec<StoredWorkflow>, StorageError>;

    /// 按 ID 读取；不存在返回 `Ok(None)`。
    ///
    /// # Errors
    ///
    /// 定义无法解析时返回 [`StorageError::Corrupt`]。
    async fn get(&mut self, id: &WorkflowId) -> Result<Option<StoredWorkflow>, StorageError>;

    /// 插入或整体覆盖一个 Workflow；已存在时保留创建时间。
    ///
    /// # Errors
    ///
    /// 数据库不可用时返回对应的 [`StorageError`]。
    async fn upsert(&mut self, workflow: &Workflow, now: DateTime<Utc>)
    -> Result<(), StorageError>;

    /// 删除一个 Workflow；不存在是空操作。运行记录保留。
    ///
    /// # Errors
    ///
    /// 数据库不可用时返回对应的 [`StorageError`]。
    async fn delete(&mut self, id: &WorkflowId) -> Result<(), StorageError>;

    /// 写入一条运行记录（连同它的 Step 记录）。
    ///
    /// # Errors
    ///
    /// 数据库不可用时返回对应的 [`StorageError`]。
    async fn insert_run(&mut self, run: &RunRecord) -> Result<(), StorageError>;

    /// 最近的运行记录，新的在前，带 Step 记录。
    ///
    /// # Errors
    ///
    /// 记录损坏时返回 [`StorageError::Corrupt`]。
    async fn list_runs(&mut self, limit: u32) -> Result<Vec<RunRecord>, StorageError>;

    /// 清理运行记录：只保留最近 `keep` 条，且删除开始时间早于 `before` 的。返回删除的条数。
    ///
    /// # Errors
    ///
    /// 数据库不可用时返回对应的 [`StorageError`]。
    async fn prune_runs(&mut self, keep: u32, before: DateTime<Utc>) -> Result<u64, StorageError>;
}
