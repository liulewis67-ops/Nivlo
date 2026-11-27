//! 回收站（软删除）在真实 SQLite 上的行为（实施计划 3.5、D-08）。

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "集成测试中失败即断言"
)]

use chrono::{DateTime, Duration, NaiveDate, TimeZone, Utc};
use starat_application::ports::{ItemFilter, StorageError, UnitOfWork};
use starat_domain::id::{ItemId, ProjectId, TagId};
use starat_domain::item::{DatePoint, Item, ItemType, NewItem};
use starat_domain::project::Project;
use starat_domain::tag::{Tag, TagName};
use starat_storage::Database;
use uuid::Uuid;

/// 在临时目录中创建并迁移好的数据库。
async fn new_db() -> (tempfile::TempDir, std::path::PathBuf, Database) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("starat.db");
    let db = Database::open(&path).await.unwrap();
    db.migrate().await.unwrap();
    (dir, path, db)
}

/// 固定的"现在"。
fn t(hour: u32) -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 10, 9, hour, 0, 0).unwrap()
}

/// 确定性的 ID。
fn id(n: u128) -> ItemId {
    ItemId::from_uuid(Uuid::from_u128(n))
}

/// 计划在 2026-10-09 的 Todo。
fn todo(n: u128, title: &str, project: Option<ProjectId>) -> Item {
    let mut new = NewItem::new(ItemType::Todo, title);
    new.scheduled = Some(DatePoint::all_day(
        NaiveDate::from_ymd_opt(2026, 10, 9).unwrap(),
    ));
    new.project_id = project;
    Item::create(id(n), new, t(8)).unwrap().0
}

#[tokio::test]
async fn a_deleted_item_vanishes_from_every_query_but_not_from_get() {
    let (_dir, _path, db) = new_db().await;
    let project = Project::create(ProjectId::from_uuid(Uuid::from_u128(1)), "P", t(8)).unwrap();
    let tag = Tag {
        id: TagId::from_uuid(Uuid::from_u128(2)),
        name: TagName::new("标签").unwrap(),
    };
    let mut done = todo(3, "已完成的删除目标", None);
    done.complete(t(9)).unwrap();
    let mut tx = db.begin().await.unwrap();
    tx.projects().insert(&project).await.unwrap();
    tx.tags().insert(&tag).await.unwrap();
    for item in [
        todo(1, "留下的", None),
        todo(2, "删除目标", Some(project.id)),
        done,
    ] {
        tx.items().insert(&item).await.unwrap();
    }
    tx.tags().set_for_item(id(2), &[tag.id]).await.unwrap();
    tx.commit().await.unwrap();

    let mut tx = db.begin().await.unwrap();
    tx.trash().mark_deleted(id(2), t(10)).await.unwrap();
    tx.trash().mark_deleted(id(3), t(10)).await.unwrap();
    tx.commit().await.unwrap();

    let mut tx = db.begin().await.unwrap();
    let day = NaiveDate::from_ymd_opt(2026, 10, 9).unwrap();
    // 列表（含项目 / 标签过滤）、Today 的三个来源、搜索、计数。
    assert_eq!(
        tx.items().list(&ItemFilter::default()).await.unwrap().len(),
        1
    );
    assert!(
        tx.items()
            .list(&ItemFilter {
                project_id: Some(project.id),
                include_archived: true,
                ..ItemFilter::default()
            })
            .await
            .unwrap()
            .is_empty()
    );
    assert!(
        tx.items()
            .list(&ItemFilter {
                tag_id: Some(tag.id),
                ..ItemFilter::default()
            })
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        tx.items()
            .list_open_todos_scheduled_on_or_before(day)
            .await
            .unwrap()
            .len(),
        1
    );
    assert!(
        tx.items()
            .list_todos_completed_between(t(0), t(23))
            .await
            .unwrap()
            .is_empty()
    );
    assert!(
        tx.items()
            .search("删除目标", true, 50)
            .await
            .unwrap()
            .is_empty()
    );
    assert!(
        tx.items()
            .search("目标", true, 50)
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        tx.items().search("留下的", false, 50).await.unwrap().len(),
        1
    );
    assert!(tx.projects().open_item_counts().await.unwrap().is_empty());
    assert_eq!(tx.tags().list_with_counts().await.unwrap()[0].1, 0);
    // 但按 ID 仍然读得到。
    assert_eq!(
        tx.items()
            .get(id(2))
            .await
            .unwrap()
            .unwrap()
            .title()
            .as_str(),
        "删除目标"
    );
}

#[tokio::test]
async fn restore_brings_everything_back_and_survives_a_restart() {
    let (_dir, path, db) = new_db().await;
    let tag = Tag {
        id: TagId::from_uuid(Uuid::from_u128(2)),
        name: TagName::new("标签").unwrap(),
    };
    {
        let mut tx = db.begin().await.unwrap();
        tx.items().insert(&todo(1, "要恢复的", None)).await.unwrap();
        tx.tags().insert(&tag).await.unwrap();
        tx.tags().set_for_item(id(1), &[tag.id]).await.unwrap();
        tx.trash().mark_deleted(id(1), t(10)).await.unwrap();
        tx.commit().await.unwrap();
    }
    db.close().await;

    // 重启后还在回收站里。
    let db = Database::open(&path).await.unwrap();
    {
        let mut tx = db.begin().await.unwrap();
        let listed = tx.trash().list_deleted().await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].0.title().as_str(), "要恢复的");
        assert_eq!(listed[0].1, t(10));
        assert_eq!(tx.trash().deleted_at(id(1)).await.unwrap(), Some(t(10)));
        tx.trash().restore(id(1)).await.unwrap();
        tx.commit().await.unwrap();
    }
    let mut tx = db.begin().await.unwrap();
    assert!(tx.trash().list_deleted().await.unwrap().is_empty());
    assert_eq!(tx.trash().deleted_at(id(1)).await.unwrap(), None);
    assert_eq!(
        tx.items().search("要恢复", false, 50).await.unwrap().len(),
        1
    );
    assert_eq!(tx.tags().for_item(id(1)).await.unwrap().len(), 1);
    assert_eq!(tx.tags().list_with_counts().await.unwrap()[0].1, 1);
}

#[tokio::test]
async fn deleting_keeps_the_original_time_and_missing_items_are_reported() {
    let (_dir, _path, db) = new_db().await;
    let mut tx = db.begin().await.unwrap();
    tx.items().insert(&todo(1, "x", None)).await.unwrap();
    tx.trash().mark_deleted(id(1), t(10)).await.unwrap();
    tx.trash().mark_deleted(id(1), t(12)).await.unwrap();
    assert_eq!(tx.trash().deleted_at(id(1)).await.unwrap(), Some(t(10)));
    assert!(matches!(
        tx.trash().mark_deleted(id(99), t(10)).await,
        Err(StorageError::NotFound { entity: "item", .. })
    ));
    // 恢复一个不在回收站里的 Item 是空操作。
    tx.trash().restore(id(99)).await.unwrap();
}

#[tokio::test]
async fn the_trash_is_ordered_newest_first_and_expiry_is_found_by_cutoff() {
    let (_dir, _path, db) = new_db().await;
    let mut tx = db.begin().await.unwrap();
    for n in 1..=3 {
        tx.items().insert(&todo(n, "x", None)).await.unwrap();
    }
    tx.trash().mark_deleted(id(1), t(8)).await.unwrap();
    tx.trash().mark_deleted(id(2), t(10)).await.unwrap();
    tx.trash().mark_deleted(id(3), t(9)).await.unwrap();

    let order: Vec<ItemId> = tx
        .trash()
        .list_deleted()
        .await
        .unwrap()
        .iter()
        .map(|(i, _)| i.id())
        .collect();
    assert_eq!(order, [id(2), id(3), id(1)]);
    assert_eq!(
        tx.trash()
            .deleted_before(t(9) + Duration::minutes(1))
            .await
            .unwrap(),
        [id(1), id(3)]
    );
    assert!(tx.trash().deleted_before(t(8)).await.unwrap().is_empty());
}

#[tokio::test]
async fn permanent_delete_cascades_and_clears_the_search_index() {
    let (_dir, _path, db) = new_db().await;
    let tag = Tag {
        id: TagId::from_uuid(Uuid::from_u128(2)),
        name: TagName::new("标签").unwrap(),
    };
    let mut tx = db.begin().await.unwrap();
    tx.items()
        .insert(&todo(1, "永久删除的条目", None))
        .await
        .unwrap();
    tx.tags().insert(&tag).await.unwrap();
    tx.tags().set_for_item(id(1), &[tag.id]).await.unwrap();
    tx.trash().mark_deleted(id(1), t(10)).await.unwrap();
    tx.items().delete(id(1)).await.unwrap();
    tx.commit().await.unwrap();

    let mut tx = db.begin().await.unwrap();
    assert!(tx.items().get(id(1)).await.unwrap().is_none());
    assert!(tx.trash().list_deleted().await.unwrap().is_empty());
    assert!(
        tx.items()
            .search("永久删除", true, 50)
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(tx.tags().list_with_counts().await.unwrap()[0].1, 0);
}
