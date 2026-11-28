//! 项目与标签在真实 SQLite 上的行为（实施计划 3.3）。

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "集成测试中失败即断言"
)]

use asterjot_application::ports::{ItemFilter, ItemOrder, StorageError, UnitOfWork};
use asterjot_domain::id::{ItemId, ProjectId, TagId};
use asterjot_domain::item::{DatePoint, Item, ItemType, NewItem, Priority};
use asterjot_domain::project::Project;
use asterjot_domain::tag::{Tag, TagName};
use asterjot_storage::Database;
use chrono::{DateTime, NaiveDate, TimeZone, Utc};
use sqlx::sqlite::SqliteConnectOptions;
use sqlx::{ConnectOptions, Connection};
use uuid::Uuid;

/// 在临时目录中创建并迁移好的数据库。
async fn new_db() -> (tempfile::TempDir, std::path::PathBuf, Database) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("asterjot.db");
    let db = Database::open(&path).await.unwrap();
    db.migrate().await.unwrap();
    (dir, path, db)
}

/// 固定的"现在"。
fn t(hour: u32) -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 10, 9, hour, 0, 0).unwrap()
}

/// 确定性的 ID。
fn item_id(n: u128) -> ItemId {
    ItemId::from_uuid(Uuid::from_u128(n))
}

/// 确定性的项目 ID。
fn project_id(n: u128) -> ProjectId {
    ProjectId::from_uuid(Uuid::from_u128(n))
}

/// 确定性的标签。
fn tag(n: u128, name: &str) -> Tag {
    Tag {
        id: TagId::from_uuid(Uuid::from_u128(n)),
        name: TagName::new(name).unwrap(),
    }
}

/// 创建一个 Todo。
fn todo(
    n: u128,
    title: &str,
    project: Option<ProjectId>,
    priority: Priority,
    day: Option<u32>,
) -> Item {
    let mut new = NewItem::new(ItemType::Todo, title);
    new.project_id = project;
    new.priority = priority;
    new.scheduled = day.map(|d| DatePoint::all_day(NaiveDate::from_ymd_opt(2026, 10, d).unwrap()));
    Item::create(item_id(n), new, t(8)).unwrap().0
}

#[tokio::test]
async fn projects_round_trip_and_survive_reopen() {
    let (_dir, path, db) = new_db().await;
    let alpha = Project::create(project_id(1), "Alpha", t(8)).unwrap();
    let mut beta = Project::create(project_id(2), "Beta", t(9)).unwrap();
    {
        let mut tx = db.begin().await.unwrap();
        tx.projects().insert(&alpha).await.unwrap();
        tx.projects().insert(&beta).await.unwrap();
        beta.rename("Beta 2").unwrap();
        beta.archive(t(10)).unwrap();
        tx.projects().update(&beta).await.unwrap();
        tx.commit().await.unwrap();
    }
    db.close().await;

    let db = Database::open(&path).await.unwrap();
    db.migrate().await.unwrap();
    let mut tx = db.begin().await.unwrap();
    assert_eq!(
        tx.projects().list(false).await.unwrap(),
        std::slice::from_ref(&alpha)
    );
    assert_eq!(
        tx.projects().list(true).await.unwrap(),
        [alpha.clone(), beta.clone()]
    );
    assert_eq!(tx.projects().get(beta.id).await.unwrap(), Some(beta));
    assert_eq!(tx.projects().get(project_id(9)).await.unwrap(), None);
}

#[tokio::test]
async fn updating_a_missing_project_is_not_found() {
    let (_dir, _path, db) = new_db().await;
    let ghost = Project::create(project_id(7), "Ghost", t(8)).unwrap();
    let mut tx = db.begin().await.unwrap();
    assert!(matches!(
        tx.projects().update(&ghost).await,
        Err(StorageError::NotFound {
            entity: "project",
            ..
        })
    ));
}

#[tokio::test]
async fn open_counts_skip_done_archived_and_unassigned_items() {
    let (_dir, _path, db) = new_db().await;
    let p = Project::create(project_id(1), "P", t(8)).unwrap();
    let mut done = todo(3, "done", Some(p.id), Priority::None, None);
    done.complete(t(9)).unwrap();
    let mut archived = todo(4, "archived", Some(p.id), Priority::None, None);
    archived.archive(t(9)).unwrap();
    let mut tx = db.begin().await.unwrap();
    tx.projects().insert(&p).await.unwrap();
    for item in [
        todo(1, "open", Some(p.id), Priority::None, None),
        todo(2, "open2", Some(p.id), Priority::None, None),
        done,
        archived,
        todo(5, "loose", None, Priority::None, None),
    ] {
        tx.items().insert(&item).await.unwrap();
    }
    assert_eq!(tx.projects().open_item_counts().await.unwrap(), [(p.id, 2)]);
}

#[tokio::test]
async fn project_filter_and_view_order_match_decision_d05() {
    let (_dir, _path, db) = new_db().await;
    let p = Project::create(project_id(1), "P", t(8)).unwrap();
    let other = Project::create(project_id(2), "Other", t(8)).unwrap();
    let mut done = todo(5, "已完成", Some(p.id), Priority::High, Some(1));
    done.complete(t(9)).unwrap();
    let mut tx = db.begin().await.unwrap();
    tx.projects().insert(&p).await.unwrap();
    tx.projects().insert(&other).await.unwrap();
    for item in [
        todo(1, "低", Some(p.id), Priority::Low, Some(1)),
        todo(2, "高·晚", Some(p.id), Priority::High, Some(20)),
        todo(3, "高·早", Some(p.id), Priority::High, Some(10)),
        todo(4, "高·无日期", Some(p.id), Priority::High, None),
        done,
        todo(6, "别的项目", Some(other.id), Priority::High, Some(1)),
    ] {
        tx.items().insert(&item).await.unwrap();
    }
    let listed = tx
        .items()
        .list(&ItemFilter {
            project_id: Some(p.id),
            order: ItemOrder::ProjectView,
            ..ItemFilter::default()
        })
        .await
        .unwrap();
    let titles: Vec<&str> = listed.iter().map(|i| i.title().as_str()).collect();
    assert_eq!(titles, ["高·早", "高·晚", "高·无日期", "低", "已完成"]);
}

#[tokio::test]
async fn deleting_a_project_row_keeps_its_items_unassigned() {
    let (_dir, path, db) = new_db().await;
    let p = Project::create(project_id(1), "P", t(8)).unwrap();
    let mut tx = db.begin().await.unwrap();
    tx.projects().insert(&p).await.unwrap();
    tx.items()
        .insert(&todo(1, "x", Some(p.id), Priority::None, None))
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let mut conn = SqliteConnectOptions::new()
        .filename(&path)
        .connect()
        .await
        .unwrap();
    sqlx::query("DELETE FROM projects")
        .execute(&mut conn)
        .await
        .unwrap();
    conn.close().await.unwrap();

    let mut tx = db.begin().await.unwrap();
    assert_eq!(
        tx.items()
            .get(item_id(1))
            .await
            .unwrap()
            .unwrap()
            .project_id(),
        None
    );
}

#[tokio::test]
async fn tags_are_unique_ignoring_case_and_can_be_found_by_name() {
    let (_dir, _path, db) = new_db().await;
    let mut tx = db.begin().await.unwrap();
    tx.tags().insert(&tag(1, "Jira")).await.unwrap();
    assert!(matches!(
        tx.tags().insert(&tag(2, "jira")).await,
        Err(StorageError::Constraint(_))
    ));
    let found = tx
        .tags()
        .find_by_name(&TagName::new("JIRA").unwrap())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(found.name.as_str(), "Jira");
    assert_eq!(tx.tags().get(found.id).await.unwrap(), Some(found));
}

#[tokio::test]
async fn item_tags_replace_filter_and_count() {
    let (_dir, path, db) = new_db().await;
    let mut archived = todo(3, "归档", None, Priority::None, None);
    archived.archive(t(9)).unwrap();
    {
        let mut tx = db.begin().await.unwrap();
        for item in [
            todo(1, "a", None, Priority::None, None),
            todo(2, "b", None, Priority::None, None),
            archived,
        ] {
            tx.items().insert(&item).await.unwrap();
        }
        for tag in [tag(10, "work"), tag(11, "Api")] {
            tx.tags().insert(&tag).await.unwrap();
        }
        let work = TagId::from_uuid(Uuid::from_u128(10));
        let api = TagId::from_uuid(Uuid::from_u128(11));
        tx.tags()
            .set_for_item(item_id(1), &[work, api])
            .await
            .unwrap();
        tx.tags().set_for_item(item_id(2), &[work]).await.unwrap();
        tx.tags().set_for_item(item_id(3), &[work]).await.unwrap();
        // 整体替换。
        tx.tags().set_for_item(item_id(2), &[api]).await.unwrap();
        tx.commit().await.unwrap();
    }
    db.close().await;

    let db = Database::open(&path).await.unwrap();
    let mut tx = db.begin().await.unwrap();
    let names = |tags: Vec<Tag>| -> Vec<String> {
        tags.iter().map(|t| t.name.as_str().to_owned()).collect()
    };
    assert_eq!(
        names(tx.tags().for_item(item_id(1)).await.unwrap()),
        ["Api", "work"]
    );
    assert_eq!(
        names(tx.tags().for_item(item_id(2)).await.unwrap()),
        ["Api"]
    );
    // 数量只算未归档的 Item；按名称（小写键）排序。
    let counts: Vec<(String, u32)> = tx
        .tags()
        .list_with_counts()
        .await
        .unwrap()
        .into_iter()
        .map(|(t, n)| (t.name.as_str().to_owned(), n))
        .collect();
    assert_eq!(counts, [("Api".to_owned(), 2), ("work".to_owned(), 1)]);

    let filtered = tx
        .items()
        .list(&ItemFilter {
            tag_id: Some(TagId::from_uuid(Uuid::from_u128(11))),
            ..ItemFilter::default()
        })
        .await
        .unwrap();
    let mut ids: Vec<_> = filtered.iter().map(|i| i.id()).collect();
    ids.sort();
    assert_eq!(ids, [item_id(1), item_id(2)]);
}

#[tokio::test]
async fn setting_tags_for_unknown_item_or_tag_violates_constraints() {
    let (_dir, _path, db) = new_db().await;
    let mut tx = db.begin().await.unwrap();
    tx.items()
        .insert(&todo(1, "a", None, Priority::None, None))
        .await
        .unwrap();
    let ghost = TagId::from_uuid(Uuid::from_u128(77));
    assert!(matches!(
        tx.tags().set_for_item(item_id(1), &[ghost]).await,
        Err(StorageError::Constraint(_))
    ));
}

#[tokio::test]
async fn rename_keeps_associations_and_rejects_duplicates() {
    let (_dir, _path, db) = new_db().await;
    let mut tx = db.begin().await.unwrap();
    tx.items()
        .insert(&todo(1, "a", None, Priority::None, None))
        .await
        .unwrap();
    let a = tag(1, "alpha");
    let b = tag(2, "beta");
    tx.tags().insert(&a).await.unwrap();
    tx.tags().insert(&b).await.unwrap();
    tx.tags().set_for_item(item_id(1), &[a.id]).await.unwrap();

    tx.tags()
        .rename(a.id, &TagName::new("Alpha!").unwrap())
        .await
        .unwrap();
    assert_eq!(
        tx.tags().for_item(item_id(1)).await.unwrap()[0]
            .name
            .as_str(),
        "Alpha!"
    );
    assert!(matches!(
        tx.tags().rename(a.id, &TagName::new("BETA").unwrap()).await,
        Err(StorageError::Constraint(_))
    ));
    assert!(matches!(
        tx.tags()
            .rename(
                TagId::from_uuid(Uuid::from_u128(99)),
                &TagName::new("x").unwrap()
            )
            .await,
        Err(StorageError::NotFound { entity: "tag", .. })
    ));
}

#[tokio::test]
async fn merge_moves_associations_once_and_deletes_the_source() {
    let (_dir, _path, db) = new_db().await;
    let mut tx = db.begin().await.unwrap();
    for n in 1..=3 {
        tx.items()
            .insert(&todo(n, "x", None, Priority::None, None))
            .await
            .unwrap();
    }
    let old = tag(1, "old");
    let new = tag(2, "new");
    tx.tags().insert(&old).await.unwrap();
    tx.tags().insert(&new).await.unwrap();
    tx.tags().set_for_item(item_id(1), &[old.id]).await.unwrap();
    tx.tags().set_for_item(item_id(2), &[new.id]).await.unwrap();
    tx.tags()
        .set_for_item(item_id(3), &[old.id, new.id])
        .await
        .unwrap();

    tx.tags().merge(old.id, new.id).await.unwrap();

    assert_eq!(tx.tags().get(old.id).await.unwrap(), None);
    let counts = tx.tags().list_with_counts().await.unwrap();
    assert_eq!(counts, [(new.clone(), 3)]);
    assert!(matches!(
        tx.tags().merge(old.id, new.id).await,
        Err(StorageError::NotFound { entity: "tag", .. })
    ));
}
