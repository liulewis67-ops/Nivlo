//! `IntegrationService` 的测试：秘密只进凭据库、断开会删除凭据、测试连接区分各种失败（实施计划 9.5）。

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use chrono::{TimeZone, Utc};
use starat_application::error::ErrorCode;
use starat_application::ports::http::{HostPolicy, HttpError, HttpPort, HttpRequest, HttpResponse};
use starat_application::ports::integration::{
    Integration, IntegrationCall, IntegrationContext, IntegrationError, IntegrationOutput,
    IntegrationRegistry,
};
use starat_application::settings::SettingsService;
use starat_application::testing::FakeUnitOfWork;
use starat_common::clock::FakeClock;
use starat_platform::credential::{CredentialKey, CredentialPort, MemoryCredentials};

use super::{IntegrationService, TestOutcome};

/// 测试连接结果可预设的假集成（同时扮演 jira 与 github）。
struct Scripted {
    id: &'static str,
    outcome: Mutex<Result<String, IntegrationError>>,
}

#[async_trait]
impl Integration for Scripted {
    fn id(&self) -> &'static str {
        self.id
    }

    fn display_name(&self) -> &'static str {
        "Scripted"
    }

    async fn test_connection(
        &self,
        _account: &str,
        _scheme: &str,
        _ctx: &IntegrationContext<'_>,
    ) -> Result<String, IntegrationError> {
        self.outcome.lock().unwrap().clone()
    }

    async fn call(
        &self,
        _call: &IntegrationCall,
        _ctx: &IntegrationContext<'_>,
    ) -> Result<IntegrationOutput, IntegrationError> {
        Ok(IntegrationOutput::new())
    }
}

/// 不会被调用的网络（假集成不发请求）。
struct NoHttp;

#[async_trait]
impl HttpPort for NoHttp {
    async fn get(&self, _: &HttpRequest, _: &HostPolicy) -> Result<HttpResponse, HttpError> {
        Err(HttpError::Network("不应联网".into()))
    }
}

struct Fixture {
    service: IntegrationService,
    credentials: Arc<MemoryCredentials>,
    settings: SettingsService,
    jira: Arc<Scripted>,
}

fn fixture() -> Fixture {
    let clock = Arc::new(FakeClock::at_utc(
        Utc.with_ymd_and_hms(2026, 10, 12, 8, 0, 0).unwrap(),
    ));
    let settings = SettingsService::new(Arc::new(FakeUnitOfWork::new()), clock.clone());
    let credentials = Arc::new(MemoryCredentials::new());
    let jira = Arc::new(Scripted {
        id: "jira",
        outcome: Mutex::new(Ok("林悦".to_owned())),
    });
    let mut registry = IntegrationRegistry::new();
    registry.register(jira.clone());
    registry.register(Arc::new(Scripted {
        id: "github",
        outcome: Mutex::new(Ok("octocat".to_owned())),
    }));
    let service = IntegrationService::new(
        settings.clone(),
        credentials.clone(),
        Arc::new(registry),
        Some(Arc::new(NoHttp)),
        clock,
    );
    Fixture {
        service,
        credentials,
        settings,
        jira,
    }
}

fn key(integration: &str, account: &str) -> CredentialKey {
    CredentialKey::new(integration, account).unwrap()
}

#[tokio::test]
async fn the_secret_goes_to_the_credential_store_and_never_to_settings() {
    let f = fixture();
    let connection = f
        .service
        .connect(
            "jira",
            "https://Acme.Atlassian.net/",
            "me@acme.com:SECRET-TOKEN-123",
        )
        .await
        .unwrap();
    assert_eq!(connection.account, "acme.atlassian.net");
    assert_eq!(connection.scheme, "https");

    let stored = f
        .credentials
        .get(&key("jira", "acme.atlassian.net"))
        .unwrap()
        .unwrap();
    assert_eq!(stored.expose(), "me@acme.com:SECRET-TOKEN-123");

    // 设置表里只有元数据。
    let raw = f
        .settings
        .get("integrations.connections")
        .await
        .unwrap()
        .unwrap();
    assert!(!raw.contains("SECRET-TOKEN"), "{raw}");
    assert!(!raw.contains("me@acme.com"), "{raw}");
    assert_eq!(f.service.list().await.unwrap(), vec![connection]);
}

#[tokio::test]
async fn disconnecting_removes_the_credential_from_the_store() {
    let f = fixture();
    f.service
        .connect("github", "ignored", "ghp_secret")
        .await
        .unwrap();
    assert!(
        f.credentials
            .get(&key("github", "github.com"))
            .unwrap()
            .is_some()
    );

    f.service.disconnect("github", "github.com").await.unwrap();
    assert!(
        f.credentials
            .get(&key("github", "github.com"))
            .unwrap()
            .is_none()
    );
    assert!(f.service.list().await.unwrap().is_empty());
    // 重复断开不报错。
    f.service.disconnect("github", "github.com").await.unwrap();
}

#[tokio::test]
async fn reconnecting_replaces_the_credential_and_the_record() {
    let f = fixture();
    f.service.connect("github", "", "old").await.unwrap();
    f.service.connect("github", "", "new").await.unwrap();
    assert_eq!(f.service.list().await.unwrap().len(), 1);
    assert_eq!(
        f.credentials
            .get(&key("github", "github.com"))
            .unwrap()
            .unwrap()
            .expose(),
        "new"
    );
}

#[tokio::test]
async fn bad_input_is_rejected_without_touching_the_store() {
    let f = fixture();
    for (integration, account, secret) in [
        ("unknown", "x", "t"),
        ("github", "", ""),
        ("github", "", "   "),
        ("jira", "", "pat"),
        ("jira", "https://", "pat"),
        ("jira", "bad host", "pat"),
        // Cloud 需要「邮箱:API Token」。
        ("jira", "acme.atlassian.net", "just-a-token"),
    ] {
        let error = f
            .service
            .connect(integration, account, secret)
            .await
            .unwrap_err();
        assert_eq!(
            error.code,
            ErrorCode::InvalidInput,
            "{integration} {account:?} {secret:?}"
        );
    }
    assert!(f.service.list().await.unwrap().is_empty());
    assert!(
        f.credentials
            .get(&key("jira", "acme.atlassian.net"))
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn self_hosted_jira_keeps_the_scheme_and_port() {
    let f = fixture();
    let connection = f
        .service
        .connect("jira", "http://jira.corp.local:8080/jira", "pat-123")
        .await
        .unwrap();
    assert_eq!(connection.scheme, "http");
    assert_eq!(connection.account, "jira.corp.local:8080");
}

#[tokio::test]
async fn testing_tells_the_failure_kinds_apart_and_records_the_last_error() {
    let f = fixture();
    f.service
        .connect("jira", "jira.example.com", "pat")
        .await
        .unwrap();

    let cases = [
        (Ok("林悦".to_owned()), "ok"),
        (Err(IntegrationError::Unauthorized), "authFailed"),
        (
            Err(IntegrationError::Forbidden("权限不足".into())),
            "permissionDenied",
        ),
        (Err(IntegrationError::Retryable("连不上".into())), "network"),
        (Err(IntegrationError::Timeout), "network"),
        (Err(IntegrationError::NotConnected), "notConnected"),
        (Err(IntegrationError::Fatal("奇怪".into())), "failed"),
    ];
    for (scripted, status) in cases {
        *f.jira.outcome.lock().unwrap() = scripted;
        let outcome = f.service.test("jira", "jira.example.com").await.unwrap();
        assert_eq!(outcome.status(), status);
        let connection = &f.service.list().await.unwrap()[0];
        assert!(connection.last_checked_at.is_some());
        // 成功清空最近错误，失败则记下说明。
        assert_eq!(
            connection.last_error.is_none(),
            outcome.status() == "ok",
            "{status}"
        );
        if let TestOutcome::Ok(name) = outcome {
            assert_eq!(name, "林悦");
        }
    }
    assert_eq!(
        f.service.test("nope", "x").await.unwrap_err().code,
        ErrorCode::InvalidInput
    );
}

#[tokio::test]
async fn http_jira_credentials_carry_the_scheme_and_switching_removes_the_old_one() {
    let f = fixture();
    f.service
        .connect("jira", "http://jira.corp.local:8080", "pat-http")
        .await
        .unwrap();
    let http_key = key("jira", "http://jira.corp.local:8080");
    let https_key = key("jira", "jira.corp.local:8080");
    assert!(f.credentials.get(&http_key).unwrap().is_some());
    assert!(f.credentials.get(&https_key).unwrap().is_none());

    // 改成 https 重新连接：http 的凭据被删除，不会留下明文通道。
    f.service
        .connect("jira", "https://jira.corp.local:8080", "pat-https")
        .await
        .unwrap();
    assert!(f.credentials.get(&http_key).unwrap().is_none());
    assert_eq!(
        f.credentials.get(&https_key).unwrap().unwrap().expose(),
        "pat-https"
    );

    // 断开：按记录里的协议删除。
    f.service
        .disconnect("jira", "jira.corp.local:8080")
        .await
        .unwrap();
    assert!(f.credentials.get(&https_key).unwrap().is_none());
}
