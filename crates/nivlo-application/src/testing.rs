//! 测试替身：内存版 `UnitOfWork` 与事件记录器。
//!
//! 让 Use Case 测试不依赖 SQLite（后端规范 §12）。启用 `testing` feature 后其他 crate 也可使用。
//! 行为与真实 Adapter 对齐：事务内的写入只有在 `commit` 之后才对外可见，
//! 事务被丢弃时自动回滚；列表排序规则与 `ItemRepository::list` 的约定一致。

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use nivlo_domain::event::DomainEvent;
use nivlo_domain::id::ItemId;
use nivlo_domain::item::Item;

use crate::event::EventPublisher;
use crate::ports::{
    ItemFilter, ItemRepository, SettingsRepository, StorageError, Transaction, UnitOfWork,
};

/// 内存数据库的共享状态。
#[derive(Debug, Default)]
struct FakeState {
    /// 已提交的 Item。
    items: BTreeMap<ItemId, Item>,
    /// 已提交的设置。
    settings: BTreeMap<String, String>,
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
        self.lock().items.values().cloned().collect()
    }

    /// 返回当前已提交的某个设置。
    pub fn committed_setting(&self, key: &str) -> Option<String> {
        self.lock().settings.get(key).cloned()
    }

    /// 直接放入一个已存在的 Item，跳过 Use Case，用于准备测试数据。
    pub fn seed(&self, item: Item) {
        self.lock().items.insert(item.id(), item);
    }
}

#[async_trait]
impl UnitOfWork for FakeUnitOfWork {
    /// 开启事务：复制当前已提交数据作为工作副本。
    async fn begin(&self) -> Result<Box<dyn Transaction>, StorageError> {
        let (working, working_settings) = {
            let state = self.lock();
            (state.items.clone(), state.settings.clone())
        };
        Ok(Box::new(FakeTransaction {
            shared: self.clone(),
            working,
            working_settings,
        }))
    }
}

/// 内存事务：在工作副本上读写，提交时整体替换已提交数据。
struct FakeTransaction {
    /// 所属数据库。
    shared: FakeUnitOfWork,
    /// 本事务的 Item 工作副本；丢弃即回滚。
    working: BTreeMap<ItemId, Item>,
    /// 本事务的设置工作副本；丢弃即回滚。
    working_settings: BTreeMap<String, String>,
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

    /// 提交：把工作副本写回共享状态。
    async fn commit(self: Box<Self>) -> Result<(), StorageError> {
        let mut state = self.shared.lock();
        if state.fail_next_commit {
            state.fail_next_commit = false;
            return Err(StorageError::Unavailable("模拟的提交失败".to_owned()));
        }
        state.items = self.working;
        state.settings = self.working_settings;
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
        if self.working.contains_key(&item.id()) {
            return Err(StorageError::Constraint(format!(
                "重复的 Item ID {}",
                item.id()
            )));
        }
        self.working.insert(item.id(), item.clone());
        Ok(())
    }

    /// 更新；不存在视为 NotFound。
    async fn update(&mut self, item: &Item) -> Result<(), StorageError> {
        match self.working.get_mut(&item.id()) {
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
        Ok(self.working.get(&id).cloned())
    }

    /// 列表：创建时间倒序，同一时刻按 ID 倒序，与真实 Adapter 一致。
    async fn list(&mut self, filter: &ItemFilter) -> Result<Vec<Item>, StorageError> {
        let mut items: Vec<Item> = self
            .working
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
        Ok(self.working_settings.get(key).cloned())
    }

    /// 写入并覆盖；内存版忽略更新时间。
    async fn set(
        &mut self,
        key: &str,
        value: &str,
        _updated_at: DateTime<Utc>,
    ) -> Result<(), StorageError> {
        self.working_settings
            .insert(key.to_owned(), value.to_owned());
        Ok(())
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
