//! GitHub Issue / PR（实施计划 6.5）：URL 解析、公开 API 取标题、限流时退回页面标题、全部失败时只留编号。

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, missing_docs)]

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use chrono::NaiveDate;
use serde_json::Value;
use stardeskbox_application::ports::http::{
    HostPolicy, HttpError, HttpPort, HttpRequest, HttpResponse,
};
use stardeskbox_application::workflow::{RunMode, WorkflowEngine, WorkflowRunResult};
use stardeskbox_capture::normalize_text;
use stardeskbox_workflow::{WorkflowEngineAdapter, builtin::builtin_workflows};

const CASES: &str = include_str!("../../../fixtures/github/cases.json");

/// 按主机分流的假网络：`api.github.com` 与 `github.com` 各有各的回复；记录请求。
struct GithubHttp {
    /// API 的回复。
    api: Result<HttpResponse, HttpError>,
    /// 页面的回复。
    page: Result<HttpResponse, HttpError>,
    /// 收到的请求地址。
    seen: Mutex<Vec<String>>,
}

#[async_trait]
impl HttpPort for GithubHttp {
    async fn get(
        &self,
        request: &HttpRequest,
        policy: &HostPolicy,
    ) -> Result<HttpResponse, HttpError> {
        let url = policy.check(&request.url)?;
        self.seen.lock().unwrap().push(request.url.clone());
        if url.host_str() == Some("api.github.com") {
            self.api.clone()
        } else {
            self.page.clone()
        }
    }
}

fn ok(content_type: &str, body: &str) -> Result<HttpResponse, HttpError> {
    status(200, content_type, body)
}

fn status(code: u16, content_type: &str, body: &str) -> Result<HttpResponse, HttpError> {
    Ok(HttpResponse {
        status: code,
        final_url: "https://github.com/x".into(),
        content_type: Some(content_type.into()),
        body: body.as_bytes().to_vec(),
        truncated: false,
    })
}

fn cases() -> Value {
    serde_json::from_str(CASES).unwrap()
}

fn api(kind: &str) -> Result<HttpResponse, HttpError> {
    ok("application/json", cases()["api"][kind].as_str().unwrap())
}

fn page(kind: &str) -> Result<HttpResponse, HttpError> {
    ok(
        "text/html; charset=utf-8",
        cases()["pages"][kind].as_str().unwrap(),
    )
}

async fn run(
    url: &str,
    mode: RunMode,
    api: Result<HttpResponse, HttpError>,
    page: Result<HttpResponse, HttpError>,
) -> (WorkflowRunResult, Arc<GithubHttp>) {
    let http = Arc::new(GithubHttp {
        api,
        page,
        seen: Mutex::new(Vec::new()),
    });
    let engine = WorkflowEngineAdapter::with_http(http.clone());
    let input = normalize_text(url).unwrap();
    let result = engine
        .resolve_and_run(
            &builtin_workflows(),
            &input,
            None,
            NaiveDate::from_ymd_opt(2026, 10, 11).unwrap(),
            mode,
        )
        .await
        .unwrap();
    (result, http)
}

#[tokio::test]
async fn issue_pull_and_deep_links_are_parsed_and_unrelated_urls_are_not() {
    for case in cases()["urls"].as_array().unwrap() {
        let url = case["url"].as_str().unwrap();
        let (result, _) = run(
            url,
            RunMode::Instant,
            Err(HttpError::Timeout),
            Err(HttpError::Timeout),
        )
        .await;
        match case["workflow"].as_str() {
            Some(workflow) => {
                assert_eq!(result.workflow_id.as_str(), workflow, "{url}");
                let items = result.result.unwrap();
                assert_eq!(items[0].title, case["title"].as_str().unwrap(), "{url}");
            }
            None => assert!(
                !result.workflow_id.as_str().starts_with("builtin.github"),
                "{url} 不应被 GitHub 规则命中"
            ),
        }
    }
}

#[tokio::test]
async fn the_public_api_supplies_the_title_and_state() {
    let (result, http) = run(
        "https://github.com/acme/web/pull/182",
        RunMode::Full,
        api("pull"),
        page("pull"),
    )
    .await;
    let items = result.result.unwrap();
    assert_eq!(items[0].title, "Review PR #182: 修复登录失败");
    assert_eq!(
        items[0].source_label.as_deref(),
        Some("GitHub · acme/web#182")
    );
    assert_eq!(items[0].metadata["state"], "open");
    assert_eq!(items[0].metadata["kind"], "pull");
    assert!(
        http.seen
            .lock()
            .unwrap()
            .contains(&"https://api.github.com/repos/acme/web/issues/182".to_owned())
    );

    let (result, _) = run(
        "https://github.com/acme/web/issues/123",
        RunMode::Full,
        api("issue"),
        page("issue"),
    )
    .await;
    let items = result.result.unwrap();
    assert_eq!(items[0].title, "[web#123] Crash on startup");
    assert_eq!(items[0].metadata["state"], "closed");
}

#[tokio::test]
async fn rate_limiting_falls_back_to_the_page_title_and_still_succeeds() {
    for limited in [
        status(
            403,
            "application/json",
            "{\"message\":\"API rate limit exceeded\"}",
        ),
        status(429, "application/json", "{}"),
        Err(HttpError::Timeout),
    ] {
        let (result, _) = run(
            "https://github.com/acme/web/pull/182",
            RunMode::Full,
            limited,
            page("pull"),
        )
        .await;
        let items = result.result.unwrap();
        assert_eq!(items[0].title, "Review PR #182: 修复登录失败");
        assert_eq!(items[0].metadata["state"], "");
    }
    let (result, _) = run(
        "https://github.com/acme/web/issues/123",
        RunMode::Full,
        status(403, "application/json", "{}"),
        page("issue"),
    )
    .await;
    assert_eq!(
        result.result.unwrap()[0].title,
        "[web#123] Crash on startup"
    );
}

#[tokio::test]
async fn when_everything_fails_only_the_number_remains() {
    for (api, page) in [
        (
            Err(HttpError::Network("x".into())),
            Err(HttpError::Network("x".into())),
        ),
        (status(403, "application/json", "{}"), page("login")),
        (ok("text/html", "<html>not json</html>"), page("login")),
    ] {
        let (result, _) = run(
            "https://github.com/acme/web/pull/182",
            RunMode::Full,
            api,
            page,
        )
        .await;
        assert_eq!(result.result.unwrap()[0].title, "Review PR #182");
    }
}
