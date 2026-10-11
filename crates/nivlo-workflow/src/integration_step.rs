//! `integration` Step：调用一个已注册的第三方集成（实施计划 9.2）。
//!
//! 引擎在这里只认识 [`IntegrationRegistry`] 的抽象，没有任何 Jira / GitHub 的具体代码。
//! 凭据在集成适配器内部读取，认证信息由适配器附在请求上；Step 只拿到调用结果。
//!
//! 「还没连接」「凭据被拒绝（401 / 403）」统一变成 `UserActionRequired`，并携带
//! `OPEN_INTEGRATION_SETTINGS:<集成>` 动作：界面显示「需要连接 Jira」和跳转按钮，而不是 HTTP 错误堆栈。

use std::collections::BTreeMap;
use std::sync::Arc;

use async_trait::async_trait;
use nivlo_application::ports::http::{HostPolicy, HttpPort};
use nivlo_application::ports::integration::{
    IntegrationCall, IntegrationContext, IntegrationError, IntegrationRegistry,
};
use nivlo_application::workflow::FailureAction;
use nivlo_domain::workflow::Step;

use crate::executor::{ErrorKind, RunContext, StepError, StepExecutor, step_kind};

/// 没有网络组件时用的占位 Port：任何请求都失败。配合空的注册表，让引擎总能处理 `integration` Step。
pub struct UnavailableHttp;

#[async_trait]
impl HttpPort for UnavailableHttp {
    /// 总是失败。
    async fn get(
        &self,
        _request: &nivlo_application::ports::http::HttpRequest,
        _policy: &HostPolicy,
    ) -> Result<
        nivlo_application::ports::http::HttpResponse,
        nivlo_application::ports::http::HttpError,
    > {
        Err(nivlo_application::ports::http::HttpError::Network(
            "网络组件不可用".to_owned(),
        ))
    }
}

/// `integration` 的执行器。
pub struct IntegrationExecutor {
    /// 已注册的集成。
    registry: Arc<IntegrationRegistry>,
    /// 网络 Port（集成适配器经它发请求）。
    http: Arc<dyn HttpPort>,
}

impl IntegrationExecutor {
    /// 创建执行器。
    #[must_use]
    pub fn new(registry: Arc<IntegrationRegistry>, http: Arc<dyn HttpPort>) -> Self {
        Self { registry, http }
    }
}

/// 集成的错误 → Step 的错误（含界面的下一步动作）。
fn step_error(error: &IntegrationError, integration: &str, display_name: &str) -> StepError {
    let connect = || FailureAction::OpenIntegrationSettings {
        integration: integration.to_owned(),
    };
    match error {
        IntegrationError::NotConnected => StepError {
            kind: ErrorKind::UserActionRequired,
            message: format!("需要连接 {display_name}"),
            action: Some(connect()),
        },
        IntegrationError::Unauthorized => StepError {
            kind: ErrorKind::UserActionRequired,
            message: format!("{display_name} 的连接已失效，需要重新连接"),
            action: Some(connect()),
        },
        IntegrationError::PermissionDenied(message) => StepError {
            kind: ErrorKind::PermissionDenied,
            message: message.clone(),
            action: None,
        },
        IntegrationError::InvalidInput(message) => StepError::invalid(message.clone()),
        IntegrationError::Retryable(message) => StepError {
            kind: ErrorKind::Retryable,
            message: message.clone(),
            action: None,
        },
        IntegrationError::Timeout => StepError {
            kind: ErrorKind::Timeout,
            message: "请求超时".to_owned(),
            action: None,
        },
        IntegrationError::Fatal(message) => StepError::fatal(message.clone()),
    }
}

/// `optional` 时可以安静跳过的失败：连不上或没授权。配置错误（权限、参数）永远要报。
fn skippable(error: &IntegrationError) -> bool {
    matches!(
        error,
        IntegrationError::NotConnected
            | IntegrationError::Unauthorized
            | IntegrationError::Retryable(_)
            | IntegrationError::Timeout
    )
}

#[async_trait]
impl StepExecutor for IntegrationExecutor {
    /// 种类。
    fn kind(&self) -> &'static str {
        "integration"
    }

    /// 渲染参数 → 调用集成 → 把返回的字段写进 `vars.<into>_<字段>`。
    async fn execute(&self, step: &Step, ctx: &mut RunContext<'_>) -> Result<(), StepError> {
        let Step::Integration {
            integration,
            operation,
            params,
            into,
            optional,
        } = step
        else {
            return Err(StepError::fatal(format!(
                "Executor 收到了不属于它的 Step（{}）",
                step_kind(step)
            )));
        };
        if !ctx.network {
            // 即时运行：不联网，后续 Step 用 optional / default 兜底；联网的部分稍后在后台补全。
            return Ok(());
        }
        if !ctx.permissions.network {
            return Err(StepError {
                kind: ErrorKind::PermissionDenied,
                message: "这个 Workflow 没有声明网络权限".to_owned(),
                action: None,
            });
        }
        let Some(adapter) = self.registry.get(integration) else {
            // 可选的 Step 引用了没有注册的集成（比如网络组件初始化失败）：当作没有连接，直接跳过。
            if *optional {
                return Ok(());
            }
            return Err(StepError::fatal(format!("没有名为 {integration} 的集成")));
        };
        let mut rendered = BTreeMap::new();
        for (name, template) in params {
            rendered.insert(name.clone(), ctx.render(template)?);
        }
        let call = IntegrationCall {
            operation: operation.clone(),
            params: rendered,
        };
        let policy = HostPolicy::new(&ctx.permissions.hosts);
        let outcome = adapter
            .call(
                &call,
                &IntegrationContext {
                    http: self.http.as_ref(),
                    policy: &policy,
                },
            )
            .await;
        match outcome {
            Ok(fields) => {
                for (name, value) in fields {
                    ctx.scope.insert(format!("vars.{into}_{name}"), value);
                }
                Ok(())
            }
            Err(error) if *optional && skippable(&error) => {
                tracing::debug!(
                    event = "integration_step_skipped",
                    integration = integration.as_str(),
                    "可选的 integration Step 被跳过"
                );
                // 凭据失效（曾经连接过）：降级继续，但要提示用户重新连接。从没连接过不打扰。
                if matches!(error, IntegrationError::Unauthorized) && ctx.notice.is_none() {
                    let failure = step_error(&error, integration, adapter.display_name());
                    ctx.notice = Some((failure.message, failure.action));
                }
                Ok(())
            }
            Err(error) => Err(step_error(&error, integration, adapter.display_name())),
        }
    }
}
