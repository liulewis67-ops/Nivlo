//! Item 聚合根及其领域规则。
//!
//! 所有状态变化都通过方法完成，字段保持私有，外部无法绕过规则构造出非法状态
//! （例如已完成的 Tip）。持久化通过 [`ItemSnapshot`] 进出，重建时会重新校验不变量。

use chrono::{DateTime, NaiveDate, NaiveTime, Utc};
use serde::{Deserialize, Serialize};

use super::kinds::{ContentFormat, ItemStatus, ItemType, Priority};
use super::values::{DatePoint, Title};
use crate::error::DomainError;
use crate::event::DomainEvent;
use crate::id::{ItemId, ProjectId};

/// 内容（描述 / 正文）允许的最大字符数。
pub const MAX_CONTENT_CHARS: usize = 200_000;

/// 创建 Item 所需的输入。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewItem {
    /// Item 类型。
    pub item_type: ItemType,
    /// 原始标题，创建时会被校验并去除首尾空白。
    pub title: String,
    /// 内容；空白内容会被规范化为 `None`。
    pub content: Option<String>,
    /// 内容格式。
    pub content_format: ContentFormat,
    /// 优先级（仅 Todo 可以设置为 `None` 以外的值）。
    pub priority: Priority,
    /// 计划日期（我计划什么时候做）。
    pub scheduled: Option<DatePoint>,
    /// 截止日期（最晚什么时候完成），仅 Todo。
    pub due: Option<DatePoint>,
    /// 提醒时间点，仅 Todo 与 Tip。
    pub reminder_at: Option<DateTime<Utc>>,
    /// 所属项目。
    pub project_id: Option<ProjectId>,
}

impl NewItem {
    /// 以给定类型与标题创建输入，其余字段取默认值。
    pub fn new(item_type: ItemType, title: impl Into<String>) -> Self {
        Self {
            item_type,
            title: title.into(),
            content: None,
            content_format: ContentFormat::default(),
            priority: Priority::None,
            scheduled: None,
            due: None,
            reminder_at: None,
            project_id: None,
        }
    }
}

/// Item 的持久化快照，字段与存储列一一对应（实施计划 D-03 的拆分时间模型）。
///
/// 快照本身不保证一致；必须经 [`Item::restore`] 校验后才能得到 [`Item`]。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ItemSnapshot {
    /// Item ID。
    pub id: ItemId,
    /// 类型。
    pub item_type: ItemType,
    /// 标题。
    pub title: String,
    /// 内容。
    pub content: Option<String>,
    /// 内容格式。
    pub content_format: ContentFormat,
    /// 状态。
    pub status: ItemStatus,
    /// 优先级。
    pub priority: Priority,
    /// 计划日期。
    pub scheduled_date: Option<NaiveDate>,
    /// 计划时间。
    pub scheduled_time: Option<NaiveTime>,
    /// 截止日期。
    pub due_date: Option<NaiveDate>,
    /// 截止时间。
    pub due_time: Option<NaiveTime>,
    /// 提醒时间点（UTC）。
    pub reminder_at: Option<DateTime<Utc>>,
    /// 所属项目。
    pub project_id: Option<ProjectId>,
    /// 创建时间。
    pub created_at: DateTime<Utc>,
    /// 最近更新时间。
    pub updated_at: DateTime<Utc>,
    /// 完成时间。
    pub completed_at: Option<DateTime<Utc>>,
    /// 归档时间。
    pub archived_at: Option<DateTime<Utc>>,
}

/// 统一的 Item 聚合根（Todo / Note / Tip）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "ItemSnapshot", into = "ItemSnapshot")]
pub struct Item {
    /// Item ID。
    id: ItemId,
    /// 类型。
    item_type: ItemType,
    /// 已校验的标题。
    title: Title,
    /// 内容；永远不是空白字符串。
    content: Option<String>,
    /// 内容格式。
    content_format: ContentFormat,
    /// 状态；只有 Todo 可能是 `Done`。
    status: ItemStatus,
    /// 优先级；非 Todo 恒为 `None`。
    priority: Priority,
    /// 计划日期。
    scheduled: Option<DatePoint>,
    /// 截止日期；仅 Todo 可有。
    due: Option<DatePoint>,
    /// 提醒时间点；仅 Todo 与 Tip 可有。
    reminder_at: Option<DateTime<Utc>>,
    /// 所属项目。
    project_id: Option<ProjectId>,
    /// 创建时间。
    created_at: DateTime<Utc>,
    /// 最近更新时间。
    updated_at: DateTime<Utc>,
    /// 完成时间；当且仅当 `status == Done` 时存在。
    completed_at: Option<DateTime<Utc>>,
    /// 归档时间。
    archived_at: Option<DateTime<Utc>>,
}

/// 规范化内容：空白内容视为没有内容，并校验长度。
fn normalize_content(content: Option<String>) -> Result<Option<String>, DomainError> {
    match content {
        Some(text) if text.trim().is_empty() => Ok(None),
        Some(text) if text.chars().count() > MAX_CONTENT_CHARS => {
            Err(DomainError::ContentTooLong {
                max: MAX_CONTENT_CHARS,
            })
        }
        other => Ok(other),
    }
}

/// 校验类型与字段的适用关系：不适用的字段只允许处于"未设置"状态。
fn check_applicable(
    item_type: ItemType,
    priority: Priority,
    due: Option<DatePoint>,
    reminder_at: Option<DateTime<Utc>>,
) -> Result<(), DomainError> {
    if priority != Priority::None && !item_type.supports_priority() {
        return Err(DomainError::FieldNotApplicable {
            field: "priority",
            item_type,
        });
    }
    if due.is_some() && !item_type.supports_due() {
        return Err(DomainError::FieldNotApplicable {
            field: "due",
            item_type,
        });
    }
    if reminder_at.is_some() && !item_type.supports_reminder() {
        return Err(DomainError::FieldNotApplicable {
            field: "reminder_at",
            item_type,
        });
    }
    Ok(())
}

impl Item {
    /// 创建一个新的 Item。
    ///
    /// 新 Item 总是处于未完成、未归档状态。`id` 与 `now` 由调用方提供，
    /// 本函数不生成 ID、不读取时间。
    ///
    /// # Errors
    ///
    /// * [`DomainError::EmptyTitle`] / [`DomainError::TitleTooLong`] - 标题不合法。
    /// * [`DomainError::ContentTooLong`] - 内容过长。
    /// * [`DomainError::FieldNotApplicable`] - 给 Note / Tip 设置了不适用的优先级、截止日期，
    ///   或给 Note 设置了提醒。
    pub fn create(
        id: ItemId,
        new: NewItem,
        now: DateTime<Utc>,
    ) -> Result<(Self, DomainEvent), DomainError> {
        let title = Title::new(&new.title)?;
        let content = normalize_content(new.content)?;
        check_applicable(new.item_type, new.priority, new.due, new.reminder_at)?;
        let item = Self {
            id,
            item_type: new.item_type,
            title,
            content,
            content_format: new.content_format,
            status: ItemStatus::Open,
            priority: new.priority,
            scheduled: new.scheduled,
            due: new.due,
            reminder_at: new.reminder_at,
            project_id: new.project_id,
            created_at: now,
            updated_at: now,
            completed_at: None,
            archived_at: None,
        };
        Ok((item, DomainEvent::ItemCreated { item_id: id }))
    }

    /// 从持久化快照重建 Item，并重新校验全部不变量。
    ///
    /// 存储层读到的数据可能被外部工具改动或来自旧版本，因此不能假定其一致。
    ///
    /// # Errors
    ///
    /// 标题 / 内容不合法，或状态与类型、完成时间、时间字段互相矛盾时返回错误
    /// （多为 [`DomainError::InvalidSnapshot`]）。
    pub fn restore(snapshot: ItemSnapshot) -> Result<Self, DomainError> {
        let title = Title::new(&snapshot.title)?;
        let content = normalize_content(snapshot.content)?;
        let scheduled = DatePoint::from_parts(
            snapshot.scheduled_date,
            snapshot.scheduled_time,
            "scheduled",
        )?;
        let due = DatePoint::from_parts(snapshot.due_date, snapshot.due_time, "due")?;
        check_applicable(
            snapshot.item_type,
            snapshot.priority,
            due,
            snapshot.reminder_at,
        )
        .map_err(|e| DomainError::InvalidSnapshot(e.to_string()))?;

        let done = snapshot.status == ItemStatus::Done;
        if done && !snapshot.item_type.is_completable() {
            return Err(DomainError::InvalidSnapshot(format!(
                "{:?} 不应处于已完成状态",
                snapshot.item_type
            )));
        }
        if done != snapshot.completed_at.is_some() {
            return Err(DomainError::InvalidSnapshot(
                "completed_at 必须当且仅当状态为 done 时存在".to_owned(),
            ));
        }

        Ok(Self {
            id: snapshot.id,
            item_type: snapshot.item_type,
            title,
            content,
            content_format: snapshot.content_format,
            status: snapshot.status,
            priority: snapshot.priority,
            scheduled,
            due,
            reminder_at: snapshot.reminder_at,
            project_id: snapshot.project_id,
            created_at: snapshot.created_at,
            updated_at: snapshot.updated_at,
            completed_at: snapshot.completed_at,
            archived_at: snapshot.archived_at,
        })
    }

    /// 导出用于持久化的快照。
    pub fn snapshot(&self) -> ItemSnapshot {
        ItemSnapshot {
            id: self.id,
            item_type: self.item_type,
            title: self.title.as_str().to_owned(),
            content: self.content.clone(),
            content_format: self.content_format,
            status: self.status,
            priority: self.priority,
            scheduled_date: self.scheduled.map(|p| p.date()),
            scheduled_time: self.scheduled.and_then(|p| p.time()),
            due_date: self.due.map(|p| p.date()),
            due_time: self.due.and_then(|p| p.time()),
            reminder_at: self.reminder_at,
            project_id: self.project_id,
            created_at: self.created_at,
            updated_at: self.updated_at,
            completed_at: self.completed_at,
            archived_at: self.archived_at,
        }
    }

    /// 修改标题。
    ///
    /// # Errors
    ///
    /// 标题不合法时返回 [`DomainError::EmptyTitle`] 或 [`DomainError::TitleTooLong`]，Item 不变。
    pub fn rename(&mut self, title: &str, now: DateTime<Utc>) -> Result<DomainEvent, DomainError> {
        self.title = Title::new(title)?;
        Ok(self.touch(now))
    }

    /// 修改内容与格式；空白内容会清空内容。
    ///
    /// # Errors
    ///
    /// 内容超长时返回 [`DomainError::ContentTooLong`]，Item 不变。
    pub fn set_content(
        &mut self,
        content: Option<String>,
        format: ContentFormat,
        now: DateTime<Utc>,
    ) -> Result<DomainEvent, DomainError> {
        self.content = normalize_content(content)?;
        self.content_format = format;
        Ok(self.touch(now))
    }

    /// 修改优先级。
    ///
    /// # Errors
    ///
    /// 给非 Todo 设置 `None` 以外的优先级时返回 [`DomainError::FieldNotApplicable`]。
    pub fn set_priority(
        &mut self,
        priority: Priority,
        now: DateTime<Utc>,
    ) -> Result<DomainEvent, DomainError> {
        check_applicable(self.item_type, priority, None, None)?;
        self.priority = priority;
        Ok(self.touch(now))
    }

    /// 修改（或清除）所属项目。
    pub fn set_project(
        &mut self,
        project_id: Option<ProjectId>,
        now: DateTime<Utc>,
    ) -> DomainEvent {
        self.project_id = project_id;
        self.touch(now)
    }

    /// 修改（或清除）计划日期——"我计划什么时候做"。
    ///
    /// 返回 [`DomainEvent::ScheduleChanged`]，Scheduler 据此重新计算触发点。
    pub fn set_scheduled(
        &mut self,
        scheduled: Option<DatePoint>,
        now: DateTime<Utc>,
    ) -> DomainEvent {
        self.scheduled = scheduled;
        self.updated_at = now;
        DomainEvent::ScheduleChanged { item_id: self.id }
    }

    /// 修改（或清除）截止日期——"最晚什么时候必须完成"。
    ///
    /// 截止日期与计划日期语义不同，二者互不约束先后顺序（架构文档 §32）。
    ///
    /// # Errors
    ///
    /// 给非 Todo 设置截止日期时返回 [`DomainError::FieldNotApplicable`]。
    pub fn set_due(
        &mut self,
        due: Option<DatePoint>,
        now: DateTime<Utc>,
    ) -> Result<DomainEvent, DomainError> {
        check_applicable(self.item_type, Priority::None, due, None)?;
        self.due = due;
        self.updated_at = now;
        Ok(DomainEvent::ScheduleChanged { item_id: self.id })
    }

    /// 修改（或清除）提醒时间点。
    ///
    /// # Errors
    ///
    /// 给 Note 设置提醒时返回 [`DomainError::FieldNotApplicable`]。
    pub fn set_reminder(
        &mut self,
        reminder_at: Option<DateTime<Utc>>,
        now: DateTime<Utc>,
    ) -> Result<DomainEvent, DomainError> {
        check_applicable(self.item_type, Priority::None, None, reminder_at)?;
        self.reminder_at = reminder_at;
        self.updated_at = now;
        Ok(DomainEvent::ScheduleChanged { item_id: self.id })
    }

    /// 转换 Item 类型，并清理新类型不再适用的状态。
    ///
    /// * 离开 Todo：清除完成状态、截止日期、优先级。
    /// * 变成 Note：额外清除提醒。
    /// * 变成 Todo：无需清理，Note 内容与计划日期原样保留。
    ///
    /// 类型不变时是空操作，但仍返回事件以保持调用方逻辑简单。
    pub fn change_type(&mut self, new_type: ItemType, now: DateTime<Utc>) -> DomainEvent {
        if new_type != self.item_type {
            if !new_type.supports_due() {
                self.due = None;
            }
            if !new_type.supports_priority() {
                self.priority = Priority::None;
            }
            if !new_type.supports_reminder() {
                self.reminder_at = None;
            }
            if !new_type.is_completable() {
                self.status = ItemStatus::Open;
                self.completed_at = None;
            }
            self.item_type = new_type;
            self.updated_at = now;
        }
        DomainEvent::ItemTypeChanged { item_id: self.id }
    }

    /// 完成 Todo。
    ///
    /// # Errors
    ///
    /// * [`DomainError::NotCompletable`] - Note / Tip 不能完成。
    /// * [`DomainError::Archived`] - 已归档，需先取消归档。
    /// * [`DomainError::AlreadyCompleted`] - 已经完成。
    pub fn complete(&mut self, now: DateTime<Utc>) -> Result<DomainEvent, DomainError> {
        if !self.item_type.is_completable() {
            return Err(DomainError::NotCompletable {
                item_type: self.item_type,
            });
        }
        if self.archived_at.is_some() {
            return Err(DomainError::Archived);
        }
        if self.status == ItemStatus::Done {
            return Err(DomainError::AlreadyCompleted);
        }
        self.status = ItemStatus::Done;
        self.completed_at = Some(now);
        self.updated_at = now;
        Ok(DomainEvent::ItemCompleted { item_id: self.id })
    }

    /// 重新打开已完成的 Todo，清除完成时间。
    ///
    /// # Errors
    ///
    /// * [`DomainError::Archived`] - 已归档，需先取消归档。
    /// * [`DomainError::NotCompleted`] - 尚未完成。
    pub fn reopen(&mut self, now: DateTime<Utc>) -> Result<DomainEvent, DomainError> {
        if self.archived_at.is_some() {
            return Err(DomainError::Archived);
        }
        if self.status != ItemStatus::Done {
            return Err(DomainError::NotCompleted);
        }
        self.status = ItemStatus::Open;
        self.completed_at = None;
        self.updated_at = now;
        Ok(DomainEvent::ItemReopened { item_id: self.id })
    }

    /// 归档 Item（长期保留，但不再出现在日常视图中）。
    ///
    /// # Errors
    ///
    /// 已归档时返回 [`DomainError::AlreadyArchived`]。
    pub fn archive(&mut self, now: DateTime<Utc>) -> Result<DomainEvent, DomainError> {
        if self.archived_at.is_some() {
            return Err(DomainError::AlreadyArchived);
        }
        self.archived_at = Some(now);
        self.updated_at = now;
        Ok(DomainEvent::ItemArchived { item_id: self.id })
    }

    /// 取消归档。
    ///
    /// # Errors
    ///
    /// 未归档时返回 [`DomainError::NotArchived`]。
    pub fn unarchive(&mut self, now: DateTime<Utc>) -> Result<DomainEvent, DomainError> {
        if self.archived_at.is_none() {
            return Err(DomainError::NotArchived);
        }
        self.archived_at = None;
        self.updated_at = now;
        Ok(DomainEvent::ItemUnarchived { item_id: self.id })
    }

    /// 刷新更新时间并返回通用的"已更新"事件。
    fn touch(&mut self, now: DateTime<Utc>) -> DomainEvent {
        self.updated_at = now;
        DomainEvent::ItemUpdated { item_id: self.id }
    }

    /// Item ID。
    pub fn id(&self) -> ItemId {
        self.id
    }

    /// Item 类型。
    pub fn item_type(&self) -> ItemType {
        self.item_type
    }

    /// 标题。
    pub fn title(&self) -> &Title {
        &self.title
    }

    /// 内容；没有内容时为 `None`。
    pub fn content(&self) -> Option<&str> {
        self.content.as_deref()
    }

    /// 内容格式。
    pub fn content_format(&self) -> ContentFormat {
        self.content_format
    }

    /// 完成状态。
    pub fn status(&self) -> ItemStatus {
        self.status
    }

    /// 优先级。
    pub fn priority(&self) -> Priority {
        self.priority
    }

    /// 计划日期。
    pub fn scheduled(&self) -> Option<DatePoint> {
        self.scheduled
    }

    /// 截止日期。
    pub fn due(&self) -> Option<DatePoint> {
        self.due
    }

    /// 提醒时间点。
    pub fn reminder_at(&self) -> Option<DateTime<Utc>> {
        self.reminder_at
    }

    /// 所属项目。
    pub fn project_id(&self) -> Option<ProjectId> {
        self.project_id
    }

    /// 创建时间。
    pub fn created_at(&self) -> DateTime<Utc> {
        self.created_at
    }

    /// 最近更新时间。
    pub fn updated_at(&self) -> DateTime<Utc> {
        self.updated_at
    }

    /// 完成时间。
    pub fn completed_at(&self) -> Option<DateTime<Utc>> {
        self.completed_at
    }

    /// 归档时间。
    pub fn archived_at(&self) -> Option<DateTime<Utc>> {
        self.archived_at
    }

    /// 是否已完成。
    pub fn is_done(&self) -> bool {
        self.status == ItemStatus::Done
    }

    /// 是否已归档。
    pub fn is_archived(&self) -> bool {
        self.archived_at.is_some()
    }
}

impl TryFrom<ItemSnapshot> for Item {
    type Error = DomainError;

    /// 反序列化入口，经 [`Item::restore`] 校验。
    fn try_from(value: ItemSnapshot) -> Result<Self, Self::Error> {
        Self::restore(value)
    }
}

impl From<Item> for ItemSnapshot {
    /// 序列化出口。
    fn from(value: Item) -> Self {
        value.snapshot()
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use chrono::TimeZone;
    use uuid::Uuid;

    use super::*;

    /// 固定的"现在"。
    fn t0() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 10, 9, 8, 0, 0).unwrap()
    }

    /// 比 [`t0`] 晚一小时。
    fn t1() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 10, 9, 9, 0, 0).unwrap()
    }

    /// 测试用 ID。
    fn id() -> ItemId {
        ItemId::from_uuid(Uuid::from_u128(1))
    }

    /// 创建一个指定类型的最简 Item。
    fn item(item_type: ItemType) -> Item {
        Item::create(id(), NewItem::new(item_type, "买牛奶"), t0())
            .unwrap()
            .0
    }

    #[test]
    fn create_sets_defaults_and_emits_event() {
        let (item, event) =
            Item::create(id(), NewItem::new(ItemType::Todo, "  写周报 "), t0()).unwrap();
        assert_eq!(item.title().as_str(), "写周报");
        assert_eq!(item.status(), ItemStatus::Open);
        assert_eq!(item.created_at(), t0());
        assert_eq!(item.updated_at(), t0());
        assert!(item.completed_at().is_none() && item.archived_at().is_none());
        assert_eq!(event, DomainEvent::ItemCreated { item_id: id() });
    }

    #[test]
    fn create_rejects_invalid_title() {
        let err = Item::create(id(), NewItem::new(ItemType::Todo, "   "), t0()).unwrap_err();
        assert_eq!(err, DomainError::EmptyTitle);
    }

    #[test]
    fn blank_content_is_normalized_to_none() {
        let mut new = NewItem::new(ItemType::Note, "想法");
        new.content = Some("  \n ".to_owned());
        assert!(Item::create(id(), new, t0()).unwrap().0.content().is_none());
    }

    #[test]
    fn too_long_content_is_rejected() {
        let mut new = NewItem::new(ItemType::Note, "想法");
        new.content = Some("a".repeat(MAX_CONTENT_CHARS + 1));
        assert_eq!(
            Item::create(id(), new, t0()).unwrap_err(),
            DomainError::ContentTooLong {
                max: MAX_CONTENT_CHARS
            }
        );
    }

    #[test]
    fn todo_can_be_completed_and_reopened() {
        let mut todo = item(ItemType::Todo);
        let event = todo.complete(t1()).unwrap();
        assert_eq!(event, DomainEvent::ItemCompleted { item_id: id() });
        assert!(todo.is_done());
        assert_eq!(todo.completed_at(), Some(t1()));
        assert_eq!(todo.updated_at(), t1());

        assert_eq!(todo.complete(t1()), Err(DomainError::AlreadyCompleted));

        let event = todo.reopen(t1()).unwrap();
        assert_eq!(event, DomainEvent::ItemReopened { item_id: id() });
        assert!(!todo.is_done());
        assert!(todo.completed_at().is_none());
        assert_eq!(todo.reopen(t1()), Err(DomainError::NotCompleted));
    }

    #[test]
    fn tip_and_note_cannot_be_completed() {
        for item_type in [ItemType::Tip, ItemType::Note] {
            let mut item = item(item_type);
            assert_eq!(
                item.complete(t1()),
                Err(DomainError::NotCompletable { item_type })
            );
            assert!(!item.is_done());
        }
    }

    #[test]
    fn archived_item_cannot_be_completed_or_reopened() {
        let mut todo = item(ItemType::Todo);
        todo.archive(t1()).unwrap();
        assert_eq!(todo.complete(t1()), Err(DomainError::Archived));
        assert_eq!(todo.reopen(t1()), Err(DomainError::Archived));
    }

    #[test]
    fn archive_and_unarchive() {
        let mut note = item(ItemType::Note);
        let event = note.archive(t1()).unwrap();
        assert_eq!(event, DomainEvent::ItemArchived { item_id: id() });
        assert_eq!(note.archived_at(), Some(t1()));
        assert_eq!(note.archive(t1()), Err(DomainError::AlreadyArchived));

        note.unarchive(t1()).unwrap();
        assert!(!note.is_archived());
        assert_eq!(note.unarchive(t1()), Err(DomainError::NotArchived));
    }

    #[test]
    fn todo_to_note_clears_completion_due_priority_and_reminder() {
        let mut todo = item(ItemType::Todo);
        let date = NaiveDate::from_ymd_opt(2026, 10, 12).unwrap();
        todo.set_due(Some(DatePoint::all_day(date)), t0()).unwrap();
        todo.set_priority(Priority::High, t0()).unwrap();
        todo.set_reminder(Some(t1()), t0()).unwrap();
        todo.set_scheduled(Some(DatePoint::all_day(date)), t0());
        todo.complete(t1()).unwrap();

        let event = todo.change_type(ItemType::Note, t1());
        assert_eq!(event, DomainEvent::ItemTypeChanged { item_id: id() });
        assert_eq!(todo.item_type(), ItemType::Note);
        assert_eq!(todo.status(), ItemStatus::Open);
        assert!(todo.completed_at().is_none());
        assert!(todo.due().is_none());
        assert_eq!(todo.priority(), Priority::None);
        assert!(todo.reminder_at().is_none());
        // 计划日期不属于"不再适用"的状态，保留。
        assert_eq!(todo.scheduled(), Some(DatePoint::all_day(date)));
    }

    #[test]
    fn todo_to_tip_keeps_reminder() {
        let mut todo = item(ItemType::Todo);
        todo.set_reminder(Some(t1()), t0()).unwrap();
        todo.change_type(ItemType::Tip, t1());
        assert_eq!(todo.reminder_at(), Some(t1()));
    }

    #[test]
    fn note_to_todo_keeps_content() {
        let mut note = item(ItemType::Note);
        note.set_content(Some("正文".to_owned()), ContentFormat::Markdown, t0())
            .unwrap();
        note.change_type(ItemType::Todo, t1());
        assert_eq!(note.item_type(), ItemType::Todo);
        assert_eq!(note.content(), Some("正文"));
        assert_eq!(note.content_format(), ContentFormat::Markdown);
    }

    #[test]
    fn same_type_conversion_does_not_touch_updated_at() {
        let mut todo = item(ItemType::Todo);
        todo.change_type(ItemType::Todo, t1());
        assert_eq!(todo.updated_at(), t0());
    }

    #[test]
    fn non_applicable_fields_are_rejected() {
        let date = DatePoint::all_day(NaiveDate::from_ymd_opt(2026, 10, 12).unwrap());
        let mut note = item(ItemType::Note);
        assert!(matches!(
            note.set_priority(Priority::High, t1()),
            Err(DomainError::FieldNotApplicable {
                field: "priority",
                ..
            })
        ));
        assert!(matches!(
            note.set_due(Some(date), t1()),
            Err(DomainError::FieldNotApplicable { field: "due", .. })
        ));
        assert!(matches!(
            note.set_reminder(Some(t1()), t1()),
            Err(DomainError::FieldNotApplicable {
                field: "reminder_at",
                ..
            })
        ));
        // 清除操作永远允许。
        assert!(note.set_priority(Priority::None, t1()).is_ok());
        assert!(note.set_due(None, t1()).is_ok());
        assert!(note.set_reminder(None, t1()).is_ok());

        let mut tip = item(ItemType::Tip);
        assert!(tip.set_reminder(Some(t1()), t1()).is_ok());
        assert!(tip.set_due(Some(date), t1()).is_err());
    }

    #[test]
    fn create_rejects_non_applicable_fields() {
        let mut new = NewItem::new(ItemType::Tip, "服务器维护");
        new.priority = Priority::High;
        assert!(matches!(
            Item::create(id(), new, t0()),
            Err(DomainError::FieldNotApplicable {
                field: "priority",
                ..
            })
        ));
    }

    #[test]
    fn scheduled_and_due_are_independent_and_emit_schedule_changed() {
        let mut todo = item(ItemType::Todo);
        let sep29 = DatePoint::all_day(NaiveDate::from_ymd_opt(2026, 9, 29).unwrap());
        let oct2 = DatePoint::all_day(NaiveDate::from_ymd_opt(2026, 10, 2).unwrap());
        let e1 = todo.set_scheduled(Some(sep29), t1());
        let e2 = todo.set_due(Some(oct2), t1()).unwrap();
        assert_eq!(e1, DomainEvent::ScheduleChanged { item_id: id() });
        assert_eq!(e2, DomainEvent::ScheduleChanged { item_id: id() });
        assert_eq!(todo.scheduled(), Some(sep29));
        assert_eq!(todo.due(), Some(oct2));
        // 即使计划晚于截止日期也不报错：二者语义不同，由 UI 决定是否提示。
        todo.set_scheduled(
            Some(DatePoint::all_day(
                NaiveDate::from_ymd_opt(2026, 10, 5).unwrap(),
            )),
            t1(),
        );
        assert_eq!(todo.due(), Some(oct2));
    }

    #[test]
    fn failed_update_leaves_item_unchanged() {
        let mut todo = item(ItemType::Todo);
        assert_eq!(todo.rename("  ", t1()), Err(DomainError::EmptyTitle));
        assert_eq!(todo.title().as_str(), "买牛奶");
        assert_eq!(todo.updated_at(), t0());
    }

    #[test]
    fn rename_and_project_update_timestamp() {
        let mut todo = item(ItemType::Todo);
        todo.rename("买燕麦奶", t1()).unwrap();
        assert_eq!(todo.title().as_str(), "买燕麦奶");
        let project = ProjectId::from_uuid(Uuid::from_u128(9));
        todo.set_project(Some(project), t1());
        assert_eq!(todo.project_id(), Some(project));
        assert_eq!(todo.updated_at(), t1());
    }

    #[test]
    fn snapshot_round_trip() {
        let mut todo = item(ItemType::Todo);
        let date = NaiveDate::from_ymd_opt(2026, 10, 12).unwrap();
        let time = NaiveTime::from_hms_opt(14, 30, 0).unwrap();
        todo.set_scheduled(Some(DatePoint::at(date, time)), t0());
        todo.set_due(Some(DatePoint::all_day(date)), t0()).unwrap();
        todo.set_priority(Priority::Medium, t0()).unwrap();
        todo.complete(t1()).unwrap();

        let restored = Item::restore(todo.snapshot()).unwrap();
        assert_eq!(restored, todo);
    }

    #[test]
    fn serde_round_trip_validates_on_the_way_in() {
        let todo = item(ItemType::Todo);
        let json = serde_json::to_string(&todo).unwrap();
        assert_eq!(serde_json::from_str::<Item>(&json).unwrap(), todo);

        // 伪造一个已完成的 Tip：反序列化必须拒绝。
        let mut value: serde_json::Value = serde_json::to_value(item(ItemType::Tip)).unwrap();
        value["status"] = "done".into();
        value["completed_at"] = serde_json::to_value(t1()).unwrap();
        assert!(serde_json::from_value::<Item>(value).is_err());
    }

    #[test]
    fn restore_rejects_inconsistent_snapshots() {
        let base = item(ItemType::Todo).snapshot();

        let mut done_without_time = base.clone();
        done_without_time.status = ItemStatus::Done;
        assert!(matches!(
            Item::restore(done_without_time),
            Err(DomainError::InvalidSnapshot(_))
        ));

        let mut time_without_date = base.clone();
        time_without_date.scheduled_time = NaiveTime::from_hms_opt(9, 0, 0);
        assert!(matches!(
            Item::restore(time_without_date),
            Err(DomainError::InvalidSnapshot(_))
        ));

        let mut completed_at_while_open = base.clone();
        completed_at_while_open.completed_at = Some(t1());
        assert!(matches!(
            Item::restore(completed_at_while_open),
            Err(DomainError::InvalidSnapshot(_))
        ));

        let mut note_with_due = item(ItemType::Note).snapshot();
        note_with_due.due_date = NaiveDate::from_ymd_opt(2026, 10, 12);
        assert!(matches!(
            Item::restore(note_with_due),
            Err(DomainError::InvalidSnapshot(_))
        ));

        let mut blank_title = base;
        blank_title.title = "  ".to_owned();
        assert_eq!(Item::restore(blank_title), Err(DomainError::EmptyTitle));
    }
}
