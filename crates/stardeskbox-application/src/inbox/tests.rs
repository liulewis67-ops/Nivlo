//! `InboxService` 的 Use Case 测试：只依赖内存 Fake。

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::Arc;

use chrono::{Datelike, Duration, NaiveDate, TimeZone, Utc, Weekday};
use stardeskbox_common::clock::FakeClock;
use stardeskbox_domain::event::DomainEvent;
use stardeskbox_domain::id::ItemId;
use stardeskbox_domain::item::{Item, ItemType, NewItem};

use super::{InboxService, OrganizeAction, ScheduleTarget};
use crate::error::ErrorCode;
use crate::testing::{FakeUnitOfWork, RecordingPublisher};

/// 测试夹具。
struct Fixture {
    service: InboxService,
    uow: FakeUnitOfWork,
    events: Arc<RecordingPublisher>,
}

/// 构造夹具；时钟固定在 2026-10-09（周五）08:00 UTC。
fn fixture() -> Fixture {
    let uow = FakeUnitOfWork::new();
    let events = Arc::new(RecordingPublisher::new());
    let clock = FakeClock::at_utc(Utc.with_ymd_and_hms(2026, 10, 9, 8, 0, 0).unwrap());
    let service = InboxService::new(Arc::new(uow.clone()), Arc::new(clock), events.clone());
    Fixture {
        service,
        uow,
        events,
    }
}

/// 往库里放一个 Item；`in_inbox` 决定是否在收集箱里。创建时间随 `n` 递增。
fn seed(f: &Fixture, n: u32, item_type: ItemType, title: &str, in_inbox: bool) -> ItemId {
    let id = ItemId::from_uuid(uuid::Uuid::from_u128(u128::from(n)));
    let mut new = NewItem::new(item_type, title);
    new.in_inbox = in_inbox;
    let created = Utc.with_ymd_and_hms(2026, 10, 9, 7, 0, n % 60).unwrap();
    let (item, _) = Item::create(id, new, created).unwrap();
    f.uow.seed(item);
    id
}

/// 读回已提交的 Item。
fn committed(f: &Fixture, id: ItemId) -> Item {
    f.uow
        .committed_items()
        .into_iter()
        .find(|i| i.id() == id)
        .unwrap()
}

#[tokio::test]
async fn list_returns_only_inbox_items_newest_first_and_count_matches() {
    let f = fixture();
    let old = seed(&f, 1, ItemType::Note, "旧的", true);
    seed(&f, 2, ItemType::Todo, "已整理", false);
    let new = seed(&f, 3, ItemType::Todo, "新的", true);

    let entries = f.service.list().await.unwrap();
    let ids: Vec<ItemId> = entries.iter().map(|e| e.item.id()).collect();
    assert_eq!(ids, vec![new, old]);
    assert_eq!(f.service.count().await.unwrap(), 2);
}

#[tokio::test]
async fn archived_items_are_not_in_the_inbox_view() {
    let f = fixture();
    let id = seed(&f, 1, ItemType::Note, "x", true);
    f.service
        .organize(&[id], OrganizeAction::Archive)
        .await
        .unwrap();
    assert_eq!(f.service.count().await.unwrap(), 0);
    assert!(f.service.list().await.unwrap().is_empty());
}

#[tokio::test]
async fn every_organize_action_makes_items_leave_the_inbox() {
    for action in [
        OrganizeAction::LeaveInbox,
        OrganizeAction::Schedule(ScheduleTarget::Today),
        OrganizeAction::Schedule(ScheduleTarget::Tomorrow),
        OrganizeAction::Schedule(ScheduleTarget::Later),
        OrganizeAction::Schedule(ScheduleTarget::Date(
            NaiveDate::from_ymd_opt(2026, 12, 1).unwrap(),
        )),
        OrganizeAction::ConvertTo(ItemType::Todo),
        OrganizeAction::Archive,
    ] {
        let f = fixture();
        let id = seed(&f, 1, ItemType::Note, "x", true);
        let outcome = f.service.organize(&[id], action).await.unwrap();
        assert!(!outcome.items[0].in_inbox(), "{action:?}");
        assert!(!committed(&f, id).in_inbox(), "{action:?}");
        assert_eq!(f.service.count().await.unwrap(), 0, "{action:?}");
    }
}

#[tokio::test]
async fn schedule_targets_resolve_against_the_local_today() {
    let f = fixture();
    let a = seed(&f, 1, ItemType::Todo, "a", true);
    let b = seed(&f, 2, ItemType::Todo, "b", true);
    let c = seed(&f, 3, ItemType::Todo, "c", true);

    for (id, target) in [
        (a, ScheduleTarget::Today),
        (b, ScheduleTarget::Tomorrow),
        (c, ScheduleTarget::Later),
    ] {
        f.service
            .organize(&[id], OrganizeAction::Schedule(target))
            .await
            .unwrap();
    }

    let date = |id| committed(&f, id).scheduled().unwrap().date();
    let today = date(a);
    assert_eq!(date(b), today + Duration::days(1));
    // 「稍后」是严格晚于今天的下一个周一。
    assert_eq!(date(c).weekday(), Weekday::Mon);
    assert!(date(c) > today && date(c) <= today + Duration::days(7));
}

#[tokio::test]
async fn converting_the_type_follows_domain_rules() {
    let f = fixture();
    let id = seed(&f, 1, ItemType::Todo, "x", true);
    let outcome = f
        .service
        .organize(&[id], OrganizeAction::ConvertTo(ItemType::Note))
        .await
        .unwrap();
    assert_eq!(outcome.items[0].item_type(), ItemType::Note);
    assert_eq!(committed(&f, id).item_type(), ItemType::Note);
}

#[tokio::test]
async fn a_batch_is_all_or_nothing() {
    let f = fixture();
    let a = seed(&f, 1, ItemType::Note, "a", true);
    let missing = ItemId::from_uuid(uuid::Uuid::from_u128(99));
    f.events.clear();

    let error = f
        .service
        .organize(&[a, missing], OrganizeAction::LeaveInbox)
        .await
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::ItemNotFound);
    assert!(committed(&f, a).in_inbox(), "第一条也不能改变");
    assert!(f.events.events().is_empty(), "回滚后不发布事件");
}

#[tokio::test]
async fn a_failed_commit_changes_nothing_and_publishes_nothing() {
    let f = fixture();
    let a = seed(&f, 1, ItemType::Note, "a", true);
    f.events.clear();
    f.uow.fail_next_commit();

    let error = f
        .service
        .organize(&[a], OrganizeAction::Archive)
        .await
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::StorageUnavailable);
    let item = committed(&f, a);
    assert!(item.in_inbox() && !item.is_archived());
    assert!(f.events.events().is_empty());
}

#[tokio::test]
async fn events_are_published_only_after_commit() {
    let f = fixture();
    let a = seed(&f, 1, ItemType::Note, "a", true);
    f.events.clear();
    f.service
        .organize(&[a], OrganizeAction::LeaveInbox)
        .await
        .unwrap();
    assert_eq!(
        f.events.events(),
        vec![DomainEvent::ItemUpdated { item_id: a }]
    );
}

#[tokio::test]
async fn restore_undoes_each_action_exactly() {
    for action in [
        OrganizeAction::LeaveInbox,
        OrganizeAction::Schedule(ScheduleTarget::Tomorrow),
        OrganizeAction::ConvertTo(ItemType::Tip),
        OrganizeAction::Archive,
    ] {
        let f = fixture();
        let a = seed(&f, 1, ItemType::Note, "a", true);
        let b = seed(&f, 2, ItemType::Todo, "b", true);
        let before: Vec<Item> = [a, b].iter().map(|&id| committed(&f, id)).collect();

        let outcome = f.service.organize(&[a, b], action).await.unwrap();
        f.service.restore(&outcome.previous).await.unwrap();

        for original in before {
            let now = committed(&f, original.id());
            assert_eq!(now.item_type(), original.item_type(), "{action:?}");
            assert_eq!(now.scheduled(), original.scheduled(), "{action:?}");
            assert_eq!(now.in_inbox(), original.in_inbox(), "{action:?}");
            assert_eq!(now.is_archived(), original.is_archived(), "{action:?}");
        }
        assert_eq!(f.service.count().await.unwrap(), 2, "{action:?}");
    }
}

#[tokio::test]
async fn organizing_fifty_items_is_a_single_quick_transaction() {
    let f = fixture();
    let ids: Vec<ItemId> = (1..=50)
        .map(|n| seed(&f, n, ItemType::Note, &format!("条目 {n}"), true))
        .collect();
    let started = std::time::Instant::now();
    let outcome = f
        .service
        .organize(&ids, OrganizeAction::Schedule(ScheduleTarget::Today))
        .await
        .unwrap();
    assert_eq!(outcome.items.len(), 50);
    assert!(started.elapsed().as_millis() < 1000);
    assert_eq!(f.service.count().await.unwrap(), 0);
}
