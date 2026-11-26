//! `TrashService` 的 Use Case 测试：使用内存 Fake。

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::sync::Arc;

use chrono::{Duration, TimeZone, Utc};
use stardeskbox_capture::{image_input, normalize_files, normalize_text};
use stardeskbox_common::clock::FakeClock;
use stardeskbox_domain::capture::{CaptureOrigin, CaptureRequest};
use stardeskbox_domain::event::DomainEvent;
use stardeskbox_domain::id::ItemId;
use stardeskbox_domain::item::{ItemType, NewItem};
use uuid::Uuid;

use super::{TRASH_RETENTION_DAYS, TrashService};
use crate::capture::CaptureService;
use crate::error::ErrorCode;
use crate::item::ItemService;
use crate::organize::{ProjectService, TagService};
use crate::ports::ItemFilter;
use crate::testing::{FakeAttachmentFiles, FakeUnitOfWork, RecordingPublisher};
use crate::today::TodayService;

/// 一个 PNG 文件头。
const PNG: &[u8] = &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3, 4];

/// 测试夹具。
struct Fixture {
    trash: TrashService,
    items: ItemService,
    capture: CaptureService,
    projects: ProjectService,
    tags: TagService,
    today: TodayService,
    uow: FakeUnitOfWork,
    events: Arc<RecordingPublisher>,
    files: Arc<FakeAttachmentFiles>,
    clock: FakeClock,
}

/// 构造夹具；时钟固定在 2026-10-10 08:00 UTC。
fn fixture() -> Fixture {
    let uow = FakeUnitOfWork::new();
    let events = Arc::new(RecordingPublisher::new());
    let files = Arc::new(FakeAttachmentFiles::new());
    let clock = FakeClock::at_utc(Utc.with_ymd_and_hms(2026, 10, 10, 8, 0, 0).unwrap());
    Fixture {
        trash: TrashService::new(
            Arc::new(uow.clone()),
            Arc::new(clock.clone()),
            events.clone(),
            files.clone(),
        ),
        items: ItemService::new(
            Arc::new(uow.clone()),
            Arc::new(clock.clone()),
            events.clone(),
        ),
        capture: CaptureService::new(
            Arc::new(uow.clone()),
            Arc::new(clock.clone()),
            events.clone(),
            files.clone(),
        ),
        projects: ProjectService::new(Arc::new(uow.clone()), Arc::new(clock.clone())),
        tags: TagService::new(
            Arc::new(uow.clone()),
            Arc::new(clock.clone()),
            events.clone(),
        ),
        today: TodayService::new(
            Arc::new(uow.clone()),
            Arc::new(clock.clone()),
            events.clone(),
        ),
        uow,
        events,
        files,
        clock,
    }
}

/// 创建一个 Todo（计划日期是今天）。
async fn todo(f: &Fixture, title: &str) -> ItemId {
    f.items
        .quick_create(ItemType::Todo, title)
        .await
        .unwrap()
        .id()
}

#[tokio::test]
async fn undo_creation_only_moves_the_unchanged_item_to_trash() {
    let f = fixture();
    let id = todo(&f, "原样撤销").await;
    let revision = f.items.get_item(id).await.unwrap().created_at();
    f.trash.undo_created(id, revision).await.unwrap();
    assert_eq!(f.trash.list().await.unwrap()[0].item.id(), id);

    let edited = todo(&f, "继续编辑").await;
    let revision = f.items.get_item(edited).await.unwrap().created_at();
    f.clock.advance(Duration::seconds(1));
    f.items.complete_item(edited).await.unwrap();
    let error = f.trash.undo_created(edited, revision).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::InvalidInput);
    assert_eq!(f.trash.list().await.unwrap().len(), 1);
}

#[tokio::test]
async fn deleted_items_disappear_from_every_view_and_come_back_on_restore() {
    let f = fixture();
    let keep = todo(&f, "留下的任务").await;
    let gone = todo(&f, "要删除的任务").await;
    let project = f.projects.create("P").await.unwrap();
    f.items
        .update_item(
            gone,
            crate::item::UpdateItemInput {
                project_id: crate::item::Patch::Set(project.id),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    f.tags
        .set_item_tags(gone, &["标签".to_owned()])
        .await
        .unwrap();
    assert_eq!(f.today.get_today().await.unwrap().todos.len(), 2);

    f.trash.delete(&[gone]).await.unwrap();

    // 列表、Today、搜索、项目与标签的数量里都没有它。
    let listed = f.items.list_items(ItemFilter::default()).await.unwrap();
    assert_eq!(listed.iter().map(|i| i.id()).collect::<Vec<_>>(), [keep]);
    assert_eq!(f.today.get_today().await.unwrap().todos.len(), 1);
    assert!(f.items.search_items("要删除").await.unwrap().is_empty());
    assert_eq!(f.projects.list(false).await.unwrap()[0].open_count, 0);
    assert_eq!(f.tags.list().await.unwrap()[0].item_count, 0);
    // 但按 ID 仍然读得到（恢复需要）。
    assert_eq!(
        f.items.get_item(gone).await.unwrap().title().as_str(),
        "要删除的任务"
    );
    assert!(
        f.events
            .events()
            .contains(&DomainEvent::ItemDeleted { item_id: gone })
    );

    f.trash.restore(&[gone]).await.unwrap();
    assert_eq!(f.today.get_today().await.unwrap().todos.len(), 2);
    assert_eq!(f.items.search_items("要删除").await.unwrap().len(), 1);
    assert_eq!(f.projects.list(false).await.unwrap()[0].open_count, 1);
    assert_eq!(f.tags.list().await.unwrap()[0].item_count, 1);
    assert!(f.trash.list().await.unwrap().is_empty());
    // 重复恢复是安全的空操作。
    f.trash.restore(&[gone]).await.unwrap();
}

#[tokio::test]
async fn deleting_a_missing_item_changes_nothing() {
    let f = fixture();
    let real = todo(&f, "真实的").await;
    let missing = ItemId::from_uuid(Uuid::from_u128(404));
    let err = f.trash.delete(&[real, missing]).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::ItemNotFound);
    assert!(f.trash.list().await.unwrap().is_empty());
    assert_eq!(
        f.items
            .list_items(ItemFilter::default())
            .await
            .unwrap()
            .len(),
        1
    );
}

#[tokio::test]
async fn the_trash_lists_newest_first_with_the_expiry_date() {
    let f = fixture();
    let first = todo(&f, "先删的").await;
    let second = todo(&f, "后删的").await;
    f.trash.delete(&[first]).await.unwrap();
    f.clock.advance(Duration::hours(2));
    f.trash.delete(&[second]).await.unwrap();
    // 重复删除保留原来的删除时间。
    f.clock.advance(Duration::hours(2));
    f.trash.delete(&[first]).await.unwrap();

    let entries = f.trash.list().await.unwrap();
    assert_eq!(
        entries.iter().map(|e| e.item.id()).collect::<Vec<_>>(),
        [second, first]
    );
    assert_eq!(
        entries[1].expires_at - entries[1].deleted_at,
        Duration::days(TRASH_RETENTION_DAYS)
    );
    assert_eq!(
        entries[1].deleted_at,
        Utc.with_ymd_and_hms(2026, 10, 10, 8, 0, 0).unwrap()
    );
}

#[tokio::test]
async fn purge_only_touches_deleted_items_and_removes_stardeskboxs_own_files() {
    let f = fixture();
    let image = f
        .capture
        .capture(CaptureRequest::new(
            image_input(PNG.to_vec()).unwrap(),
            CaptureOrigin::Paste,
        ))
        .await
        .unwrap();
    let files = f
        .capture
        .capture(CaptureRequest::new(
            normalize_files(&[r"D:\x\a.txt"]).unwrap(),
            CaptureOrigin::Drop,
        ))
        .await
        .unwrap();
    let text = f
        .capture
        .capture(CaptureRequest::new(
            normalize_text("留着").unwrap(),
            CaptureOrigin::Manual,
        ))
        .await
        .unwrap();
    let image_id = image.items[0].id();
    let file_id = files.items[0].id();
    let kept_id = text.items[0].id();
    assert_eq!(f.files.stored_paths().len(), 1);

    // 没删除过的 Item 不能被永久删除，哪怕传了它的 ID。
    assert_eq!(f.trash.purge(&[image_id, kept_id]).await.unwrap(), 0);
    assert_eq!(f.uow.committed_items().len(), 3);

    f.trash.delete(&[image_id, file_id]).await.unwrap();
    f.events.clear();
    assert_eq!(
        f.trash.purge(&[image_id, file_id, kept_id]).await.unwrap(),
        2
    );

    let remaining: Vec<ItemId> = f.uow.committed_items().iter().map(|i| i.id()).collect();
    assert_eq!(remaining, [kept_id]);
    assert!(f.uow.committed_attachments().is_empty());
    // 自己保存的截图被清理；引用的用户文件从来不是 StarDeskBox 的，没有任何删除动作。
    assert!(f.files.stored_paths().is_empty());
    assert_eq!(f.events.events().len(), 2);
}

#[tokio::test]
async fn emptying_the_trash_removes_everything_in_it() {
    let f = fixture();
    let a = todo(&f, "a").await;
    let b = todo(&f, "b").await;
    let c = todo(&f, "c").await;
    f.trash.delete(&[a, b]).await.unwrap();
    assert_eq!(f.trash.empty().await.unwrap(), 2);
    let remaining: Vec<ItemId> = f.uow.committed_items().iter().map(|i| i.id()).collect();
    assert_eq!(remaining, [c]);
    assert_eq!(f.trash.empty().await.unwrap(), 0);
}

#[tokio::test]
async fn items_are_purged_automatically_after_the_retention_period() {
    let f = fixture();
    let old = todo(&f, "很久以前删的").await;
    let recent = todo(&f, "刚删的").await;
    f.trash.delete(&[old]).await.unwrap();
    f.clock.advance(Duration::days(TRASH_RETENTION_DAYS - 1));
    f.trash.delete(&[recent]).await.unwrap();

    // 29 天：都还在。
    assert_eq!(f.trash.purge_expired().await.unwrap(), 0);
    // 31 天：最早删的那条超期被清除，刚删的还在。
    f.clock.advance(Duration::days(2));
    assert_eq!(f.trash.purge_expired().await.unwrap(), 1);
    let ids: Vec<ItemId> = f
        .trash
        .list()
        .await
        .unwrap()
        .iter()
        .map(|e| e.item.id())
        .collect();
    assert_eq!(ids, [recent]);
    assert!(f.items.get_item(old).await.is_err());
}

#[tokio::test]
async fn a_failed_purge_commit_keeps_records_and_files() {
    let f = fixture();
    let image = f
        .capture
        .capture(CaptureRequest::new(
            image_input(PNG.to_vec()).unwrap(),
            CaptureOrigin::Paste,
        ))
        .await
        .unwrap();
    let id = image.items[0].id();
    f.trash.delete(&[id]).await.unwrap();

    f.uow.fail_next_commit();
    assert!(f.trash.purge(&[id]).await.is_err());
    assert_eq!(
        f.files.stored_paths().len(),
        1,
        "提交失败时不能先把文件删掉"
    );
    assert_eq!(f.trash.list().await.unwrap().len(), 1);
    // 一条普通 Item 也不受影响。
    let plain = f
        .items
        .create_item(NewItem::new(ItemType::Note, "n"))
        .await
        .unwrap();
    assert_eq!(
        f.items.get_item(plain.id()).await.unwrap().title().as_str(),
        "n"
    );
}
