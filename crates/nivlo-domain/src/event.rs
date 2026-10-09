//! 领域事件。
//!
//! 领域方法返回事件，由 Application 层在**事务提交成功之后**发布（后端规范 §4.2），
//! 因此订阅者不会收到随后被回滚的变更。事件只携带 ID，订阅者按需再查询最新状态。

use chrono::NaiveDate;
use serde::{Deserialize, Serialize};

use crate::id::{ItemId, ProjectId};

/// 领域中发生的、其他模块可能关心的事实。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum DomainEvent {
    /// 新建了一个 Item。
    ItemCreated {
        /// 新 Item 的 ID。
        item_id: ItemId,
    },
    /// Item 的普通字段（标题、内容、优先级、项目等）发生变化。
    ItemUpdated {
        /// 变化的 Item。
        item_id: ItemId,
    },
    /// Item 的类型被转换。
    ItemTypeChanged {
        /// 变化的 Item。
        item_id: ItemId,
    },
    /// Todo 被完成。
    ItemCompleted {
        /// 被完成的 Item。
        item_id: ItemId,
    },
    /// 已完成的 Todo 被重新打开。
    ItemReopened {
        /// 被重新打开的 Item。
        item_id: ItemId,
    },
    /// Item 被归档。
    ItemArchived {
        /// 被归档的 Item。
        item_id: ItemId,
    },
    /// Item 被取消归档。
    ItemUnarchived {
        /// 被取消归档的 Item。
        item_id: ItemId,
    },
    /// Item 的计划 / 截止 / 提醒时间发生变化，Scheduler 需要重新计算触发点。
    ScheduleChanged {
        /// 变化的 Item。
        item_id: ItemId,
    },
    /// Today 的手动顺序被调整。
    TodayReordered,
    /// 本地日期发生了切换（过了本地午夜、休眠唤醒或用户修改了系统时间）。
    ///
    /// Today 视图依赖"今天"，收到该事件后需要重新计算。
    DayChanged {
        /// 新的本地日期。
        date: NaiveDate,
    },
    /// 新建了一个 Project。
    ProjectCreated {
        /// 新 Project 的 ID。
        project_id: ProjectId,
    },
}

impl DomainEvent {
    /// 返回事件关联的 Item ID；与 Item 无关的事件返回 `None`。
    pub fn item_id(&self) -> Option<ItemId> {
        match self {
            Self::ItemCreated { item_id }
            | Self::ItemUpdated { item_id }
            | Self::ItemTypeChanged { item_id }
            | Self::ItemCompleted { item_id }
            | Self::ItemReopened { item_id }
            | Self::ItemArchived { item_id }
            | Self::ItemUnarchived { item_id }
            | Self::ScheduleChanged { item_id } => Some(*item_id),
            Self::TodayReordered | Self::DayChanged { .. } | Self::ProjectCreated { .. } => None,
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use uuid::Uuid;

    use super::*;

    #[test]
    fn serde_round_trip_uses_tagged_representation() {
        let id = ItemId::from_uuid(Uuid::from_u128(1));
        let event = DomainEvent::ItemCompleted { item_id: id };
        let json = serde_json::to_value(&event).unwrap();
        assert_eq!(json["type"], "item_completed");
        assert_eq!(serde_json::from_value::<DomainEvent>(json).unwrap(), event);

        let reorder = serde_json::to_string(&DomainEvent::TodayReordered).unwrap();
        assert_eq!(
            serde_json::from_str::<DomainEvent>(&reorder).unwrap(),
            DomainEvent::TodayReordered
        );
    }

    #[test]
    fn item_id_is_extracted_when_present() {
        let id = ItemId::from_uuid(Uuid::from_u128(7));
        assert_eq!(
            DomainEvent::ScheduleChanged { item_id: id }.item_id(),
            Some(id)
        );
        assert_eq!(DomainEvent::TodayReordered.item_id(), None);
    }
}
