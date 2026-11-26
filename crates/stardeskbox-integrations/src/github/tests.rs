//! GitHub 集成的测试：Issue 与 PR 的 fixtures 字段映射、Token 认证、私有仓库、错误分类（实施计划 9.4）。

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use stardeskbox_application::ports::http::{
    HostPolicy, HttpError, HttpPort, HttpRequest, HttpResponse,
};
use stardeskbox_application::ports::integration::{
    Integration, IntegrationCall, IntegrationContext, IntegrationError,
};
use stardeskbox_platform::credential::{CredentialKey, CredentialPort, MemoryCredentials, Secret};

use super::GithubIntegration;

const ISSUE: &str = include_str!("../../../../fixtures/github/api/issue.json");
const PULL: &str = include_str!("../../../../fixtures/github/api/pull.json");
const DRAFT: &str = include_str!("../../../../fixtures/github/api/pull-draft.json");
const RATE_LIMITED: &str = include_str!("../../../../fixtures/github/api/rate-limited.json");

/// 一次请求的记录：地址与（名称，值）形式的请求头。
type Seen = (String, Vec<(String, String)>);

/// 记录请求、按预设返回的网络；和真实适配器一样先过策略。
struct FakeHttp {
    reply: Mutex<Result<HttpResponse, HttpError>>,
    seen: Mutex<Vec<Seen>>,
}

impl FakeHttp {
    fn json(status: u16, body: &str) -> Arc<Self> {
        Arc::new(Self {
            reply: Mutex::new(Ok(HttpResponse {
                status,
                final_url: "https://api.github.com/".into(),
                content_type: Some("application/json".into()),
                body: body.as_bytes().to_vec(),
                truncated: false,
            })),
            seen: Mutex::new(Vec::new()),
        })
    }

    fn header(&self, name: &str) -> String {
        let seen = self.seen.lock().unwrap();
        seen[0].1.iter().find(|(n, _)| n == name).unwrap().1.clone()
    }
}

#[async_trait]
impl HttpPort for FakeHttp {
    async fn get(
        &self,
        request: &HttpRequest,
        policy: &HostPolicy,
    ) -> Result<HttpResponse, HttpError> {
        policy.check(&request.url)?;
        let headers = request
            .headers
            .iter()
            .map(|(n, v)| (n.clone(), v.expose().to_owned()))
            .collect();
        self.seen
            .lock()
            .unwrap()
            .push((request.url.clone(), headers));
        self.reply.lock().unwrap().clone()
    }
}

fn connected() -> Arc<MemoryCredentials> {
    let store = Arc::new(MemoryCredentials::new());
    store
        .set(
            &CredentialKey::new("github", "github.com").unwrap(),
            &Secret::new("ghp_testtoken"),
        )
        .unwrap();
    store
}

async fn call(
    store: Arc<MemoryCredentials>,
    http: &FakeHttp,
    operation: &str,
    owner: &str,
    repo: &str,
    number: &str,
) -> Result<BTreeMap<String, String>, IntegrationError> {
    let call = IntegrationCall {
        operation: operation.into(),
        params: [("owner", owner), ("repo", repo), ("number", number)]
            .into_iter()
            .map(|(k, v)| (k.to_owned(), v.to_owned()))
            .collect(),
    };
    let policy = HostPolicy::new(["api.github.com"]);
    GithubIntegration::new(store)
        .call(
            &call,
            &IntegrationContext {
                http,
                policy: &policy,
            },
        )
        .await
}

#[tokio::test]
async fn issue_fields_are_mapped_and_the_token_is_sent_as_a_bearer() {
    let http = FakeHttp::json(200, ISSUE);
    let out = call(connected(), &http, "issue", "acme", "web", "123")
        .await
        .unwrap();
    assert_eq!(out["kind"], "issue");
    assert_eq!(out["title"], "Crash on startup");
    assert_eq!(out["state"], "open");
    assert_eq!(out["draft"], "false");
    assert!(out["body"].starts_with("Steps to reproduce"));
    assert_eq!(out["author"], "octocat");
    assert_eq!(out["labels"], "bug,p1");
    assert_eq!(out["assignees"], "hubot,monalisa");
    assert_eq!(out["milestone"], "v1.2");
    assert_eq!(out["url"], "https://github.com/acme/web/issues/123");

    let url = http.seen.lock().unwrap()[0].0.clone();
    assert_eq!(url, "https://api.github.com/repos/acme/web/issues/123");
    assert_eq!(http.header("Authorization"), "Bearer ghp_testtoken");
    assert_eq!(http.header("Accept"), "application/vnd.github+json");
}

#[tokio::test]
async fn pull_requests_report_merged_and_draft_states() {
    let http = FakeHttp::json(200, PULL);
    let out = call(connected(), &http, "pull", "acme", "web", "182")
        .await
        .unwrap();
    assert_eq!(out["kind"], "pull");
    assert_eq!(out["title"], "修复登录失败");
    // closed + merged → merged。
    assert_eq!(out["state"], "merged");
    assert_eq!(out["labels"], "fix");
    assert_eq!(out["assignees"], "");
    assert_eq!(out["milestone"], "");
    assert_eq!(
        http.seen.lock().unwrap()[0].0,
        "https://api.github.com/repos/acme/web/pulls/182"
    );

    let out = call(
        connected(),
        &FakeHttp::json(200, DRAFT),
        "pull",
        "acme",
        "web",
        "190",
    )
    .await
    .unwrap();
    assert_eq!(out["state"], "open");
    assert_eq!(out["draft"], "true");
    assert_eq!(out["body"], "");
}

#[tokio::test]
async fn a_private_repository_needs_the_token_and_without_one_nothing_is_sent() {
    // 配置了 Token：私有仓库能读（假服务器按「带 Bearer 才 200」模拟）。
    let http = FakeHttp::json(200, ISSUE);
    assert!(
        call(connected(), &http, "issue", "acme", "private", "1")
            .await
            .is_ok()
    );
    assert!(http.header("Authorization").starts_with("Bearer "));

    // 没有 Token：NotConnected，不发请求（公开仓库由 Workflow 的匿名路径处理）。
    let http = FakeHttp::json(200, ISSUE);
    let error = call(
        Arc::new(MemoryCredentials::new()),
        &http,
        "issue",
        "acme",
        "private",
        "1",
    )
    .await
    .unwrap_err();
    assert_eq!(error, IntegrationError::NotConnected);
    assert!(http.seen.lock().unwrap().is_empty());
}

#[tokio::test]
async fn errors_are_classified_for_the_user() {
    let run = |status: u16, body: &str| {
        let body = body.to_owned();
        async move {
            call(
                connected(),
                &FakeHttp::json(status, &body),
                "issue",
                "acme",
                "web",
                "1",
            )
            .await
            .unwrap_err()
        }
    };
    assert_eq!(run(401, "{}").await, IntegrationError::Unauthorized);
    // 403：限流可重试，其他（Token 权限不足）提示重新连接。
    assert!(matches!(
        run(403, RATE_LIMITED).await,
        IntegrationError::Retryable(_)
    ));
    assert_eq!(
        run(
            403,
            r#"{"message":"Resource not accessible by personal access token"}"#
        )
        .await,
        IntegrationError::Unauthorized
    );
    assert!(matches!(run(404, "{}").await, IntegrationError::Fatal(_)));
    for status in [429, 500, 502] {
        assert!(
            matches!(run(status, "{}").await, IntegrationError::Retryable(_)),
            "{status}"
        );
    }
    assert!(matches!(
        run(200, "not json").await,
        IntegrationError::Fatal(_)
    ));
}

#[tokio::test]
async fn bad_parameters_and_operations_are_rejected_before_any_request() {
    let http = FakeHttp::json(200, ISSUE);
    for (op, owner, repo, number) in [
        ("issue", "acme", "web", "abc"),
        ("issue", "acme", "web", ""),
        ("issue", "../x", "web", "1"),
        ("issue", "acme", "we b", "1"),
        ("issue", "acme/evil", "web", "1"),
        ("issue", "", "web", "1"),
        ("commits", "acme", "web", "1"),
    ] {
        let error = call(connected(), &http, op, owner, repo, number)
            .await
            .unwrap_err();
        assert!(
            matches!(error, IntegrationError::InvalidInput(_)),
            "{op} {owner} {repo} {number}"
        );
    }
    assert!(http.seen.lock().unwrap().is_empty());
}

#[tokio::test]
async fn only_the_api_host_is_reachable() {
    // 策略里没有 api.github.com 时，请求在到达网络之前就被拒绝。
    let http = FakeHttp::json(200, ISSUE);
    let policy = HostPolicy::new(["example.com"]);
    let call = IntegrationCall {
        operation: "issue".into(),
        params: [("owner", "acme"), ("repo", "web"), ("number", "1")]
            .into_iter()
            .map(|(k, v)| (k.to_owned(), v.to_owned()))
            .collect(),
    };
    let error = GithubIntegration::new(connected())
        .call(
            &call,
            &IntegrationContext {
                http: http.as_ref(),
                policy: &policy,
            },
        )
        .await
        .unwrap_err();
    assert!(matches!(error, IntegrationError::PermissionDenied(_)));
    assert!(http.seen.lock().unwrap().is_empty());
}

const USER: &str = include_str!("../../../../fixtures/github/api/user.json");

async fn test_connection(
    store: Arc<MemoryCredentials>,
    http: &FakeHttp,
) -> Result<String, IntegrationError> {
    let policy = HostPolicy::new(["api.github.com"]);
    GithubIntegration::new(store)
        .test_connection(
            "github.com",
            "https",
            &IntegrationContext {
                http,
                policy: &policy,
            },
        )
        .await
}

#[tokio::test]
async fn testing_the_connection_tells_network_auth_and_permission_problems_apart() {
    let http = FakeHttp::json(200, USER);
    assert_eq!(
        test_connection(connected(), &http).await.unwrap(),
        "octocat"
    );
    assert_eq!(
        http.seen.lock().unwrap()[0].0,
        "https://api.github.com/user"
    );

    let auth = test_connection(connected(), &FakeHttp::json(401, "{}")).await;
    assert_eq!(auth.unwrap_err(), IntegrationError::Unauthorized);
    let permission = test_connection(
        connected(),
        &FakeHttp::json(403, r#"{"message":"Resource not accessible"}"#),
    )
    .await;
    assert!(matches!(
        permission.unwrap_err(),
        IntegrationError::Forbidden(_)
    ));
    let limited = test_connection(connected(), &FakeHttp::json(403, RATE_LIMITED)).await;
    assert!(matches!(
        limited.unwrap_err(),
        IntegrationError::Retryable(_)
    ));
    let missing = test_connection(
        Arc::new(MemoryCredentials::new()),
        &FakeHttp::json(200, USER),
    )
    .await;
    assert_eq!(missing.unwrap_err(), IntegrationError::NotConnected);
}
