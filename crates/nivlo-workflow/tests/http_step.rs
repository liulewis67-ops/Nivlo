//! `http` Step 的测试：权限、可选降级、状态码分类、与校验的配合（实施计划 6.1）。

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, missing_docs)]

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use chrono::NaiveDate;
use nivlo_application::ports::http::{HostPolicy, HttpError, HttpPort, HttpRequest, HttpResponse};
use nivlo_application::workflow::{FailureKind, RunMode, WorkflowEngine};
use nivlo_capture::normalize_text;
use nivlo_workflow::WorkflowEngineAdapter;

/// 脚本化的网络：按预设返回；和真实适配器一样先过策略。
struct ScriptedHttp {
    /// 下一次的结果。
    reply: Mutex<Result<HttpResponse, HttpError>>,
    /// 收到的请求地址。
    seen: Mutex<Vec<String>>,
}

impl ScriptedHttp {
    fn new(reply: Result<HttpResponse, HttpError>) -> Arc<Self> {
        Arc::new(Self {
            reply: Mutex::new(reply),
            seen: Mutex::new(Vec::new()),
        })
    }
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

fn page(status: u16, body: &str) -> Result<HttpResponse, HttpError> {
    Ok(HttpResponse {
        status,
        final_url: "https://example.com/final".into(),
        content_type: Some("text/html; charset=utf-8".into()),
        body: body.as_bytes().to_vec(),
        truncated: false,
    })
}

fn workflow(permissions: &str, optional: bool) -> String {
    format!(
        r##"{{"schemaVersion":1,"id":"user.fetch","name":"抓取","priority":5,
        "matcher":{{"field":"input.type","op":"equals","value":"url"}},
        {permissions}
        "steps":[
          {{"type":"http","url":"{{{{ input.url }}}}","into":"page","optional":{optional}}},
          {{"type":"createItem","itemType":"note","title":"{{{{ input.title }}}}","content":"{{{{ vars.page }}}}"}}
        ]}}"##
    )
}

const ALLOWED: &str = r#""permissions":{"network":true,"hosts":["example.com"]},"#;

fn today() -> NaiveDate {
    NaiveDate::from_ymd_opt(2026, 10, 11).unwrap()
}

async fn run(
    port: Arc<ScriptedHttp>,
    definition: &str,
    text: &str,
) -> nivlo_application::workflow::WorkflowRunResult {
    let engine = WorkflowEngineAdapter::with_http(port);
    let workflow = engine.parse(definition).unwrap();
    let input = normalize_text(text).unwrap();
    engine
        .run(&workflow, &input, None, today(), RunMode::Full)
        .await
}

#[tokio::test]
async fn the_body_is_available_to_later_steps() {
    let port = ScriptedHttp::new(page(200, "<html>你好</html>"));
    let result = run(
        port.clone(),
        &workflow(ALLOWED, false),
        "https://example.com/a",
    )
    .await;
    let items = result.result.unwrap();
    assert_eq!(items[0].content.as_deref(), Some("<html>你好</html>"));
    assert_eq!(
        port.seen.lock().unwrap().as_slice(),
        ["https://example.com/a"]
    );
}

#[tokio::test]
async fn a_host_that_was_not_declared_is_denied_even_when_optional() {
    let port = ScriptedHttp::new(page(200, "x"));
    let result = run(port.clone(), &workflow(ALLOWED, true), "https://evil.org/a").await;
    let failure = result.result.unwrap_err();
    assert_eq!(failure.kind, FailureKind::PermissionDenied);
    assert!(port.seen.lock().unwrap().is_empty(), "不应发出请求");
}

#[tokio::test]
async fn optional_steps_degrade_when_offline_or_on_error_statuses() {
    for reply in [
        Err(HttpError::Network("无法连接".into())),
        Err(HttpError::Timeout),
        page(500, "oops"),
        page(404, "nope"),
    ] {
        let port = ScriptedHttp::new(reply);
        let result = run(port, &workflow(ALLOWED, true), "https://example.com/a").await;
        // 照样创建了 Item，只是没有页面内容（vars.page 缺失会让内容模板失败时才算失败——
        // 所以这里的 createItem 用了 vars.page：缺失即失败，说明可选只是「Step 本身不报错」）。
        let failure = result.result.unwrap_err();
        assert_eq!(failure.kind, FailureKind::InvalidInput);
        assert_eq!(failure.failed_step, Some(1));
        assert_eq!(result.steps[0].outcome.as_str(), "ok");
    }
}

#[tokio::test]
async fn required_steps_fail_with_a_classified_error() {
    let cases = [
        (page(403, ""), FailureKind::UserActionRequired),
        (page(429, ""), FailureKind::Retryable),
        (page(503, ""), FailureKind::Retryable),
        (page(404, ""), FailureKind::Fatal),
        (Err(HttpError::Timeout), FailureKind::Timeout),
        (Err(HttpError::Network("x".into())), FailureKind::Retryable),
    ];
    for (reply, kind) in cases {
        let result = run(
            ScriptedHttp::new(reply),
            &workflow(ALLOWED, false),
            "https://example.com/a",
        )
        .await;
        let failure = result.result.unwrap_err();
        assert_eq!(failure.kind, kind);
        assert_eq!(failure.failed_step, Some(0));
    }
}

#[test]
fn a_workflow_using_http_must_declare_network_and_hosts() {
    let engine = WorkflowEngineAdapter::standard();
    for permissions in [
        "",
        r#""permissions":{"network":true},"#,
        r#""permissions":{"hosts":["example.com"]},"#,
    ] {
        let issues = engine.parse(&workflow(permissions, false)).unwrap_err();
        assert!(
            issues.iter().any(|i| i.message.contains("permissions")),
            "{permissions}: {issues:?}"
        );
    }
    assert!(engine.parse(&workflow(ALLOWED, false)).is_ok());
}

#[tokio::test]
async fn the_standard_engine_without_a_network_port_refuses_http_steps() {
    let engine = WorkflowEngineAdapter::standard();
    let workflow = engine.parse(&workflow(ALLOWED, false)).unwrap();
    let input = normalize_text("https://example.com/a").unwrap();
    let result = engine
        .run(&workflow, &input, None, today(), RunMode::Full)
        .await;
    assert!(result.result.is_err());
}
