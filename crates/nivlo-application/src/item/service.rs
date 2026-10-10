//! `ItemService`：Item 的创建、更新、读取与列表。
//!
//! 每个写操作都遵循同一个模式（后端规范 §4.2、架构文档 §56）：
//!
//! 1. 开启事务；
//! 2. 在事务内读取并修改 Domain 对象，所有业务规则由 Domain 保证；
//! 3. 写回并**提交**；
//! 4. 只有提交成功后才发布领域事件——事务回滚时前端不会收到一个随后消失的变更。

use std::sync::Arc;

use chrono::{DateTime, Datelike, Duration, NaiveDate, Utc};
use nivlo_common::clock::Clock;
use nivlo_common::id::new_uuid_v7;
use nivlo_domain::error::DomainError;
use nivlo_domain::event::DomainEvent;
use nivlo_domain::id::ItemId;
use nivlo_domain::item::{DatePoint, Item, ItemType, NewItem};

use super::input::UpdateItemInput;
use crate::error::AppError;
use crate::event::EventPublisher;
use crate::ports::{ItemFilter, UnitOfWork};

/// 创建 Item 的输入。直接复用领域的 [`NewItem`]，字段含义见其文档。
pub type CreateItemInput = NewItem;

/// 改期的目标。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RescheduleTarget {
    /// 今天。
    Today,
    /// 明天。
    Tomorrow,
    /// 稍后：下周一。
    Later,
    /// 收集箱：清除计划日期并标记为待整理（`in_inbox`，D-02）。
    Inbox,
    /// 精确设置（或清除）计划，用于撤销。
    Exact(Option<DatePoint>),
}

/// 严格晚于 `date` 的下一个周一（今天是周一则为 7 天后）。
pub(crate) fn next_monday_after(date: NaiveDate) -> NaiveDate {
    let days = 7 - i64::from(date.weekday().num_days_from_monday());
    date + Duration::days(days)
}

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

    /// 快速创建（悬浮窗的 Quick Create，产品文档 §6.1「先创建，再整理」）。
    ///
    /// 只需要类型与标题，其余使用默认值：Todo 与 Tip 的计划日期是**今天**（用户本地日期，
    /// 由注入的时钟决定），Note 没有日期。标题会被去除首尾空白；空标题被拒绝。
    ///
    /// # Errors
    ///
    /// 同 [`ItemService::create_item`]；标题为空时为 [`crate::error::ErrorCode::ItemTitleEmpty`]。
    pub async fn quick_create(&self, item_type: ItemType, title: &str) -> Result<Item, AppError> {
        let mut input = NewItem::new(item_type, title);
        if matches!(item_type, ItemType::Todo | ItemType::Tip) {
            input.scheduled = Some(DatePoint::all_day(self.clock.today_local()));
        }
        self.create_item(input).await
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

    /// 改期（推迟）：把计划日期移到目标日期，并让 Item 离开 Today 的手动顺序。
    ///
    /// 目标为 Today / Tomorrow / Later 时保留原有的具体时间（如果有）；Later 是**下周一**
    /// （严格晚于今天的下一个周一，后续可配置）；Inbox 清除计划日期并标记为待整理
    /// （`in_inbox`，D-02）。`Exact` 用于撤销：原样恢复之前的计划。
    ///
    /// # Errors
    ///
    /// * [`crate::error::ErrorCode::ItemNotFound`] - Item 不存在。
    /// * 存储错误，事务已回滚。
    pub async fn reschedule_item(
        &self,
        id: ItemId,
        target: RescheduleTarget,
    ) -> Result<Item, AppError> {
        let now = self.clock.now_utc();
        let today = self.clock.today_local();
        let mut tx = self.uow.begin().await?;
        let mut item = tx
            .items()
            .get(id)
            .await?
            .ok_or_else(|| AppError::item_not_found(id))?;
        let on = |date: NaiveDate| match item.scheduled().and_then(|s| s.time()) {
            Some(time) => DatePoint::at(date, time),
            None => DatePoint::all_day(date),
        };
        let event = match target {
            RescheduleTarget::Today => item.set_scheduled(Some(on(today)), now),
            RescheduleTarget::Tomorrow => {
                item.set_scheduled(Some(on(today.succ_opt().unwrap_or(today))), now)
            }
            RescheduleTarget::Later => item.set_scheduled(Some(on(next_monday_after(today))), now),
            // 放回收集箱：清除日期并标记为待整理（D-02）。
            RescheduleTarget::Inbox => item.move_to_inbox(now),
            RescheduleTarget::Exact(scheduled) => item.set_scheduled(scheduled, now),
        };
        tx.items().update(&item).await?;
        // 无论去哪儿，它在 Today 里的旧位置都不再有意义；回到 Today（撤销）时由调用方重新排序。
        tx.today_order().remove_item(id).await?;
        tx.commit().await?;
        self.events.publish(event);
        Ok(item)
    }

    /// 完成一个 Todo。
    ///
    /// 完成**不会**清理 `daily_item_order`：撤销（[`ItemService::reopen_item`]）后
    /// Item 回到 Today 原来的位置。
    ///
    /// # Errors
    ///
    /// * [`crate::error::ErrorCode::ItemNotFound`] - Item 不存在。
    /// * `ITEM_NOT_COMPLETABLE` / `ITEM_ALREADY_COMPLETED` / `ITEM_ARCHIVED` - 领域规则拒绝。
    /// * 存储错误，事务已回滚。
    pub async fn complete_item(&self, id: ItemId) -> Result<Item, AppError> {
        self.transition(id, |item, now| item.complete(now)).await
    }

    /// 重新打开已完成的 Todo（也是"完成"的撤销）。
    ///
    /// # Errors
    ///
    /// * [`crate::error::ErrorCode::ItemNotFound`] - Item 不存在。
    /// * `ITEM_NOT_COMPLETED` / `ITEM_ARCHIVED` - 领域规则拒绝。
    /// * 存储错误，事务已回滚。
    pub async fn reopen_item(&self, id: ItemId) -> Result<Item, AppError> {
        self.transition(id, |item, now| item.reopen(now)).await
    }

    /// 读取 Item、执行一次状态转换、写回并在提交后发布事件。
    async fn transition(
        &self,
        id: ItemId,
        apply: impl FnOnce(&mut Item, DateTime<Utc>) -> Result<DomainEvent, DomainError>,
    ) -> Result<Item, AppError> {
        let now = self.clock.now_utc();
        let mut tx = self.uow.begin().await?;
        let mut item = tx
            .items()
            .get(id)
            .await?
            .ok_or_else(|| AppError::item_not_found(id))?;
        let event = apply(&mut item, now)?;
        tx.items().update(&item).await?;
        tx.commit().await?;
        self.events.publish(event);
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
