//! 捕获经由 Workflow 的端到端（内存 Fake）：内置 Workflow 复刻默认规则，失败时捕获不丢失（实施计划 5.5）。

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::Arc;

use chrono::{TimeZone, Utc};
use nivlo_application::capture::CaptureService;
use nivlo_application::testing::{FakeAttachmentFiles, FakeUnitOfWork, RecordingPublisher};
use nivlo_application::workflow::{RunStatus, WorkflowService};
use nivlo_capture::{image_input, normalize_files, normalize_text};
use nivlo_common::clock::FakeClock;
use nivlo_domain::capture::{CaptureOrigin, CaptureRequest};
use nivlo_domain::item::ItemType;
use nivlo_workflow::{WorkflowEngineAdapter, builtin::builtin_workflows};

const PNG: &[u8] = &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3, 4];

struct Fixture {
    capture: CaptureService,
    workflows: WorkflowService,
    uow: FakeUnitOfWork,
}

async fn fixture() -> Fixture {
    let uow = FakeUnitOfWork::new();
    let clock = Arc::new(FakeClock::at_utc(
        Utc.with_ymd_and_hms(2026, 10, 10, 8, 0, 0).unwrap(),
    ));
    let engine = Arc::new(WorkflowEngineAdapter::standard());
    let workflows = WorkflowService::new(Arc::new(uow.clone()), clock.clone(), engine.clone());
    workflows.sync_builtin(builtin_workflows()).await.unwrap();
    let capture = CaptureService::new(
        Arc::new(uow.clone()),
        clock,
        Arc::new(RecordingPublisher::new()),
        Arc::new(FakeAttachmentFiles::new()),
    )
    .with_workflows(engine);
    Fixture {
        capture,
        workflows,
        uow,
    }
}

fn request(input: nivlo_domain::capture::CaptureInput) -> CaptureRequest {
    CaptureRequest::new(input, CaptureOrigin::Drop)
}

#[tokio::test]
async fn builtin_workflows_reproduce_the_default_capture_rules() {
    let f = fixture().await;

    let text = f
        .capture
        .capture(request(normalize_text("买牛奶").unwrap()))
        .await
        .unwrap();
    assert_eq!(text.items[0].item_type(), ItemType::Todo);
    assert_eq!(text.items[0].title().as_str(), "买牛奶");
    assert!(text.items[0].in_inbox());

    let url = f
        .capture
        .capture(request(
            normalize_text("https://www.example.com/docs/page?x=1").unwrap(),
        ))
        .await
        .unwrap();
    assert_eq!(url.items[0].item_type(), ItemType::Note);
    assert_eq!(url.items[0].title().as_str(), "example.com/docs/page");

    let files = f
        .capture
        .capture(request(
            normalize_files(&[r"D:\a\1.txt", r"D:\a\2.txt"]).unwrap(),
        ))
        .await
        .unwrap();
    assert_eq!(files.items.len(), 2);
    assert_eq!(f.uow.committed_attachments().len(), 2);

    let image = f
        .capture
        .capture(request(image_input(PNG.to_vec()).unwrap()))
        .await
        .unwrap();
    assert_eq!(image.items[0].title().as_str(), "图片");
    assert_eq!(f.uow.committed_attachments().len(), 3);

    // 每次捕获都留下一条成功的运行记录。
    let runs = f.workflows.recent_runs(10).await.unwrap();
    assert_eq!(runs.len(), 4);
    assert!(runs.iter().all(|r| r.status == RunStatus::Succeeded));
}

#[tokio::test]
async fn a_duplicated_workflow_with_higher_priority_wins_and_tags_the_item() {
    let f = fixture().await;
    let builtin = f
        .workflows
        .list()
        .await
        .unwrap()
        .into_iter()
        .find(|s| s.workflow.id.as_str() == "builtin.generic-url")
        .unwrap();
    let mut copy = f.workflows.duplicate(&builtin.workflow.id).await.unwrap();
    copy.steps = serde_json::from_str(
        r##"[{"type":"createItem","itemType":"todo","title":"读：{{ input.title }}","content":"{{ input.url }}","tags":["read"]}]"##,
    )
    .unwrap();
    f.workflows.save(copy).await.unwrap();

    let result = f
        .capture
        .capture(request(normalize_text("https://example.com/a").unwrap()))
        .await
        .unwrap();

    assert_eq!(result.items[0].item_type(), ItemType::Todo);
    assert!(result.items[0].title().as_str().starts_with("读："));
    let runs = f.workflows.recent_runs(1).await.unwrap();
    assert!(runs[0].workflow_id.starts_with("user."));
}

#[tokio::test]
async fn a_failing_workflow_never_loses_the_capture() {
    let f = fixture().await;
    let mut broken = f
        .workflows
        .get(&nivlo_domain::workflow::WorkflowId::new("builtin.generic-text").unwrap())
        .await
        .unwrap()
        .workflow;
    broken.id = nivlo_domain::workflow::WorkflowId::new("user.broken").unwrap();
    broken.priority = 100;
    broken.source = nivlo_domain::workflow::WorkflowSource::User;
    broken.steps = serde_json::from_str(
        r#"[{"type":"jsonPath","from":"input.text","path":"$.a","into":"x"},{"type":"createItem","itemType":"todo","title":"x"}]"#,
    )
    .unwrap();
    f.workflows.save(broken).await.unwrap();

    let result = f
        .capture
        .capture(request(normalize_text("not json at all").unwrap()))
        .await
        .unwrap();

    // 默认规则兜底，原始输入照常保存。
    assert_eq!(result.items[0].title().as_str(), "not json at all");
    let sources = f.uow.committed_sources();
    let metadata = sources[0].metadata_json.as_deref().unwrap();
    assert!(metadata.contains("workflowError"));
    assert!(metadata.contains("user.broken"));
    let runs = f.workflows.recent_runs(1).await.unwrap();
    assert_eq!(runs[0].status, RunStatus::Failed);
}
