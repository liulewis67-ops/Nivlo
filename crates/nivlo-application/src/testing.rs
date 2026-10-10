//! 测试替身：内存版 `UnitOfWork` 与事件记录器。
//!
//! 让 Use Case 测试不依赖 SQLite（后端规范 §12）。启用 `testing` feature 后其他 crate 也可使用。
//! 行为与真实 Adapter 对齐：事务内的写入只有在 `commit` 之后才对外可见，
//! 事务被丢弃时自动回滚；列表与查询的过滤、排序规则与 `ItemRepository` 文档约定一致。

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use async_trait::async_trait;
use chrono::{DateTime, NaiveDate, Utc};
use nivlo_domain::event::DomainEvent;
use nivlo_domain::id::ItemId;
use nivlo_domain::item::{Item, ItemStatus, ItemType};

use crate::event::EventPublisher;
use crate::ports::{
    ItemFilter, ItemRepository, SettingsRepository, StorageError, TodayOrderRepository,
    Transaction, UnitOfWork,
};

/// 内存数据库中的全部数据。事务开始时整体克隆为工作副本，提交时整体替换。
#[derive(Debug, Clone, Default)]
struct FakeData {
    /// Item。
    items: BTreeMap<ItemId, Item>,
    /// 设置。
    settings: BTreeMap<String, String>,
    /// 每个本地日期的 Today 手动顺序。
    today_order: BTreeMap<NaiveDate, Vec<ItemId>>,
}

/// 内存数据库的共享状态。
#[derive(Debug, Default)]
struct FakeState {
    /// 已提交的数据。
    data: FakeData,
    /// 为 `true` 时下一次 `commit` 失败（用于测试回滚路径），触发后自动复位。
    fail_next_commit: bool,
}

/// 内存版 [`UnitOfWork`]。克隆共享同一份数据。
#[derive(Debug, Clone, Default)]
pub struct FakeUnitOfWork {
    /// 共享状态。
    state: Arc<Mutex<FakeState>>,
}

impl FakeUnitOfWork {
    /// 创建一个空的内存数据库。
    pub fn new() -> Self {
        Self::default()
    }

    /// 获取状态锁；锁中毒只会发生在其他测试线程 panic 后，数据仍可用。
    fn lock(&self) -> MutexGuard<'_, FakeState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// 让下一次 `commit` 返回错误。
    pub fn fail_next_commit(&self) {
        self.lock().fail_next_commit = true;
    }

    /// 返回当前已提交的全部 Item（按 ID 排序）。
    pub fn committed_items(&self) -> Vec<Item> {
        self.lock().data.items.values().cloned().collect()
    }

    /// 返回当前已提交的某个设置。
    pub fn committed_setting(&self, key: &str) -> Option<String> {
        self.lock().data.settings.get(key).cloned()
    }

    /// 直接放入一个已存在的 Item，跳过 Use Case，用于准备测试数据。
    pub fn seed(&self, item: Item) {
        self.lock().data.items.insert(item.id(), item);
    }

    /// 直接写入某个日期的 Today 手动顺序，用于准备测试数据。
    pub fn seed_today_order(&self, date: NaiveDate, ids: Vec<ItemId>) {
        self.lock().data.today_order.insert(date, ids);
    }
}

#[async_trait]
impl UnitOfWork for FakeUnitOfWork {
    /// 开启事务：复制当前已提交数据作为工作副本。
    async fn begin(&self) -> Result<Box<dyn Transaction>, StorageError> {
        let working = self.lock().data.clone();
        Ok(Box::new(FakeTransaction {
            shared: self.clone(),
            working,
        }))
    }
}

/// 内存事务：在工作副本上读写，提交时整体替换已提交数据。
struct FakeTransaction {
    /// 所属数据库。
    shared: FakeUnitOfWork,
    /// 本事务的工作副本；丢弃即回滚。
    working: FakeData,
}

#[async_trait]
impl Transaction for FakeTransaction {
    /// 返回 Item Repository 视图。
    fn items(&mut self) -> &mut dyn ItemRepository {
        self
    }

    /// 返回设置 Repository 视图。
    fn settings(&mut self) -> &mut dyn SettingsRepository {
        self
    }

    /// 返回 Today 顺序 Repository 视图。
    fn today_order(&mut self) -> &mut dyn TodayOrderRepository {
        self
    }

    /// 提交：把工作副本写回共享状态。
    async fn commit(self: Box<Self>) -> Result<(), StorageError> {
        let mut state = self.shared.lock();
        if state.fail_next_commit {
            state.fail_next_commit = false;
            return Err(StorageError::Unavailable("模拟的提交失败".to_owned()));
        }
        state.data = self.working;
        Ok(())
    }

    /// 回滚：丢弃工作副本。
    async fn rollback(self: Box<Self>) -> Result<(), StorageError> {
        Ok(())
    }
}

#[async_trait]
impl ItemRepository for FakeTransaction {
    /// 插入；ID 重复视为约束冲突。
    async fn insert(&mut self, item: &Item) -> Result<(), StorageError> {
        if self.working.items.contains_key(&item.id()) {
            return Err(StorageError::Constraint(format!(
                "重复的 Item ID {}",
                item.id()
            )));
        }
        self.working.items.insert(item.id(), item.clone());
        Ok(())
    }

    /// 更新；不存在视为 NotFound。
    async fn update(&mut self, item: &Item) -> Result<(), StorageError> {
        match self.working.items.get_mut(&item.id()) {
            Some(slot) => {
                *slot = item.clone();
                Ok(())
            }
            None => Err(StorageError::NotFound {
                entity: "item",
                id: item.id().to_string(),
            }),
        }
    }

    /// 按 ID 读取。
    async fn get(&mut self, id: ItemId) -> Result<Option<Item>, StorageError> {
        Ok(self.working.items.get(&id).cloned())
    }

    /// 计划日期不晚于 `date` 的未完成、未归档 Todo，按计划日期、创建时间、ID 升序。
    async fn list_open_todos_scheduled_on_or_before(
        &mut self,
        date: NaiveDate,
    ) -> Result<Vec<Item>, StorageError> {
        let mut items: Vec<Item> = self
            .working
            .items
            .values()
            .filter(|i| i.item_type() == ItemType::Todo)
            .filter(|i| i.status() == ItemStatus::Open && !i.is_archived())
            .filter(|i| i.scheduled().is_some_and(|s| s.date() <= date))
            .cloned()
            .collect();
        items.sort_by_key(|i| (i.scheduled().map(|s| s.date()), i.created_at(), i.id()));
        Ok(items)
    }

    /// 计划日期恰为 `date` 的未归档 Tip（顺序不作保证，由调用方排序）。
    async fn list_tips_scheduled_on(&mut self, date: NaiveDate) -> Result<Vec<Item>, StorageError> {
        Ok(self
            .working
            .items
            .values()
            .filter(|i| i.item_type() == ItemType::Tip && !i.is_archived())
            .filter(|i| i.scheduled().is_some_and(|s| s.date() == date))
            .cloned()
            .collect())
    }

    /// 完成时间在 `[from, to)` 内的未归档 Todo，按完成时间升序。
    async fn list_todos_completed_between(
        &mut self,
        from: DateTime<Utc>,
        to: DateTime<Utc>,
    ) -> Result<Vec<Item>, StorageError> {
        let mut items: Vec<Item> = self
            .working
            .items
            .values()
            .filter(|i| i.item_type() == ItemType::Todo && !i.is_archived())
            .filter(|i| i.completed_at().is_some_and(|at| at >= from && at < to))
            .cloned()
            .collect();
        items.sort_by_key(|i| (i.completed_at(), i.id()));
        Ok(items)
    }

    /// 列表：创建时间倒序，同一时刻按 ID 倒序，与真实 Adapter 一致。
    async fn list(&mut self, filter: &ItemFilter) -> Result<Vec<Item>, StorageError> {
        let mut items: Vec<Item> = self
            .working
            .items
            .values()
            .filter(|i| filter.item_type.is_none_or(|t| i.item_type() == t))
            .filter(|i| filter.include_archived || !i.is_archived())
            .cloned()
            .collect();
        items.sort_by(|a, b| {
            b.created_at()
                .cmp(&a.created_at())
                .then(b.id().cmp(&a.id()))
        });
        if let Some(limit) = filter.limit {
            items.truncate(limit as usize);
        }
        Ok(items)
    }
}

#[async_trait]
impl SettingsRepository for FakeTransaction {
    /// 按 key 读取。
    async fn get(&mut self, key: &str) -> Result<Option<String>, StorageError> {
        Ok(self.working.settings.get(key).cloned())
    }

    /// 写入并覆盖；内存版忽略更新时间。
    async fn set(
        &mut self,
        key: &str,
        value: &str,
        _updated_at: DateTime<Utc>,
    ) -> Result<(), StorageError> {
        self.working
            .settings
            .insert(key.to_owned(), value.to_owned());
        Ok(())
    }
}

#[async_trait]
impl TodayOrderRepository for FakeTransaction {
    /// 读取某日的手动顺序；没有记录时为空。
    async fn get(&mut self, date: NaiveDate) -> Result<Vec<ItemId>, StorageError> {
        Ok(self
            .working
            .today_order
            .get(&date)
            .cloned()
            .unwrap_or_default())
    }
}

/// 记录所有发布事件的 [`EventPublisher`]，供测试断言。
#[derive(Debug, Default)]
pub struct RecordingPublisher {
    /// 按发布顺序记录的事件。
    events: Mutex<Vec<DomainEvent>>,
}

impl RecordingPublisher {
    /// 创建一个空记录器。
    pub fn new() -> Self {
        Self::default()
    }

    /// 返回迄今为止发布的全部事件。
    pub fn events(&self) -> Vec<DomainEvent> {
        self.events
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    /// 清空已记录的事件，便于只断言之后发生的事。
    pub fn clear(&self) {
        self.events
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clear();
    }
}

impl EventPublisher for RecordingPublisher {
    /// 记录事件。
    fn publish(&self, event: DomainEvent) {
        self.events
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(event);
    }
}
