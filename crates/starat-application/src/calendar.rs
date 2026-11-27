//! `CalendarService`：Calendar 的查询（实施计划 4.1、4.2、产品文档 §20）。
//!
//! * Calendar 主要基于 **Scheduled**（计划日期）：计划在某天的 Todo / Note / Tip 出现在那一天；
//! * **Due**（截止日期）是 Deadline Overlay：开放的 Todo 在截止那天多出一个截止标记，
//!   与它的计划条目是两回事（计划是「打算哪天做」，截止是「最晚哪天要交」）；
//! * 日期都是用户本地日历日期，不含时区；「今天」来自注入的时钟，所以时区正确；
//! * 可见范围（月视图的整周网格、周视图的一周）只在这里计算——前端只负责排版，
//!   Rust 与 TS 共用 `fixtures/dates/calendar-ranges.json` 的测试向量。

use std::sync::Arc;

use chrono::{Datelike, Duration, NaiveDate};
use starat_common::clock::Clock;
use starat_domain::item::{Item, ItemType};

use crate::error::AppError;
use crate::ports::UnitOfWork;
use crate::settings::read_week_start;

/// 一周从哪天开始。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum WeekStart {
    /// 周一（默认）。
    #[default]
    Monday,
    /// 周日。
    Sunday,
}

impl WeekStart {
    /// 存进设置表的稳定文本。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Monday => "monday",
            Self::Sunday => "sunday",
        }
    }

    /// 从设置里的文本还原；不认识的值返回 `None`（调用方退回默认）。
    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "monday" => Some(Self::Monday),
            "sunday" => Some(Self::Sunday),
            _ => None,
        }
    }

    /// `date` 所在那一周的第一天。
    pub fn start_of_week(self, date: NaiveDate) -> NaiveDate {
        let back = match self {
            Self::Monday => date.weekday().num_days_from_monday(),
            Self::Sunday => date.weekday().num_days_from_sunday(),
        };
        date - Duration::days(i64::from(back))
    }
}

/// Calendar 的视图。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CalendarView {
    /// 月视图：包含这个月的整周网格（4 到 6 行）。
    Month,
    /// 周视图：`anchor` 所在的一周。
    Week,
}

/// 视图可见的日期范围（闭区间）。
///
/// 月视图从「这个月 1 日所在周的第一天」到「这个月最后一天所在周的最后一天」；
/// 周视图是 `anchor` 所在的一周。
pub fn visible_range(
    view: CalendarView,
    anchor: NaiveDate,
    week_start: WeekStart,
) -> (NaiveDate, NaiveDate) {
    match view {
        CalendarView::Week => {
            let from = week_start.start_of_week(anchor);
            (from, from + Duration::days(6))
        }
        CalendarView::Month => {
            let first = anchor.with_day(1).unwrap_or(anchor);
            let next_month_first = if first.month() == 12 {
                NaiveDate::from_ymd_opt(first.year() + 1, 1, 1)
            } else {
                NaiveDate::from_ymd_opt(first.year(), first.month() + 1, 1)
            };
            let last = next_month_first.map_or(anchor, |d| d - Duration::days(1));
            let from = week_start.start_of_week(first);
            (from, week_start.start_of_week(last) + Duration::days(6))
        }
    }
}

/// 一条 Calendar 条目的种类。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EntryKind {
    /// 计划在这一天。
    Scheduled,
    /// 这一天截止（Deadline Overlay）。
    Due,
}

/// Calendar 里的一条：某个 Item 在某一天的出现。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CalendarEntry {
    /// Item。
    pub item: Item,
    /// 出现在哪一天。
    pub date: NaiveDate,
    /// 是计划还是截止。
    pub kind: EntryKind,
}

/// Calendar 查询的结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CalendarData {
    /// 可见范围的第一天。
    pub from: NaiveDate,
    /// 可见范围的最后一天。
    pub to: NaiveDate,
    /// 今天（用户本地日期）。
    pub today: NaiveDate,
    /// 一周从哪天开始。
    pub week_start: WeekStart,
    /// 范围内的条目，按日期、种类（计划在前）、时间（全天在前）、创建时间排序。
    pub entries: Vec<CalendarEntry>,
    /// 还没有计划日期的未完成待办（待安排），最近创建的在前。
    pub unscheduled: Vec<Item>,
}

/// 「待安排」列表最多返回多少条。
pub const UNSCHEDULED_LIMIT: u32 = 100;

/// Calendar 的 Use Case。
#[derive(Clone)]
pub struct CalendarService {
    /// 事务工厂。
    uow: Arc<dyn UnitOfWork>,
    /// 时钟：「今天」与时区。
    clock: Arc<dyn Clock>,
}

impl CalendarService {
    /// 创建服务。
    pub fn new(uow: Arc<dyn UnitOfWork>, clock: Arc<dyn Clock>) -> Self {
        Self { uow, clock }
    }

    /// 查询 Calendar：可见范围内的计划与截止条目，以及待安排的待办。
    ///
    /// # Errors
    ///
    /// 存储错误。
    pub async fn get_calendar(
        &self,
        view: CalendarView,
        anchor: NaiveDate,
    ) -> Result<CalendarData, AppError> {
        let mut tx = self.uow.begin_read().await?;
        let week_start = read_week_start(&mut *tx).await?;
        let (from, to) = visible_range(view, anchor, week_start);
        let items = tx.items().list_calendar(from, to).await?;
        let unscheduled = tx
            .items()
            .list_unscheduled_open_todos(UNSCHEDULED_LIMIT)
            .await?;

        let mut entries = Vec::new();
        for item in items {
            if let Some(scheduled) = item.scheduled()
                && (from..=to).contains(&scheduled.date())
            {
                entries.push(CalendarEntry {
                    date: scheduled.date(),
                    kind: EntryKind::Scheduled,
                    item: item.clone(),
                });
            }
            // 截止标记只给还没完成的待办：做完了就不再「逼近」了。
            if item.item_type() == ItemType::Todo
                && !item.is_done()
                && let Some(due) = item.due()
                && (from..=to).contains(&due.date())
            {
                entries.push(CalendarEntry {
                    date: due.date(),
                    kind: EntryKind::Due,
                    item,
                });
            }
        }
        entries.sort_by(|a, b| {
            let time = |e: &CalendarEntry| match e.kind {
                EntryKind::Scheduled => e.item.scheduled().and_then(|p| p.time()),
                EntryKind::Due => e.item.due().and_then(|p| p.time()),
            };
            (
                a.date,
                a.kind == EntryKind::Due,
                time(a),
                a.item.created_at(),
                a.item.id(),
            )
                .cmp(&(
                    b.date,
                    b.kind == EntryKind::Due,
                    time(b),
                    b.item.created_at(),
                    b.item.id(),
                ))
        });
        Ok(CalendarData {
            from,
            to,
            today: self.clock.today_local(),
            week_start,
            entries,
            unscheduled,
        })
    }
}

#[cfg(test)]
mod tests;
