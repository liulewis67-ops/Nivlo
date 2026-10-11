//! 把 Engine 接到 Application 的 [`WorkflowEngine`] Port 上。

use std::time::Duration;

use async_trait::async_trait;
use chrono::NaiveDate;
use nivlo_application::workflow::{
    FailureKind, PlannedItem, RunMode, StepOutcome, StepReport, WorkflowEngine, WorkflowFailure,
    WorkflowIssue, WorkflowRunResult,
};
use nivlo_domain::capture::CaptureInput;
use nivlo_domain::workflow::Workflow;
use tokio_util::sync::CancellationToken;

use crate::engine::{Engine, RunFailure, RunOptions, RunReport, StepRecord, StepStatus};
use crate::executor::{ErrorKind, ItemDraft};
use crate::facts::InputFacts;
use crate::resolver::resolve;
use crate::validate::{self, Issue};

/// [`WorkflowEngine`] 的实现：包装一个 [`Engine`]。
pub struct WorkflowEngineAdapter {
    /// 引擎。
    engine: Engine,
}

impl WorkflowEngineAdapter {
    /// 用标准配置的引擎创建适配器。
    #[must_use]
    pub fn standard() -> Self {
        Self {
            engine: Engine::standard(),
        }
    }

    /// 标准配置，并启用 `http` Step（经给定的网络 Port）。
    #[must_use]
    pub fn with_http(port: std::sync::Arc<dyn nivlo_application::ports::http::HttpPort>) -> Self {
        Self {
            engine: Engine::with_http(port),
        }
    }

    /// 用指定的引擎创建适配器（测试注入假 Executor）。
    #[must_use]
    pub fn new(engine: Engine) -> Self {
        Self { engine }
    }
}

/// 引擎的错误分类 → Port 的分类。
fn failure_kind(kind: ErrorKind) -> FailureKind {
    match kind {
        ErrorKind::Retryable => FailureKind::Retryable,
        ErrorKind::Fatal => FailureKind::Fatal,
        ErrorKind::PermissionDenied => FailureKind::PermissionDenied,
        ErrorKind::UserActionRequired => FailureKind::UserActionRequired,
        ErrorKind::Timeout => FailureKind::Timeout,
        ErrorKind::InvalidInput => FailureKind::InvalidInput,
    }
}

/// 毫秒数（饱和转换）。
fn millis(duration: Duration) -> u64 {
    u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
}

/// 草稿 → 待创建的 Item。
fn planned(draft: ItemDraft) -> PlannedItem {
    PlannedItem {
        item_type: draft.item_type,
        title: draft.title,
        content: draft.content,
        in_inbox: draft.in_inbox,
        tags: draft.tags,
        priority: draft.priority,
        scheduled: draft.scheduled,
        attach: draft.attach,
        file_index: draft.file_index,
    }
}

/// Step 记录 → Port 的记录。
fn step_report(record: &StepRecord) -> StepReport {
    StepReport {
        index: u32::try_from(record.index).unwrap_or(u32::MAX),
        kind: record.kind.to_owned(),
        outcome: match record.status {
            StepStatus::Ok => StepOutcome::Ok,
            StepStatus::Skipped => StepOutcome::Skipped,
            StepStatus::Failed => StepOutcome::Failed,
        },
        duration_ms: millis(record.duration),
        message: record.message.clone(),
    }
}

/// 校验问题 → Port 的问题。
fn issue(issue: Issue) -> WorkflowIssue {
    WorkflowIssue {
        path: issue.path,
        message: issue.message,
    }
}

/// 汇总一次运行的结果。
fn result_of(
    workflow: &Workflow,
    outcome: Result<RunReport, RunFailure>,
    duration: Duration,
) -> WorkflowRunResult {
    let (result, steps) = match outcome {
        Ok(report) => (
            Ok(report.drafts.into_iter().map(planned).collect()),
            report.steps,
        ),
        Err(failure) => (
            Err(WorkflowFailure {
                kind: failure_kind(failure.error.kind),
                message: failure.error.message,
                failed_step: failure.failed_step,
            }),
            failure.steps,
        ),
    };
    WorkflowRunResult {
        workflow_id: workflow.id.clone(),
        workflow_name: workflow.name.clone(),
        result,
        steps: steps.iter().map(step_report).collect(),
        duration_ms: millis(duration),
    }
}

#[async_trait]
impl WorkflowEngine for WorkflowEngineAdapter {
    /// 深度校验。
    fn validate(&self, workflow: &Workflow) -> Result<(), Vec<WorkflowIssue>> {
        validate::check_workflow(workflow, self.engine.regexes())
            .map_err(|issues| issues.into_iter().map(issue).collect())
    }

    /// 解析并校验 JSON 定义。
    fn parse(&self, json: &str) -> Result<Workflow, Vec<WorkflowIssue>> {
        validate::parse_definition(json, self.engine.regexes())
            .map_err(|issues| issues.into_iter().map(issue).collect())
    }

    /// 选出并运行。
    async fn resolve_and_run(
        &self,
        workflows: &[Workflow],
        input: &CaptureInput,
        source_application: Option<&str>,
        today: NaiveDate,
        mode: RunMode,
    ) -> Option<WorkflowRunResult> {
        let facts = InputFacts {
            input,
            source_application,
        };
        let chosen = resolve(workflows, &facts, self.engine.regexes())?;
        Some(
            self.run(chosen, input, source_application, today, mode)
                .await,
        )
    }

    /// 运行指定的 Workflow。
    async fn run(
        &self,
        workflow: &Workflow,
        input: &CaptureInput,
        source_application: Option<&str>,
        today: NaiveDate,
        mode: RunMode,
    ) -> WorkflowRunResult {
        let facts = InputFacts {
            input,
            source_application,
        };
        let options = RunOptions {
            cancel: CancellationToken::new(),
            today,
            network: mode == RunMode::Full,
        };
        let started = std::time::Instant::now();
        let outcome = self.engine.run(workflow, &facts, &options).await;
        result_of(workflow, outcome, started.elapsed())
    }
}
