//! `TodayService`：Today 视图的查询。
//!
//! Today 的定义（实施计划 D-01、D-07）：
//!
//! * **待办**：类型为 Todo、未完成、未归档，且计划日期**不晚于**今天。计划日期早于今天的
//!   视为"逾期"，自动滚入 Today 并带逾期标记；
//! * **提示**：类型为 Tip，且计划日期**恰好**是今天；
//! * **今日已完成**：今天（本地日期）完成的 Todo，以删除线显示在底部，次日不再出现；
//! * 悬浮窗的数字 = 待办的数量（不含已完成与提示）。
//!
//! 待办的顺序是用户手动排好的 Today Order（\`daily_item_order\`），而不是 priority / created_at / due
//! （产品文档 §5.3）；没有手动顺序记录的待办（新加入 Today、逾期滚入的）追加在末尾，
//! 彼此按计划日期、创建时间排序。

use std::sync::Arc;

use chrono::NaiveDate;
use nivlo_common::clock::{Clock, start_of_local_day};
use nivlo_domain::id::ItemId;
use nivlo_domain::item::Item;

use crate::error::AppError;
use crate::ports::UnitOfWork;

/// Today 中的一个条目。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TodayEntry {
    /// 条目本身。
    pub item: Item,
    /// 是否逾期：计划日期早于今天。
    pub is_overdue: bool,
}

/// Today 视图。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TodayView {
    /// 用户本地时区下的"今天"。
    pub date: NaiveDate,
    /// 未完成的待办，已按 Today Order 排序。
    pub todos: Vec<TodayEntry>,
    /// 今天的提示，按时间排序（全天提示在前）。
    pub tips: Vec<TodayEntry>,
    /// 今天已完成的待办，按完成时间排序。
    pub completed: Vec<TodayEntry>,
}

impl TodayView {
    /// 今天还剩多少个待办——悬浮窗徽标上显示的数字。
    pub fn remaining_count(&self) -> usize {
        self.todos.len()
    }
}

/// Today 的 Use Case。
#[derive(Clone)]
pub struct TodayService {
    /// 事务工厂。
    uow: Arc<dyn UnitOfWork>,
    /// 时钟：决定"今天"与本地日期的 UTC 边界。
    clock: Arc<dyn Clock>,
}

/// 把待办按手动顺序排列：先是 `order` 中出现的（保持 `order` 的先后），其余保持输入顺序追加在末尾。
///
/// `order` 中有但 `todos` 中没有的 ID（已完成、已推迟、已删除）被忽略，因此顺序表里的陈旧记录
/// 不会让结果出错（实施计划 1.7 还会在写入时清理它们）。
fn apply_manual_order(todos: Vec<Item>, order: &[ItemId]) -> Vec<Item> {
    let mut remaining = todos;
    let mut ordered = Vec::with_capacity(remaining.len());
    for id in order {
        if let Some(index) = remaining.iter().position(|item| item.id() == *id) {
            ordered.push(remaining.remove(index));
        }
    }
    // 没有手动顺序的待办保持查询给出的"计划日期、创建时间"顺序。
    ordered.extend(remaining);
    ordered
}

impl TodayService {
    /// 创建服务。
    pub fn new(uow: Arc<dyn UnitOfWork>, clock: Arc<dyn Clock>) -> Self {
        Self { uow, clock }
    }

    /// 查询今天的视图。
    ///
    /// 在单个事务中读取，保证待办、提示、已完成与手动顺序来自同一时刻的一致快照。
    ///
    /// # Errors
    ///
    /// 存储错误（含 [`crate::error::ErrorCode::StorageCorrupt`]）。
    pub async fn get_today(&self) -> Result<TodayView, AppError> {
        let timezone = self.clock.timezone();
        let date = self.clock.today_local();
        // 本地"今天"在 UTC 轴上的区间；夏令时让某天不是 24 小时，所以两端都单独换算。
        let from = start_of_local_day(date, timezone);
        let to = start_of_local_day(date.succ_opt().unwrap_or(date), timezone);

        let mut tx = self.uow.begin().await?;
        let open_todos = tx
            .items()
            .list_open_todos_scheduled_on_or_before(date)
            .await?;
        let tips = tx.items().list_tips_scheduled_on(date).await?;
        let completed = tx.items().list_todos_completed_between(from, to).await?;
        let order = tx.today_order().get(date).await?;
        drop(tx);

        let entry = |item: Item| {
            let is_overdue = item.scheduled().is_some_and(|s| s.date() < date);
            TodayEntry { item, is_overdue }
        };
        let mut tips: Vec<Item> = tips;
        // 全天提示（没有具体时间）排在有时间的前面，其余按时间、创建时间排序。
        tips.sort_by_key(|i| (i.scheduled().and_then(|s| s.time()), i.created_at(), i.id()));

        Ok(TodayView {
            date,
            todos: apply_manual_order(open_todos, &order)
                .into_iter()
                .map(entry)
                .collect(),
            tips: tips.into_iter().map(entry).collect(),
            completed: completed.into_iter().map(entry).collect(),
        })
    }
}

#[cfg(test)]
mod tests;
