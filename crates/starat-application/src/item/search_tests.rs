//! `ItemService::search_items` 的 Use Case 测试：使用内存 Fake。

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::sync::Arc;

use chrono::{TimeZone, Utc};
use starat_common::clock::FakeClock;
use starat_domain::id::ItemId;
use starat_domain::item::{Item, ItemType, NewItem};
use uuid::Uuid;

use super::{ItemService, SEARCH_LIMIT};
use crate::testing::{FakeUnitOfWork, RecordingPublisher};

/// 构造服务；时钟固定。
fn service() -> ItemService {
    service_on(FakeUnitOfWork::new())
}

/// 在给定的内存数据库上构造服务。
fn service_on(uow: FakeUnitOfWork) -> ItemService {
    ItemService::new(
        Arc::new(uow),
        Arc::new(FakeClock::at_utc(
            Utc.with_ymd_and_hms(2026, 10, 9, 8, 0, 0).unwrap(),
        )),
        Arc::new(RecordingPublisher::new()),
    )
}

#[tokio::test]
async fn blank_queries_return_nothing_without_touching_storage() {
    let service = service();
    service
        .create_item(NewItem::new(ItemType::Todo, "修复登录超时"))
        .await
        .unwrap();
    assert!(service.search_items("").await.unwrap().is_empty());
    assert!(service.search_items("  \t ").await.unwrap().is_empty());
}

#[tokio::test]
async fn search_finds_substrings_in_titles_and_content_and_skips_archived() {
    let uow = FakeUnitOfWork::new();
    let service = service_on(uow.clone());
    service
        .create_item(NewItem::new(ItemType::Todo, "修复登录超时"))
        .await
        .unwrap();
    let mut note = NewItem::new(ItemType::Note, "周报");
    note.content = Some("登录页改版完成".to_owned());
    service.create_item(note).await.unwrap();
    let now = Utc.with_ymd_and_hms(2026, 10, 1, 8, 0, 0).unwrap();
    let (mut archived, _) = Item::create(
        ItemId::from_uuid(Uuid::from_u128(9)),
        NewItem::new(ItemType::Todo, "旧的登录任务"),
        now,
    )
    .unwrap();
    archived.archive(now).unwrap();
    uow.seed(archived);

    let found = service.search_items("登录").await.unwrap();
    let titles: Vec<&str> = found.iter().map(|i| i.title().as_str()).collect();
    // 标题命中的排在正文命中之前；归档的不出现。
    assert_eq!(titles, ["修复登录超时", "周报"]);
}

#[tokio::test]
async fn search_is_capped() {
    let service = service();
    for n in 0..(SEARCH_LIMIT + 5) {
        service
            .create_item(NewItem::new(ItemType::Todo, format!("任务 {n}")))
            .await
            .unwrap();
    }
    assert_eq!(
        service.search_items("任务").await.unwrap().len(),
        SEARCH_LIMIT as usize
    );
}
