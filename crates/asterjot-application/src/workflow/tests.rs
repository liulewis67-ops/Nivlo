//! `WorkflowService` 的 Use Case 测试：内存 Fake + 假引擎。

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::sync::Arc;

use asterjot_common::clock::FakeClock;
use asterjot_domain::capture::CaptureInput;
use asterjot_domain::workflow::{Workflow, WorkflowId, WorkflowSource};
use async_trait::async_trait;
use chrono::{DateTime, Duration, NaiveDate, TimeZone, Utc};

use super::{
    PlannedItem, RUN_RETENTION_COUNT, RunRecord, RunStatus, WorkflowEngine, WorkflowIssue,
    WorkflowRunResult, WorkflowService, summarize_input,
};
use crate::error::ErrorCode;
use crate::testing::FakeUnitOfWork;

/// 假引擎：名称叫「坏」的 Workflow 校验失败；运行总是产出一条待创建的笔记。
struct FakeEngine;

#[async_trait]
impl WorkflowEngine for FakeEngine {
    fn validate(&self, workflow: &Workflow) -> Result<(), Vec<WorkflowIssue>> {
        if workflow.name == "坏" {
            Err(vec![WorkflowIssue {
                path: "/steps/0/title".into(),
                message: "模板语法错误".into(),
            }])
        } else {
            Ok(())
        }
    }

    fn parse(&self, json: &str) -> Result<Workflow, Vec<WorkflowIssue>> {
        serde_json::from_str(json).map_err(|e| {
            vec![WorkflowIssue {
                path: String::new(),
                message: e.to_string(),
            }]
        })
    }

    async fn resolve_and_run(
        &self,
        workflows: &[Workflow],
        input: &CaptureInput,
        source_application: Option<&str>,
        today: NaiveDate,
        _mode: crate::workflow::RunMode,
    ) -> Option<WorkflowRunResult> {
        let first = workflows.first()?;
        Some(
            self.run(first, input, source_application, today, _mode)
                .await,
        )
    }

    async fn run(
        &self,
        workflow: &Workflow,
        _input: &CaptureInput,
        _source_application: Option<&str>,
        _today: NaiveDate,
        _mode: crate::workflow::RunMode,
    ) -> WorkflowRunResult {
        WorkflowRunResult {
            workflow_id: workflow.id.clone(),
            workflow_name: workflow.name.clone(),
            result: Ok(vec![PlannedItem {
                item_type: asterjot_domain::item::ItemType::Note,
                title: "t".into(),
                content: None,
                in_inbox: true,
                tags: Vec::new(),
                priority: None,
                scheduled: None,
                attach: false,
                file_index: None,
                source_label: None,
                metadata: Default::default(),
            }]),
            steps: Vec::new(),
            notice: None,
            duration_ms: 1,
        }
    }
}

/// 构造一个 Workflow。
fn workflow(id: &str, name: &str, source: &str, priority: i32, version: u32) -> Workflow {
    serde_json::from_str(&format!(
        r#"{{ "schemaVersion": 1, "id": "{id}", "name": "{name}", "source": "{source}",
              "priority": {priority}, "version": {version},
              "matcher": {{ "field": "input.type", "op": "equals", "value": "url" }},
              "steps": [ {{ "type": "createItem", "itemType": "note", "title": "t" }} ] }}"#
    ))
    .unwrap()
}

/// 测试夹具。
struct Fixture {
    service: WorkflowService,
    uow: FakeUnitOfWork,
    clock: FakeClock,
}

fn fixture() -> Fixture {
    let uow = FakeUnitOfWork::new();
    let clock = FakeClock::at_utc(Utc.with_ymd_and_hms(2026, 10, 14, 8, 0, 0).unwrap());
    Fixture {
        service: WorkflowService::new(
            Arc::new(uow.clone()),
            Arc::new(clock.clone()),
            Arc::new(FakeEngine),
        ),
        uow,
        clock,
    }
}

fn id(text: &str) -> WorkflowId {
    WorkflowId::new(text).unwrap()
}

#[tokio::test]
async fn builtin_sync_adds_missing_ones_and_keeps_user_choices_on_upgrade() {
    let f = fixture();
    f.service
        .sync_builtin(vec![workflow("builtin.a", "A", "builtin", 0, 1)])
        .await
        .unwrap();
    f.service
        .set_enabled(&id("builtin.a"), false)
        .await
        .unwrap();
    f.service.set_priority(&id("builtin.a"), 7).await.unwrap();

    // 同一版本再同步：什么都不变。
    f.service
        .sync_builtin(vec![workflow("builtin.a", "A（新名字）", "builtin", 0, 1)])
        .await
        .unwrap();
    assert_eq!(
        f.service.get(&id("builtin.a")).await.unwrap().workflow.name,
        "A"
    );

    // 版本升级：定义更新，启用状态与优先级保留。
    f.service
        .sync_builtin(vec![
            workflow("builtin.a", "A（新名字）", "builtin", 0, 2),
            workflow("builtin.b", "B", "builtin", 0, 1),
        ])
        .await
        .unwrap();
    let a = f.service.get(&id("builtin.a")).await.unwrap().workflow;
    assert_eq!(a.name, "A（新名字）");
    assert_eq!(a.version, 2);
    assert!(!a.enabled);
    assert_eq!(a.priority, 7);
    assert_eq!(a.source, WorkflowSource::Builtin);
    assert!(f.service.get(&id("builtin.b")).await.is_ok());
}

#[tokio::test]
async fn list_puts_builtin_first_then_user_by_priority() {
    let f = fixture();
    f.service
        .sync_builtin(vec![workflow("builtin.z", "Z", "builtin", 0, 1)])
        .await
        .unwrap();
    f.service
        .save(workflow("user.low", "低", "user", 1, 1))
        .await
        .unwrap();
    f.service
        .save(workflow("user.high", "高", "user", 9, 1))
        .await
        .unwrap();
    let ids: Vec<String> = f
        .service
        .list()
        .await
        .unwrap()
        .iter()
        .map(|s| s.workflow.id.to_string())
        .collect();
    assert_eq!(ids, ["builtin.z", "user.high", "user.low"]);
}

#[tokio::test]
async fn duplicating_creates_a_user_copy_that_outranks_the_original() {
    let f = fixture();
    f.service
        .sync_builtin(vec![workflow(
            "builtin.generic-url",
            "网页链接",
            "builtin",
            0,
            3,
        )])
        .await
        .unwrap();
    let copy = f
        .service
        .duplicate(&id("builtin.generic-url"))
        .await
        .unwrap();
    assert_eq!(copy.id.as_str(), "user.generic-url-copy");
    assert_eq!(copy.name, "网页链接 副本");
    assert_eq!(copy.source, WorkflowSource::User);
    assert_eq!(copy.version, 1);
    assert_eq!(copy.priority, 10);
    assert!(copy.enabled);

    let second = f
        .service
        .duplicate(&id("builtin.generic-url"))
        .await
        .unwrap();
    assert_eq!(second.id.as_str(), "user.generic-url-copy-2");
    // 复制用户的副本也行。
    let third = f
        .service
        .duplicate(&id("user.generic-url-copy"))
        .await
        .unwrap();
    assert_eq!(third.id.as_str(), "user.generic-url-copy-copy");
    assert_eq!(
        f.service.duplicate(&id("nope")).await.unwrap_err().code,
        ErrorCode::WorkflowNotFound
    );
}

#[tokio::test]
async fn builtin_workflows_are_read_only_but_can_be_disabled() {
    let f = fixture();
    f.service
        .sync_builtin(vec![workflow("builtin.a", "A", "builtin", 0, 1)])
        .await
        .unwrap();
    let err = f
        .service
        .save(workflow("builtin.a", "改了", "user", 0, 1))
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::WorkflowReadOnly);
    assert_eq!(
        f.service.delete(&id("builtin.a")).await.unwrap_err().code,
        ErrorCode::WorkflowReadOnly
    );
    assert_eq!(
        f.service.get(&id("builtin.a")).await.unwrap().workflow.name,
        "A"
    );
    f.service
        .set_enabled(&id("builtin.a"), false)
        .await
        .unwrap();
    assert!(
        !f.service
            .get(&id("builtin.a"))
            .await
            .unwrap()
            .workflow
            .enabled
    );
}

#[tokio::test]
async fn saving_validates_and_reports_where_the_problem_is() {
    let f = fixture();
    let err = f
        .service
        .save(workflow("user.bad", "坏", "user", 0, 1))
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::WorkflowInvalid);
    assert!(err.message.contains("/steps/0/title"), "{}", err.message);
    assert!(
        f.service.list().await.unwrap().is_empty(),
        "没通过校验的不会被保存"
    );

    // 用户保存的永远不是内置的；修改后更新时间前进、创建时间不变。
    let saved = f
        .service
        .save(workflow("user.ok", "好", "builtin", 0, 1))
        .await
        .unwrap();
    assert_eq!(saved.source, WorkflowSource::User);
    let before = f.service.get(&id("user.ok")).await.unwrap();
    f.clock.advance(Duration::hours(1));
    f.service
        .save(workflow("user.ok", "好 2", "user", 0, 1))
        .await
        .unwrap();
    let after = f.service.get(&id("user.ok")).await.unwrap();
    assert_eq!(after.created_at, before.created_at);
    assert!(after.updated_at > before.updated_at);
    assert_eq!(after.workflow.name, "好 2");
}

#[tokio::test]
async fn importing_marks_the_source_and_reports_parse_errors() {
    let f = fixture();
    let json = serde_json::to_string(&workflow("user.imp", "导入的", "user", 0, 1)).unwrap();
    let imported = f.service.import(&json).await.unwrap();
    assert_eq!(imported.source, WorkflowSource::Imported);
    assert_eq!(
        f.service.import("{ 坏的").await.unwrap_err().code,
        ErrorCode::WorkflowInvalid
    );
}

#[tokio::test]
async fn deleting_removes_user_workflows() {
    let f = fixture();
    f.service
        .save(workflow("user.x", "x", "user", 0, 1))
        .await
        .unwrap();
    f.service.delete(&id("user.x")).await.unwrap();
    assert_eq!(
        f.service.get(&id("user.x")).await.unwrap_err().code,
        ErrorCode::WorkflowNotFound
    );
    assert_eq!(
        f.service.delete(&id("user.x")).await.unwrap_err().code,
        ErrorCode::WorkflowNotFound
    );
}

#[tokio::test]
async fn dry_run_returns_the_result_and_writes_nothing() {
    let f = fixture();
    let draft = workflow("user.draft", "草稿", "user", 0, 1);
    let input = CaptureInput::Url {
        url: "https://example.com/a?token=SECRET".into(),
    };
    let before = f.uow.committed_items().len();

    let result = f.service.dry_run(&draft, &input).await.unwrap();
    assert!(result.result.is_ok());
    // 草稿没有被保存、没有 Item、没有运行记录。
    assert!(f.service.list().await.unwrap().is_empty());
    assert_eq!(f.uow.committed_items().len(), before);
    assert!(f.service.recent_runs(10).await.unwrap().is_empty());

    // 没通过校验的草稿被拒绝。
    let err = f
        .service
        .dry_run(&workflow("user.bad", "坏", "user", 0, 1), &input)
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::WorkflowInvalid);
}

/// 构造一条运行记录。
fn run(n: u32, started_at: DateTime<Utc>) -> RunRecord {
    RunRecord {
        id: format!("run-{n:04}"),
        workflow_id: "builtin.a".into(),
        workflow_name: "A".into(),
        input_kind: "url".into(),
        input_summary: "example.com/a".into(),
        status: RunStatus::Succeeded,
        error_kind: None,
        error_message: None,
        items_created: 1,
        duration_ms: 3,
        started_at,
        steps: Vec::new(),
    }
}

#[tokio::test]
async fn run_history_is_bounded_by_count_and_by_age() {
    let f = fixture();
    let now = f.clock_now();
    {
        let mut tx = f.uow_begin().await;
        // 先写 510 条「今天」的，再写 3 条 40 天前的。
        for n in 0..510 {
            tx.workflows()
                .insert_run(&run(n, now - Duration::minutes(i64::from(n))))
                .await
                .unwrap();
        }
        for n in 600..603 {
            tx.workflows()
                .insert_run(&run(n, now - Duration::days(40)))
                .await
                .unwrap();
        }
        tx.commit().await.unwrap();
    }
    let removed = f.service.prune_runs().await.unwrap();
    assert_eq!(removed, 10 + 3);
    let kept = f.service.recent_runs(1000).await.unwrap();
    assert_eq!(kept.len(), RUN_RETENTION_COUNT as usize);
    assert_eq!(kept[0].id, "run-0000", "最新的在前");
    assert!(kept.iter().all(|r| r.started_at > now - Duration::days(30)));
}

impl Fixture {
    /// 当前假想时间。
    fn clock_now(&self) -> DateTime<Utc> {
        use asterjot_common::clock::Clock;
        self.clock.now_utc()
    }

    /// 开启一个事务（测试里直接写运行记录用）。
    async fn uow_begin(&self) -> Box<dyn crate::ports::Transaction> {
        use crate::ports::UnitOfWork;
        self.uow.begin().await.unwrap()
    }
}

#[test]
fn input_summaries_never_contain_the_full_text_query_strings_or_directories() {
    let long = "一段很长的敏感文字，包含密码 hunter2。".repeat(10);
    let text = summarize_input(&CaptureInput::Text { text: long.clone() });
    assert!(text.starts_with("文字 · "));
    assert!(!text.contains("hunter2"));

    let url = summarize_input(&CaptureInput::Url {
        url: "https://acme.example.com/browse/REQ-1?token=SECRET#frag".into(),
    });
    assert_eq!(url, "acme.example.com/browse/REQ-1");

    let file = summarize_input(&CaptureInput::File {
        file: asterjot_domain::capture::FileRef {
            path: r"C:\Users\lewis\机密\报告.pdf".into(),
            name: "报告.pdf".into(),
            extension: Some("pdf".into()),
            size_bytes: None,
            mime: None,
            is_dir: false,
        },
    });
    assert_eq!(file, "报告.pdf");
}

#[tokio::test]
async fn imports_are_disabled_keep_the_publisher_and_never_overwrite() {
    let f = fixture();
    // 已有一个同 ID 的用户 Workflow 和一个内置的。
    f.service
        .save(workflow("user.same", "我的", "user", 0, 1))
        .await
        .unwrap();
    f.service
        .sync_builtin(vec![workflow("builtin.b", "B", "builtin", 0, 1)])
        .await
        .unwrap();

    let mut incoming = workflow("user.same", "别人的", "user", 0, 1);
    incoming.publisher = Some("Alice".to_owned());
    let json = serde_json::to_string(&incoming).unwrap();

    let preview = f.service.preview_import(&json).await.unwrap();
    assert_eq!(preview.workflow.id.as_str(), "user.same-imported");
    assert_eq!(preview.renamed_from.as_ref().unwrap().as_str(), "user.same");
    assert!(!preview.workflow.enabled);
    assert_eq!(preview.workflow.publisher.as_deref(), Some("Alice"));
    // 预览不写任何数据。
    assert_eq!(f.service.list().await.unwrap().len(), 2);

    let imported = f.service.import(&json).await.unwrap();
    assert_eq!(imported.id.as_str(), "user.same-imported");
    assert!(!imported.enabled);
    assert_eq!(imported.source, WorkflowSource::Imported);
    // 原来的 Workflow 没被覆盖。
    let mine = f.service.get(&id("user.same")).await.unwrap();
    assert_eq!(mine.workflow.name, "我的");
    // 再导入一次：继续换新的 ID。
    let again = f.service.import(&json).await.unwrap();
    assert_eq!(again.id.as_str(), "user.same-imported-2");

    // 与内置同 ID 也不覆盖。
    let builtin_json = serde_json::to_string(&workflow("builtin.b", "冒充", "user", 0, 1)).unwrap();
    let renamed = f.service.import(&builtin_json).await.unwrap();
    assert_eq!(renamed.id.as_str(), "builtin.b-imported");
    assert_eq!(
        f.service.get(&id("builtin.b")).await.unwrap().workflow.name,
        "B"
    );
}

#[tokio::test]
async fn a_newer_format_version_gets_a_clear_upgrade_message() {
    let f = fixture();
    let json = r#"{ "schemaVersion": 2, "id": "user.future", "name": "未来" }"#;
    let error = f.service.preview_import(json).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::WorkflowInvalid);
    assert!(error.message.contains("升级AsterJot"), "{}", error.message);
    assert!(error.message.contains("版本 2"), "{}", error.message);
}
