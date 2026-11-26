//! 内置 Jira Workflow 与 Jira 集成的端到端测试（实施计划 9.3）：
//! API → 页面元数据 → 仅工单号的完整降级链，以及凭据失效时的重新连接提示。

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, missing_docs)]

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use chrono::NaiveDate;
use serde_json::Value;
use stardeskbox_application::ports::http::{
    HostPolicy, HttpError, HttpPort, HttpRequest, HttpResponse,
};
use stardeskbox_application::ports::integration::IntegrationRegistry;
use stardeskbox_application::workflow::{
    FailureAction, RunMode, WorkflowEngine, WorkflowRunResult,
};
use stardeskbox_capture::normalize_text;
use stardeskbox_integrations::JiraIntegration;
use stardeskbox_platform::credential::{CredentialKey, CredentialPort, MemoryCredentials, Secret};
use stardeskbox_workflow::WorkflowEngineAdapter;
use stardeskbox_workflow::builtin::builtin_workflows;

const CASES: &str = include_str!("../../../fixtures/jira/cases.json");
const API_OK: &str = include_str!("../../../fixtures/jira/api/issue-cloud.json");
const URL: &str = "https://acme.atlassian.net/browse/AI-128";

/// 按地址分流的假网络：REST API 与页面各有预设响应。
struct RoutedHttp {
    api: Mutex<Result<HttpResponse, HttpError>>,
    page: Mutex<Result<HttpResponse, HttpError>>,
    requests: Mutex<Vec<String>>,
}

#[async_trait]
impl HttpPort for RoutedHttp {
    async fn get(
        &self,
        request: &HttpRequest,
        policy: &HostPolicy,
    ) -> Result<HttpResponse, HttpError> {
        policy.check(&request.url)?;
        self.requests.lock().unwrap().push(request.url.clone());
        if request.url.contains("/rest/api/2/") {
            self.api.lock().unwrap().clone()
        } else {
            self.page.lock().unwrap().clone()
        }
    }
}

fn response(status: u16, content_type: &str, body: &str) -> Result<HttpResponse, HttpError> {
    Ok(HttpResponse {
        status,
        final_url: URL.into(),
        content_type: Some(content_type.into()),
        body: body.as_bytes().to_vec(),
        truncated: false,
    })
}

fn issue_page() -> Result<HttpResponse, HttpError> {
    let cases: Value = serde_json::from_str(CASES).unwrap();
    let page = &cases["pages"]["issue"];
    response(
        200,
        page["contentType"].as_str().unwrap(),
        page["body"].as_str().unwrap(),
    )
}

async fn run(
    connected: bool,
    api: Result<HttpResponse, HttpError>,
    page: Result<HttpResponse, HttpError>,
) -> (WorkflowRunResult, Arc<RoutedHttp>) {
    let credentials = Arc::new(MemoryCredentials::new());
    if connected {
        credentials
            .set(
                &CredentialKey::new("jira", "acme.atlassian.net").unwrap(),
                &Secret::new("me@acme.com:token"),
            )
            .unwrap();
    }
    let http = Arc::new(RoutedHttp {
        api: Mutex::new(api),
        page: Mutex::new(page),
        requests: Mutex::new(Vec::new()),
    });
    let mut registry = IntegrationRegistry::new();
    registry.register(Arc::new(JiraIntegration::new(credentials)));
    let engine = WorkflowEngineAdapter::with_http(http.clone())
        .with_integrations(Arc::new(registry), http.clone());
    let input = normalize_text(URL).unwrap();
    let result = engine
        .resolve_and_run(
            &builtin_workflows(),
            &input,
            None,
            NaiveDate::from_ymd_opt(2026, 10, 12).unwrap(),
            RunMode::Full,
        )
        .await
        .unwrap();
    (result, http)
}

#[tokio::test]
async fn the_api_supplies_the_full_set_of_fields() {
    let (result, http) = run(
        true,
        response(200, "application/json", API_OK),
        issue_page(),
    )
    .await;
    assert!(result.notice.is_none());
    let items = result.result.unwrap();
    assert_eq!(items[0].title, "[AI-128] 登录页在 Safari 上无法提交表单");
    assert!(items[0].content.as_deref().unwrap().contains("h2. 现象"));
    assert!(items[0].content.as_deref().unwrap().contains(URL));
    let meta = &items[0].metadata;
    assert_eq!(meta["integration"], "jira");
    assert_eq!(meta["status"], "In Progress");
    assert_eq!(meta["priority"], "High");
    assert_eq!(meta["assignee"], "林悦");
    assert_eq!(meta["project"], "AI");
    assert_eq!(meta["labels"], "web,regression");
    assert_eq!(meta["startDate"], "2026-10-14");
    assert_eq!(meta["dueDate"], "2026-10-20");
    // 认证头没有进入任何记录：请求地址里也没有凭据。
    assert!(
        http.requests
            .lock()
            .unwrap()
            .iter()
            .all(|u| !u.contains("token"))
    );
}

#[tokio::test]
async fn an_expired_credential_falls_back_to_the_page_title_and_asks_to_reconnect() {
    let (result, _) = run(true, response(401, "application/json", "{}"), issue_page()).await;
    let notice = result.notice.clone().expect("应当提示重新连接");
    assert!(notice.message.contains("重新连接"), "{}", notice.message);
    assert_eq!(
        notice.action,
        Some(FailureAction::OpenIntegrationSettings {
            integration: "jira".to_owned()
        })
    );
    // 降级为页面标题，待办照常创建。
    assert_eq!(result.result.unwrap()[0].title, "[AI-128] 修复登录失败");
}

#[tokio::test]
async fn without_a_connection_the_old_page_path_is_used_quietly() {
    let (result, http) = run(
        false,
        response(200, "application/json", API_OK),
        issue_page(),
    )
    .await;
    assert!(result.notice.is_none(), "从没连接过不打扰用户");
    assert_eq!(result.result.unwrap()[0].title, "[AI-128] 修复登录失败");
    // 没有凭据就不发 API 请求。
    assert!(
        http.requests
            .lock()
            .unwrap()
            .iter()
            .all(|u| !u.contains("/rest/api/"))
    );
}

#[tokio::test]
async fn when_everything_fails_only_the_key_remains() {
    let (result, _) = run(
        true,
        Err(HttpError::Network("无法连接".into())),
        Err(HttpError::Timeout),
    )
    .await;
    assert_eq!(result.result.unwrap()[0].title, "[AI-128]");
}
