//! `InboxService`：Inbox 的列表与批量整理（实施计划 2.7、产品文档 §8、D-02）。
//!
//! Inbox 是「先收下，再整理」的中间层：捕获的一切先落在这里。整理动作（安排日期、转换类型、
//! 归档、手动移出）按 D-02 的规则让 Item 离开 Inbox，规则本身在 Domain 里，这里只负责编排：
//!
//! * 批量整理在**一个事务**里完成，要么全部生效要么全部不变；
//! * 提交成功之后才发布事件；
//! * 每次整理都返回整理**之前**的状态（[`PreviousState`]），[`InboxService::restore`] 据此精确撤销。

use std::sync::Arc;

use asterjot_common::clock::Clock;
use asterjot_domain::attachment::Attachment;
use asterjot_domain::event::DomainEvent;
use asterjot_domain::id::ItemId;
use asterjot_domain::item::{DatePoint, Item, ItemType};
use asterjot_domain::source::Source;
use asterjot_domain::tag::Tag;
use chrono::{DateTime, NaiveDate, Utc};

use crate::error::{AppError, ErrorCode};
use crate::event::EventPublisher;
use crate::ports::{ItemFilter, UnitOfWork};
use crate::settings::read_later_rule;

/// Inbox 中的一条：Item 以及它的来源与附件。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InboxEntry {
    /// Item。
    pub item: Item,
    /// 来源（来自哪里），按捕获时间升序。
    pub sources: Vec<Source>,
    /// 附件（文件引用 / 保存的图片），按添加时间升序。
    pub attachments: Vec<Attachment>,
    /// 标签，按名称排序。
    pub tags: Vec<Tag>,
}

/// 安排日期的目标。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScheduleTarget {
    /// 今天。
    Today,
    /// 明天。
    Tomorrow,
    /// 稍后：下周一。
    Later,
    /// 指定某一天。
    Date(NaiveDate),
}

/// 对一批 Item 的整理动作。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OrganizeAction {
    /// 手动移出 Inbox：不用再整理了。
    LeaveInbox,
    /// 安排日期（同时离开 Inbox）。
    Schedule(ScheduleTarget),
    /// 转换类型（同时离开 Inbox）。
    ConvertTo(ItemType),
    /// 归档（同时离开 Inbox）。
    Archive,
}

/// 整理之前的状态，用于精确撤销。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreviousState {
    /// Item ID。
    pub id: ItemId,
    /// 原来的类型。
    pub item_type: ItemType,
    /// 原来的计划日期。
    pub scheduled: Option<DatePoint>,
    /// 原来是否在 Inbox 里。
    pub in_inbox: bool,
    /// 原来是否已归档。
    pub archived: bool,
    /// 整理写入后的版本，避免撤销覆盖后续编辑。
    pub revision: Option<DateTime<Utc>>,
}

impl PreviousState {
    /// 记录 `item` 当前的状态。
    fn of(item: &Item) -> Self {
        Self {
            id: item.id(),
            item_type: item.item_type(),
            scheduled: item.scheduled(),
            in_inbox: item.in_inbox(),
            archived: item.is_archived(),
            revision: None,
        }
    }
}

/// 一次批量整理的结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OrganizeOutcome {
    /// 整理之后的 Item，顺序与请求一致。
    pub items: Vec<Item>,
    /// 整理之前的状态，传给 [`InboxService::restore`] 撤销。
    pub previous: Vec<PreviousState>,
}

/// Inbox 的 Use Case。
#[derive(Clone)]
pub struct InboxService {
    /// 事务工厂。
    uow: Arc<dyn UnitOfWork>,
    /// 时钟。
    clock: Arc<dyn Clock>,
    /// 提交成功后发布领域事件。
    events: Arc<dyn EventPublisher>,
}

impl InboxService {
    /// 创建服务。
    pub fn new(
        uow: Arc<dyn UnitOfWork>,
        clock: Arc<dyn Clock>,
        events: Arc<dyn EventPublisher>,
    ) -> Self {
        Self { uow, clock, events }
    }

    /// 列出 Inbox（未归档且 `in_inbox` 的 Item），捕获时间从新到旧，附带来源与附件。
    ///
    /// # Errors
    ///
    /// 存储错误。
    pub async fn list(&self) -> Result<Vec<InboxEntry>, AppError> {
        let mut tx = self.uow.begin_read().await?;
        let items = tx
            .items()
            .list(&ItemFilter {
                in_inbox_only: true,
                ..ItemFilter::default()
            })
            .await?;
        let mut entries = Vec::with_capacity(items.len());
        for item in items {
            let sources = tx.sources().list_for_item(item.id()).await?;
            let attachments = tx.attachments().list_for_item(item.id()).await?;
            let tags = tx.tags().for_item(item.id()).await?;
            entries.push(InboxEntry {
                item,
                sources,
                attachments,
                tags,
            });
        }
        Ok(entries)
    }

    /// Inbox 里有多少条等待整理。
    ///
    /// # Errors
    ///
    /// 存储错误。
    pub async fn count(&self) -> Result<u32, AppError> {
        let mut tx = self.uow.begin_read().await?;
        let items = tx
            .items()
            .list(&ItemFilter {
                in_inbox_only: true,
                ..ItemFilter::default()
            })
            .await?;
        Ok(u32::try_from(items.len()).unwrap_or(u32::MAX))
    }

    /// 对一批 Item 执行同一个整理动作。
    ///
    /// 全部在一个事务里：任何一条失败（不存在、领域规则拒绝）都会让整批不变。
    ///
    /// # Errors
    ///
    /// * [`crate::error::ErrorCode::ItemNotFound`] - 某个 Item 不存在。
    /// * 领域规则错误（如归档已归档的 Item）映射为对应错误码。
    /// * 存储错误，事务已回滚。
    pub async fn organize(
        &self,
        ids: &[ItemId],
        action: OrganizeAction,
    ) -> Result<OrganizeOutcome, AppError> {
        let now = self.clock.now_utc();
        let today = self.clock.today_local();
        let mut tx = self.uow.begin().await?;
        let later = read_later_rule(&mut *tx).await?;
        let mut items = Vec::with_capacity(ids.len());
        let mut previous = Vec::with_capacity(ids.len());
        let mut events: Vec<DomainEvent> = Vec::with_capacity(ids.len());
        for &id in ids {
            let mut item = tx
                .items()
                .get(id)
                .await?
                .ok_or_else(|| AppError::item_not_found(id))?;
            let mut prior = PreviousState::of(&item);
            let event = match action {
                OrganizeAction::LeaveInbox => item.leave_inbox(now),
                OrganizeAction::Schedule(target) => {
                    let date = match target {
                        ScheduleTarget::Today => today,
                        ScheduleTarget::Tomorrow => today.succ_opt().unwrap_or(today),
                        ScheduleTarget::Later => later.resolve(today),
                        ScheduleTarget::Date(date) => date,
                    };
                    item.set_scheduled(Some(DatePoint::all_day(date)), now)
                }
                OrganizeAction::ConvertTo(item_type) => item.change_type(item_type, now),
                OrganizeAction::Archive => item.archive(now)?,
            };
            tx.items().update(&item).await?;
            prior.revision = Some(item.updated_at());
            previous.push(prior);
            if matches!(action, OrganizeAction::Schedule(_)) {
                // 换了日期，它在 Today 里的旧位置不再有意义。
                tx.today_order().remove_item(id).await?;
            }
            events.push(event);
            events.push(DomainEvent::ItemUpdated { item_id: id });
            items.push(item);
        }
        tx.commit().await?;
        for event in dedup(events) {
            self.events.publish(event);
        }
        Ok(OrganizeOutcome { items, previous })
    }

    /// 精确撤销一次整理：把每个 Item 恢复到 [`PreviousState`] 记录的状态。
    ///
    /// # Errors
    ///
    /// * [`crate::error::ErrorCode::ItemNotFound`] - 某个 Item 已不存在。
    /// * 存储错误，事务已回滚。
    pub async fn restore(&self, previous: &[PreviousState]) -> Result<Vec<Item>, AppError> {
        let now = self.clock.now_utc();
        let mut tx = self.uow.begin().await?;
        let mut items = Vec::with_capacity(previous.len());
        let mut events: Vec<DomainEvent> = Vec::new();
        for state in previous {
            let mut item = tx
                .items()
                .get(state.id)
                .await?
                .ok_or_else(|| AppError::item_not_found(state.id))?;
            if state.revision.is_some_and(|revision| {
                revision.timestamp_millis() != item.updated_at().timestamp_millis()
            }) {
                return Err(AppError::new(
                    ErrorCode::InvalidInput,
                    "事项已修改，无法撤销整理",
                ));
            }
            item.change_type(state.item_type, now);
            item.set_scheduled(state.scheduled, now);
            if item.is_archived() && !state.archived {
                item.unarchive(now)?;
            } else if !item.is_archived() && state.archived {
                item.archive(now)?;
            }
            // 放在最后：前面的步骤会按 D-02 改动 Inbox 标记，这里还原成整理之前的值。
            item.restore_inbox_flag(state.in_inbox, now);
            tx.items().update(&item).await?;
            tx.today_order().remove_item(state.id).await?;
            events.push(DomainEvent::ItemUpdated { item_id: state.id });
            items.push(item);
        }
        tx.commit().await?;
        for event in dedup(events) {
            self.events.publish(event);
        }
        Ok(items)
    }
}

/// 去掉重复事件，保持首次出现的顺序。
fn dedup(events: Vec<DomainEvent>) -> Vec<DomainEvent> {
    let mut unique: Vec<DomainEvent> = Vec::with_capacity(events.len());
    for event in events {
        if !unique.contains(&event) {
            unique.push(event);
        }
    }
    unique
}

#[cfg(test)]
mod tests;
