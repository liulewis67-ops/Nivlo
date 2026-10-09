//! `nivlo-storage` 集成测试：使用临时数据库文件，验证 Migration、事务与 Item CRUD。

#![allow(
    missing_docs,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::missing_docs_in_private_items
)]

use chrono::{DateTime, NaiveDate, NaiveTime, TimeZone, Utc};
use nivlo_application::ports::{ItemFilter, StorageError, UnitOfWork};
use nivlo_common::paths::AppPaths;
use nivlo_domain::id::{ItemId, ProjectId};
use nivlo_domain::item::{ContentFormat, DatePoint, Item, ItemType, NewItem, Priority};
use nivlo_storage::Database;
use sqlx::sqlite::SqliteConnectOptions;
use sqlx::{ConnectOptions, Connection};
use uuid::Uuid;

/// 在临时目录中创建并迁移好的数据库。
async fn new_db() -> (tempfile::TempDir, std::path::PathBuf, Database) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("nivlo.db");
    let db = Database::open(&path).await.unwrap();
    db.migrate().await.unwrap();
    (dir, path, db)
}

/// 固定的"现在"。
fn t(hour: u32, minute: u32) -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 10, 9, hour, minute, 0).unwrap()
}

/// 以序号生成确定性的 Item ID。
fn id(n: u128) -> ItemId {
    ItemId::from_uuid(Uuid::from_u128(n))
}

/// 创建一个最简 Item。
fn simple(n: u128, item_type: ItemType, title: &str, created: DateTime<Utc>) -> Item {
    Item::create(id(n), NewItem::new(item_type, title), created)
        .unwrap()
        .0
}

#[tokio::test]
async fn migrates_from_empty_and_is_idempotent() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("nivlo.db")).await.unwrap();
    assert_eq!(db.schema_version().await.unwrap(), None);

    db.migrate().await.unwrap();
    assert_eq!(db.schema_version().await.unwrap(), Some(1));

    // 再次运行不报错，版本不变。
    db.migrate().await.unwrap();
    assert_eq!(db.schema_version().await.unwrap(), Some(1));
}

#[tokio::test]
async fn database_lives_at_app_paths_location() {
    let dir = tempfile::tempdir().unwrap();
    let paths = AppPaths::from_root(dir.path().join("Nivlo"));
    paths.ensure_dirs().unwrap();
    let db = Database::open(&paths.database_file()).await.unwrap();
    db.migrate().await.unwrap();
    assert!(
        paths.database_file().ends_with("database/nivlo.db")
            || paths.database_file().ends_with("database\\nivlo.db")
    );
    assert!(paths.database_file().is_file());
}

#[tokio::test]
async fn tampered_migration_is_reported_as_migration_error() {
    let (_dir, path, db) = new_db().await;
    db.close().await;

    // 模拟"已合入的 Migration 被改动"：篡改已记录的 checksum。
    let mut conn = SqliteConnectOptions::new()
        .filename(&path)
        .connect()
        .await
        .unwrap();
    sqlx::query("UPDATE _sqlx_migrations SET checksum = X'00'")
        .execute(&mut conn)
        .await
        .unwrap();
    conn.close().await.unwrap();

    let db = Database::open(&path).await.unwrap();
    let err = db.migrate().await.unwrap_err();
    assert!(matches!(err, StorageError::Migration(_)), "{err:?}");
}

#[tokio::test]
async fn item_round_trips_with_all_fields() {
    let (_dir, _path, db) = new_db().await;

    let mut new = NewItem::new(ItemType::Todo, "修复登录超时");
    new.content = Some("复现步骤……".to_owned());
    new.content_format = ContentFormat::Markdown;
    new.priority = Priority::High;
    new.scheduled = Some(DatePoint::at(
        NaiveDate::from_ymd_opt(2026, 10, 12).unwrap(),
        NaiveTime::from_hms_opt(9, 30, 0).unwrap(),
    ));
    new.due = Some(DatePoint::all_day(
        NaiveDate::from_ymd_opt(2026, 10, 15).unwrap(),
    ));
    new.reminder_at = Some(t(7, 0));
    let (mut item, _) = Item::create(id(1), new, t(8, 0)).unwrap();
    item.complete(t(9, 0)).unwrap();
    item.archive(t(10, 0)).unwrap();

    let mut tx = db.begin().await.unwrap();
    tx.items().insert(&item).await.unwrap();
    tx.commit().await.unwrap();

    let mut tx = db.begin().await.unwrap();
    let loaded = tx.items().get(id(1)).await.unwrap().unwrap();
    assert_eq!(loaded, item);
    assert!(tx.items().get(id(404)).await.unwrap().is_none());
}

#[tokio::test]
async fn update_overwrites_and_missing_item_is_not_found() {
    let (_dir, _path, db) = new_db().await;
    let mut item = simple(1, ItemType::Todo, "写周报", t(8, 0));

    let mut tx = db.begin().await.unwrap();
    tx.items().insert(&item).await.unwrap();
    item.rename("写月报", t(9, 0)).unwrap();
    item.complete(t(9, 30)).unwrap();
    tx.items().update(&item).await.unwrap();
    tx.commit().await.unwrap();

    let mut tx = db.begin().await.unwrap();
    assert_eq!(tx.items().get(id(1)).await.unwrap().unwrap(), item);

    let ghost = simple(2, ItemType::Note, "不存在", t(8, 0));
    let err = tx.items().update(&ghost).await.unwrap_err();
    assert!(
        matches!(err, StorageError::NotFound { entity: "item", .. }),
        "{err:?}"
    );
}

#[tokio::test]
async fn list_orders_filters_and_limits() {
    let (_dir, _path, db) = new_db().await;
    let old = simple(1, ItemType::Todo, "旧待办", t(8, 0));
    let note = simple(2, ItemType::Note, "笔记", t(9, 0));
    let mut archived = simple(3, ItemType::Note, "已归档", t(10, 0));
    archived.archive(t(11, 0)).unwrap();
    let new = simple(4, ItemType::Todo, "新待办", t(12, 0));

    let mut tx = db.begin().await.unwrap();
    for item in [&old, &note, &archived, &new] {
        tx.items().insert(item).await.unwrap();
    }
    tx.commit().await.unwrap();

    let mut tx = db.begin().await.unwrap();
    let titles = |items: Vec<Item>| {
        items
            .iter()
            .map(|i| i.title().to_string())
            .collect::<Vec<_>>()
    };

    let all = tx.items().list(&ItemFilter::default()).await.unwrap();
    assert_eq!(titles(all), ["新待办", "笔记", "旧待办"]);

    let with_archived = tx
        .items()
        .list(&ItemFilter {
            include_archived: true,
            ..ItemFilter::default()
        })
        .await
        .unwrap();
    assert_eq!(
        titles(with_archived),
        ["新待办", "已归档", "笔记", "旧待办"]
    );

    let todos = tx
        .items()
        .list(&ItemFilter {
            item_type: Some(ItemType::Todo),
            ..ItemFilter::default()
        })
        .await
        .unwrap();
    assert_eq!(titles(todos), ["新待办", "旧待办"]);

    let limited = tx
        .items()
        .list(&ItemFilter {
            limit: Some(1),
            ..ItemFilter::default()
        })
        .await
        .unwrap();
    assert_eq!(titles(limited), ["新待办"]);
}

#[tokio::test]
async fn uncommitted_transaction_is_rolled_back() {
    let (_dir, _path, db) = new_db().await;

    let mut tx = db.begin().await.unwrap();
    tx.items()
        .insert(&simple(1, ItemType::Todo, "不会保留", t(8, 0)))
        .await
        .unwrap();
    drop(tx);

    let mut tx = db.begin().await.unwrap();
    assert!(tx.items().get(id(1)).await.unwrap().is_none());
}

#[tokio::test]
async fn failure_midway_rolls_back_the_whole_transaction() {
    let (_dir, _path, db) = new_db().await;
    let first = simple(1, ItemType::Todo, "第一条", t(8, 0));

    let mut tx = db.begin().await.unwrap();
    tx.items().insert(&first).await.unwrap();
    tx.items()
        .insert(&simple(2, ItemType::Todo, "第二条", t(8, 1)))
        .await
        .unwrap();
    // 主键重复：第三步失败。
    let err = tx.items().insert(&first).await.unwrap_err();
    assert!(matches!(err, StorageError::Constraint(_)), "{err:?}");
    tx.rollback().await.unwrap();

    let mut tx = db.begin().await.unwrap();
    assert!(
        tx.items()
            .list(&ItemFilter::default())
            .await
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn foreign_key_is_enforced() {
    let (_dir, _path, db) = new_db().await;
    let mut new = NewItem::new(ItemType::Todo, "属于不存在的项目");
    new.project_id = Some(ProjectId::from_uuid(Uuid::from_u128(99)));
    let (item, _) = Item::create(id(1), new, t(8, 0)).unwrap();

    let mut tx = db.begin().await.unwrap();
    let err = tx.items().insert(&item).await.unwrap_err();
    assert!(matches!(err, StorageError::Constraint(_)), "{err:?}");
}

#[tokio::test]
async fn corrupt_rows_are_reported_not_hidden() {
    let (_dir, path, db) = new_db().await;
    let mut tx = db.begin().await.unwrap();
    tx.items()
        .insert(&simple(1, ItemType::Tip, "提示", t(8, 0)))
        .await
        .unwrap();
    tx.commit().await.unwrap();

    // 绕过 Domain 直接写入一个"已完成的 Tip"，模拟被外部工具改坏的数据。
    let mut conn = SqliteConnectOptions::new()
        .filename(&path)
        .connect()
        .await
        .unwrap();
    sqlx::query("UPDATE items SET status = 'done', completed_at = '2026-10-09T09:00:00.000Z'")
        .execute(&mut conn)
        .await
        .unwrap();
    conn.close().await.unwrap();

    let mut tx = db.begin().await.unwrap();
    let err = tx.items().get(id(1)).await.unwrap_err();
    assert!(matches!(err, StorageError::Corrupt(_)), "{err:?}");
}
