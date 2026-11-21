//! `ExportService` 的测试：JSON 与 Markdown 的内容、文件名安全、回收站不导出。

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::Arc;

use chrono::{TimeZone, Utc};
use nivlo_common::clock::FakeClock;
use nivlo_domain::id::{ItemId, SourceId, TagId};
use nivlo_domain::item::{DatePoint, Item, ItemType, NewItem};
use nivlo_domain::source::{Source, SourceType};
use nivlo_domain::tag::{Tag, TagName};
use serde_json::Value;
use uuid::Uuid;

use super::{ExportFormat, ExportService};
use crate::ports::UnitOfWork;
use crate::testing::FakeUnitOfWork;

fn at(minute: u32) -> chrono::DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 10, 11, 8, minute, 0).unwrap()
}

fn item(n: u128, item_type: ItemType, title: &str, minute: u32) -> Item {
    Item::create(
        ItemId::from_uuid(Uuid::from_u128(n)),
        NewItem::new(item_type, title),
        at(minute),
    )
    .unwrap()
    .0
}

async fn service_with_data() -> (ExportService, FakeUnitOfWork) {
    let uow = FakeUnitOfWork::new();
    let mut todo = item(1, ItemType::Todo, "买牛奶", 0);
    let _ = todo.set_scheduled(
        Some(DatePoint::all_day(
            chrono::NaiveDate::from_ymd_opt(2026, 10, 12).unwrap(),
        )),
        at(1),
    );
    let mut note = item(2, ItemType::Note, "读书/笔记: 第一章?", 2);
    note.set_content(
        Some("第一行\n第二行\n".to_owned()),
        nivlo_domain::item::ContentFormat::Plain,
        at(2),
    )
    .unwrap();
    let archived = item(3, ItemType::Note, "旧笔记", 3);
    uow.seed(todo);
    uow.seed(note);
    uow.seed(archived);

    let mut tx = uow.begin().await.unwrap();
    let tag = Tag {
        id: TagId::from_uuid(Uuid::from_u128(100)),
        name: TagName::new("read").unwrap(),
    };
    tx.tags().insert(&tag).await.unwrap();
    tx.tags()
        .set_for_item(ItemId::from_uuid(Uuid::from_u128(2)), &[tag.id])
        .await
        .unwrap();
    tx.sources()
        .insert(&Source {
            id: SourceId::from_uuid(Uuid::from_u128(200)),
            item_id: ItemId::from_uuid(Uuid::from_u128(2)),
            source_type: SourceType::new("web"),
            source_app: Some("Chrome".into()),
            source_url: Some("https://example.com/a".into()),
            source_path: None,
            original_title: Some("示例页面".into()),
            metadata_json: Some("{\"secret\":\"must-not-leak\"}".into()),
            captured_at: at(2),
        })
        .await
        .unwrap();
    tx.commit().await.unwrap();

    let clock = FakeClock::at_utc(at(30));
    (
        ExportService::new(Arc::new(uow.clone()), Arc::new(clock)),
        uow,
    )
}

#[tokio::test]
async fn json_export_contains_every_item_with_tags_sources_and_dates() {
    let (service, _) = service_with_data().await;
    let bundle = service.export(ExportFormat::Json).await.unwrap();
    assert_eq!(bundle.item_count, 3);
    assert_eq!(bundle.files.len(), 1);
    let value: Value = serde_json::from_slice(&bundle.files[0].bytes).unwrap();
    assert_eq!(value["format"], "nivlo-export");
    assert_eq!(value["itemCount"], 3);
    let items = value["items"].as_array().unwrap();
    assert_eq!(items[0]["title"], "买牛奶");
    assert_eq!(items[0]["scheduled"], "2026-10-12");
    assert_eq!(items[0]["status"], "open");
    assert_eq!(items[1]["tags"][0], "read");
    assert_eq!(items[1]["sources"][0]["url"], "https://example.com/a");
    assert_eq!(items[1]["sources"][0]["originalTitle"], "示例页面");
    assert_eq!(items[1]["createdAt"], "2026-10-11T08:02:00Z");
    // Integration 的内部元数据不进导出。
    let text = String::from_utf8(bundle.files[0].bytes.clone()).unwrap();
    assert!(!text.contains("must-not-leak"));
}

#[tokio::test]
async fn markdown_export_is_readable_and_includes_sources() {
    let (service, _) = service_with_data().await;
    let bundle = service.export(ExportFormat::Markdown).await.unwrap();
    let text = String::from_utf8(bundle.files[0].bytes.clone()).unwrap();
    assert!(text.starts_with("# 拾序导出"));
    assert!(text.contains("## [ ] 买牛奶"));
    assert!(text.contains("计划 2026-10-12"));
    assert!(text.contains("第一行\n第二行"));
    assert!(text.contains("#read"));
    assert!(text.contains("来源：\n\n- web · Chrome · 示例页面 · https://example.com/a"));
}

#[tokio::test]
async fn per_item_files_have_safe_unique_names_and_front_matter() {
    let (service, _) = service_with_data().await;
    let bundle = service.export(ExportFormat::MarkdownFiles).await.unwrap();
    assert_eq!(bundle.files.len(), 3);
    let names: Vec<_> = bundle.files.iter().map(|f| f.path.as_str()).collect();
    for name in &names {
        assert!(
            !name.contains(['\\', ':', '*', '?', '"', '<', '>', '|']),
            "{name}"
        );
        assert!(!name.contains('/'), "{name}");
        assert!(name.ends_with(".md"));
    }
    let unique: std::collections::HashSet<_> = names.iter().collect();
    assert_eq!(unique.len(), names.len());
    let note = String::from_utf8(bundle.files[1].bytes.clone()).unwrap();
    assert!(note.starts_with("---\nid: "));
    assert!(note.contains("tags: [\"read\"]"));
    assert!(
        note.contains("# 读书/笔记: 第一章?"),
        "标题原样保留在正文里"
    );
}

#[tokio::test]
async fn trashed_items_are_not_exported() {
    let (service, uow) = service_with_data().await;
    let mut tx = uow.begin().await.unwrap();
    tx.trash()
        .mark_deleted(ItemId::from_uuid(Uuid::from_u128(3)), at(40))
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let bundle = service.export(ExportFormat::Json).await.unwrap();
    assert_eq!(bundle.item_count, 2);
}
