//! Jira 集成的测试：用录制的 API 响应（`fixtures/jira/api/`）覆盖字段映射，
//! 以及认证方式、错误分类、凭据缺失与内网主机的豁免范围（实施计划 9.3）。

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use nivlo_application::ports::http::{HostPolicy, HttpError, HttpPort, HttpRequest, HttpResponse};
use nivlo_application::ports::integration::{
    Integration, IntegrationCall, IntegrationContext, IntegrationError,
};
use nivlo_platform::credential::{CredentialKey, CredentialPort, MemoryCredentials, Secret};

use super::JiraIntegration;

const CLOUD: &str = include_str!("../../../../fixtures/jira/api/issue-cloud.json");
const SERVER: &str = include_str!("../../../../fixtures/jira/api/issue-server.json");
const MINIMAL: &str = include_str!("../../../../fixtures/jira/api/issue-minimal.json");

/// 一次请求的记录：地址与（名称，值）形式的请求头。
type Seen = (String, Vec<(String, String)>);

/// 记录请求并返回预设响应的网络；和真实适配器一样先过策略。
struct FakeHttp {
    reply: Mutex<Result<HttpResponse, HttpError>>,
    seen: Mutex<Vec<Seen>>,
}

impl FakeHttp {
    fn json(status: u16, body: &str) -> Arc<Self> {
        Self::reply(Ok(HttpResponse {
            status,
            final_url: "https://x/".into(),
            content_type: Some("application/json".into()),
            body: body.as_bytes().to_vec(),
            truncated: false,
        }))
    }

    fn reply(reply: Result<HttpResponse, HttpError>) -> Arc<Self> {
        Arc::new(Self {
            reply: Mutex::new(reply),
            seen: Mutex::new(Vec::new()),
        })
    }

    /// 最近一次请求里某个请求头的值。
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

fn credentials(host: &str, secret: &str) -> Arc<MemoryCredentials> {
    let store = Arc::new(MemoryCredentials::new());
    store
        .set(
            &CredentialKey::new("jira", host).unwrap(),
            &Secret::new(secret),
        )
        .unwrap();
    store
}

async fn fetch(
    store: Arc<MemoryCredentials>,
    http: &FakeHttp,
    host: &str,
    key: &str,
    policy: &HostPolicy,
) -> Result<BTreeMap<String, String>, IntegrationError> {
    let call = IntegrationCall {
        operation: "issue".into(),
        params: [("key", key), ("host", host)]
            .into_iter()
            .map(|(k, v)| (k.to_owned(), v.to_owned()))
            .collect(),
    };
    JiraIntegration::new(store)
        .call(&call, &IntegrationContext { http, policy })
        .await
}

#[tokio::test]
async fn cloud_fields_are_mapped_and_basic_auth_is_used() {
    let http = FakeHttp::json(200, CLOUD);
    let policy = HostPolicy::new(["acme.atlassian.net"]);
    let out = fetch(
        credentials("acme.atlassian.net", "me@acme.com:api-token"),
        &http,
        "acme.atlassian.net",
        "AI-128",
        &policy,
    )
    .await
    .unwrap();
    assert_eq!(out["key"], "AI-128");
    assert_eq!(out["title"], "登录页在 Safari 上无法提交表单");
    assert!(out["description"].starts_with("h2. 现象"));
    assert_eq!(out["status"], "In Progress");
    assert_eq!(out["priority"], "High");
    assert_eq!(out["assignee"], "林悦");
    assert_eq!(out["start"], "2026-10-14");
    assert_eq!(out["due"], "2026-10-20");
    assert_eq!(out["labels"], "web,regression");
    assert_eq!(out["project"], "AI");
    assert_eq!(out["project_name"], "AI Platform");
    assert_eq!(out["url"], "https://acme.atlassian.net/browse/AI-128");

    let url = http.seen.lock().unwrap()[0].0.clone();
    assert!(url.starts_with("https://acme.atlassian.net/rest/api/2/issue/AI-128?fields="));
    // base64("me@acme.com:api-token")
    assert_eq!(
        http.header("Authorization"),
        "Basic bWVAYWNtZS5jb206YXBpLXRva2Vu"
    );
}

#[tokio::test]
async fn server_uses_a_bearer_pat_and_missing_fields_become_empty() {
    let http = FakeHttp::json(200, SERVER);
    let policy = HostPolicy::new(["jira.example.com"]);
    let out = fetch(
        credentials("jira.example.com", "pat-123"),
        &http,
        "jira.example.com",
        "OPS-77",
        &policy,
    )
    .await
    .unwrap();
    assert_eq!(out["status"], "To Do");
    assert_eq!(out["assignee"], "张三");
    assert_eq!(out["due"], "");
    assert_eq!(out["start"], "");
    assert_eq!(out["labels"], "");
    assert_eq!(http.header("Authorization"), "Bearer pat-123");

    let http = FakeHttp::json(200, MINIMAL);
    let out = fetch(
        credentials("jira.example.com", "pat"),
        &http,
        "jira.example.com",
        "AI-1",
        &policy,
    )
    .await
    .unwrap();
    assert_eq!(out["title"], "只有标题");
    for field in ["description", "status", "priority", "assignee", "project"] {
        assert_eq!(out[field], "", "{field}");
    }
}

#[tokio::test]
async fn errors_are_classified_for_the_user() {
    let policy = HostPolicy::new(["jira.example.com"]);
    let store = || credentials("jira.example.com", "pat");
    for status in [401, 403] {
        let http = FakeHttp::json(status, "{}");
        let error = fetch(store(), &http, "jira.example.com", "AI-1", &policy)
            .await
            .unwrap_err();
        assert_eq!(error, IntegrationError::Unauthorized, "{status}");
    }
    let not_found = fetch(
        store(),
        &FakeHttp::json(404, "{}"),
        "jira.example.com",
        "AI-1",
        &policy,
    )
    .await
    .unwrap_err();
    assert!(matches!(not_found, IntegrationError::Fatal(_)));
    for status in [429, 500, 503] {
        let error = fetch(
            store(),
            &FakeHttp::json(status, "{}"),
            "jira.example.com",
            "AI-1",
            &policy,
        )
        .await
        .unwrap_err();
        assert!(matches!(error, IntegrationError::Retryable(_)), "{status}");
    }
    let timeout = fetch(
        store(),
        &FakeHttp::reply(Err(HttpError::Timeout)),
        "jira.example.com",
        "AI-1",
        &policy,
    )
    .await
    .unwrap_err();
    assert_eq!(timeout, IntegrationError::Timeout);
    // 200 返回登录页 HTML：当作凭据失效。
    let html = FakeHttp::reply(Ok(HttpResponse {
        status: 200,
        final_url: "https://x/".into(),
        content_type: Some("text/html".into()),
        body: b"<html>login</html>".to_vec(),
        truncated: false,
    }));
    let error = fetch(store(), &html, "jira.example.com", "AI-1", &policy)
        .await
        .unwrap_err();
    assert_eq!(error, IntegrationError::Unauthorized);
}

#[tokio::test]
async fn no_credential_means_not_connected_and_no_request_is_sent() {
    let http = FakeHttp::json(200, CLOUD);
    let policy = HostPolicy::new(["*"]);
    let error = fetch(
        Arc::new(MemoryCredentials::new()),
        &http,
        "acme.atlassian.net",
        "AI-128",
        &policy,
    )
    .await
    .unwrap_err();
    assert_eq!(error, IntegrationError::NotConnected);
    assert!(http.seen.lock().unwrap().is_empty());
    // 凭据按主机区分：连了 A 不等于连了 B。
    let error = fetch(
        credentials("a.atlassian.net", "x:y"),
        &http,
        "b.atlassian.net",
        "AI-1",
        &policy,
    )
    .await
    .unwrap_err();
    assert_eq!(error, IntegrationError::NotConnected);
}

#[tokio::test]
async fn bad_parameters_are_rejected_before_anything_happens() {
    let http = FakeHttp::json(200, CLOUD);
    let policy = HostPolicy::new(["*"]);
    let store = credentials("acme.atlassian.net", "x:y");
    for (host, key) in [
        ("acme.atlassian.net", "ai-1"),
        ("acme.atlassian.net", "AI-"),
        ("acme.atlassian.net", "../etc"),
        ("acme.atlassian.net/evil", "AI-1"),
        ("user@acme.atlassian.net", "AI-1"),
        ("", "AI-1"),
    ] {
        let error = fetch(store.clone(), &http, host, key, &policy)
            .await
            .unwrap_err();
        assert!(
            matches!(error, IntegrationError::InvalidInput(_)),
            "{host} {key}"
        );
    }
    assert!(http.seen.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_connected_intranet_host_may_bypass_the_private_address_limit_but_nothing_else() {
    // 内网 Jira：`.local` / 内网 IP 默认被拒绝；用户连接过的主机例外。
    for host in ["jira.corp.local", "10.1.2.3"] {
        let http = FakeHttp::json(200, SERVER);
        let out = fetch(
            credentials(host, "pat"),
            &http,
            host,
            "OPS-77",
            &HostPolicy::new(["*"]),
        )
        .await
        .unwrap();
        assert_eq!(out["key"], "OPS-77", "{host}");
        assert_eq!(
            out["url"],
            format!("https://{host}/browse/OPS-77"),
            "{host}"
        );
    }
    // 没连接过的内网主机：没有凭据 → NotConnected，不会发请求。
    let http = FakeHttp::json(200, SERVER);
    let error = fetch(
        credentials("jira.corp.local", "pat"),
        &http,
        "other.corp.local",
        "OPS-77",
        &HostPolicy::new(["*"]),
    )
    .await
    .unwrap_err();
    assert_eq!(error, IntegrationError::NotConnected);
    assert!(http.seen.lock().unwrap().is_empty());
    // 豁免不会扩大到其他主机，也不影响没有豁免的策略。
    let policy = HostPolicy::new(["*"]).with_configured_private_hosts(["jira.corp.local"]);
    assert!(policy.check("https://jira.corp.local/x").is_ok());
    assert!(policy.check("https://10.9.9.9/x").is_err());
    assert!(
        HostPolicy::new(["*"])
            .check("https://jira.corp.local/x")
            .is_err()
    );
}

const MYSELF: &str = include_str!("../../../../fixtures/jira/api/myself.json");

async fn test_connection(
    store: Arc<MemoryCredentials>,
    http: &FakeHttp,
    host: &str,
) -> Result<String, IntegrationError> {
    let policy = HostPolicy::new(["*"]);
    JiraIntegration::new(store)
        .test_connection(
            host,
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
    let host = "acme.atlassian.net";
    let store = || credentials(host, "me@acme.com:token");

    let http = FakeHttp::json(200, MYSELF);
    assert_eq!(test_connection(store(), &http, host).await.unwrap(), "林悦");
    assert!(
        http.seen.lock().unwrap()[0]
            .0
            .ends_with("/rest/api/2/myself")
    );
    assert!(http.header("Authorization").starts_with("Basic "));

    let auth = test_connection(store(), &FakeHttp::json(401, "{}"), host).await;
    assert_eq!(auth.unwrap_err(), IntegrationError::Unauthorized);
    let permission = test_connection(store(), &FakeHttp::json(403, "{}"), host).await;
    assert!(matches!(
        permission.unwrap_err(),
        IntegrationError::Forbidden(_)
    ));
    let network = test_connection(
        store(),
        &FakeHttp::reply(Err(HttpError::Network("无法连接".into()))),
        host,
    )
    .await;
    assert!(matches!(
        network.unwrap_err(),
        IntegrationError::Retryable(_)
    ));
    let unreachable =
        test_connection(store(), &FakeHttp::reply(Err(HttpError::Timeout)), host).await;
    assert_eq!(unreachable.unwrap_err(), IntegrationError::Timeout);

    let missing = test_connection(
        Arc::new(MemoryCredentials::new()),
        &FakeHttp::json(200, MYSELF),
        host,
    )
    .await;
    assert_eq!(missing.unwrap_err(), IntegrationError::NotConnected);
}
