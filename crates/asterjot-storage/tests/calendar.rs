//! Calendar 查询在真实 SQLite 上的行为与性能（实施计划 4.2）。

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "集成测试中失败即断言"
)]

use std::time::Instant;

use asterjot_application::ports::UnitOfWork;
use asterjot_domain::id::ItemId;
use asterjot_domain::item::{DatePoint, Item, ItemType, NewItem};
use asterjot_storage::Database;
use chrono::{DateTime, Duration, NaiveDate, TimeZone, Utc};
use uuid::Uuid;

/// 在临时目录中创建并迁移好的数据库。
async fn new_db() -> (tempfile::TempDir, Database) {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("asterjot.db"))
        .await
        .unwrap();
    db.migrate().await.unwrap();
    (dir, db)
}

/// 解析 `YYYY-MM-DD`。
fn d(text: &str) -> NaiveDate {
    NaiveDate::parse_from_str(text, "%Y-%m-%d").unwrap()
}

/// 固定的"现在"，按分钟递增。
fn t(minute: i64) -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 10, 1, 8, 0, 0).unwrap() + Duration::minutes(minute)
}

/// 创建一个条目。
fn item(
    n: u128,
    item_type: ItemType,
    title: &str,
    scheduled: Option<&str>,
    due: Option<&str>,
) -> Item {
    let mut new = NewItem::new(item_type, title);
    new.scheduled = scheduled.map(|s| DatePoint::all_day(d(s)));
    new.due = due.map(|s| DatePoint::all_day(d(s)));
    Item::create(ItemId::from_uuid(Uuid::from_u128(n)), new, t(n as i64))
        .unwrap()
        .0
}

#[tokio::test]
async fn calendar_returns_items_scheduled_or_due_in_the_closed_range() {
    let (_dir, db) = new_db().await;
    let mut archived = item(5, ItemType::Todo, "归档的", Some("2026-10-14"), None);
    archived.archive(t(10)).unwrap();
    let mut tx = db.begin().await.unwrap();
    for i in [
        item(1, ItemType::Todo, "边界起点", Some("2026-10-12"), None),
        item(2, ItemType::Todo, "边界终点", Some("2026-10-18"), None),
        item(3, ItemType::Todo, "只有截止", None, Some("2026-10-15")),
        item(
            4,
            ItemType::Todo,
            "两者都在范围内",
            Some("2026-10-13"),
            Some("2026-10-16"),
        ),
        archived,
        item(6, ItemType::Todo, "范围前", Some("2026-10-11"), None),
        item(7, ItemType::Todo, "范围后", Some("2026-10-19"), None),
        item(8, ItemType::Note, "笔记", Some("2026-10-14"), None),
        item(9, ItemType::Todo, "删除的", Some("2026-10-14"), None),
    ] {
        tx.items().insert(&i).await.unwrap();
    }
    tx.trash()
        .mark_deleted(ItemId::from_uuid(Uuid::from_u128(9)), t(20))
        .await
        .unwrap();

    let titles: Vec<String> = tx
        .items()
        .list_calendar(d("2026-10-12"), d("2026-10-18"))
        .await
        .unwrap()
        .iter()
        .map(|i| i.title().as_str().to_owned())
        .collect();
    // 同时在范围内的只返回一次；归档、删除、范围外的都没有；按创建时间排序。
    assert_eq!(
        titles,
        ["边界起点", "边界终点", "只有截止", "两者都在范围内", "笔记"]
    );
}

#[tokio::test]
async fn unscheduled_open_todos_are_newest_first_and_limited() {
    let (_dir, db) = new_db().await;
    let mut done = item(3, ItemType::Todo, "已完成", None, None);
    done.complete(t(30)).unwrap();
    let mut tx = db.begin().await.unwrap();
    for i in [
        item(1, ItemType::Todo, "先建的", None, None),
        item(2, ItemType::Todo, "后建的", None, None),
        done,
        item(4, ItemType::Todo, "有日期", Some("2026-10-14"), None),
        item(5, ItemType::Note, "笔记", None, None),
        item(6, ItemType::Tip, "提示", None, None),
    ] {
        tx.items().insert(&i).await.unwrap();
    }
    let titles = |items: Vec<Item>| -> Vec<String> {
        items
            .iter()
            .map(|i| i.title().as_str().to_owned())
            .collect()
    };
    assert_eq!(
        titles(tx.items().list_unscheduled_open_todos(10).await.unwrap()),
        ["后建的", "先建的"]
    );
    assert_eq!(
        titles(tx.items().list_unscheduled_open_todos(1).await.unwrap()),
        ["后建的"]
    );
}

#[tokio::test]
async fn a_month_query_over_five_thousand_items_is_fast() {
    let (_dir, db) = new_db().await;
    let mut tx = db.begin().await.unwrap();
    for n in 0..5_000_u32 {
        // 散布在约 2 年里，每月约 200 条。
        let day = d("2025-01-01") + Duration::days(i64::from(n % 730));
        let scheduled = day.format("%Y-%m-%d").to_string();
        let due = (day + Duration::days(3)).format("%Y-%m-%d").to_string();
        tx.items()
            .insert(&item(
                u128::from(n) + 1,
                ItemType::Todo,
                &format!("任务 {n}"),
                Some(&scheduled),
                (n % 3 == 0).then_some(due.as_str()),
            ))
            .await
            .unwrap();
    }
    tx.commit().await.unwrap();

    let mut best = std::time::Duration::MAX;
    let mut found = 0;
    for _ in 0..5 {
        let started = Instant::now();
        let mut tx = db.begin().await.unwrap();
        let listed = tx
            .items()
            .list_calendar(d("2026-09-28"), d("2026-11-01"))
            .await
            .unwrap();
        best = best.min(started.elapsed());
        found = listed.len();
    }
    assert!(found > 100, "应该能查到约一个月的数据，实际 {found}");
    // 目标 < 20ms（实施计划 4.2，发布构建）；debug 构建留出余量，只防止退化到量级错误。
    assert!(
        best.as_millis() < 200,
        "一次月查询耗时 {best:?}，命中 {found} 条"
    );
}
