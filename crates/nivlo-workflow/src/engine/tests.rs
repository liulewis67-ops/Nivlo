//! Engine 与标准 Executor 的测试：Fake Executor 验证引擎行为，真实 Executor 用输入样例验证。

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use chrono::NaiveDate;
use nivlo_domain::capture::{CaptureInput, FileRef};
use nivlo_domain::item::ItemType;
use nivlo_domain::workflow::{Step, Workflow};
use tokio_util::sync::CancellationToken;

use super::{Engine, RunOptions, StepStatus};
use crate::executor::{ErrorKind, ExecutorRegistry, RunContext, StepError, StepExecutor};
use crate::facts::InputFacts;
use crate::pattern::RegexCache;

/// 由 JSON 步骤数组构造 Workflow。
fn workflow(steps: &str) -> Workflow {
    serde_json::from_str(&format!(
        r#"{{ "schemaVersion": 1, "id": "t", "name": "t",
              "matcher": {{ "field": "input.type", "op": "exists" }}, "steps": {steps} }}"#
    ))
    .unwrap()
}

fn options() -> RunOptions {
    RunOptions {
        cancel: CancellationToken::new(),
        today: NaiveDate::from_ymd_opt(2026, 10, 14).unwrap(),
        network: true,
    }
}

/// 文本输入的事实。
fn text(text: &str) -> CaptureInput {
    CaptureInput::Text { text: text.into() }
}

fn url(url: &str) -> CaptureInput {
    CaptureInput::Url { url: url.into() }
}

fn file(name: &str, ext: Option<&str>) -> FileRef {
    FileRef {
        path: format!(r"D:\docs\{name}"),
        name: name.into(),
        extension: ext.map(str::to_owned),
        size_bytes: Some(1),
        mime: None,
        is_dir: false,
    }
}

/// 运行并返回结果。
async fn run(
    engine: &Engine,
    workflow: &Workflow,
    input: &CaptureInput,
) -> Result<super::RunReport, super::RunFailure> {
    engine
        .run(
            workflow,
            &InputFacts {
                input,
                source_application: Some("Chrome"),
            },
            &options(),
        )
        .await
}

// ———— Fake Executor：验证引擎本身的行为，不依赖任何具体 Step ————

/// 记录调用并可配置结果的假执行器。
struct Fake {
    kind: &'static str,
    log: Arc<Mutex<Vec<&'static str>>>,
    result: Result<(), StepError>,
    sleep: Duration,
    stop: bool,
}

#[async_trait]
impl StepExecutor for Fake {
    fn kind(&self) -> &'static str {
        self.kind
    }

    async fn execute(&self, _step: &Step, ctx: &mut RunContext<'_>) -> Result<(), StepError> {
        self.log.lock().unwrap().push(self.kind);
        if !self.sleep.is_zero() {
            tokio::time::sleep(self.sleep).await;
        }
        if self.stop {
            ctx.stopped = true;
        }
        self.result.clone()
    }
}

/// 一个只含假执行器的引擎。
fn fake_engine(fakes: Vec<Fake>, timeout: Duration) -> Engine {
    let mut registry = ExecutorRegistry::new();
    for fake in fakes {
        registry.register(Arc::new(fake));
    }
    Engine::new(registry, Arc::new(RegexCache::new()), timeout)
}

fn fake(kind: &'static str, log: &Arc<Mutex<Vec<&'static str>>>) -> Fake {
    Fake {
        kind,
        log: log.clone(),
        result: Ok(()),
        sleep: Duration::ZERO,
        stop: false,
    }
}

/// 三个种类各一个 Step。
const THREE_STEPS: &str = r#"[
    { "type": "transform", "set": { "a": "1" } },
    { "type": "condition", "var": "x", "op": "exists" },
    { "type": "createItem", "itemType": "note", "title": "t" }
]"#;

#[tokio::test]
async fn steps_run_in_order_and_are_recorded() {
    let log = Arc::new(Mutex::new(Vec::new()));
    let engine = fake_engine(
        vec![
            fake("transform", &log),
            fake("condition", &log),
            fake("createItem", &log),
        ],
        Duration::from_secs(5),
    );
    let report = run(&engine, &workflow(THREE_STEPS), &text("x"))
        .await
        .unwrap();
    assert_eq!(
        *log.lock().unwrap(),
        ["transform", "condition", "createItem"]
    );
    let kinds: Vec<_> = report
        .steps
        .iter()
        .map(|s| (s.index, s.kind, s.status))
        .collect();
    assert_eq!(
        kinds,
        [
            (0, "transform", StepStatus::Ok),
            (1, "condition", StepStatus::Ok),
            (2, "createItem", StepStatus::Ok)
        ]
    );
    assert!(!report.stopped_early);
}

#[tokio::test]
async fn a_failing_step_short_circuits_with_its_classification() {
    for kind in [
        ErrorKind::Retryable,
        ErrorKind::Fatal,
        ErrorKind::PermissionDenied,
        ErrorKind::UserActionRequired,
        ErrorKind::Timeout,
        ErrorKind::InvalidInput,
    ] {
        let log = Arc::new(Mutex::new(Vec::new()));
        let mut failing = fake("condition", &log);
        failing.result = Err(StepError {
            kind,
            message: "坏了".into(),
            action: None,
        });
        let engine = fake_engine(
            vec![fake("transform", &log), failing, fake("createItem", &log)],
            Duration::from_secs(5),
        );
        let failure = run(&engine, &workflow(THREE_STEPS), &text("x"))
            .await
            .unwrap_err();
        assert_eq!(failure.error.kind, kind);
        assert_eq!(failure.failed_step, Some(1));
        assert_eq!(
            *log.lock().unwrap(),
            ["transform", "condition"],
            "失败之后的 Step 不再执行"
        );
        assert_eq!(failure.steps.len(), 2);
        assert_eq!(failure.steps[1].status, StepStatus::Failed);
        assert_eq!(failure.steps[1].message.as_deref(), Some("坏了"));
    }
}

#[tokio::test]
async fn an_unmet_condition_skips_the_rest_but_keeps_earlier_results() {
    let log = Arc::new(Mutex::new(Vec::new()));
    let mut condition = fake("condition", &log);
    condition.stop = true;
    let engine = fake_engine(
        vec![fake("transform", &log), condition, fake("createItem", &log)],
        Duration::from_secs(5),
    );
    let report = run(&engine, &workflow(THREE_STEPS), &text("x"))
        .await
        .unwrap();
    assert_eq!(*log.lock().unwrap(), ["transform", "condition"]);
    assert!(report.stopped_early);
    assert_eq!(report.steps[2].status, StepStatus::Skipped);
}

#[tokio::test]
async fn a_step_without_a_registered_executor_is_a_fatal_error() {
    let engine = fake_engine(vec![], Duration::from_secs(5));
    let failure = run(&engine, &workflow(THREE_STEPS), &text("x"))
        .await
        .unwrap_err();
    assert_eq!(failure.error.kind, ErrorKind::Fatal);
    assert!(failure.error.message.contains("transform"));
}

#[tokio::test(start_paused = true)]
async fn the_whole_run_times_out() {
    let log = Arc::new(Mutex::new(Vec::new()));
    let mut slow = fake("transform", &log);
    slow.sleep = Duration::from_secs(60);
    let engine = fake_engine(
        vec![slow, fake("condition", &log), fake("createItem", &log)],
        Duration::from_secs(2),
    );
    let failure = run(&engine, &workflow(THREE_STEPS), &text("x"))
        .await
        .unwrap_err();
    assert_eq!(failure.error.kind, ErrorKind::Timeout);
    assert_eq!(failure.failed_step, None);
}

#[tokio::test(start_paused = true)]
async fn cancellation_stops_a_running_workflow() {
    let log = Arc::new(Mutex::new(Vec::new()));
    let mut slow = fake("transform", &log);
    slow.sleep = Duration::from_secs(60);
    let engine = fake_engine(vec![slow], Duration::from_secs(120));
    let cancel = CancellationToken::new();
    let options = RunOptions {
        cancel: cancel.clone(),
        ..options()
    };
    let canceller = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(1)).await;
        cancel.cancel();
    });
    let wf = workflow(
        r#"[{ "type": "transform", "set": { "a": "1" } },
                           { "type": "createItem", "itemType": "note", "title": "t" }]"#,
    );
    let input = text("x");
    let failure = engine
        .run(
            &wf,
            &InputFacts {
                input: &input,
                source_application: None,
            },
            &options,
        )
        .await
        .unwrap_err();
    canceller.await.unwrap();
    assert_eq!(failure.error.message, "已取消");
}

// ———— 标准 Executor：用输入样例验证 ————

#[tokio::test]
async fn extract_and_create_item_build_a_github_style_todo() {
    let wf: Workflow = serde_json::from_str(include_str!(
        "../../../../workflows/examples/github-pr.workflow.json"
    ))
    .unwrap();
    let report = run(
        &Engine::standard(),
        &wf,
        &url("https://github.com/acme/repo/pull/42?x=1"),
    )
    .await
    .unwrap();
    assert_eq!(report.drafts.len(), 1);
    let draft = &report.drafts[0];
    assert_eq!(draft.title, "评审 PR #42（acme/repo）");
    assert_eq!(
        draft.content.as_deref(),
        Some("https://github.com/acme/repo/pull/42?x=1")
    );
    assert_eq!(draft.item_type, ItemType::Todo);
    assert_eq!(draft.scheduled, NaiveDate::from_ymd_opt(2026, 10, 14));
    assert!(!draft.in_inbox);
    assert_eq!(draft.tags, ["github", "review"]);
}

#[tokio::test]
async fn extract_fails_without_a_match_unless_optional() {
    let required = workflow(
        r#"[
        { "type": "extract", "from": "url.path", "pattern": "/pull/(\\d+)", "into": "n" },
        { "type": "createItem", "itemType": "note", "title": "{{ vars.n }}" }]"#,
    );
    let failure = run(
        &Engine::standard(),
        &required,
        &url("https://github.com/a/b/issues/1"),
    )
    .await
    .unwrap_err();
    assert_eq!(failure.error.kind, ErrorKind::InvalidInput);
    assert_eq!(failure.failed_step, Some(0));

    let optional = workflow(
        r#"[
        { "type": "extract", "from": "url.path", "pattern": "/pull/(\\d+)", "into": "n", "optional": true },
        { "type": "createItem", "itemType": "note", "title": "PR {{ vars.n | default(\"?\") }}" }]"#,
    );
    let report = run(
        &Engine::standard(),
        &optional,
        &url("https://github.com/a/b/issues/1"),
    )
    .await
    .unwrap();
    assert_eq!(report.drafts[0].title, "PR ?");
}

#[tokio::test]
async fn regex_replace_and_transform_compose_values() {
    let wf = workflow(
        r#"[
        { "type": "regex", "from": "input.text", "pattern": "\\s+", "replacement": " ", "into": "clean" },
        { "type": "regex", "from": "vars.clean", "pattern": "(\\w+)@(\\w+)", "replacement": "$2:$1", "into": "swapped" },
        { "type": "transform", "set": { "label": "{{ vars.swapped | upper }}!" } },
        { "type": "createItem", "itemType": "tip", "title": "{{ vars.label }}" }]"#,
    );
    let report = run(&Engine::standard(), &wf, &text("a   b   joe@home"))
        .await
        .unwrap();
    assert_eq!(report.drafts[0].title, "A B HOME:JOE!");
}

#[tokio::test]
async fn json_path_reads_values_out_of_json_text() {
    let wf = workflow(
        r#"[
        { "type": "jsonPath", "from": "input.text", "path": "$.issue.title", "into": "t" },
        { "type": "jsonPath", "from": "input.text", "path": "$.issue.labels[0]", "into": "l", "optional": true },
        { "type": "jsonPath", "from": "input.text", "path": "$.nope", "into": "n", "optional": true },
        { "type": "createItem", "itemType": "todo", "title": "{{ vars.t }}",
          "tags": ["{{ vars.l }}", "{{ vars.n | default('') }}"] }]"#,
    );
    let report = run(
        &Engine::standard(),
        &wf,
        &text(r#"{"issue":{"title":"登录超时","labels":["bug"]}}"#),
    )
    .await
    .unwrap();
    assert_eq!(report.drafts[0].title, "登录超时");
    assert_eq!(report.drafts[0].tags, ["bug"], "渲染出空串的标签被丢弃");

    let broken = workflow(
        r#"[
        { "type": "jsonPath", "from": "input.text", "path": "$.a", "into": "a" },
        { "type": "createItem", "itemType": "note", "title": "{{ vars.a }}" }]"#,
    );
    let failure = run(&Engine::standard(), &broken, &text("不是 json"))
        .await
        .unwrap_err();
    assert_eq!(failure.error.kind, ErrorKind::InvalidInput);
}

#[tokio::test]
async fn condition_stops_the_pipeline_when_unmet() {
    let wf = workflow(
        r#"[
        { "type": "createItem", "itemType": "note", "title": "先创建的" },
        { "type": "condition", "var": "input.text", "op": "startsWith", "value": "todo:" },
        { "type": "createItem", "itemType": "todo", "title": "后创建的" }]"#,
    );
    let stopped = run(&Engine::standard(), &wf, &text("普通文字"))
        .await
        .unwrap();
    assert_eq!(stopped.drafts.len(), 1);
    assert!(stopped.stopped_early);
    assert_eq!(stopped.steps[2].status, StepStatus::Skipped);

    let continued = run(&Engine::standard(), &wf, &text("TODO: 买菜"))
        .await
        .unwrap();
    assert_eq!(continued.drafts.len(), 2);
    assert!(!continued.stopped_early);

    // 条件里引用的变量不存在：exists 为假而不是报错。
    let missing = workflow(
        r#"[
        { "type": "condition", "var": "vars.nope", "op": "exists" },
        { "type": "createItem", "itemType": "note", "title": "不该创建" }]"#,
    );
    let report = run(&Engine::standard(), &missing, &text("x"))
        .await
        .unwrap();
    assert!(report.drafts.is_empty());
}

#[tokio::test]
async fn for_each_files_creates_one_draft_per_file_and_add_tag_applies_to_all() {
    let wf = workflow(
        r##"[
        { "type": "createItem", "itemType": "note", "title": "{{ file.stem }} ({{ file.extension }})",
          "forEach": "files", "tags": ["文件"] },
        { "type": "addTag", "tag": "#导入" },
        { "type": "addTag", "tag": "文件" }]"##,
    );
    let input = CaptureInput::Files {
        files: vec![
            file("报告.pdf", Some("pdf")),
            file("README", None),
            file("图.PNG", Some("png")),
        ],
    };
    let report = run(&Engine::standard(), &wf, &input).await.unwrap();
    let titles: Vec<&str> = report.drafts.iter().map(|d| d.title.as_str()).collect();
    assert_eq!(titles, ["报告 (pdf)", "README ()", "图.PNG (png)"]);
    assert_eq!(
        report
            .drafts
            .iter()
            .map(|d| d.file_index)
            .collect::<Vec<_>>(),
        [Some(0), Some(1), Some(2)]
    );
    // 标签：Step 自带的 + addTag 的，忽略大小写去重、去掉 # 前缀。
    assert!(report.drafts.iter().all(|d| d.tags == ["文件", "导入"]));

    // 没有文件输入时 forEach 是错误。
    let failure = run(&Engine::standard(), &wf, &text("没有文件"))
        .await
        .unwrap_err();
    assert_eq!(failure.error.kind, ErrorKind::InvalidInput);
}

#[tokio::test]
async fn create_item_validates_what_it_renders() {
    let empty_title = workflow(
        r#"[{ "type": "createItem", "itemType": "note", "title": "  {{ vars.x | default('') }}  " }]"#,
    );
    assert_eq!(
        run(&Engine::standard(), &empty_title, &text("x"))
            .await
            .unwrap_err()
            .error
            .kind,
        ErrorKind::InvalidInput
    );
    let missing_var =
        workflow(r#"[{ "type": "createItem", "itemType": "note", "title": "{{ vars.nope }}" }]"#);
    let failure = run(&Engine::standard(), &missing_var, &text("x"))
        .await
        .unwrap_err();
    assert!(failure.error.message.contains("vars.nope"));
    let bad_date = workflow(
        r#"[{ "type": "createItem", "itemType": "todo", "title": "t", "scheduled": "明天" }]"#,
    );
    assert!(
        run(&Engine::standard(), &bad_date, &text("x"))
            .await
            .unwrap_err()
            .error
            .message
            .contains("YYYY-MM-DD")
    );
    let priority_on_note = workflow(
        r#"[{ "type": "createItem", "itemType": "note", "title": "t", "priority": "high" }]"#,
    );
    assert_eq!(
        run(&Engine::standard(), &priority_on_note, &text("x"))
            .await
            .unwrap_err()
            .error
            .kind,
        ErrorKind::InvalidInput
    );
    let content_blank = workflow(
        r#"[{ "type": "createItem", "itemType": "note", "title": "t", "content": "{{ input.extra }}" }]"#,
    );
    let report = run(&Engine::standard(), &content_blank, &text("t"))
        .await
        .unwrap();
    assert_eq!(
        report.drafts[0].content, None,
        "渲染出空白的内容当作没有内容"
    );
}

#[tokio::test]
async fn the_engine_runs_without_side_effects_and_is_repeatable() {
    let wf = workflow(
        r#"[{ "type": "createItem", "itemType": "note", "title": "{{ input.title }}", "tags": ["a"] }]"#,
    );
    let engine = Engine::standard();
    let input = text("一条文字");
    let first = run(&engine, &wf, &input).await.unwrap();
    let second = run(&engine, &wf, &input).await.unwrap();
    assert_eq!(first.drafts, second.drafts);
}
