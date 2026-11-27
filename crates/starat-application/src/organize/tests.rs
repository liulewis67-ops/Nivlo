//! `ProjectService` 与 `TagService` 的 Use Case 测试：使用内存 Fake。

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::sync::Arc;

use chrono::{NaiveDate, TimeZone, Utc};
use starat_common::clock::FakeClock;
use starat_domain::event::DomainEvent;
use starat_domain::id::{ItemId, ProjectId};
use starat_domain::item::{DatePoint, ItemType, NewItem, Priority};
use uuid::Uuid;

use super::{ProjectService, TagService};
use crate::error::ErrorCode;
use crate::item::{ItemService, Patch, UpdateItemInput};
use crate::ports::{ItemFilter, ItemOrder};
use crate::testing::{FakeUnitOfWork, RecordingPublisher};

/// 测试夹具。
struct Fixture {
    projects: ProjectService,
    tags: TagService,
    items: ItemService,
    events: Arc<RecordingPublisher>,
}

/// 构造夹具；时钟固定。
fn fixture() -> Fixture {
    let uow = FakeUnitOfWork::new();
    let events = Arc::new(RecordingPublisher::new());
    let clock = FakeClock::at_utc(Utc.with_ymd_and_hms(2026, 10, 9, 8, 0, 0).unwrap());
    Fixture {
        projects: ProjectService::new(Arc::new(uow.clone()), Arc::new(clock.clone())),
        tags: TagService::new(
            Arc::new(uow.clone()),
            Arc::new(clock.clone()),
            events.clone(),
        ),
        items: ItemService::new(Arc::new(uow), Arc::new(clock), events.clone()),
        events,
    }
}

/// 创建一个最简 Todo。
async fn todo(f: &Fixture, title: &str) -> ItemId {
    f.items
        .create_item(NewItem::new(ItemType::Todo, title))
        .await
        .unwrap()
        .id()
}

#[tokio::test]
async fn project_lifecycle_create_rename_archive() {
    let f = fixture();
    let project = f.projects.create("  支付重构 ").await.unwrap();
    assert_eq!(project.name.as_str(), "支付重构");

    let renamed = f.projects.rename(project.id, "结算").await.unwrap();
    assert_eq!(renamed.name.as_str(), "结算");

    f.projects.archive(project.id).await.unwrap();
    assert!(f.projects.list(false).await.unwrap().is_empty());
    assert_eq!(f.projects.list(true).await.unwrap().len(), 1);
    assert_eq!(
        f.projects.archive(project.id).await.unwrap_err().code,
        ErrorCode::ItemAlreadyArchived
    );

    f.projects.unarchive(project.id).await.unwrap();
    assert_eq!(f.projects.list(false).await.unwrap().len(), 1);
}

#[tokio::test]
async fn project_names_are_validated_and_missing_projects_reported() {
    let f = fixture();
    assert_eq!(
        f.projects.create("   ").await.unwrap_err().code,
        ErrorCode::NameEmpty
    );
    let project = f.projects.create("A").await.unwrap();
    assert_eq!(
        f.projects.rename(project.id, "").await.unwrap_err().code,
        ErrorCode::NameEmpty
    );
    // 失败后名称不变。
    assert_eq!(
        f.projects.list(false).await.unwrap()[0]
            .project
            .name
            .as_str(),
        "A"
    );
    let missing = ProjectId::from_uuid(Uuid::from_u128(99));
    assert_eq!(
        f.projects.rename(missing, "x").await.unwrap_err().code,
        ErrorCode::ProjectNotFound
    );
}

#[tokio::test]
async fn project_counts_only_open_unarchived_items() {
    let f = fixture();
    let project = f.projects.create("P").await.unwrap();
    let mut ids = Vec::new();
    for title in ["a", "b", "c"] {
        let mut new = NewItem::new(ItemType::Todo, title);
        new.project_id = Some(project.id);
        ids.push(f.items.create_item(new).await.unwrap().id());
    }
    f.items.complete_item(ids[0]).await.unwrap();
    assert_eq!(f.projects.list(false).await.unwrap()[0].open_count, 2);
}

#[tokio::test]
async fn assigning_a_missing_project_is_rejected_and_changes_nothing() {
    let f = fixture();
    let id = todo(&f, "x").await;
    let missing = ProjectId::from_uuid(Uuid::from_u128(99));
    let err = f
        .items
        .update_item(
            id,
            UpdateItemInput {
                project_id: Patch::Set(missing),
                ..UpdateItemInput::default()
            },
        )
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::ProjectNotFound);
    assert_eq!(f.items.get_item(id).await.unwrap().project_id(), None);
}

#[tokio::test]
async fn project_view_orders_open_first_then_priority_then_schedule() {
    let f = fixture();
    let project = f.projects.create("P").await.unwrap();
    let make = |title: &str, priority: Priority, day: Option<u32>| {
        let mut new = NewItem::new(ItemType::Todo, title);
        new.project_id = Some(project.id);
        new.priority = priority;
        new.scheduled =
            day.map(|d| DatePoint::all_day(NaiveDate::from_ymd_opt(2026, 10, d).unwrap()));
        new
    };
    let low = f
        .items
        .create_item(make("低", Priority::Low, Some(1)))
        .await
        .unwrap();
    let high_late = f
        .items
        .create_item(make("高·晚", Priority::High, Some(20)))
        .await
        .unwrap();
    let high_early = f
        .items
        .create_item(make("高·早", Priority::High, Some(10)))
        .await
        .unwrap();
    let high_none = f
        .items
        .create_item(make("高·无日期", Priority::High, None))
        .await
        .unwrap();
    let done = f
        .items
        .create_item(make("已完成", Priority::High, Some(1)))
        .await
        .unwrap();
    f.items.complete_item(done.id()).await.unwrap();

    let listed = f
        .items
        .list_items(ItemFilter {
            project_id: Some(project.id),
            order: ItemOrder::ProjectView,
            ..ItemFilter::default()
        })
        .await
        .unwrap();
    let ids: Vec<_> = listed.iter().map(|i| i.id()).collect();
    assert_eq!(
        ids,
        [
            high_early.id(),
            high_late.id(),
            high_none.id(),
            low.id(),
            done.id()
        ]
    );
}

#[tokio::test]
async fn set_item_tags_creates_missing_tags_and_dedupes_case_insensitively() {
    let f = fixture();
    let id = todo(&f, "n").await;
    let names = ["Jira", "jira", " 工作 ", "api"].map(String::from);
    let tags = f.tags.set_item_tags(id, &names).await.unwrap();
    let shown: Vec<_> = tags.iter().map(|t| t.name.as_str()).collect();
    // 按名称（小写键）排序；重复的 jira 只留先出现的写法。
    assert_eq!(shown, ["api", "Jira", "工作"]);
    assert!(
        f.events
            .events()
            .contains(&DomainEvent::ItemUpdated { item_id: id })
    );

    // 整体替换：再次设置只保留给出的标签，已有同名标签沿用原写法。
    let again = f
        .tags
        .set_item_tags(id, &["JIRA".to_owned()])
        .await
        .unwrap();
    assert_eq!(again.len(), 1);
    assert_eq!(again[0].name.as_str(), "Jira");
    let listed = f.tags.list().await.unwrap();
    assert_eq!(listed.len(), 3, "不再被使用的标签仍然保留");
    assert_eq!(
        listed
            .iter()
            .find(|s| s.tag.name.as_str() == "api")
            .unwrap()
            .item_count,
        0
    );
}

#[tokio::test]
async fn invalid_tag_name_changes_nothing() {
    let f = fixture();
    let id = todo(&f, "n").await;
    f.tags
        .set_item_tags(id, &["keep".to_owned()])
        .await
        .unwrap();
    let err = f
        .tags
        .set_item_tags(id, &["ok".to_owned(), "  ".to_owned()])
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::NameEmpty);
    let still = f.tags.for_item(id).await.unwrap();
    assert_eq!(still.len(), 1);
    assert_eq!(still[0].name.as_str(), "keep");
    assert_eq!(f.tags.list().await.unwrap().len(), 1, "没有残留新建的标签");
}

#[tokio::test]
async fn tags_on_a_missing_item_are_rejected() {
    let f = fixture();
    let missing = ItemId::from_uuid(Uuid::from_u128(5));
    let err = f
        .tags
        .set_item_tags(missing, &["x".to_owned()])
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::ItemNotFound);
}

#[tokio::test]
async fn rename_tag_updates_everywhere_and_rejects_duplicates() {
    let f = fixture();
    let id = todo(&f, "t").await;
    let tags = f
        .tags
        .set_item_tags(id, &["jira".to_owned(), "work".to_owned()])
        .await
        .unwrap();
    let jira = tags.iter().find(|t| t.name.as_str() == "jira").unwrap().id;

    // 只改大小写是允许的。
    f.tags.rename(jira, "Jira").await.unwrap();
    let shown: Vec<String> = f
        .tags
        .for_item(id)
        .await
        .unwrap()
        .iter()
        .map(|t| t.name.as_str().to_owned())
        .collect();
    assert_eq!(shown, ["Jira", "work"]);

    // 与另一个标签重名（忽略大小写）被拒绝。
    let err = f.tags.rename(jira, "WORK").await.unwrap_err();
    assert_eq!(err.code, ErrorCode::TagNameTaken);
    assert_eq!(
        f.tags.rename(jira, " ").await.unwrap_err().code,
        ErrorCode::NameEmpty
    );
}

#[tokio::test]
async fn merge_moves_items_dedupes_and_removes_the_source_tag() {
    let f = fixture();
    let a = todo(&f, "a").await;
    let b = todo(&f, "b").await;
    let both = todo(&f, "both").await;
    f.tags.set_item_tags(a, &["old".to_owned()]).await.unwrap();
    f.tags.set_item_tags(b, &["new".to_owned()]).await.unwrap();
    f.tags
        .set_item_tags(both, &["old".to_owned(), "new".to_owned()])
        .await
        .unwrap();
    let all = f.tags.list().await.unwrap();
    let old = all
        .iter()
        .find(|s| s.tag.name.as_str() == "old")
        .unwrap()
        .tag
        .id;
    let new = all
        .iter()
        .find(|s| s.tag.name.as_str() == "new")
        .unwrap()
        .tag
        .id;

    assert_eq!(
        f.tags.merge(old, old).await.unwrap_err().code,
        ErrorCode::InvalidInput
    );
    let kept = f.tags.merge(old, new).await.unwrap();
    assert_eq!(kept.name.as_str(), "new");

    let after = f.tags.list().await.unwrap();
    assert_eq!(after.len(), 1);
    assert_eq!(after[0].item_count, 3);
    assert_eq!(f.tags.for_item(both).await.unwrap().len(), 1);
    assert_eq!(
        f.tags.merge(old, new).await.unwrap_err().code,
        ErrorCode::TagNotFound
    );
}

#[tokio::test]
async fn tag_filter_returns_only_tagged_items() {
    let f = fixture();
    let a = todo(&f, "a").await;
    todo(&f, "b").await;
    let tags = f.tags.set_item_tags(a, &["x".to_owned()]).await.unwrap();
    let listed = f
        .items
        .list_items(ItemFilter {
            tag_id: Some(tags[0].id),
            ..ItemFilter::default()
        })
        .await
        .unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].id(), a);
}

#[tokio::test]
async fn tags_for_items_reads_a_batch_in_order() {
    let f = fixture();
    let a = todo(&f, "A").await;
    let b = todo(&f, "B").await;
    f.tags
        .set_item_tags(a, &["work".to_owned(), "jira".to_owned()])
        .await
        .unwrap();

    let found = f.tags.for_items(&[b, a]).await.unwrap();
    let names: Vec<(ItemId, Vec<String>)> = found
        .iter()
        .map(|(id, tags)| {
            (
                *id,
                tags.iter().map(|t| t.name.as_str().to_owned()).collect(),
            )
        })
        .collect();
    assert_eq!(names[0], (b, Vec::<String>::new()));
    assert_eq!(names[1].0, a);
    let mut a_tags = names[1].1.clone();
    a_tags.sort();
    assert_eq!(a_tags, ["jira", "work"]);
}
