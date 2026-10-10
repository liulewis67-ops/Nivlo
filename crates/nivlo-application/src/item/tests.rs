//! `ItemService` 的 Use Case 测试：使用内存 Fake，不依赖 SQLite。

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::sync::Arc;

use chrono::{Duration, NaiveDate, TimeZone, Utc};
use nivlo_common::clock::{Clock, FakeClock};
use nivlo_domain::event::DomainEvent;
use nivlo_domain::id::ItemId;
use nivlo_domain::item::{DatePoint, ItemStatus, ItemType, NewItem, Priority};

use super::{ItemService, Patch, UpdateItemInput};
use crate::error::ErrorCode;
use crate::ports::ItemFilter;
use crate::testing::{FakeUnitOfWork, RecordingPublisher};

/// 测试夹具：服务 + 可观察的依赖。
struct Fixture {
    service: ItemService,
    uow: FakeUnitOfWork,
    events: Arc<RecordingPublisher>,
    clock: FakeClock,
}

/// 构造夹具；时钟固定在 2026-10-09 08:00 UTC。
fn fixture() -> Fixture {
    let uow = FakeUnitOfWork::new();
    let events = Arc::new(RecordingPublisher::new());
    let clock = FakeClock::at_utc(Utc.with_ymd_and_hms(2026, 10, 9, 8, 0, 0).unwrap());
    let service = ItemService::new(
        Arc::new(uow.clone()),
        Arc::new(clock.clone()),
        events.clone(),
    );
    Fixture {
        service,
        uow,
        events,
        clock,
    }
}

#[tokio::test]
async fn create_persists_and_publishes_item_created() {
    let f = fixture();
    let item = f
        .service
        .create_item(NewItem::new(ItemType::Todo, "  写周报 "))
        .await
        .unwrap();

    assert_eq!(item.title().as_str(), "写周报");
    assert_eq!(item.created_at(), f.clock.now_utc());
    assert_eq!(f.uow.committed_items(), vec![item.clone()]);
    assert_eq!(
        f.events.events(),
        vec![DomainEvent::ItemCreated { item_id: item.id() }]
    );
}

#[tokio::test]
async fn create_with_schedule_also_publishes_schedule_changed() {
    let f = fixture();
    let mut new = NewItem::new(ItemType::Todo, "交报告");
    new.scheduled = Some(DatePoint::all_day(
        NaiveDate::from_ymd_opt(2026, 10, 10).unwrap(),
    ));
    let item = f.service.create_item(new).await.unwrap();
    assert_eq!(
        f.events.events(),
        vec![
            DomainEvent::ItemCreated { item_id: item.id() },
            DomainEvent::ScheduleChanged { item_id: item.id() },
        ]
    );
}

#[tokio::test]
async fn create_validation_failure_writes_nothing_and_publishes_nothing() {
    let f = fixture();
    let err = f
        .service
        .create_item(NewItem::new(ItemType::Todo, "   "))
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::ItemTitleEmpty);
    assert!(f.uow.committed_items().is_empty());
    assert!(f.events.events().is_empty());
}

#[tokio::test]
async fn commit_failure_publishes_no_event_and_leaves_no_data() {
    let f = fixture();
    f.uow.fail_next_commit();
    let err = f
        .service
        .create_item(NewItem::new(ItemType::Todo, "x"))
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::StorageUnavailable);
    assert!(f.uow.committed_items().is_empty());
    // 事务回滚时不得发布事件。
    assert!(f.events.events().is_empty());
}

#[tokio::test]
async fn update_changes_fields_and_publishes_item_updated() {
    let f = fixture();
    let item = f
        .service
        .create_item(NewItem::new(ItemType::Todo, "旧标题"))
        .await
        .unwrap();
    f.clock.advance(Duration::hours(1));

    let updated = f
        .service
        .update_item(
            item.id(),
            UpdateItemInput {
                title: Some("新标题".into()),
                priority: Some(Priority::High),
                content: Patch::Set("详情".into()),
                ..UpdateItemInput::default()
            },
        )
        .await
        .unwrap();

    assert_eq!(updated.title().as_str(), "新标题");
    assert_eq!(updated.priority(), Priority::High);
    assert_eq!(updated.content(), Some("详情"));
    assert!(updated.updated_at() > updated.created_at());
    assert_eq!(f.uow.committed_items(), vec![updated.clone()]);

    let events = f.events.events();
    assert_eq!(
        events.last(),
        Some(&DomainEvent::ItemUpdated { item_id: item.id() })
    );
    // 只发布一次 ItemUpdated。
    assert_eq!(
        events
            .iter()
            .filter(|e| matches!(e, DomainEvent::ItemUpdated { .. }))
            .count(),
        1
    );
}

#[tokio::test]
async fn update_schedule_publishes_schedule_changed_for_the_scheduler() {
    let f = fixture();
    let item = f
        .service
        .create_item(NewItem::new(ItemType::Todo, "x"))
        .await
        .unwrap();
    let date = DatePoint::all_day(NaiveDate::from_ymd_opt(2026, 10, 12).unwrap());
    f.service
        .update_item(
            item.id(),
            UpdateItemInput {
                scheduled: Patch::Set(date),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let events = f.events.events();
    assert!(events.contains(&DomainEvent::ScheduleChanged { item_id: item.id() }));
    assert!(events.contains(&DomainEvent::ItemUpdated { item_id: item.id() }));

    // 清除计划日期同样是 Schedule 变化。
    f.service
        .update_item(
            item.id(),
            UpdateItemInput {
                scheduled: Patch::Clear,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert!(
        f.service
            .get_item(item.id())
            .await
            .unwrap()
            .scheduled()
            .is_none()
    );
}

#[tokio::test]
async fn type_change_and_dependent_field_clear_in_one_update() {
    let f = fixture();
    let mut new = NewItem::new(ItemType::Todo, "转笔记");
    new.due = Some(DatePoint::all_day(
        NaiveDate::from_ymd_opt(2026, 10, 15).unwrap(),
    ));
    new.priority = Priority::High;
    let item = f.service.create_item(new).await.unwrap();

    let updated = f
        .service
        .update_item(
            item.id(),
            UpdateItemInput {
                item_type: Some(ItemType::Note),
                due: Patch::Clear,
                ..UpdateItemInput::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(updated.item_type(), ItemType::Note);
    assert!(updated.due().is_none());
    assert_eq!(updated.priority(), Priority::None);
    assert!(
        f.events
            .events()
            .contains(&DomainEvent::ItemTypeChanged { item_id: item.id() })
    );
}

#[tokio::test]
async fn failed_update_rolls_back_everything() {
    let f = fixture();
    let item = f
        .service
        .create_item(NewItem::new(ItemType::Note, "笔记"))
        .await
        .unwrap();
    let before_events = f.events.events().len();

    // 先改标题（合法），再给 Note 设置优先级（非法）：整个更新必须作废。
    let err = f
        .service
        .update_item(
            item.id(),
            UpdateItemInput {
                title: Some("改了".into()),
                priority: Some(Priority::High),
                ..UpdateItemInput::default()
            },
        )
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::ItemFieldNotApplicable);
    assert_eq!(
        f.service
            .get_item(item.id())
            .await
            .unwrap()
            .title()
            .as_str(),
        "笔记"
    );
    assert_eq!(f.events.events().len(), before_events);
}

#[tokio::test]
async fn empty_update_is_a_no_op() {
    let f = fixture();
    let item = f
        .service
        .create_item(NewItem::new(ItemType::Todo, "x"))
        .await
        .unwrap();
    let before = f.events.events().len();
    let same = f
        .service
        .update_item(item.id(), UpdateItemInput::default())
        .await
        .unwrap();
    assert_eq!(same, item);
    assert_eq!(f.events.events().len(), before);
}

#[tokio::test]
async fn missing_item_reports_item_not_found() {
    let f = fixture();
    let ghost = ItemId::from_uuid(uuid::Uuid::from_u128(404));
    assert_eq!(
        f.service.get_item(ghost).await.unwrap_err().code,
        ErrorCode::ItemNotFound
    );
    assert_eq!(
        f.service
            .update_item(ghost, UpdateItemInput::default())
            .await
            .unwrap_err()
            .code,
        ErrorCode::ItemNotFound
    );
}

#[tokio::test]
async fn list_returns_newest_first_and_honors_filters() {
    let f = fixture();
    let a = f
        .service
        .create_item(NewItem::new(ItemType::Todo, "A"))
        .await
        .unwrap();
    f.clock.advance(Duration::minutes(1));
    let b = f
        .service
        .create_item(NewItem::new(ItemType::Note, "B"))
        .await
        .unwrap();
    f.clock.advance(Duration::minutes(1));
    let c = f
        .service
        .create_item(NewItem::new(ItemType::Todo, "C"))
        .await
        .unwrap();

    let all = f.service.list_items(ItemFilter::default()).await.unwrap();
    assert_eq!(
        all.iter().map(|i| i.id()).collect::<Vec<_>>(),
        vec![c.id(), b.id(), a.id()]
    );

    let todos = f
        .service
        .list_items(ItemFilter {
            item_type: Some(ItemType::Todo),
            ..ItemFilter::default()
        })
        .await
        .unwrap();
    assert_eq!(
        todos.iter().map(|i| i.id()).collect::<Vec<_>>(),
        vec![c.id(), a.id()]
    );
    assert!(todos.iter().all(|i| i.status() == ItemStatus::Open));
}

#[tokio::test]
async fn quick_create_gives_todos_and_tips_today_and_notes_no_date() {
    let f = fixture();
    let today = f.clock.today_local();

    let todo = f
        .service
        .quick_create(ItemType::Todo, "  写周报 ")
        .await
        .unwrap();
    let tip = f
        .service
        .quick_create(ItemType::Tip, "服务器维护")
        .await
        .unwrap();
    let note = f
        .service
        .quick_create(ItemType::Note, "一个想法")
        .await
        .unwrap();

    assert_eq!(todo.title().as_str(), "写周报");
    assert_eq!(todo.scheduled(), Some(DatePoint::all_day(today)));
    assert_eq!(tip.scheduled(), Some(DatePoint::all_day(today)));
    assert_eq!(note.scheduled(), None);
    assert_eq!(f.uow.committed_items().len(), 3);
}

#[tokio::test]
async fn quick_create_uses_the_users_local_date_not_utc() {
    // UTC 16:30 在上海已经是次日。
    let uow = FakeUnitOfWork::new();
    let events = Arc::new(RecordingPublisher::new());
    let clock = FakeClock::new(
        Utc.with_ymd_and_hms(2026, 10, 9, 16, 30, 0).unwrap(),
        chrono_tz::Tz::Asia__Shanghai,
    );
    let service = ItemService::new(Arc::new(uow), Arc::new(clock), events);

    let todo = service.quick_create(ItemType::Todo, "x").await.unwrap();

    assert_eq!(
        todo.scheduled(),
        Some(DatePoint::all_day(
            NaiveDate::from_ymd_opt(2026, 10, 10).unwrap()
        ))
    );
}

#[tokio::test]
async fn quick_create_rejects_blank_titles_without_writing_anything() {
    let f = fixture();
    for title in [
        "", "   ", "
	",
    ] {
        let err = f
            .service
            .quick_create(ItemType::Todo, title)
            .await
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::ItemTitleEmpty);
    }
    assert!(f.uow.committed_items().is_empty());
    assert!(f.events.events().is_empty());
}

#[tokio::test]
async fn quick_create_publishes_created_and_schedule_events_for_scheduled_types_only() {
    let f = fixture();
    let todo = f.service.quick_create(ItemType::Todo, "a").await.unwrap();
    let note = f.service.quick_create(ItemType::Note, "b").await.unwrap();

    assert_eq!(
        f.events.events(),
        vec![
            DomainEvent::ItemCreated { item_id: todo.id() },
            DomainEvent::ScheduleChanged { item_id: todo.id() },
            DomainEvent::ItemCreated { item_id: note.id() },
        ]
    );
}

#[tokio::test]
async fn complete_then_reopen_round_trips_and_publishes_events() {
    let f = fixture();
    let todo = f
        .service
        .quick_create(ItemType::Todo, "写周报")
        .await
        .unwrap();
    f.events.clear();

    let done = f.service.complete_item(todo.id()).await.unwrap();
    assert_eq!(done.status(), ItemStatus::Done);
    assert_eq!(done.completed_at(), Some(f.clock.now_utc()));

    let reopened = f.service.reopen_item(todo.id()).await.unwrap();
    assert_eq!(reopened.status(), ItemStatus::Open);
    assert_eq!(reopened.completed_at(), None);
    assert_eq!(
        f.events.events(),
        vec![
            DomainEvent::ItemCompleted { item_id: todo.id() },
            DomainEvent::ItemReopened { item_id: todo.id() },
        ]
    );
}

#[tokio::test]
async fn complete_and_reopen_reject_invalid_transitions_without_events() {
    let f = fixture();
    let todo = f.service.quick_create(ItemType::Todo, "a").await.unwrap();
    let note = f.service.quick_create(ItemType::Note, "b").await.unwrap();
    f.events.clear();

    let err = f.service.reopen_item(todo.id()).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::ItemNotCompleted);
    let err = f.service.complete_item(note.id()).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::ItemNotCompletable);
    f.service.complete_item(todo.id()).await.unwrap();
    f.events.clear();
    let err = f.service.complete_item(todo.id()).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::ItemAlreadyCompleted);
    let err = f
        .service
        .complete_item(ItemId::from_uuid(uuid::Uuid::nil()))
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::ItemNotFound);
    assert!(f.events.events().is_empty());
}

/// 日期简写。
fn day(m: u32, d: u32) -> NaiveDate {
    NaiveDate::from_ymd_opt(2026, m, d).unwrap()
}

#[tokio::test]
async fn reschedule_moves_the_plan_and_drops_the_item_from_the_today_order() {
    use super::RescheduleTarget;

    let f = fixture(); // 2026-10-09，周五
    let todo = f
        .service
        .quick_create(ItemType::Todo, "写周报")
        .await
        .unwrap();
    let other = f
        .service
        .quick_create(ItemType::Todo, "回邮件")
        .await
        .unwrap();
    f.uow
        .seed_today_order(day(10, 9), vec![todo.id(), other.id()]);
    f.events.clear();

    let moved = f
        .service
        .reschedule_item(todo.id(), RescheduleTarget::Tomorrow)
        .await
        .unwrap();

    assert_eq!(moved.scheduled(), Some(DatePoint::all_day(day(10, 10))));
    // 顺序记录里只剩没被推迟的那一项。
    assert_eq!(f.uow.committed_today_order(day(10, 9)), vec![other.id()]);
    assert_eq!(
        f.events.events(),
        vec![DomainEvent::ScheduleChanged { item_id: todo.id() }]
    );
}

#[tokio::test]
async fn reschedule_targets_resolve_relative_to_the_local_today() {
    use super::RescheduleTarget;

    let f = fixture();
    let todo = f.service.quick_create(ItemType::Todo, "a").await.unwrap();
    let scheduled = |target| {
        let service = f.service.clone();
        let id = todo.id();
        async move {
            service
                .reschedule_item(id, target)
                .await
                .unwrap()
                .scheduled()
        }
    };

    // 周五之后的"下周一"是 10-12；今天是周一时是 7 天后（见 next_monday_after 测试）。
    assert_eq!(
        scheduled(RescheduleTarget::Later).await,
        Some(DatePoint::all_day(day(10, 12)))
    );
    assert_eq!(
        scheduled(RescheduleTarget::Today).await,
        Some(DatePoint::all_day(day(10, 9)))
    );
    assert_eq!(scheduled(RescheduleTarget::Inbox).await, None);
    let exact = DatePoint::all_day(day(11, 3));
    assert_eq!(
        scheduled(RescheduleTarget::Exact(Some(exact))).await,
        Some(exact)
    );
}

#[tokio::test]
async fn reschedule_keeps_a_specific_time_of_day() {
    use chrono::NaiveTime;

    use super::RescheduleTarget;

    let f = fixture();
    let mut new = NewItem::new(ItemType::Todo, "站会");
    let nine = NaiveTime::from_hms_opt(9, 30, 0).unwrap();
    new.scheduled = Some(DatePoint::at(day(10, 9), nine));
    let todo = f.service.create_item(new).await.unwrap();

    let moved = f
        .service
        .reschedule_item(todo.id(), RescheduleTarget::Tomorrow)
        .await
        .unwrap();

    assert_eq!(moved.scheduled(), Some(DatePoint::at(day(10, 10), nine)));
}

#[test]
fn next_monday_is_strictly_after_the_given_day() {
    use super::service::next_monday_after;

    assert_eq!(next_monday_after(day(10, 9)), day(10, 12)); // 周五
    assert_eq!(next_monday_after(day(10, 11)), day(10, 12)); // 周日
    assert_eq!(next_monday_after(day(10, 12)), day(10, 19)); // 周一
}
