//! 网页捕获的两阶段（实施计划 6.3）：先即时创建，再在后台用页面元数据补全；离线时不受影响。

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, missing_docs)]

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use chrono::{Duration, TimeZone, Utc};
use nivlo_application::capture::{CaptureService, EnrichmentJob};
use nivlo_application::ports::UnitOfWork;
use nivlo_application::ports::http::{HostPolicy, HttpError, HttpPort, HttpRequest, HttpResponse};
use nivlo_application::testing::{FakeAttachmentFiles, FakeUnitOfWork, RecordingPublisher};
use nivlo_application::workflow::{RunStatus, WorkflowService};
use nivlo_capture::normalize_text;
use nivlo_common::clock::{Clock, FakeClock};
use nivlo_domain::capture::{CaptureOrigin, CaptureRequest};
use nivlo_domain::event::DomainEvent;
use nivlo_workflow::{WorkflowEngineAdapter, builtin::builtin_workflows};
use tokio::sync::mpsc::{UnboundedReceiver, unbounded_channel};

/// 脚本化的网络。
struct ScriptedHttp {
    /// 下一次的结果。
    reply: Mutex<Result<HttpResponse, HttpError>>,
    /// 收到的请求地址。
    seen: Mutex<Vec<String>>,
}

#[async_trait]
impl HttpPort for ScriptedHttp {
    async fn get(
        &self,
        request: &HttpRequest,
        policy: &HostPolicy,
    ) -> Result<HttpResponse, HttpError> {
        policy.check(&request.url)?;
        self.seen.lock().unwrap().push(request.url.clone());
        self.reply.lock().unwrap().clone()
    }
}

fn html(body: &str) -> Result<HttpResponse, HttpError> {
    Ok(HttpResponse {
        status: 200,
        final_url: "https://example.com/post".into(),
        content_type: Some("text/html; charset=utf-8".into()),
        body: body.as_bytes().to_vec(),
        truncated: false,
    })
}

struct Fixture {
    capture: CaptureService,
    workflows: WorkflowService,
    uow: FakeUnitOfWork,
    clock: FakeClock,
    http: Arc<ScriptedHttp>,
    events: Arc<RecordingPublisher>,
    jobs: UnboundedReceiver<EnrichmentJob>,
}

async fn fixture(reply: Result<HttpResponse, HttpError>) -> Fixture {
    let uow = FakeUnitOfWork::new();
    let clock = FakeClock::at_utc(Utc.with_ymd_and_hms(2026, 10, 11, 8, 0, 0).unwrap());
    let http = Arc::new(ScriptedHttp {
        reply: Mutex::new(reply),
        seen: Mutex::new(Vec::new()),
    });
    let engine = Arc::new(WorkflowEngineAdapter::with_http(http.clone()));
    let workflows = WorkflowService::new(
        Arc::new(uow.clone()),
        Arc::new(clock.clone()),
        engine.clone(),
    );
    workflows.sync_builtin(builtin_workflows()).await.unwrap();
    let events = Arc::new(RecordingPublisher::new());
    let (queue, jobs) = unbounded_channel();
    let capture = CaptureService::new(
        Arc::new(uow.clone()),
        Arc::new(clock.clone()),
        events.clone(),
        Arc::new(FakeAttachmentFiles::new()),
    )
    .with_workflows(engine)
    .with_enrichment(queue);
    Fixture {
        capture,
        workflows,
        uow,
        clock,
        http,
        events,
        jobs,
    }
}

fn url_request(url: &str) -> CaptureRequest {
    CaptureRequest::new(normalize_text(url).unwrap(), CaptureOrigin::Drop)
}

const PAGE: &str = r#"<html><head><title>备用标题</title>
    <meta property="og:title" content="真正的页面标题">
    <meta name="description" content="这是一段摘要。">
    </head></html>"#;

#[tokio::test]
async fn capture_is_instant_then_enrichment_fills_in_title_and_summary() {
    let mut f = fixture(html(PAGE)).await;
    let result = f
        .capture
        .capture(url_request("https://example.com/post"))
        .await
        .unwrap();

    // 即时阶段：没有联网，标题是「域名/路径」。
    let item = &result.items[0];
    assert_eq!(item.title().as_str(), "example.com/post");
    assert!(f.http.seen.lock().unwrap().is_empty(), "捕获不能等网络");
    let job = f.jobs.try_recv().expect("应当排了一个后台补全");

    // 后台阶段。
    f.clock.advance(Duration::seconds(3));
    f.events.clear();
    assert_eq!(f.capture.enrich(job).await, 1);
    assert_eq!(
        f.http.seen.lock().unwrap().as_slice(),
        ["https://example.com/post"]
    );
    let stored = &f.uow.committed_items()[0];
    assert_eq!(stored.title().as_str(), "真正的页面标题");
    assert_eq!(
        stored.content(),
        Some("https://example.com/post\n\n这是一段摘要。")
    );
    assert!(matches!(
        f.events.events().as_slice(),
        [DomainEvent::ItemUpdated { .. }]
    ));
    // 两次运行都留下了记录。
    let runs = f.workflows.recent_runs(10).await.unwrap();
    assert_eq!(runs.len(), 2);
    assert!(runs.iter().all(|r| r.status == RunStatus::Succeeded));
    assert!(runs.iter().all(|r| r.workflow_id == "builtin.web-page"));
}

#[tokio::test]
async fn offline_leaves_the_instant_note_untouched() {
    let mut f = fixture(Err(HttpError::Network("无法连接".into()))).await;
    let result = f
        .capture
        .capture(url_request("https://example.com/post"))
        .await
        .unwrap();
    let job = f.jobs.try_recv().unwrap();
    f.clock.advance(Duration::seconds(3));

    // 可选的 http 失败 → 元数据为空 → 标题回退到 input.title，与即时版本一致：不需要更新。
    assert_eq!(f.capture.enrich(job).await, 0);
    let stored = &f.uow.committed_items()[0];
    assert_eq!(stored.title().as_str(), "example.com/post");
    assert_eq!(stored.content(), Some("https://example.com/post"));
    assert_eq!(result.items.len(), 1);
}

#[tokio::test]
async fn items_the_user_already_changed_are_not_overwritten() {
    let mut f = fixture(html(PAGE)).await;
    let result = f
        .capture
        .capture(url_request("https://example.com/post"))
        .await
        .unwrap();
    let job = f.jobs.try_recv().unwrap();

    // 用户在补全完成之前改了标题。
    f.clock.advance(Duration::seconds(1));
    {
        let mut tx = f.uow.begin().await.unwrap();
        let mut item = tx.items().get(result.items[0].id()).await.unwrap().unwrap();
        item.rename("我自己起的名字", f.clock.now_utc()).unwrap();
        tx.items().update(&item).await.unwrap();
        tx.commit().await.unwrap();
    }
    f.clock.advance(Duration::seconds(3));
    assert_eq!(f.capture.enrich(job).await, 0);
    assert_eq!(
        f.uow.committed_items()[0].title().as_str(),
        "我自己起的名字"
    );
}

#[tokio::test]
async fn text_captures_never_queue_enrichment() {
    let mut f = fixture(html(PAGE)).await;
    f.capture
        .capture(CaptureRequest::new(
            normalize_text("买牛奶").unwrap(),
            CaptureOrigin::QuickAdd,
        ))
        .await
        .unwrap();
    assert!(f.jobs.try_recv().is_err());
}

#[tokio::test]
async fn gbk_encoded_pages_get_a_readable_title() {
    // “你好” 的 GBK 字节，页面里的 meta 声明 gbk，响应头没有 charset。
    let mut body = b"<html><head><meta charset=\"gbk\"><title>".to_vec();
    body.extend_from_slice(&[0xC4, 0xE3, 0xBA, 0xC3]);
    body.extend_from_slice(b"</title></head></html>");
    let reply = Ok(HttpResponse {
        status: 200,
        final_url: "https://example.cn/page".into(),
        content_type: Some("text/html".into()),
        body,
        truncated: false,
    });
    let mut f = fixture(reply).await;
    f.capture
        .capture(url_request("https://example.cn/page"))
        .await
        .unwrap();
    let job = f.jobs.try_recv().unwrap();
    f.clock.advance(Duration::seconds(2));
    assert_eq!(f.capture.enrich(job).await, 1);
    assert_eq!(f.uow.committed_items()[0].title().as_str(), "你好");
}

#[tokio::test]
async fn rerun_overwrites_on_request_and_refuses_sources_it_cannot_replay() {
    let f = fixture(html(PAGE)).await;
    let url = f
        .capture
        .capture(url_request("https://example.com/post"))
        .await
        .unwrap();
    f.clock.advance(Duration::seconds(2));
    // 用户改过标题也会被覆盖——这是明确的请求。
    assert!(f.capture.rerun(url.items[0].id()).await.unwrap());
    assert_eq!(
        f.uow.committed_items()[0].title().as_str(),
        "真正的页面标题"
    );
    f.clock.advance(Duration::seconds(2));
    assert!(
        !f.capture.rerun(url.items[0].id()).await.unwrap(),
        "没有变化"
    );

    let text = f
        .capture
        .capture(CaptureRequest::new(
            normalize_text("买牛奶").unwrap(),
            CaptureOrigin::QuickAdd,
        ))
        .await
        .unwrap();
    let error = f.capture.rerun(text.items[0].id()).await.unwrap_err();
    assert_eq!(error.code.as_str(), "WORKFLOW_RUN_FAILED");
}
