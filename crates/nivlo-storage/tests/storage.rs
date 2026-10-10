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
    assert_eq!(db.schema_version().await.unwrap(), Some(2));

    // 再次运行不报错，版本不变。
    db.migrate().await.unwrap();
    assert_eq!(db.schema_version().await.unwrap(), Some(2));
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

#[tokio::test]
async fn settings_round_trip_overwrite_and_roll_back() {
    let (_dir, _path, db) = new_db().await;

    let mut tx = db.begin().await.unwrap();
    assert_eq!(tx.settings().get("floating.placement").await.unwrap(), None);
    tx.settings()
        .set("floating.placement", "{\"edge\":\"right\"}", t(8, 0))
        .await
        .unwrap();
    tx.commit().await.unwrap();

    let mut tx = db.begin().await.unwrap();
    assert_eq!(
        tx.settings()
            .get("floating.placement")
            .await
            .unwrap()
            .as_deref(),
        Some("{\"edge\":\"right\"}")
    );
    // 覆盖写入后只有一行。
    tx.settings()
        .set("floating.placement", "v2", t(9, 0))
        .await
        .unwrap();
    tx.commit().await.unwrap();

    // 未提交的修改被丢弃。
    let mut tx = db.begin().await.unwrap();
    tx.settings()
        .set("floating.placement", "uncommitted", t(10, 0))
        .await
        .unwrap();
    drop(tx);

    let mut tx = db.begin().await.unwrap();
    assert_eq!(
        tx.settings()
            .get("floating.placement")
            .await
            .unwrap()
            .as_deref(),
        Some("v2")
    );
}

/// 给 Item 设置本地计划日期。
fn scheduled(mut item: Item, month: u32, day: u32) -> Item {
    item.set_scheduled(
        Some(DatePoint::all_day(
            NaiveDate::from_ymd_opt(2026, month, day).unwrap(),
        )),
        t(8, 0),
    );
    item
}

#[tokio::test]
async fn today_queries_filter_on_the_real_database() {
    let (_dir, _path, db) = new_db().await;
    let today = NaiveDate::from_ymd_opt(2026, 10, 9).unwrap();

    let open_today = scheduled(simple(1, ItemType::Todo, "今天", t(8, 0)), 10, 9);
    let open_overdue = scheduled(simple(2, ItemType::Todo, "逾期", t(8, 1)), 10, 1);
    let open_future = scheduled(simple(3, ItemType::Todo, "明天", t(8, 2)), 10, 10);
    let unscheduled = simple(4, ItemType::Todo, "没有日期", t(8, 3));
    let mut done = scheduled(simple(5, ItemType::Todo, "已完成", t(8, 4)), 10, 9);
    done.complete(t(10, 0)).unwrap();
    let mut archived = scheduled(simple(6, ItemType::Todo, "已归档", t(8, 5)), 10, 9);
    archived.archive(t(9, 0)).unwrap();
    let note = scheduled(simple(7, ItemType::Note, "笔记", t(8, 6)), 10, 9);
    let tip_today = scheduled(simple(8, ItemType::Tip, "今天的提示", t(8, 7)), 10, 9);
    let tip_other = scheduled(simple(9, ItemType::Tip, "别天的提示", t(8, 8)), 10, 8);

    let mut tx = db.begin().await.unwrap();
    for item in [
        &open_today,
        &open_overdue,
        &open_future,
        &unscheduled,
        &done,
        &archived,
        &note,
        &tip_today,
        &tip_other,
    ] {
        tx.items().insert(item).await.unwrap();
    }
    tx.commit().await.unwrap();

    let mut tx = db.begin().await.unwrap();
    let ids = |items: Vec<Item>| items.iter().map(Item::id).collect::<Vec<_>>();

    // 逾期的在前（计划日期更早），今天的在后。
    let todos = tx
        .items()
        .list_open_todos_scheduled_on_or_before(today)
        .await
        .unwrap();
    assert_eq!(ids(todos), [id(2), id(1)]);

    let tips = tx.items().list_tips_scheduled_on(today).await.unwrap();
    assert_eq!(ids(tips), [id(8)]);

    let completed = tx
        .items()
        .list_todos_completed_between(t(0, 0), t(23, 59))
        .await
        .unwrap();
    assert_eq!(ids(completed), [id(5)]);
    // 区间右端不包含：恰好等于完成时间的上界排除该条。
    let none = tx
        .items()
        .list_todos_completed_between(t(0, 0), t(10, 0))
        .await
        .unwrap();
    assert!(none.is_empty());
}

#[tokio::test]
async fn today_order_is_read_back_by_position() {
    let (_dir, path, db) = new_db().await;
    let today = NaiveDate::from_ymd_opt(2026, 10, 9).unwrap();
    let mut tx = db.begin().await.unwrap();
    for n in 1..=3 {
        tx.items()
            .insert(&scheduled(simple(n, ItemType::Todo, "x", t(8, 0)), 10, 9))
            .await
            .unwrap();
    }
    tx.commit().await.unwrap();

    // 目前还没有写入顺序的 Use Case（实施计划 1.7），直接用 SQL 播种。
    let mut conn = SqliteConnectOptions::new()
        .filename(&path)
        .connect()
        .await
        .unwrap();
    for (position, n) in [(0_i64, 3_u128), (1, 1), (2, 2)] {
        sqlx::query("INSERT INTO daily_item_order (date, item_id, position) VALUES (?, ?, ?)")
            .bind("2026-10-09")
            .bind(id(n).to_string())
            .bind(position)
            .execute(&mut conn)
            .await
            .unwrap();
    }
    conn.close().await.unwrap();

    let mut tx = db.begin().await.unwrap();
    assert_eq!(
        tx.today_order().get(today).await.unwrap(),
        [id(3), id(1), id(2)]
    );
    let other = NaiveDate::from_ymd_opt(2026, 10, 10).unwrap();
    assert!(tx.today_order().get(other).await.unwrap().is_empty());
}

#[tokio::test]
async fn today_service_works_end_to_end_on_sqlite() {
    use std::sync::Arc;

    use chrono_tz::Tz;
    use nivlo_application::today::TodayService;
    use nivlo_common::clock::FakeClock;

    let (_dir, _path, db) = new_db().await;
    // 上海时间 2026-10-09 20:00（UTC 12:00）。
    let clock = FakeClock::new(t(12, 0), Tz::Asia__Shanghai);
    let service = TodayService::new(
        Arc::new(db.clone()),
        Arc::new(clock),
        Arc::new(nivlo_application::testing::RecordingPublisher::new()),
    );

    let mut tx = db.begin().await.unwrap();
    tx.items()
        .insert(&scheduled(
            simple(1, ItemType::Todo, "今天", t(8, 0)),
            10,
            9,
        ))
        .await
        .unwrap();
    tx.items()
        .insert(&scheduled(
            simple(2, ItemType::Todo, "逾期", t(8, 1)),
            10,
            7,
        ))
        .await
        .unwrap();
    let mut done = scheduled(simple(3, ItemType::Todo, "刚完成", t(8, 2)), 10, 9);
    // UTC 10:00 = 上海 18:00，仍在今天。
    done.complete(t(10, 0)).unwrap();
    tx.items().insert(&done).await.unwrap();
    tx.items()
        .insert(&scheduled(simple(4, ItemType::Tip, "提示", t(8, 3)), 10, 9))
        .await
        .unwrap();
    tx.commit().await.unwrap();

    let view = service.get_today().await.unwrap();

    assert_eq!(view.date, NaiveDate::from_ymd_opt(2026, 10, 9).unwrap());
    assert_eq!(view.remaining_count(), 2);
    assert_eq!(view.todos[0].item.id(), id(2));
    assert!(view.todos[0].is_overdue);
    assert_eq!(view.completed.len(), 1);
    assert_eq!(view.tips.len(), 1);
}

#[tokio::test]
async fn reorder_today_replaces_the_stored_order_atomically_and_survives_reopen() {
    use std::sync::Arc;

    use chrono_tz::Tz;
    use nivlo_application::testing::RecordingPublisher;
    use nivlo_application::today::TodayService;
    use nivlo_common::clock::FakeClock;

    let (dir, path, db) = new_db().await;
    let clock = FakeClock::new(t(12, 0), Tz::Asia__Shanghai);
    let events = Arc::new(RecordingPublisher::new());
    let service = TodayService::new(Arc::new(db.clone()), Arc::new(clock), events.clone());
    let mut tx = db.begin().await.unwrap();
    for n in 1..=3 {
        tx.items()
            .insert(&scheduled(
                simple(n, ItemType::Todo, "x", t(8, n as u32)),
                10,
                9,
            ))
            .await
            .unwrap();
    }
    tx.commit().await.unwrap();

    service.reorder_today(&[id(3), id(1), id(2)]).await.unwrap();
    // 再排一次（含一个界面不知道的 id(2)）：旧记录被整体替换，没有残留或重复。
    service.reorder_today(&[id(2), id(3)]).await.unwrap();

    let today = NaiveDate::from_ymd_opt(2026, 10, 9).unwrap();
    let mut tx = db.begin().await.unwrap();
    assert_eq!(
        tx.today_order().get(today).await.unwrap(),
        [id(2), id(3), id(1)]
    );
    drop(tx);
    assert_eq!(events.events().len(), 2);

    // 重启（关闭后重新打开同一个文件）顺序不变。
    db.close().await;
    let reopened = Database::open(&path).await.unwrap();
    let mut tx = reopened.begin().await.unwrap();
    assert_eq!(
        tx.today_order().get(today).await.unwrap(),
        [id(2), id(3), id(1)]
    );
    drop(dir);
}

/// 一个在 Inbox 里的 Note。
fn inbox_note(n: u128) -> Item {
    let mut new = NewItem::new(ItemType::Note, "网页");
    new.in_inbox = true;
    Item::create(id(n), new, t(8, 0)).unwrap().0
}

/// 一条来源记录。
fn source_for(item: ItemId, n: u128) -> nivlo_domain::source::Source {
    nivlo_domain::source::Source {
        id: nivlo_domain::id::SourceId::from_uuid(Uuid::from_u128(1000 + n)),
        item_id: item,
        source_type: nivlo_domain::source::SourceType::new("web"),
        source_app: Some("Chrome".into()),
        source_url: Some("https://example.com/a".into()),
        source_path: None,
        original_title: Some("示例页面".into()),
        metadata_json: Some(r#"{"k":"v"}"#.into()),
        captured_at: t(9, n as u32),
    }
}

/// 一条附件记录。
fn attachment_for(
    item: ItemId,
    n: u128,
    kind: nivlo_domain::attachment::AttachmentKind,
    path: &str,
) -> nivlo_domain::attachment::Attachment {
    nivlo_domain::attachment::Attachment {
        id: nivlo_domain::id::AttachmentId::from_uuid(Uuid::from_u128(2000 + n)),
        item_id: item,
        kind,
        path: path.into(),
        name: "报告.pdf".into(),
        mime: Some("application/pdf".into()),
        size_bytes: Some(4096),
        added_at: t(10, n as u32),
    }
}

#[tokio::test]
async fn in_inbox_is_stored_and_cleared_by_organizing() {
    let (_dir, _path, db) = new_db().await;
    let mut tx = db.begin().await.unwrap();
    tx.items().insert(&inbox_note(1)).await.unwrap();
    tx.items()
        .insert(&simple(2, ItemType::Todo, "普通待办", t(8, 1)))
        .await
        .unwrap();
    tx.commit().await.unwrap();

    let mut tx = db.begin().await.unwrap();
    assert!(tx.items().get(id(1)).await.unwrap().unwrap().in_inbox());
    assert!(!tx.items().get(id(2)).await.unwrap().unwrap().in_inbox());

    // 安排日期后离开 Inbox，并且持久化。
    let mut note = tx.items().get(id(1)).await.unwrap().unwrap();
    note.set_scheduled(
        Some(DatePoint::all_day(
            NaiveDate::from_ymd_opt(2026, 10, 10).unwrap(),
        )),
        t(11, 0),
    );
    tx.items().update(&note).await.unwrap();
    tx.commit().await.unwrap();
    let mut tx = db.begin().await.unwrap();
    assert!(!tx.items().get(id(1)).await.unwrap().unwrap().in_inbox());
}

#[tokio::test]
async fn source_and_attachment_records_round_trip_in_order() {
    use nivlo_domain::attachment::AttachmentKind;

    let (_dir, _path, db) = new_db().await;
    let mut tx = db.begin().await.unwrap();
    tx.items().insert(&inbox_note(1)).await.unwrap();
    // 故意乱序插入，读取必须按时间升序。
    tx.sources().insert(&source_for(id(1), 2)).await.unwrap();
    tx.sources().insert(&source_for(id(1), 1)).await.unwrap();
    tx.attachments()
        .insert(&attachment_for(id(1), 2, AttachmentKind::Stored, "a/b.png"))
        .await
        .unwrap();
    tx.attachments()
        .insert(&attachment_for(
            id(1),
            1,
            AttachmentKind::Reference,
            r"C:\用户\文档\报告.pdf",
        ))
        .await
        .unwrap();
    tx.commit().await.unwrap();

    let mut tx = db.begin().await.unwrap();
    let sources = tx.sources().list_for_item(id(1)).await.unwrap();
    assert_eq!(sources, vec![source_for(id(1), 1), source_for(id(1), 2)]);
    let attachments = tx.attachments().list_for_item(id(1)).await.unwrap();
    assert_eq!(attachments.len(), 2);
    assert_eq!(attachments[0].kind, AttachmentKind::Reference);
    assert_eq!(attachments[0].path, r"C:\用户\文档\报告.pdf");
    assert_eq!(attachments[1].kind, AttachmentKind::Stored);
    assert_eq!(attachments[0].size_bytes, Some(4096));
    assert!(tx.sources().list_for_item(id(99)).await.unwrap().is_empty());
}

#[tokio::test]
async fn sources_and_attachments_require_an_existing_item() {
    use nivlo_domain::attachment::AttachmentKind;

    let (_dir, _path, db) = new_db().await;
    let mut tx = db.begin().await.unwrap();
    let source = tx.sources().insert(&source_for(id(404), 1)).await;
    assert!(matches!(source, Err(StorageError::Constraint(_))));
    let attachment = tx
        .attachments()
        .insert(&attachment_for(id(404), 1, AttachmentKind::Reference, "x"))
        .await;
    assert!(matches!(attachment, Err(StorageError::Constraint(_))));
}

#[tokio::test]
async fn deleting_an_item_cascades_records_but_never_touches_the_referenced_file() {
    use nivlo_domain::attachment::AttachmentKind;

    let (dir, path, db) = new_db().await;
    // 用户自己的文件：被引用，不是 Nivlo 的。
    let user_file = dir.path().join("用户的 报告.pdf");
    std::fs::write(&user_file, b"%PDF-1.7 precious").unwrap();

    let mut tx = db.begin().await.unwrap();
    tx.items().insert(&inbox_note(1)).await.unwrap();
    let reference = attachment_for(
        id(1),
        1,
        AttachmentKind::Reference,
        &user_file.to_string_lossy(),
    );
    tx.attachments().insert(&reference).await.unwrap();
    tx.sources().insert(&source_for(id(1), 1)).await.unwrap();
    tx.commit().await.unwrap();

    // 目前没有「删除 Item」的 Use Case（3.5），直接用 SQL 触发数据库的级联。
    let mut conn = SqliteConnectOptions::new()
        .filename(&path)
        .foreign_keys(true)
        .connect()
        .await
        .unwrap();
    sqlx::query("DELETE FROM items WHERE id = ?")
        .bind(id(1).to_string())
        .execute(&mut conn)
        .await
        .unwrap();
    conn.close().await.unwrap();

    let mut tx = db.begin().await.unwrap();
    assert!(tx.sources().list_for_item(id(1)).await.unwrap().is_empty());
    assert!(
        tx.attachments()
            .list_for_item(id(1))
            .await
            .unwrap()
            .is_empty()
    );
    // 记录没了，但用户的文件原封不动。
    assert_eq!(std::fs::read(&user_file).unwrap(), b"%PDF-1.7 precious");
    // 领域规则：引用类附件不归 Nivlo 所有，只有复制进 attachments/ 的才会被清理。
    assert!(!reference.owns_file());
}

#[tokio::test]
async fn in_inbox_only_filter_returns_pending_items_and_ignores_archived() {
    let (_dir, _path, db) = new_db().await;
    let inbox_item = |n: u128, title: &str, in_inbox: bool, minute: u32| {
        let mut new = NewItem::new(ItemType::Note, title);
        new.in_inbox = in_inbox;
        Item::create(id(n), new, t(8, minute)).unwrap().0
    };
    let pending = inbox_item(1, "待整理", true, 0);
    let organized = inbox_item(2, "已整理", false, 1);
    let mut archived = inbox_item(3, "已归档", true, 2);
    archived.archive(t(9, 0)).unwrap();

    let mut tx = db.begin().await.unwrap();
    for item in [&pending, &organized, &archived] {
        tx.items().insert(item).await.unwrap();
    }
    tx.commit().await.unwrap();

    let mut tx = db.begin().await.unwrap();
    let listed = tx
        .items()
        .list(&ItemFilter {
            in_inbox_only: true,
            ..ItemFilter::default()
        })
        .await
        .unwrap();
    let titles: Vec<String> = listed.iter().map(|i| i.title().to_string()).collect();
    assert_eq!(titles, ["待整理"]);
}
