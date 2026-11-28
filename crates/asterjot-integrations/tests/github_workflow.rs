//! 内置 GitHub Workflow 与 GitHub 集成的端到端测试（实施计划 9.4）：
//! 配置 Token 后用认证 API，私有仓库可读；没有 Token 时仍走匿名路径。

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, missing_docs)]

use std::sync::{Arc, Mutex};

use asterjot_application::ports::http::{
    HostPolicy, HttpError, HttpPort, HttpRequest, HttpResponse,
};
use asterjot_application::ports::integration::IntegrationRegistry;
use asterjot_application::workflow::{RunMode, WorkflowEngine, WorkflowRunResult};
use asterjot_capture::normalize_text;
use asterjot_integrations::GithubIntegration;
use asterjot_platform::credential::{CredentialKey, CredentialPort, MemoryCredentials, Secret};
use asterjot_workflow::WorkflowEngineAdapter;
use asterjot_workflow::builtin::builtin_workflows;
use async_trait::async_trait;
use chrono::NaiveDate;

const ISSUE: &str = include_str!("../../../fixtures/github/api/issue.json");
const PULL: &str = include_str!("../../../fixtures/github/api/pull.json");

/// 模拟一个私有仓库：只有带 Bearer 的 API 请求才有内容，匿名请求（API 与页面）都是 404。
struct PrivateRepoHttp {
    body: String,
    requests: Mutex<Vec<(String, bool)>>,
}

#[async_trait]
impl HttpPort for PrivateRepoHttp {
    async fn get(
        &self,
        request: &HttpRequest,
        policy: &HostPolicy,
    ) -> Result<HttpResponse, HttpError> {
        policy.check(&request.url)?;
        let authed = request
            .headers
            .iter()
            .any(|(n, v)| n == "Authorization" && v.expose().starts_with("Bearer "));
        self.requests
            .lock()
            .unwrap()
            .push((request.url.clone(), authed));
        let (status, body) = if authed {
            (200, self.body.clone())
        } else {
            (404, "{\"message\":\"Not Found\"}".to_owned())
        };
        Ok(HttpResponse {
            status,
            final_url: request.url.clone(),
            content_type: Some("application/json".into()),
            body: body.into_bytes(),
            truncated: false,
        })
    }
}

async fn run(url: &str, token: bool, body: &str) -> (WorkflowRunResult, Arc<PrivateRepoHttp>) {
    let credentials = Arc::new(MemoryCredentials::new());
    if token {
        credentials
            .set(
                &CredentialKey::new("github", "github.com").unwrap(),
                &Secret::new("ghp_testtoken"),
            )
            .unwrap();
    }
    let http = Arc::new(PrivateRepoHttp {
        body: body.to_owned(),
        requests: Mutex::new(Vec::new()),
    });
    let mut registry = IntegrationRegistry::new();
    registry.register(Arc::new(GithubIntegration::new(credentials)));
    let engine = WorkflowEngineAdapter::with_http(http.clone())
        .with_integrations(Arc::new(registry), http.clone());
    let input = normalize_text(url).unwrap();
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
async fn a_private_issue_is_readable_once_a_token_is_configured() {
    let (result, http) = run("https://github.com/acme/secret/issues/123", true, ISSUE).await;
    assert_eq!(result.workflow_id.as_str(), "builtin.github-issue");
    let items = result.result.unwrap();
    assert_eq!(items[0].title, "[secret#123] Crash on startup");
    let meta = &items[0].metadata;
    assert_eq!(meta["state"], "open");
    assert_eq!(meta["labels"], "bug,p1");
    assert_eq!(meta["assignees"], "hubot,monalisa");
    assert_eq!(meta["milestone"], "v1.2");
    // 认证请求确实发出过。
    assert!(
        http.requests
            .lock()
            .unwrap()
            .iter()
            .any(|(_, authed)| *authed)
    );
}

#[tokio::test]
async fn a_private_pull_request_reports_merged_and_keeps_the_review_title() {
    let (result, _) = run("https://github.com/acme/secret/pull/182", true, PULL).await;
    assert_eq!(result.workflow_id.as_str(), "builtin.github-pr");
    let items = result.result.unwrap();
    assert_eq!(items[0].title, "Review PR #182: 修复登录失败");
    assert_eq!(items[0].metadata["state"], "merged");
    assert_eq!(items[0].metadata["labels"], "fix");
}

#[tokio::test]
async fn without_a_token_a_private_repository_degrades_to_the_number_only() {
    let (result, http) = run("https://github.com/acme/secret/issues/123", false, ISSUE).await;
    // 私有仓库的匿名请求全是 404：待办仍然创建，只保留编号；没有任何认证请求。
    assert_eq!(result.result.unwrap()[0].title, "[secret#123]");
    assert!(result.notice.is_none());
    assert!(
        http.requests
            .lock()
            .unwrap()
            .iter()
            .all(|(_, authed)| !*authed)
    );
}
