//! `ItemService`：Item 的创建、更新、读取与列表。
//!
//! 每个写操作都遵循同一个模式（后端规范 §4.2、架构文档 §56）：
//!
//! 1. 开启事务；
//! 2. 在事务内读取并修改 Domain 对象，所有业务规则由 Domain 保证；
//! 3. 写回并**提交**；
//! 4. 只有提交成功后才发布领域事件——事务回滚时前端不会收到一个随后消失的变更。

use std::sync::Arc;

use nivlo_common::clock::Clock;
use nivlo_common::id::new_uuid_v7;
use nivlo_domain::event::DomainEvent;
use nivlo_domain::id::ItemId;
use nivlo_domain::item::{Item, NewItem};

use super::input::UpdateItemInput;
use crate::error::AppError;
use crate::event::EventPublisher;
use crate::ports::{ItemFilter, UnitOfWork};

/// 创建 Item 的输入。直接复用领域的 [`NewItem`]，字段含义见其文档。
pub type CreateItemInput = NewItem;

/// Item 的 Use Case 集合。
#[derive(Clone)]
pub struct ItemService {
    /// 事务工厂。
    uow: Arc<dyn UnitOfWork>,
    /// 时钟：提供"现在"并用于生成 UUIDv7。
    clock: Arc<dyn Clock>,
    /// 提交成功后发布领域事件。
    events: Arc<dyn EventPublisher>,
}

impl ItemService {
    /// 创建服务。
    pub fn new(
        uow: Arc<dyn UnitOfWork>,
        clock: Arc<dyn Clock>,
        events: Arc<dyn EventPublisher>,
    ) -> Self {
        Self { uow, clock, events }
    }

    /// 创建一个 Item。
    ///
    /// 在单个事务中写入；提交后发布 [`DomainEvent::ItemCreated`]，
    /// 若设置了计划 / 截止 / 提醒，再发布 [`DomainEvent::ScheduleChanged`] 通知 Scheduler。
    ///
    /// # Errors
    ///
    /// * 领域规则错误（标题为空、字段不适用等）映射为对应错误码，数据库不变。
    /// * [`crate::error::ErrorCode::StorageUnavailable`] 等存储错误，事务已回滚。
    pub async fn create_item(&self, input: CreateItemInput) -> Result<Item, AppError> {
        let now = self.clock.now_utc();
        let has_schedule =
            input.scheduled.is_some() || input.due.is_some() || input.reminder_at.is_some();
        let id = ItemId::from_uuid(new_uuid_v7(self.clock.as_ref()));
        let (item, created) = Item::create(id, input, now)?;

        let mut tx = self.uow.begin().await?;
        tx.items().insert(&item).await?;
        tx.commit().await?;

        // 提交成功之后才发布事件，避免订阅者看到随后被回滚的 Item。
        self.events.publish(created);
        if has_schedule {
            self.events
                .publish(DomainEvent::ScheduleChanged { item_id: id });
        }
        Ok(item)
    }

    /// 修改一个 Item 的若干字段。
    ///
    /// 先转换类型（如有），再设置其他字段，这样"Todo 转 Note 同时清除截止日期"这类组合修改
    /// 不会因为中间状态而被领域规则拒绝。任何一步失败都会丢弃事务，Item 保持原样。
    /// 没有任何修改时不写数据库、不发布事件。
    ///
    /// # Errors
    ///
    /// * [`crate::error::ErrorCode::ItemNotFound`] - Item 不存在。
    /// * 领域规则错误映射为对应错误码。
    /// * 存储错误，事务已回滚。
    pub async fn update_item(&self, id: ItemId, input: UpdateItemInput) -> Result<Item, AppError> {
        let now = self.clock.now_utc();
        let mut tx = self.uow.begin().await?;
        let mut item = tx
            .items()
            .get(id)
            .await?
            .ok_or_else(|| AppError::item_not_found(id))?;
        if input.is_empty() {
            return Ok(item);
        }

        let mut events: Vec<DomainEvent> = Vec::new();
        let mut record = |event: DomainEvent| {
            if !events.contains(&event) {
                events.push(event);
            }
        };

        if let Some(item_type) = input.item_type {
            record(item.change_type(item_type, now));
        }
        if let Some(title) = &input.title {
            record(item.rename(title, now)?);
        }
        if input.content.is_change() || input.content_format.is_some() {
            let content = input.content.apply(item.content().map(str::to_owned));
            let format = input
                .content_format
                .unwrap_or_else(|| item.content_format());
            record(item.set_content(content, format, now)?);
        }
        if let Some(priority) = input.priority {
            record(item.set_priority(priority, now)?);
        }
        if input.scheduled.is_change() {
            record(item.set_scheduled(input.scheduled.apply(item.scheduled()), now));
        }
        if input.due.is_change() {
            record(item.set_due(input.due.apply(item.due()), now)?);
        }
        if input.reminder_at.is_change() {
            record(item.set_reminder(input.reminder_at.apply(item.reminder_at()), now)?);
        }
        if input.project_id.is_change() {
            record(item.set_project(input.project_id.apply(item.project_id()), now));
        }

        tx.items().update(&item).await?;
        tx.commit().await?;

        // 无论具体改了哪些字段，订阅 UI 的一方只关心"Item 变了"；
        // 额外的 ScheduleChanged / ItemTypeChanged 留给需要它们的订阅者（如 Scheduler）。
        let item_id = item.id();
        if !events.contains(&DomainEvent::ItemUpdated { item_id }) {
            events.push(DomainEvent::ItemUpdated { item_id });
        }
        for event in events {
            self.events.publish(event);
        }
        Ok(item)
    }

    /// 读取一个 Item。
    ///
    /// # Errors
    ///
    /// * [`crate::error::ErrorCode::ItemNotFound`] - Item 不存在。
    /// * 存储错误。
    pub async fn get_item(&self, id: ItemId) -> Result<Item, AppError> {
        let mut tx = self.uow.begin().await?;
        tx.items()
            .get(id)
            .await?
            .ok_or_else(|| AppError::item_not_found(id))
    }

    /// 按过滤条件列出 Item，创建时间从新到旧。
    ///
    /// # Errors
    ///
    /// 存储错误（含 [`crate::error::ErrorCode::StorageCorrupt`]）。
    pub async fn list_items(&self, filter: ItemFilter) -> Result<Vec<Item>, AppError> {
        let mut tx = self.uow.begin().await?;
        Ok(tx.items().list(&filter).await?)
    }
}
