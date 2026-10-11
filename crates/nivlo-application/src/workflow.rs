//! Workflow 的 Application 层：引擎 Port、Workflow 管理 Use Case 与运行记录（实施计划 5.1–5.7）。
//!
//! 引擎本身（匹配、模板、Step 执行）在适配器 crate `nivlo-workflow` 里，通过 [`WorkflowEngine`] Port 接入——
//! Application 只关心「给一份输入，得到要创建的草稿（或失败原因）」。引擎是纯计算，不写库，
//! 所以试运行没有任何副作用；真正创建 Item 的是 [`crate::capture::CaptureService`]，在一个事务里完成。

use std::sync::Arc;

use async_trait::async_trait;
use chrono::{DateTime, NaiveDate, Utc};
use nivlo_common::clock::Clock;
use nivlo_common::id::new_uuid_v7;
use nivlo_domain::capture::{CaptureInput, FileRef};
use nivlo_domain::item::{ItemType, Priority};
use nivlo_domain::workflow::{Workflow, WorkflowId, WorkflowSource};

use crate::error::{AppError, ErrorCode};
use crate::ports::UnitOfWork;

/// 一次运行最多保留多少条记录。
pub const RUN_RETENTION_COUNT: u32 = 500;

/// 运行记录最多保留多少天。
pub const RUN_RETENTION_DAYS: i64 = 30;

/// Workflow 产出的一条待创建的 Item。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlannedItem {
    /// 类型。
    pub item_type: ItemType,
    /// 标题。
    pub title: String,
    /// 内容。
    pub content: Option<String>,
    /// 是否放进 Inbox。
    pub in_inbox: bool,
    /// 标签名。
    pub tags: Vec<String>,
    /// 优先级。
    pub priority: Option<Priority>,
    /// 计划日期。
    pub scheduled: Option<NaiveDate>,
    /// 是否挂上输入里的文件 / 图片作为附件。
    pub attach: bool,
    /// 对应输入里的第几个文件。
    pub file_index: Option<usize>,
    /// 来源的显示名。
    pub source_label: Option<String>,
    /// Integration 专属信息。
    pub metadata: std::collections::BTreeMap<String, String>,
}

/// 失败的分类（与引擎的错误分类一一对应）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum FailureKind {
    /// 暂时性错误，重试可能成功。
    Retryable,
    /// 确定性错误。
    Fatal,
    /// 缺少权限。
    PermissionDenied,
    /// 需要用户处理（登录、授权）。
    UserActionRequired,
    /// 超时。
    Timeout,
    /// 输入不符合 Workflow 的预期。
    InvalidInput,
}

impl FailureKind {
    /// 稳定的文本，用于运行记录与日志。
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Retryable => "retryable",
            Self::Fatal => "fatal",
            Self::PermissionDenied => "permission_denied",
            Self::UserActionRequired => "user_action_required",
            Self::Timeout => "timeout",
            Self::InvalidInput => "invalid_input",
        }
    }
}

/// Workflow 运行失败。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkflowFailure {
    /// 分类。
    pub kind: FailureKind,
    /// 说明（不含输入全文）。
    pub message: String,
    /// 失败的 Step 序号。
    pub failed_step: Option<usize>,
}

/// 一个 Step 的结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StepOutcome {
    /// 成功。
    Ok,
    /// 被跳过。
    Skipped,
    /// 失败。
    Failed,
}

impl StepOutcome {
    /// 稳定的文本。
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::Skipped => "skipped",
            Self::Failed => "failed",
        }
    }

    /// 从文本还原。
    #[must_use]
    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "ok" => Some(Self::Ok),
            "skipped" => Some(Self::Skipped),
            "failed" => Some(Self::Failed),
            _ => None,
        }
    }
}

/// 一个 Step 的运行记录。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StepReport {
    /// 第几个 Step。
    pub index: u32,
    /// 种类名。
    pub kind: String,
    /// 结果。
    pub outcome: StepOutcome,
    /// 耗时（毫秒）。
    pub duration_ms: u64,
    /// 失败原因。
    pub message: Option<String>,
}

/// 一次 Workflow 运行的结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkflowRunResult {
    /// 运行的 Workflow。
    pub workflow_id: WorkflowId,
    /// 它的名称。
    pub workflow_name: String,
    /// 产出（或失败原因）。
    pub result: Result<Vec<PlannedItem>, WorkflowFailure>,
    /// 每个 Step 的记录。
    pub steps: Vec<StepReport>,
    /// 总耗时（毫秒）。
    pub duration_ms: u64,
}

/// 定义校验发现的一处问题。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkflowIssue {
    /// 位置（JSON 路径）；整体问题为空。
    pub path: String,
    /// 说明。
    pub message: String,
}

impl std::fmt::Display for WorkflowIssue {
    /// 输出 `位置：说明`。
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.path.is_empty() {
            f.write_str(&self.message)
        } else {
            write!(f, "{}：{}", self.path, self.message)
        }
    }
}

/// 一次运行是否允许联网。
///
/// 捕获先用 [`RunMode::Instant`] 立刻创建 Item（`http` Step 被跳过，不阻塞拖放），
/// 联网的部分稍后在后台用 [`RunMode::Full`] 补全（实施计划 6.3）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunMode {
    /// 完整运行，`http` Step 真的联网。
    Full,
    /// 即时运行：`http` Step 直接跳过，只做本地计算。
    Instant,
}

/// Workflow 引擎 Port，由 `nivlo-workflow` 实现。
#[async_trait]
pub trait WorkflowEngine: Send + Sync {
    /// 深度校验一个 Workflow（结构、正则、模板语法）。
    ///
    /// # Errors
    ///
    /// 返回全部问题，每个带位置。
    fn validate(&self, workflow: &Workflow) -> Result<(), Vec<WorkflowIssue>>;

    /// 解析并校验一份 JSON 定义（导入 / 编辑器）。
    ///
    /// # Errors
    ///
    /// 返回全部问题，每个带位置。
    fn parse(&self, json: &str) -> Result<Workflow, Vec<WorkflowIssue>>;

    /// 为输入选出最合适的 Workflow 并运行；没有任何 Workflow 匹配时返回 `None`。
    async fn resolve_and_run(
        &self,
        workflows: &[Workflow],
        input: &CaptureInput,
        source_application: Option<&str>,
        today: NaiveDate,
        mode: RunMode,
    ) -> Option<WorkflowRunResult>;

    /// 运行指定的 Workflow（试运行：不要求它匹配、也不检查是否启用）。
    async fn run(
        &self,
        workflow: &Workflow,
        input: &CaptureInput,
        source_application: Option<&str>,
        today: NaiveDate,
        mode: RunMode,
    ) -> WorkflowRunResult;
}

/// 一条运行记录的状态。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunStatus {
    /// 成功创建了内容。
    Succeeded,
    /// 失败（捕获内容走兜底规则保存）。
    Failed,
    /// 没有创建任何内容（Workflow 提前停止），走了默认规则。
    Skipped,
}

impl RunStatus {
    /// 稳定的文本。
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Succeeded => "succeeded",
            Self::Failed => "failed",
            Self::Skipped => "skipped",
        }
    }

    /// 从文本还原。
    #[must_use]
    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "succeeded" => Some(Self::Succeeded),
            "failed" => Some(Self::Failed),
            "skipped" => Some(Self::Skipped),
            _ => None,
        }
    }
}

/// 一条持久化的运行记录。**只存脱敏摘要**：输入全文、网址查询串、文件所在目录都不会出现在这里。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunRecord {
    /// 记录 ID（UUID 文本）。
    pub id: String,
    /// Workflow ID。
    pub workflow_id: String,
    /// Workflow 名称（保留当时的名字，Workflow 被改名 / 删除后历史仍然可读）。
    pub workflow_name: String,
    /// 输入种类（`text` / `url` / `file` / `files` / `image`）。
    pub input_kind: String,
    /// 输入的脱敏摘要。
    pub input_summary: String,
    /// 状态。
    pub status: RunStatus,
    /// 失败分类。
    pub error_kind: Option<String>,
    /// 失败说明。
    pub error_message: Option<String>,
    /// 创建了几条 Item。
    pub items_created: u32,
    /// 总耗时（毫秒）。
    pub duration_ms: u64,
    /// 开始时间。
    pub started_at: DateTime<Utc>,
    /// 每个 Step 的记录。
    pub steps: Vec<StepReport>,
}

/// 把输入变成不含全文 / 敏感内容的一句摘要。
///
/// * 文字 → 「文字 · N 字」（不含内容）；
/// * 网址 → 主机 + 路径（**去掉查询串与片段**：里面常有 token）；
/// * 文件 → 只有文件名（不含所在目录）；
/// * 图片 → 「图片」。
#[must_use]
pub fn summarize_input(input: &CaptureInput) -> String {
    match input {
        CaptureInput::Text { text } => format!("文字 · {} 字", text.chars().count()),
        CaptureInput::Url { url } => {
            let trimmed = url.split(['?', '#']).next().unwrap_or(url);
            trimmed
                .split_once("://")
                .map_or(trimmed, |(_, rest)| rest)
                .to_owned()
        }
        CaptureInput::File { file } => file.name.clone(),
        CaptureInput::Files { files } => match files.first() {
            Some(FileRef { name, .. }) => format!("{name} 等 {} 个文件", files.len()),
            None => "文件".to_owned(),
        },
        CaptureInput::Image { .. } => "图片".to_owned(),
    }
}

/// 一个已保存的 Workflow（连同时间戳）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredWorkflow {
    /// 定义（`enabled` / `priority` 以列为准）。
    pub workflow: Workflow,
    /// 创建时间。
    pub created_at: DateTime<Utc>,
    /// 最近修改时间。
    pub updated_at: DateTime<Utc>,
}

/// 把校验问题合并成一条用户能读懂的错误。
fn invalid(issues: &[WorkflowIssue]) -> AppError {
    let text = issues
        .iter()
        .take(5)
        .map(ToString::to_string)
        .collect::<Vec<_>>()
        .join("；");
    AppError::new(ErrorCode::WorkflowInvalid, text)
}

/// 「Workflow 不存在」错误。
fn not_found(id: &WorkflowId) -> AppError {
    AppError::new(ErrorCode::WorkflowNotFound, format!("Workflow {id} 不存在"))
}

/// Workflow 管理的 Use Case。
#[derive(Clone)]
pub struct WorkflowService {
    /// 事务工厂。
    uow: Arc<dyn UnitOfWork>,
    /// 时钟。
    clock: Arc<dyn Clock>,
    /// 引擎（校验与试运行）。
    engine: Arc<dyn WorkflowEngine>,
}

impl WorkflowService {
    /// 创建服务。
    pub fn new(
        uow: Arc<dyn UnitOfWork>,
        clock: Arc<dyn Clock>,
        engine: Arc<dyn WorkflowEngine>,
    ) -> Self {
        Self { uow, clock, engine }
    }

    /// 同步内置 Workflow：缺的补上；内置定义的版本更新了就更新定义，但**保留用户设置的启用状态与优先级**。
    ///
    /// # Errors
    ///
    /// 存储错误。
    pub async fn sync_builtin(&self, builtins: Vec<Workflow>) -> Result<(), AppError> {
        let now = self.clock.now_utc();
        let mut tx = self.uow.begin().await?;
        for mut builtin in builtins {
            builtin.source = WorkflowSource::Builtin;
            match tx.workflows().get(&builtin.id).await? {
                None => tx.workflows().upsert(&builtin, now).await?,
                Some(existing) if existing.workflow.version < builtin.version => {
                    builtin.enabled = existing.workflow.enabled;
                    builtin.priority = existing.workflow.priority;
                    tx.workflows().upsert(&builtin, now).await?;
                }
                Some(_) => {}
            }
        }
        tx.commit().await?;
        Ok(())
    }

    /// 全部 Workflow（内置在前，其次用户的，各自按优先级从大到小再按 ID）。
    ///
    /// # Errors
    ///
    /// 存储错误。
    pub async fn list(&self) -> Result<Vec<StoredWorkflow>, AppError> {
        let mut tx = self.uow.begin().await?;
        let mut all = tx.workflows().list().await?;
        all.sort_by(|a, b| {
            let rank = |w: &StoredWorkflow| u8::from(w.workflow.source != WorkflowSource::Builtin);
            rank(a)
                .cmp(&rank(b))
                .then(b.workflow.priority.cmp(&a.workflow.priority))
                .then(a.workflow.id.cmp(&b.workflow.id))
        });
        Ok(all)
    }

    /// 读取一个 Workflow。
    ///
    /// # Errors
    ///
    /// `WORKFLOW_NOT_FOUND`；存储错误。
    pub async fn get(&self, id: &WorkflowId) -> Result<StoredWorkflow, AppError> {
        let mut tx = self.uow.begin().await?;
        tx.workflows().get(id).await?.ok_or_else(|| not_found(id))
    }

    /// 启用 / 禁用（内置 Workflow 也可以）。
    ///
    /// # Errors
    ///
    /// `WORKFLOW_NOT_FOUND`；存储错误。
    pub async fn set_enabled(&self, id: &WorkflowId, enabled: bool) -> Result<(), AppError> {
        self.modify(id, |workflow| workflow.enabled = enabled).await
    }

    /// 调整优先级（内置 Workflow 也可以）。
    ///
    /// # Errors
    ///
    /// `WORKFLOW_NOT_FOUND`；存储错误。
    pub async fn set_priority(&self, id: &WorkflowId, priority: i32) -> Result<(), AppError> {
        self.modify(id, |workflow| workflow.priority = priority)
            .await
    }

    /// 读取、修改状态字段、写回。
    async fn modify(
        &self,
        id: &WorkflowId,
        change: impl FnOnce(&mut Workflow),
    ) -> Result<(), AppError> {
        let now = self.clock.now_utc();
        let mut tx = self.uow.begin().await?;
        let mut stored = tx.workflows().get(id).await?.ok_or_else(|| not_found(id))?;
        change(&mut stored.workflow);
        tx.workflows().upsert(&stored.workflow, now).await?;
        tx.commit().await?;
        Ok(())
    }

    /// 复制一个 Workflow 成用户的副本：新 ID、名称带「副本」、来源为 User，优先级比原来高，
    /// 这样复制出来改好之后会优先于原来的生效（产品文档 §14「Duplicate → Customize」）。
    ///
    /// # Errors
    ///
    /// `WORKFLOW_NOT_FOUND`；存储错误。
    pub async fn duplicate(&self, id: &WorkflowId) -> Result<Workflow, AppError> {
        let now = self.clock.now_utc();
        let mut tx = self.uow.begin().await?;
        let original = tx.workflows().get(id).await?.ok_or_else(|| not_found(id))?;
        let existing: Vec<WorkflowId> = tx
            .workflows()
            .list()
            .await?
            .into_iter()
            .map(|s| s.workflow.id)
            .collect();
        let base = id
            .as_str()
            .trim_start_matches("builtin.")
            .trim_start_matches("user.");
        let mut copy = original.workflow;
        let mut n = 1;
        let new_id = loop {
            let suffix = if n == 1 {
                "copy".to_owned()
            } else {
                format!("copy-{n}")
            };
            let candidate = format!("user.{base}-{suffix}");
            let candidate = WorkflowId::new(&candidate.chars().take(64).collect::<String>())
                .map_err(|e| AppError::new(ErrorCode::WorkflowInvalid, e.to_string()))?;
            if !existing.contains(&candidate) {
                break candidate;
            }
            n += 1;
        };
        copy.id = new_id;
        copy.name = format!("{} 副本", copy.name);
        copy.source = WorkflowSource::User;
        copy.version = 1;
        copy.enabled = true;
        copy.priority = copy.priority.saturating_add(10);
        tx.workflows().upsert(&copy, now).await?;
        tx.commit().await?;
        Ok(copy)
    }

    /// 保存用户的 Workflow（新建或修改）。内置 Workflow 不能被修改；保存前做深度校验。
    ///
    /// # Errors
    ///
    /// * `WORKFLOW_INVALID` - 校验没通过（消息里带位置）。
    /// * `WORKFLOW_READ_ONLY` - 试图覆盖内置 Workflow。
    /// * 存储错误。
    pub async fn save(&self, mut workflow: Workflow) -> Result<Workflow, AppError> {
        self.engine
            .validate(&workflow)
            .map_err(|issues| invalid(&issues))?;
        let now = self.clock.now_utc();
        let mut tx = self.uow.begin().await?;
        if let Some(existing) = tx.workflows().get(&workflow.id).await?
            && existing.workflow.source == WorkflowSource::Builtin
        {
            return Err(AppError::new(
                ErrorCode::WorkflowReadOnly,
                "内置 Workflow 不能修改，请先复制一份",
            ));
        }
        if workflow.source == WorkflowSource::Builtin {
            // 用户保存的永远不是内置的。
            workflow.source = WorkflowSource::User;
        }
        tx.workflows().upsert(&workflow, now).await?;
        tx.commit().await?;
        Ok(workflow)
    }

    /// 从 JSON 文本导入一份定义并保存（来源标为 Imported）。
    ///
    /// # Errors
    ///
    /// `WORKFLOW_INVALID`、`WORKFLOW_READ_ONLY`；存储错误。
    pub async fn import(&self, json: &str) -> Result<Workflow, AppError> {
        let mut workflow = self.engine.parse(json).map_err(|issues| invalid(&issues))?;
        workflow.source = WorkflowSource::Imported;
        self.save(workflow).await
    }

    /// 保存编辑器提交的 JSON 定义（新建或覆盖用户 Workflow）。
    ///
    /// # Errors
    ///
    /// `WORKFLOW_INVALID`、`WORKFLOW_READ_ONLY`；存储错误。
    pub async fn save_json(&self, json: &str) -> Result<Workflow, AppError> {
        let workflow = self.engine.parse(json).map_err(|issues| invalid(&issues))?;
        self.save(workflow).await
    }

    /// 用 JSON 草稿试运行（见 [`Self::dry_run`]）。
    ///
    /// # Errors
    ///
    /// `WORKFLOW_INVALID`。
    pub async fn dry_run_json(
        &self,
        json: &str,
        input: &CaptureInput,
    ) -> Result<WorkflowRunResult, AppError> {
        let workflow = self.engine.parse(json).map_err(|issues| invalid(&issues))?;
        self.dry_run(&workflow, input).await
    }

    /// 删除用户的 Workflow。
    ///
    /// # Errors
    ///
    /// `WORKFLOW_NOT_FOUND`；内置的返回 `WORKFLOW_READ_ONLY`；存储错误。
    pub async fn delete(&self, id: &WorkflowId) -> Result<(), AppError> {
        let mut tx = self.uow.begin().await?;
        let stored = tx.workflows().get(id).await?.ok_or_else(|| not_found(id))?;
        if stored.workflow.source == WorkflowSource::Builtin {
            return Err(AppError::new(
                ErrorCode::WorkflowReadOnly,
                "内置 Workflow 不能删除，可以禁用它",
            ));
        }
        tx.workflows().delete(id).await?;
        tx.commit().await?;
        Ok(())
    }

    /// 试运行：用一份样例输入跑指定的 Workflow（可以是还没保存的草稿），返回会创建什么。
    ///
    /// **不写任何数据**——不创建 Item、不写运行记录。
    ///
    /// # Errors
    ///
    /// `WORKFLOW_INVALID`（草稿没通过校验）。
    pub async fn dry_run(
        &self,
        workflow: &Workflow,
        input: &CaptureInput,
    ) -> Result<WorkflowRunResult, AppError> {
        self.engine
            .validate(workflow)
            .map_err(|issues| invalid(&issues))?;
        let today = self.clock.today_local();
        Ok(self
            .engine
            .run(workflow, input, None, today, RunMode::Full)
            .await)
    }

    /// 最近的运行记录（新的在前）。
    ///
    /// # Errors
    ///
    /// 存储错误。
    pub async fn recent_runs(&self, limit: u32) -> Result<Vec<RunRecord>, AppError> {
        let mut tx = self.uow.begin().await?;
        Ok(tx.workflows().list_runs(limit).await?)
    }

    /// 清理超过保留策略的运行记录：只留最近 [`RUN_RETENTION_COUNT`] 条、且不早于 [`RUN_RETENTION_DAYS`] 天。
    /// 返回删除的条数。
    ///
    /// # Errors
    ///
    /// 存储错误。
    pub async fn prune_runs(&self) -> Result<u64, AppError> {
        let cutoff = self.clock.now_utc() - chrono::Duration::days(RUN_RETENTION_DAYS);
        let mut tx = self.uow.begin().await?;
        let removed = tx
            .workflows()
            .prune_runs(RUN_RETENTION_COUNT, cutoff)
            .await?;
        tx.commit().await?;
        Ok(removed)
    }
}

/// 生成运行记录 ID（UUIDv7 文本）。
#[must_use]
pub fn new_run_id(clock: &dyn Clock) -> String {
    new_uuid_v7(clock).to_string()
}

#[cfg(test)]
mod tests;
