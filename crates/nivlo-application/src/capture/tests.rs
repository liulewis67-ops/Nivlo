//! `CaptureService` 的 Use Case 测试：只依赖内存 Fake。

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::path::Path;
use std::sync::Arc;

use chrono::{TimeZone, Utc};
use nivlo_capture::{file_ref, image_input, normalize_files, normalize_text};
use nivlo_common::clock::FakeClock;
use nivlo_domain::attachment::AttachmentKind;
use nivlo_domain::capture::{CaptureInput, CaptureOrigin, CaptureRequest};
use nivlo_domain::event::DomainEvent;
use nivlo_domain::item::ItemType;

use super::CaptureService;
use crate::error::ErrorCode;
use crate::testing::{FakeAttachmentFiles, FakeUnitOfWork, RecordingPublisher};

/// 测试夹具。
struct Fixture {
    service: CaptureService,
    uow: FakeUnitOfWork,
    events: Arc<RecordingPublisher>,
    files: Arc<FakeAttachmentFiles>,
}

/// 构造夹具。
fn fixture() -> Fixture {
    let uow = FakeUnitOfWork::new();
    let events = Arc::new(RecordingPublisher::new());
    let files = Arc::new(FakeAttachmentFiles::new());
    let clock = FakeClock::at_utc(Utc.with_ymd_and_hms(2026, 10, 10, 8, 0, 0).unwrap());
    let service = CaptureService::new(
        Arc::new(uow.clone()),
        Arc::new(clock),
        events.clone(),
        files.clone(),
    );
    Fixture {
        service,
        uow,
        events,
        files,
    }
}

/// 一个 PNG 文件头。
const PNG: &[u8] = &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3, 4];

/// 以某种来路构造请求。
fn request(input: CaptureInput, origin: CaptureOrigin) -> CaptureRequest {
    CaptureRequest::new(input, origin)
}

#[tokio::test]
async fn text_becomes_a_todo_in_the_inbox_with_a_text_source() {
    let f = fixture();
    let input = normalize_text("买牛奶").unwrap();

    let result = f
        .service
        .capture(request(input, CaptureOrigin::QuickAdd))
        .await
        .unwrap();

    let item = &result.items[0];
    assert_eq!(item.item_type(), ItemType::Todo);
    assert_eq!(item.title().as_str(), "买牛奶");
    assert!(item.in_inbox());
    assert_eq!(item.scheduled(), None);
    // 标题已经是全文，不重复放进内容。
    assert_eq!(item.content(), None);
    let sources = f.uow.committed_sources();
    assert_eq!(sources.len(), 1);
    assert_eq!(sources[0].source_type.as_str(), "text");
    assert!(f.uow.committed_attachments().is_empty());
}

#[tokio::test]
async fn multi_line_text_keeps_the_full_text_as_content() {
    let f = fixture();
    let input = normalize_text("第一行是标题\n第二行是补充说明").unwrap();

    let result = f
        .service
        .capture(request(input, CaptureOrigin::Paste))
        .await
        .unwrap();

    assert_eq!(result.items[0].title().as_str(), "第一行是标题");
    assert_eq!(
        result.items[0].content(),
        Some("第一行是标题\n第二行是补充说明")
    );
}

#[tokio::test]
async fn url_becomes_a_note_with_the_link_as_content_and_a_web_source() {
    let f = fixture();
    let input = normalize_text("https://www.example.com/docs/page?x=1").unwrap();
    let mut req = request(input, CaptureOrigin::Drop);
    req.source_application = Some("Chrome".into());

    let result = f.service.capture(req).await.unwrap();

    let item = &result.items[0];
    assert_eq!(item.item_type(), ItemType::Note);
    assert_eq!(item.title().as_str(), "example.com/docs/page");
    assert_eq!(
        item.content(),
        Some("https://www.example.com/docs/page?x=1")
    );
    assert!(item.in_inbox());
    let source = &f.uow.committed_sources()[0];
    assert_eq!(source.source_type.as_str(), "web");
    assert_eq!(
        source.source_url.as_deref(),
        Some("https://www.example.com/docs/page?x=1")
    );
    assert_eq!(source.source_app.as_deref(), Some("Chrome"));
}

#[tokio::test]
async fn a_file_becomes_a_note_with_a_reference_attachment_and_is_not_copied() {
    let f = fixture();
    let input = CaptureInput::File {
        file: file_ref(Path::new(r"C:\用户\文档\季度 报告.pdf")),
    };

    let result = f
        .service
        .capture(request(input, CaptureOrigin::Drop))
        .await
        .unwrap();

    let item = &result.items[0];
    assert_eq!(item.item_type(), ItemType::Note);
    assert_eq!(item.title().as_str(), "季度 报告.pdf");
    let attachments = f.uow.committed_attachments();
    assert_eq!(attachments.len(), 1);
    assert_eq!(attachments[0].kind, AttachmentKind::Reference);
    assert_eq!(attachments[0].path, r"C:\用户\文档\季度 报告.pdf");
    assert_eq!(f.uow.committed_sources()[0].source_type.as_str(), "file");
    assert_eq!(
        f.uow.committed_sources()[0].source_path.as_deref(),
        Some(r"C:\用户\文档\季度 报告.pdf")
    );
    // 引用文件不复制：Nivlo 自己的附件目录里什么都没有。
    assert!(f.files.stored_paths().is_empty());
}

#[tokio::test]
async fn several_files_become_one_note_each_in_a_single_transaction() {
    let f = fixture();
    let input = normalize_files(&[r"D:\a\1.txt", r"D:\a\2.txt", r"D:\a\3.txt"]).unwrap();

    let result = f
        .service
        .capture(request(input, CaptureOrigin::Drop))
        .await
        .unwrap();

    assert_eq!(result.items.len(), 3);
    assert_eq!(f.uow.committed_items().len(), 3);
    assert_eq!(f.uow.committed_attachments().len(), 3);
    assert_eq!(f.uow.committed_sources().len(), 3);
    assert!(result.items.iter().all(|i| i.in_inbox()));
    assert_eq!(f.events.events().len(), 3);
}

#[tokio::test]
async fn an_image_becomes_a_note_with_a_stored_attachment() {
    let f = fixture();
    let input = image_input(PNG.to_vec()).unwrap();

    let result = f
        .service
        .capture(request(input, CaptureOrigin::Paste))
        .await
        .unwrap();

    let item = &result.items[0];
    assert_eq!(item.item_type(), ItemType::Note);
    assert_eq!(item.title().as_str(), "图片");
    let attachments = f.uow.committed_attachments();
    assert_eq!(attachments[0].kind, AttachmentKind::Stored);
    assert_eq!(attachments[0].mime.as_deref(), Some("image/png"));
    assert_eq!(attachments[0].size_bytes, Some(PNG.len() as u64));
    // 文件由 Nivlo 保存并以附件 ID 命名。
    assert_eq!(f.files.stored_paths(), vec![attachments[0].path.clone()]);
    assert_eq!(f.uow.committed_sources()[0].source_type.as_str(), "image");
}

#[tokio::test]
async fn origin_never_changes_what_is_created() {
    let mut shapes = Vec::new();
    for origin in [
        CaptureOrigin::Manual,
        CaptureOrigin::Drop,
        CaptureOrigin::Paste,
        CaptureOrigin::QuickAdd,
        CaptureOrigin::Shortcut,
    ] {
        let f = fixture();
        let input = normalize_text("同一段文字").unwrap();
        let result = f.service.capture(request(input, origin)).await.unwrap();
        let item = &result.items[0];
        shapes.push((item.item_type(), item.title().to_string(), item.in_inbox()));
    }
    assert!(shapes.windows(2).all(|pair| pair[0] == pair[1]));
}

#[tokio::test]
async fn created_events_are_published_only_after_a_successful_commit() {
    let f = fixture();
    f.uow.fail_next_commit();

    let error = f
        .service
        .capture(request(
            normalize_text("买牛奶").unwrap(),
            CaptureOrigin::Manual,
        ))
        .await
        .unwrap_err();

    assert_eq!(error.code, ErrorCode::StorageUnavailable);
    assert!(f.events.events().is_empty());

    let ok = f
        .service
        .capture(request(
            normalize_text("买牛奶").unwrap(),
            CaptureOrigin::Manual,
        ))
        .await
        .unwrap();
    assert_eq!(
        f.events.events(),
        vec![DomainEvent::ItemCreated {
            item_id: ok.items[0].id()
        }]
    );
}

#[tokio::test]
async fn a_failed_commit_leaves_no_records_and_removes_the_stored_image() {
    let f = fixture();
    f.uow.fail_next_commit();

    let error = f
        .service
        .capture(request(
            image_input(PNG.to_vec()).unwrap(),
            CaptureOrigin::Paste,
        ))
        .await
        .unwrap_err();

    assert_eq!(error.code, ErrorCode::StorageUnavailable);
    assert!(f.uow.committed_items().is_empty());
    assert!(f.uow.committed_sources().is_empty());
    assert!(f.uow.committed_attachments().is_empty());
    // 磁盘上也不留孤儿文件。
    assert!(f.files.stored_paths().is_empty());
}

#[tokio::test]
async fn a_failed_file_write_creates_nothing() {
    let f = fixture();
    f.files.fail_next_store();

    let error = f
        .service
        .capture(request(
            image_input(PNG.to_vec()).unwrap(),
            CaptureOrigin::Paste,
        ))
        .await
        .unwrap_err();

    assert_eq!(error.code, ErrorCode::StorageUnavailable);
    assert!(f.uow.committed_items().is_empty());
    assert!(f.events.events().is_empty());
}

#[tokio::test]
async fn undo_restores_the_database_and_removes_only_nivlos_own_files() {
    let f = fixture();
    // 一个已有的、与本次捕获无关的 Item：撤销不能碰它。
    let existing = f
        .service
        .capture(request(
            normalize_text("原有的").unwrap(),
            CaptureOrigin::Manual,
        ))
        .await
        .unwrap();
    let before_items = f.uow.committed_items();
    let before_sources = f.uow.committed_sources();

    let image = f
        .service
        .capture(request(
            image_input(PNG.to_vec()).unwrap(),
            CaptureOrigin::Paste,
        ))
        .await
        .unwrap();
    let files = f
        .service
        .capture(request(
            normalize_files(&[r"D:\x\a.txt", r"D:\x\b.txt"]).unwrap(),
            CaptureOrigin::Drop,
        ))
        .await
        .unwrap();
    assert_eq!(f.files.stored_paths().len(), 1);
    f.events.clear();

    let mut ids = image.undo_ids();
    ids.extend(files.undo_ids());
    f.service.undo(&ids).await.unwrap();

    // 数据库恢复到捕获之前。
    assert_eq!(f.uow.committed_items(), before_items);
    assert_eq!(f.uow.committed_sources(), before_sources);
    assert!(f.uow.committed_attachments().is_empty());
    // Nivlo 自己保存的图片被清理；引用的用户文件本来就没被复制过。
    assert!(f.files.stored_paths().is_empty());
    assert_eq!(f.events.events().len(), 3);
    assert!(matches!(
        f.events.events()[0],
        DomainEvent::ItemDeleted { .. }
    ));
    // 重复撤销是安全的空操作。
    f.events.clear();
    f.service.undo(&ids).await.unwrap();
    assert!(f.events.events().is_empty());
    assert_eq!(existing.items.len(), 1);
}

#[tokio::test]
async fn a_failed_undo_commit_deletes_nothing() {
    let f = fixture();
    let result = f
        .service
        .capture(request(
            image_input(PNG.to_vec()).unwrap(),
            CaptureOrigin::Paste,
        ))
        .await
        .unwrap();
    f.uow.fail_next_commit();

    let error = f.service.undo(&result.undo_ids()).await.unwrap_err();

    assert_eq!(error.code, ErrorCode::StorageUnavailable);
    assert_eq!(f.uow.committed_items().len(), 1);
    // 数据库记录还在，所以磁盘文件也必须还在。
    assert_eq!(f.files.stored_paths().len(), 1);
}
