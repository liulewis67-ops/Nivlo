//! UI Event Mapper：选择并转换需要通知前端的领域事件。

use asterjot_application::event::{UiEvent, UiEventMapper};
use asterjot_domain::event::DomainEvent;

/// 默认映射：Item 的创建映射为 `ItemCreated`，其余影响 Item 展示的变化映射为 `ItemUpdated`。
///
/// 前端只需要知道"某个 Item 变了"就能刷新缓存，因此完成、重新打开、归档、类型转换、
/// 计划变化都折叠为 `ItemUpdated`；与 Item 无关的事件（如 `ProjectCreated`）暂不通知 UI。
#[derive(Debug, Default, Clone, Copy)]
pub struct DefaultUiEventMapper;

impl UiEventMapper for DefaultUiEventMapper {
    /// 映射一个领域事件；不需要通知 UI 的事件返回 `None`。
    fn map(&self, event: &DomainEvent) -> Option<UiEvent> {
        match event {
            DomainEvent::ItemCreated { item_id } => {
                Some(UiEvent::ItemCreated { item_id: *item_id })
            }
            DomainEvent::ItemUpdated { item_id }
            | DomainEvent::ItemTypeChanged { item_id }
            | DomainEvent::ItemCompleted { item_id }
            | DomainEvent::ItemReopened { item_id }
            | DomainEvent::ItemArchived { item_id }
            | DomainEvent::ItemUnarchived { item_id }
            | DomainEvent::ItemDeleted { item_id }
            | DomainEvent::ScheduleChanged { item_id } => {
                Some(UiEvent::ItemUpdated { item_id: *item_id })
            }
            DomainEvent::TodayReordered => Some(UiEvent::TodayReordered),
            DomainEvent::DayChanged { date } => Some(UiEvent::DayChanged { date: *date }),
            DomainEvent::ProjectCreated { .. } => None,
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use asterjot_domain::id::{ItemId, ProjectId};
    use uuid::Uuid;

    use super::*;

    #[test]
    fn created_maps_to_item_created() {
        let id = ItemId::from_uuid(Uuid::from_u128(1));
        assert_eq!(
            DefaultUiEventMapper.map(&DomainEvent::ItemCreated { item_id: id }),
            Some(UiEvent::ItemCreated { item_id: id })
        );
    }

    #[test]
    fn item_changes_collapse_into_item_updated() {
        let id = ItemId::from_uuid(Uuid::from_u128(1));
        for event in [
            DomainEvent::ItemUpdated { item_id: id },
            DomainEvent::ItemCompleted { item_id: id },
            DomainEvent::ItemReopened { item_id: id },
            DomainEvent::ItemArchived { item_id: id },
            DomainEvent::ItemUnarchived { item_id: id },
            DomainEvent::ItemTypeChanged { item_id: id },
            DomainEvent::ScheduleChanged { item_id: id },
        ] {
            assert_eq!(
                DefaultUiEventMapper.map(&event),
                Some(UiEvent::ItemUpdated { item_id: id })
            );
        }
    }

    #[test]
    fn today_events_are_forwarded() {
        assert_eq!(
            DefaultUiEventMapper.map(&DomainEvent::TodayReordered),
            Some(UiEvent::TodayReordered)
        );
        let date = chrono::NaiveDate::from_ymd_opt(2026, 10, 10).unwrap();
        assert_eq!(
            DefaultUiEventMapper.map(&DomainEvent::DayChanged { date }),
            Some(UiEvent::DayChanged { date })
        );
    }

    #[test]
    fn unrelated_events_are_not_forwarded() {
        let project = ProjectId::from_uuid(Uuid::from_u128(2));
        assert_eq!(
            DefaultUiEventMapper.map(&DomainEvent::ProjectCreated {
                project_id: project
            }),
            None
        );
    }
}
