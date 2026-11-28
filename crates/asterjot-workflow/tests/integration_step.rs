//! `integration` Step 的测试：注册表调用、凭据缺失 / 失效的用户动作、可选降级、权限与校验（实施计划 9.2）。
//!
//! 这里用一个假集成（`fakehub`）——引擎里没有任何具体集成的代码。

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, missing_docs)]

use std::sync::{Arc, Mutex};

use asterjot_application::ports::http::{
    HostPolicy, HttpError, HttpPort, HttpRequest, HttpResponse,
};
use asterjot_application::ports::integration::{
    Integration, IntegrationCall, IntegrationContext, IntegrationError, IntegrationOutput,
    IntegrationRegistry,
};
use asterjot_application::workflow::{FailureAction, FailureKind, RunMode, WorkflowEngine};
use asterjot_capture::normalize_text;
use asterjot_workflow::WorkflowEngineAdapter;
use async_trait::async_trait;
use chrono::NaiveDate;

/// 不会被调用的网络（假集成不发请求）。
struct NoHttp;

#[async_trait]
impl HttpPort for NoHttp {
    async fn get(&self, _: &HttpRequest, _: &HostPolicy) -> Result<HttpResponse, HttpError> {
        Err(HttpError::Network("不应联网".into()))
    }
}

/// 假集成：按预设返回；记录收到的调用。
struct FakeHub {
    outcome: Mutex<Result<IntegrationOutput, IntegrationError>>,
    calls: Mutex<Vec<IntegrationCall>>,
}

impl FakeHub {
    fn new(outcome: Result<IntegrationOutput, IntegrationError>) -> Arc<Self> {
        Arc::new(Self {
            outcome: Mutex::new(outcome),
            calls: Mutex::new(Vec::new()),
        })
    }
}

#[async_trait]
impl Integration for FakeHub {
    fn id(&self) -> &'static str {
        "fakehub"
    }

    fn display_name(&self) -> &'static str {
        "FakeHub"
    }

    async fn call(
        &self,
        call: &IntegrationCall,
        ctx: &IntegrationContext<'_>,
    ) -> Result<IntegrationOutput, IntegrationError> {
        // 策略来自 Workflow 声明的主机。
        ctx.policy
            .check("https://api.fakehub.test/x")
            .map_err(|e| IntegrationError::PermissionDenied(e.to_string()))?;
        self.calls.lock().unwrap().push(call.clone());
        self.outcome.lock().unwrap().clone()
    }
}

fn adapter(hub: Arc<FakeHub>) -> WorkflowEngineAdapter {
    let mut registry = IntegrationRegistry::new();
    registry.register(hub);
    WorkflowEngineAdapter::standard().with_integrations(Arc::new(registry), Arc::new(NoHttp))
}

fn definition(optional: bool, permissions: &str) -> String {
    format!(
        r#"{{"schemaVersion":1,"id":"user.hub","name":"集成","priority":5,
        "matcher":{{"field":"input.type","op":"equals","value":"text"}},
        {permissions}
        "steps":[
          {{"type":"integration","integration":"fakehub","operation":"issue",
            "params":{{"key":"{{{{ input.text }}}}"}},"into":"hub","optional":{optional}}},
          {{"type":"createItem","itemType":"todo","title":"{{{{ vars.hub_title | default('无标题') }}}}"}}
        ]}}"#
    )
}

const PERMS: &str = r#""permissions":{"network":true,"hosts":["api.fakehub.test"]},"#;

fn today() -> NaiveDate {
    NaiveDate::from_ymd_opt(2026, 10, 12).unwrap()
}

async fn run(
    adapter: &WorkflowEngineAdapter,
    definition: &str,
    mode: RunMode,
) -> asterjot_application::workflow::WorkflowRunResult {
    let workflow = adapter.parse(definition).unwrap();
    let input = normalize_text("APP-1").unwrap();
    adapter.run(&workflow, &input, None, today(), mode).await
}

#[tokio::test]
async fn the_integration_is_called_with_rendered_params_and_its_fields_become_variables() {
    let hub = FakeHub::new(Ok([("title".to_owned(), "登录失败".to_owned())]
        .into_iter()
        .collect()));
    let adapter = adapter(hub.clone());
    let result = run(&adapter, &definition(false, PERMS), RunMode::Full).await;
    let items = result.result.unwrap();
    assert_eq!(items[0].title, "登录失败");
    let calls = hub.calls.lock().unwrap();
    assert_eq!(calls[0].operation, "issue");
    assert_eq!(calls[0].params["key"], "APP-1");
}

#[tokio::test]
async fn a_missing_connection_asks_the_user_to_connect_instead_of_showing_http_errors() {
    for (error, fragment) in [
        (IntegrationError::NotConnected, "需要连接 FakeHub"),
        (IntegrationError::Unauthorized, "需要重新连接"),
    ] {
        let adapter = adapter(FakeHub::new(Err(error)));
        let result = run(&adapter, &definition(false, PERMS), RunMode::Full).await;
        let failure = result.result.unwrap_err();
        assert_eq!(failure.kind, FailureKind::UserActionRequired);
        assert!(failure.message.contains(fragment), "{}", failure.message);
        assert!(!failure.message.contains("HTTP"), "{}", failure.message);
        assert_eq!(
            failure.action,
            Some(FailureAction::OpenIntegrationSettings {
                integration: "fakehub".to_owned()
            })
        );
        assert_eq!(
            failure.action.unwrap().code(),
            "OPEN_INTEGRATION_SETTINGS:fakehub"
        );
    }
}

#[tokio::test]
async fn optional_steps_skip_connection_problems_but_not_configuration_errors() {
    // 没连接 / 失效 / 暂时性失败：跳过，后面的 Step 用 default 兜底。
    for error in [
        IntegrationError::NotConnected,
        IntegrationError::Unauthorized,
        IntegrationError::Retryable("限流".into()),
        IntegrationError::Timeout,
    ] {
        let adapter = adapter(FakeHub::new(Err(error)));
        let result = run(&adapter, &definition(true, PERMS), RunMode::Full).await;
        assert_eq!(result.result.unwrap()[0].title, "无标题");
    }
    // 参数 / 权限这类配置错误永远要报。
    let adapter = adapter(FakeHub::new(Err(IntegrationError::InvalidInput(
        "缺少 key".into(),
    ))));
    let result = run(&adapter, &definition(true, PERMS), RunMode::Full).await;
    assert_eq!(result.result.unwrap_err().kind, FailureKind::InvalidInput);
}

#[tokio::test]
async fn instant_runs_skip_the_integration_and_unknown_integrations_fail() {
    let hub = FakeHub::new(Ok(IntegrationOutput::new()));
    let adapter = adapter(hub.clone());
    let result = run(&adapter, &definition(true, PERMS), RunMode::Instant).await;
    assert_eq!(result.result.unwrap()[0].title, "无标题");
    assert!(hub.calls.lock().unwrap().is_empty(), "即时运行不联网");

    let unknown = definition(false, PERMS).replace("fakehub", "nothere");
    let result = run(&adapter, &unknown, RunMode::Full).await;
    let failure = result.result.unwrap_err();
    assert_eq!(failure.kind, FailureKind::Fatal);
    assert!(failure.message.contains("nothere"));
}

#[tokio::test]
async fn the_step_needs_declared_network_permission_and_valid_ids() {
    let adapter = WorkflowEngineAdapter::standard();
    // 没声明网络权限：定义校验就拒绝。
    assert!(adapter.parse(&definition(false, "")).is_err());
    // 集成标识不合法。
    let bad = definition(false, PERMS).replace(
        "\"integration\":\"fakehub\"",
        "\"integration\":\"Fake Hub\"",
    );
    assert!(adapter.parse(&bad).is_err());
    // 参数模板的语法错误在校验阶段就报出来。
    let bad_template = definition(false, PERMS).replace("{{ input.text }}", "{{ input.text");
    assert!(adapter.parse(&bad_template).is_err());
}

#[tokio::test]
async fn an_expired_connection_degrades_with_a_reconnect_notice_but_never_connected_stays_quiet() {
    let adapter_expired = adapter(FakeHub::new(Err(IntegrationError::Unauthorized)));
    let result = run(&adapter_expired, &definition(true, PERMS), RunMode::Full).await;
    let notice = result.notice.clone().expect("应当提示重新连接");
    assert!(notice.message.contains("重新连接"));
    assert_eq!(
        notice.action,
        Some(FailureAction::OpenIntegrationSettings {
            integration: "fakehub".to_owned()
        })
    );
    // 降级后照样创建了条目。
    assert_eq!(result.result.unwrap()[0].title, "无标题");

    let adapter_never = adapter(FakeHub::new(Err(IntegrationError::NotConnected)));
    let result = run(&adapter_never, &definition(true, PERMS), RunMode::Full).await;
    assert!(result.notice.is_none());
    assert!(result.result.is_ok());
}
