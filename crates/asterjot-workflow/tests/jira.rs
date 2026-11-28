//! Jira 工单（无 API 的降级路径，实施计划 6.4）：识别 Cloud 与自托管的 URL，
//! 页面读不到（需要登录 / 离线）时仍然生成 `[KEY]` 待办。

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, missing_docs)]

use std::sync::{Arc, Mutex};

use asterjot_application::ports::http::{
    HostPolicy, HttpError, HttpPort, HttpRequest, HttpResponse,
};
use asterjot_application::workflow::{RunMode, WorkflowEngine};
use asterjot_capture::normalize_text;
use asterjot_workflow::{WorkflowEngineAdapter, builtin::builtin_workflows};
use async_trait::async_trait;
use chrono::NaiveDate;
use serde_json::Value;

const CASES: &str = include_str!("../../../fixtures/jira/cases.json");

struct PageHttp(Mutex<Result<HttpResponse, HttpError>>);

#[async_trait]
impl HttpPort for PageHttp {
    async fn get(
        &self,
        request: &HttpRequest,
        policy: &HostPolicy,
    ) -> Result<HttpResponse, HttpError> {
        policy.check(&request.url)?;
        self.0.lock().unwrap().clone()
    }
}

fn today() -> NaiveDate {
    NaiveDate::from_ymd_opt(2026, 10, 11).unwrap()
}

fn page(name: &str) -> Result<HttpResponse, HttpError> {
    let cases: Value = serde_json::from_str(CASES).unwrap();
    let page = &cases["pages"][name];
    Ok(HttpResponse {
        status: 200,
        final_url: "https://acme.atlassian.net/browse/AI-128".into(),
        content_type: Some(page["contentType"].as_str().unwrap().into()),
        body: page["body"].as_str().unwrap().as_bytes().to_vec(),
        truncated: false,
    })
}

async fn run(
    url: &str,
    mode: RunMode,
    reply: Result<HttpResponse, HttpError>,
) -> Option<asterjot_application::workflow::WorkflowRunResult> {
    let engine = WorkflowEngineAdapter::with_http(Arc::new(PageHttp(Mutex::new(reply))));
    let input = normalize_text(url).unwrap();
    engine
        .resolve_and_run(&builtin_workflows(), &input, None, today(), mode)
        .await
}

#[tokio::test]
async fn cloud_and_self_hosted_urls_are_recognised_and_others_are_not() {
    let cases: Value = serde_json::from_str(CASES).unwrap();
    for case in cases["urls"].as_array().unwrap() {
        let url = case["url"].as_str().unwrap();
        let result = run(url, RunMode::Instant, Err(HttpError::Timeout))
            .await
            .unwrap();
        match case["key"].as_str() {
            Some(key) => {
                assert_eq!(result.workflow_id.as_str(), "builtin.jira-issue", "{url}");
                let items = result.result.unwrap();
                assert_eq!(items[0].title, format!("[{key}]"), "{url}");
                assert_eq!(
                    items[0].source_label.as_deref(),
                    Some(format!("Jira · {key}").as_str())
                );
            }
            None => assert_ne!(result.workflow_id.as_str(), "builtin.jira-issue", "{url}"),
        }
    }
}

#[tokio::test]
async fn the_page_title_completes_the_todo_when_it_can_be_read() {
    let cases = [
        ("issue", "[AI-128] 修复登录失败"),
        ("issue-without-suffix", "[AI-128] 导出报表 [beta]"),
    ];
    for (name, expected) in cases {
        let result = run(
            "https://acme.atlassian.net/browse/AI-128",
            RunMode::Full,
            page(name),
        )
        .await
        .unwrap();
        let items = result.result.unwrap();
        assert_eq!(items[0].title, expected, "{name}");
        assert_eq!(items[0].item_type, asterjot_domain::item::ItemType::Todo);
        assert_eq!(items[0].metadata["integration"], "jira");
        assert_eq!(items[0].metadata["issueKey"], "AI-128");
        assert_eq!(items[0].metadata["host"], "acme.atlassian.net");
    }
}

#[tokio::test]
async fn login_pages_and_network_failures_still_produce_the_key_only_todo() {
    for reply in [
        page("login"),
        Err(HttpError::Network("无法连接".into())),
        Err(HttpError::Timeout),
    ] {
        let result = run(
            "https://acme.atlassian.net/browse/AI-128",
            RunMode::Full,
            reply,
        )
        .await
        .unwrap();
        let items = result.result.unwrap();
        assert_eq!(items[0].title, "[AI-128]");
    }
}
