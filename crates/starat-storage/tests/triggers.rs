//! Scheduler 触发记录在真实 SQLite 上的行为（实施计划 4.4）。

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "集成测试中失败即断言"
)]

use chrono::{DateTime, NaiveDate, NaiveTime, TimeZone, Utc};
use starat_application::ports::{StorageError, UnitOfWork};
use starat_application::trigger::{TriggerKey, TriggerKind, triggers_of};
use starat_domain::id::ItemId;
use starat_domain::item::{DatePoint, Item, ItemType, NewItem};
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

/// 固定的 UTC 时刻。
fn t(hour: u32, minute: u32) -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 10, 14, hour, minute, 0).unwrap()
}

/// 确定性的 ID。
fn id(n: u128) -> ItemId {
    ItemId::from_uuid(Uuid::from_u128(n))
}

/// 创建一个条目。
fn item(n: u128, item_type: ItemType, edit: impl FnOnce(&mut NewItem)) -> Item {
    let mut new = NewItem::new(item_type, format!("条目{n}"));
    edit(&mut new);
    Item::create(id(n), new, t(8, 0)).unwrap().0
}

#[tokio::test]
async fn trigger_sources_are_open_items_that_can_produce_a_trigger() {
    let (_dir, _path, db) = new_db().await;
    let day = NaiveDate::from_ymd_opt(2026, 10, 14).unwrap();
    let at_ten = NaiveTime::from_hms_opt(10, 0, 0).unwrap();
    let mut done = item(5, ItemType::Todo, |n| n.reminder_at = Some(t(10, 0)));
    done.complete(t(9, 0)).unwrap();
    let mut archived = item(6, ItemType::Todo, |n| n.reminder_at = Some(t(10, 0)));
    archived.archive(t(9, 0)).unwrap();
    let mut tx = db.begin().await.unwrap();
    for i in [
        item(1, ItemType::Todo, |n| n.reminder_at = Some(t(10, 0))),
        item(2, ItemType::Tip, |n| {
            n.scheduled = Some(DatePoint::at(day, at_ten))
        }),
        item(3, ItemType::Todo, |n| {
            n.due = Some(DatePoint::at(day, at_ten))
        }),
        // 只有日期的计划 / 截止、没有任何时间的待办：不会触发。
        item(4, ItemType::Tip, |n| {
            n.scheduled = Some(DatePoint::all_day(day))
        }),
        done,
        archived,
        item(7, ItemType::Todo, |_| {}),
        item(8, ItemType::Todo, |n| n.reminder_at = Some(t(11, 0))),
    ] {
        tx.items().insert(&i).await.unwrap();
    }
    tx.trash().mark_deleted(id(8), t(9, 30)).await.unwrap();

    let mut ids: Vec<ItemId> = tx
        .triggers()
        .list_trigger_sources()
        .await
        .unwrap()
        .iter()
        .map(|i| i.id())
        .collect();
    ids.sort();
    assert_eq!(ids, [id(1), id(2), id(3)]);
    // 由 Item 推导出的触发点：提醒、Tip、截止各一个。
    let kinds: Vec<TriggerKind> = tx
        .triggers()
        .list_trigger_sources()
        .await
        .unwrap()
        .iter()
        .flat_map(|i| triggers_of(i, chrono_tz::Tz::UTC))
        .map(|trigger| trigger.key.kind)
        .collect();
    assert_eq!(kinds.len(), 3);
}

#[tokio::test]
async fn fired_records_survive_a_restart_and_are_idempotent() {
    let (_dir, path, db) = new_db().await;
    let key = TriggerKey {
        fire_at: t(10, 0),
        item_id: id(1),
        kind: TriggerKind::Reminder,
    };
    {
        let mut tx = db.begin().await.unwrap();
        tx.items()
            .insert(&item(1, ItemType::Todo, |n| n.reminder_at = Some(t(10, 0))))
            .await
            .unwrap();
        tx.triggers()
            .record_fired(&key, t(10, 1), false)
            .await
            .unwrap();
        // 重复记录是空操作。
        tx.triggers()
            .record_fired(&key, t(11, 0), true)
            .await
            .unwrap();
        tx.commit().await.unwrap();
    }
    db.close().await;

    let db = Database::open(&path).await.unwrap();
    let mut tx = db.begin().await.unwrap();
    assert_eq!(
        tx.triggers().list_fired_since(t(0, 0)).await.unwrap(),
        [key]
    );
    // 同一个 Item 的另一个触发时刻 / 另一种类，是不同的触发点。
    assert!(
        tx.triggers()
            .list_fired_since(t(10, 1))
            .await
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn records_cascade_with_the_item_and_old_ones_are_pruned() {
    let (_dir, _path, db) = new_db().await;
    let old = TriggerKey {
        fire_at: t(1, 0),
        item_id: id(1),
        kind: TriggerKind::Reminder,
    };
    let recent = TriggerKey {
        fire_at: t(10, 0),
        item_id: id(1),
        kind: TriggerKind::Due,
    };
    let mut tx = db.begin().await.unwrap();
    tx.items()
        .insert(&item(1, ItemType::Todo, |_| {}))
        .await
        .unwrap();
    tx.triggers()
        .record_fired(&old, t(1, 1), false)
        .await
        .unwrap();
    tx.triggers()
        .record_fired(&recent, t(10, 1), false)
        .await
        .unwrap();

    assert_eq!(tx.triggers().prune_fired_before(t(5, 0)).await.unwrap(), 1);
    assert_eq!(
        tx.triggers().list_fired_since(t(0, 0)).await.unwrap(),
        [recent]
    );

    // 永久删除 Item：记录随外键级联删除。
    tx.items().delete(id(1)).await.unwrap();
    assert!(
        tx.triggers()
            .list_fired_since(t(0, 0))
            .await
            .unwrap()
            .is_empty()
    );
    // 给不存在的 Item 记录违反外键约束。
    assert!(matches!(
        tx.triggers().record_fired(&recent, t(10, 1), false).await,
        Err(StorageError::Constraint(_))
    ));
}
