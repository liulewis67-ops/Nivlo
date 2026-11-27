//! 触发点（Trigger）：Scheduler 在某个时间点要通知用户的一件事（实施计划 4.4）。
//!
//! 触发点由 Item 的字段**推导**出来，不单独存储；只有「已经通知过」这件事落库
//! （`trigger_log`，见 [`crate::ports::TriggerRepository`]），所以修改提醒时间自然产生新的触发点。

use chrono::{DateTime, NaiveDate, NaiveTime, Utc};
use chrono_tz::Tz;
use starat_domain::id::ItemId;
use starat_domain::item::{Item, ItemType};

/// 触发点的种类。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum TriggerKind {
    /// 显式设置的提醒时间点（`reminder_at`）。
    Reminder,
    /// Tip 的计划时间（「15:00 提交周报」）。
    Tip,
    /// 待办的截止时间。
    Due,
}

impl TriggerKind {
    /// 存进数据库的稳定文本。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Reminder => "reminder",
            Self::Tip => "tip",
            Self::Due => "due",
        }
    }

    /// 从数据库文本还原。
    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "reminder" => Some(Self::Reminder),
            "tip" => Some(Self::Tip),
            "due" => Some(Self::Due),
            _ => None,
        }
    }
}

/// 一个触发点的身份：哪个 Item、哪种、什么时刻。时刻不同就是不同的触发点。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct TriggerKey {
    /// 触发点的时刻（UTC）。
    pub fire_at: DateTime<Utc>,
    /// Item。
    pub item_id: ItemId,
    /// 种类。
    pub kind: TriggerKind,
}

/// 一个待触发的点，连同通知需要的展示信息。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Trigger {
    /// 身份。
    pub key: TriggerKey,
    /// Item 的标题。
    pub title: String,
    /// Item 的类型。
    pub item_type: ItemType,
}

/// 把本地日期 + 时间换算成 UTC 时刻。
///
/// 夏令时回拨造成的重复时刻取**较早**的那一次；夏令时前拨造成的不存在的时刻没有对应的 UTC，
/// 返回 `None`（那个触发点被跳过，而不是胡乱挑一个时间）。
pub fn local_to_utc(date: NaiveDate, time: NaiveTime, timezone: Tz) -> Option<DateTime<Utc>> {
    use chrono::TimeZone;
    timezone
        .from_local_datetime(&date.and_time(time))
        .earliest()
        .map(|local| local.with_timezone(&Utc))
}

/// 由一个 Item 推导出它的全部触发点。
///
/// * 已完成、已归档的 Item 没有触发点（调用方还应当排除已删除的）；
/// * 提醒：`reminder_at`（Todo 与 Tip）；
/// * Tip：计划日期带具体时间时，在那个本地时间触发；
/// * 截止：Todo 的截止日期带具体时间时，在那个本地时间触发（只有日期没有时间的截止不触发通知，
///   它只是 Calendar 与 Today 里的标记）。
pub fn triggers_of(item: &Item, timezone: Tz) -> Vec<Trigger> {
    if item.is_done() || item.is_archived() {
        return Vec::new();
    }
    let make = |kind: TriggerKind, fire_at: DateTime<Utc>| Trigger {
        key: TriggerKey {
            fire_at,
            item_id: item.id(),
            kind,
        },
        title: item.title().as_str().to_owned(),
        item_type: item.item_type(),
    };
    let mut triggers = Vec::new();
    if let Some(at) = item.reminder_at() {
        triggers.push(make(TriggerKind::Reminder, at));
    }
    if item.item_type() == ItemType::Tip
        && let Some(scheduled) = item.scheduled()
        && let Some(time) = scheduled.time()
        && let Some(at) = local_to_utc(scheduled.date(), time, timezone)
    {
        triggers.push(make(TriggerKind::Tip, at));
    }
    if item.item_type() == ItemType::Todo
        && let Some(due) = item.due()
        && let Some(time) = due.time()
        && let Some(at) = local_to_utc(due.date(), time, timezone)
    {
        triggers.push(make(TriggerKind::Due, at));
    }
    triggers
}
