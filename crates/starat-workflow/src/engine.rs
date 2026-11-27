//! Engine：按顺序执行一个 Workflow 的 Step（实施计划 5.3、架构文档 §18–20、§28）。
//!
//! * **线性管道**：没有分支图。Fatal 错误短路；`condition` 不满足时停止后续 Step（已有产出保留）；
//! * 支持整体超时与取消（[`CancellationToken`]）；
//! * 返回每个 Step 的记录（种类、状态、耗时、说明），供 Run 记录与「试运行」展示；
//! * Engine 里**没有任何具体领域逻辑**：它只认识 [`StepExecutor`](crate::executor::StepExecutor) 与变量表；
//! * 不碰数据库、文件系统、网络——产出的是待创建的 [`ItemDraft`]，由 Application 层在事务里落库。
//!   因此「试运行」就是照常运行 Engine 再把草稿丢掉，不可能有副作用。

use starat_application::workflow::FailureAction;
use std::sync::Arc;
use std::time::{Duration, Instant};

use chrono::NaiveDate;
use starat_domain::workflow::{Step, Workflow};
use tokio_util::sync::CancellationToken;

use crate::executor::{
    ErrorKind, ExecutorRegistry, ItemDraft, RunContext, StepError, push_tag, step_kind,
};
use crate::facts::{InputFacts, files_of};
use crate::pattern::RegexCache;

/// 一次运行的默认总超时。
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(5);

/// 一个 Step 的执行结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StepStatus {
    /// 成功。
    Ok,
    /// 因为前面的 `condition` 不满足而被跳过。
    Skipped,
    /// 失败。
    Failed,
}

/// 一个 Step 的运行记录。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StepRecord {
    /// 第几个 Step（从 0 开始）。
    pub index: usize,
    /// 种类名。
    pub kind: &'static str,
    /// 结果。
    pub status: StepStatus,
    /// 耗时。
    pub duration: Duration,
    /// 失败原因。
    pub message: Option<String>,
    /// 脚本的 `console` 输出（只给试运行展示，不写入运行记录）。
    pub logs: Vec<String>,
}

/// 运行成功的结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunReport {
    /// 要创建的 Item（标签已套用 `addTag` 的结果）。
    pub drafts: Vec<ItemDraft>,
    /// 每个 Step 的记录。
    pub steps: Vec<StepRecord>,
    /// 是否因为 `condition` 不满足提前停止。
    pub stopped_early: bool,
    /// 运行成功但降级时的提示（如凭据失效）。
    pub notice: Option<(String, Option<FailureAction>)>,
}

/// 运行失败。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunFailure {
    /// 错误。
    pub error: StepError,
    /// 失败的 Step 序号；超时 / 取消时可能为 `None`。
    pub failed_step: Option<usize>,
    /// 到失败为止的记录。
    pub steps: Vec<StepRecord>,
}

/// 单次运行的选项。
#[derive(Debug, Clone)]
pub struct RunOptions {
    /// 取消令牌。
    pub cancel: CancellationToken,
    /// 「今天」（用户本地日期，`now.date` 变量）。
    pub today: NaiveDate,
    /// 是否允许联网；`false` 时 `http` Step 直接跳过。
    pub network: bool,
}

/// Workflow 引擎。
pub struct Engine {
    /// Step 执行器。
    registry: ExecutorRegistry,
    /// 正则缓存（Matcher 与 Step 共用）。
    regexes: Arc<RegexCache>,
    /// 整体超时。
    timeout: Duration,
}

impl Engine {
    /// 创建引擎。
    #[must_use]
    pub fn new(registry: ExecutorRegistry, regexes: Arc<RegexCache>, timeout: Duration) -> Self {
        Self {
            registry,
            regexes,
            timeout,
        }
    }

    /// 本阶段的标准配置：标准 Executor、新的正则缓存、默认超时。
    #[must_use]
    pub fn standard() -> Self {
        Self::new(
            ExecutorRegistry::standard(),
            Arc::new(RegexCache::new()),
            DEFAULT_TIMEOUT,
        )
    }

    /// 标准配置，外加 `readFile` Step（经给定的文件检查 Port）。
    #[must_use]
    pub fn with_ports(
        http: Option<Arc<dyn starat_application::ports::http::HttpPort>>,
        files: Option<Arc<dyn starat_application::ports::inspect::FileInspector>>,
    ) -> Self {
        let mut registry = ExecutorRegistry::standard();
        if let Some(port) = http {
            registry.register(Arc::new(crate::http_step::HttpExecutor::new(port)));
        }
        if let Some(port) = files {
            registry.register(Arc::new(crate::file_step::ReadFileExecutor::new(port)));
        }
        Self::new(registry, Arc::new(RegexCache::new()), DEFAULT_TIMEOUT)
    }

    /// 在已有配置上追加 `integration` Step（经给定的集成注册表与网络 Port）。
    #[must_use]
    pub fn with_integrations(
        mut self,
        registry: Arc<starat_application::ports::integration::IntegrationRegistry>,
        http: Arc<dyn starat_application::ports::http::HttpPort>,
    ) -> Self {
        self.registry
            .register(Arc::new(crate::integration_step::IntegrationExecutor::new(
                registry, http,
            )));
        self
    }

    /// 在已有配置上追加 `script` Step（经给定的 Script Worker、网络 Port 与授权记录）。
    #[must_use]
    pub fn with_script(
        mut self,
        worker: starat_script::ScriptHandle,
        http: Option<Arc<dyn starat_application::ports::http::HttpPort>>,
        grants: Arc<dyn crate::script_step::ScriptGrants>,
    ) -> Self {
        self.registry
            .register(Arc::new(crate::script_step::ScriptExecutor::new(
                worker, http, grants,
            )));
        self
    }

    /// 标准配置，外加 `http` Step（经给定的网络 Port）。
    #[must_use]
    pub fn with_http(port: Arc<dyn starat_application::ports::http::HttpPort>) -> Self {
        let mut registry = ExecutorRegistry::standard();
        registry.register(Arc::new(crate::http_step::HttpExecutor::new(port)));
        Self::new(registry, Arc::new(RegexCache::new()), DEFAULT_TIMEOUT)
    }

    /// 与 Matcher / Resolver 共用的正则缓存。
    #[must_use]
    pub fn regexes(&self) -> &RegexCache {
        &self.regexes
    }

    /// 运行一个 Workflow。
    ///
    /// # Errors
    ///
    /// 任一 Step 失败、整体超时或被取消时返回 [`RunFailure`]（带到失败为止的 Step 记录）。
    pub async fn run(
        &self,
        workflow: &Workflow,
        facts: &InputFacts<'_>,
        options: &RunOptions,
    ) -> Result<RunReport, RunFailure> {
        let mut steps: Vec<StepRecord> = Vec::with_capacity(workflow.steps.len());
        let work = self.run_steps(workflow, facts, options, &mut steps);
        let outcome = tokio::select! {
            result = tokio::time::timeout(self.timeout, work) => match result {
                Ok(inner) => inner,
                Err(_) => Err((
                    StepError {
                        kind: ErrorKind::Timeout,
                        message: format!("Workflow 超过 {} 秒仍未完成", self.timeout.as_secs()),
                        action: None,
                    },
                    None,
                )),
            },
            () = options.cancel.cancelled() => Err((StepError::fatal("已取消"), None)),
        };
        match outcome {
            Ok((drafts, stopped_early, notice)) => Ok(RunReport {
                drafts,
                steps,
                stopped_early,
                notice,
            }),
            Err((error, failed_step)) => Err(RunFailure {
                error,
                failed_step,
                steps,
            }),
        }
    }

    /// 依次执行 Step；`steps` 由调用方持有，这样超时 / 取消时仍然保留已经完成的记录。
    async fn run_steps(
        &self,
        workflow: &Workflow,
        facts: &InputFacts<'_>,
        options: &RunOptions,
        steps: &mut Vec<StepRecord>,
    ) -> Result<
        (
            Vec<ItemDraft>,
            bool,
            Option<(String, Option<FailureAction>)>,
        ),
        (StepError, Option<usize>),
    > {
        let mut ctx = RunContext {
            scope: facts.scope(options.today),
            drafts: Vec::new(),
            tags: Vec::new(),
            files: files_of(facts.input).into_iter().cloned().collect(),
            file_scopes: Vec::new(),
            regexes: &self.regexes,
            permissions: &workflow.permissions,
            network: options.network,
            stopped: false,
            logs: Vec::new(),
            notice: None,
        };
        for (index, step) in workflow.steps.iter().enumerate() {
            let kind = step_kind(step);
            // 即时运行（不联网）：`http` Step 直接跳过，不需要注册执行器；后续 Step 用 optional / default 兜底。
            if ctx.stopped
                || (!ctx.network && matches!(step, Step::Http { .. } | Step::Integration { .. }))
            {
                steps.push(StepRecord {
                    index,
                    kind,
                    status: StepStatus::Skipped,
                    duration: Duration::ZERO,
                    message: None,
                    logs: Vec::new(),
                });
                continue;
            }
            let started = Instant::now();
            let result = match self.registry.get(kind) {
                Some(executor) => executor.execute(step, &mut ctx).await,
                None => Err(StepError::fatal(format!("没有注册 {kind} 的执行器"))),
            };
            let duration = started.elapsed();
            match result {
                Ok(()) => steps.push(StepRecord {
                    index,
                    kind,
                    status: StepStatus::Ok,
                    duration,
                    message: None,
                    logs: std::mem::take(&mut ctx.logs),
                }),
                Err(error) => {
                    steps.push(StepRecord {
                        index,
                        kind,
                        status: StepStatus::Failed,
                        duration,
                        message: Some(error.message.clone()),
                        logs: std::mem::take(&mut ctx.logs),
                    });
                    return Err((error, Some(index)));
                }
            }
        }
        // `addTag` 的标签套用到全部草稿。
        let tags = ctx.tags.clone();
        let mut drafts = ctx.drafts;
        for draft in &mut drafts {
            for tag in &tags {
                push_tag(&mut draft.tags, tag.clone());
            }
        }
        Ok((drafts, ctx.stopped, ctx.notice))
    }
}

#[cfg(test)]
mod tests;
