//! `script` Step 的测试：授权、权限子集、沙箱运行、与 HttpPort 的配合（实施计划 8.3）。

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, missing_docs)]

use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use chrono::NaiveDate;
use nivlo_application::ports::http::{HostPolicy, HttpError, HttpPort, HttpRequest, HttpResponse};
use nivlo_application::workflow::{FailureKind, RunMode, WorkflowEngine};
use nivlo_capture::normalize_text;
use nivlo_domain::workflow::Permissions;
use nivlo_script::ScriptWorker;
use nivlo_workflow::WorkflowEngineAdapter;
use nivlo_workflow::script_step::{ScriptGrants, script_fingerprint};

/// 内存授权记录。
#[derive(Default)]
struct Grants(Mutex<HashSet<String>>);

#[async_trait]
impl ScriptGrants for Grants {
    async fn is_granted(&self, fingerprint: &str) -> bool {
        self.0.lock().unwrap().contains(fingerprint)
    }
}

/// 固定返回 JSON 的网络。
struct FakeHttp;

#[async_trait]
impl HttpPort for FakeHttp {
    async fn get(
        &self,
        request: &HttpRequest,
        policy: &HostPolicy,
    ) -> Result<HttpResponse, HttpError> {
        policy.check(&request.url)?;
        Ok(HttpResponse {
            status: 200,
            final_url: request.url.clone(),
            content_type: None,
            body: r#"{"name":"远端标题"}"#.as_bytes().to_vec(),
            truncated: false,
        })
    }
}

const SOURCE: &str = "export default async function (ctx) { \
    const r = ctx.http.get('https://api.example.com/x'); \
    return { title: JSON.parse(r.body).name + ' / ' + ctx.input.text, type: 'todo', tags: ['脚本'] }; }";

fn definition(source: &str, hosts: &str, permissions: &str) -> String {
    let source = serde_json::to_string(source).unwrap();
    format!(
        r#"{{"schemaVersion":1,"id":"user.script","name":"脚本","priority":5,
        "matcher":{{"field":"input.type","op":"equals","value":"text"}},
        {permissions}
        "steps":[{{"type":"script","source":{source}{hosts}}}]}}"#
    )
}

const PERMS: &str = r#""permissions":{"network":true,"hosts":["api.example.com"]},"#;
const HOSTS: &str = r#","hosts":["api.example.com"]"#;

fn today() -> NaiveDate {
    NaiveDate::from_ymd_opt(2026, 10, 11).unwrap()
}

fn engine(grants: Arc<Grants>, worker: &ScriptWorker) -> WorkflowEngineAdapter {
    WorkflowEngineAdapter::standard().with_script(worker.handle(), Some(Arc::new(FakeHttp)), grants)
}

async fn run(
    adapter: &WorkflowEngineAdapter,
    definition: &str,
) -> nivlo_application::workflow::WorkflowRunResult {
    let workflow = adapter.parse(definition).unwrap();
    let input = normalize_text("你好").unwrap();
    adapter
        .run(&workflow, &input, None, today(), RunMode::Full)
        .await
}

/// 为一份定义计算并授予指纹。
fn grant(grants: &Grants, source: &str, hosts: &[&str], permissions: &Permissions) {
    let hosts: Vec<String> = hosts.iter().map(|h| (*h).to_owned()).collect();
    grants
        .0
        .lock()
        .unwrap()
        .insert(script_fingerprint(permissions, source, &hosts));
}

fn permissions() -> Permissions {
    Permissions {
        network: true,
        hosts: vec!["api.example.com".to_owned()],
    }
}

#[tokio::test]
async fn an_ungranted_script_does_not_run() {
    let worker = ScriptWorker::spawn();
    let adapter = engine(Arc::new(Grants::default()), &worker);
    let result = run(&adapter, &definition(SOURCE, HOSTS, PERMS)).await;
    assert_eq!(
        result.result.unwrap_err().kind,
        FailureKind::UserActionRequired
    );
}

#[tokio::test]
async fn a_granted_script_produces_an_item_using_the_http_port() {
    let worker = ScriptWorker::spawn();
    let grants = Arc::new(Grants::default());
    grant(&grants, SOURCE, &["api.example.com"], &permissions());
    let adapter = engine(grants, &worker);
    let result = run(&adapter, &definition(SOURCE, HOSTS, PERMS)).await;
    let items = result.result.unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].title, "远端标题 / 你好");
    assert_eq!(items[0].tags, ["脚本"]);
}

#[tokio::test]
async fn changing_the_script_or_permissions_requires_reconfirmation() {
    let worker = ScriptWorker::spawn();
    let grants = Arc::new(Grants::default());
    grant(&grants, SOURCE, &["api.example.com"], &permissions());
    let adapter = engine(grants, &worker);
    // 改了源码。
    let edited = SOURCE.replace("脚本", "脚本2");
    let result = run(&adapter, &definition(&edited, HOSTS, PERMS)).await;
    assert_eq!(
        result.result.unwrap_err().kind,
        FailureKind::UserActionRequired
    );
    // 多声明了一个主机（Workflow 权限同步扩大）。
    let more = r#""permissions":{"network":true,"hosts":["api.example.com","other.example.com"]},"#;
    let result = run(&adapter, &definition(SOURCE, HOSTS, more)).await;
    assert_eq!(
        result.result.unwrap_err().kind,
        FailureKind::UserActionRequired
    );
}

#[tokio::test]
async fn a_script_cannot_declare_more_than_the_workflow() {
    let adapter = WorkflowEngineAdapter::standard();
    let beyond = r#","hosts":["api.example.com","evil.test"]"#;
    assert!(adapter.parse(&definition(SOURCE, beyond, PERMS)).is_err());
    // 没有声明网络权限却想联网。
    assert!(adapter.parse(&definition(SOURCE, HOSTS, "")).is_err());
}

#[tokio::test]
async fn a_script_without_hosts_cannot_reach_the_network() {
    let worker = ScriptWorker::spawn();
    let grants = Arc::new(Grants::default());
    grant(&grants, SOURCE, &[], &permissions());
    let adapter = engine(grants, &worker);
    let result = run(&adapter, &definition(SOURCE, "", PERMS)).await;
    assert_eq!(
        result.result.unwrap_err().kind,
        FailureKind::PermissionDenied
    );
}

#[tokio::test]
async fn a_bad_return_shape_is_invalid_input() {
    let worker = ScriptWorker::spawn();
    let grants = Arc::new(Grants::default());
    let source = "export default () => ({ tags: [] })";
    grant(&grants, source, &[], &Permissions::default());
    let adapter = engine(grants, &worker);
    let result = run(&adapter, &definition(source, "", "")).await;
    assert_eq!(result.result.unwrap_err().kind, FailureKind::InvalidInput);
}

#[tokio::test]
async fn a_script_without_hosts_runs_without_confirmation_and_reports_console_output() {
    let worker = ScriptWorker::spawn();
    let adapter = engine(Arc::new(Grants::default()), &worker);
    let source = "export default function transform(input) { console.log(\"got\", input.text); return { title: input.text, content: \"正文\" }; }";
    let result = run(&adapter, &definition(source, "", "")).await;
    assert_eq!(result.steps[0].logs, ["got 你好"]);
    let items = result.result.unwrap();
    assert_eq!(items[0].title, "你好");
    assert_eq!(items[0].content.as_deref(), Some("正文"));
}

#[tokio::test]
async fn script_errors_report_the_line_number() {
    let worker = ScriptWorker::spawn();
    let adapter = engine(Arc::new(Grants::default()), &worker);
    let source = "export default function (ctx) {
  const a = 1;
  throw new Error(\"boom\");
}";
    let result = run(&adapter, &definition(source, "", "")).await;
    let failure = result.result.unwrap_err();
    assert!(failure.message.contains("第 3 行"), "{}", failure.message);
    assert!(failure.message.contains("boom"));
}
