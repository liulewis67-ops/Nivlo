//! `http` Step：经 [`HttpPort`] 发一个受权限约束的 GET 请求（实施计划 6.1）。
//!
//! Engine 不认识网络——这个 Executor 持有 Port，策略来自 Workflow 声明的 `permissions.hosts`。
//! `optional: true` 时，网络失败 / 超时 / 非 2xx 不算错误（离线时仍然能创建 Item）；
//! 权限问题（主机没声明、地址不合法）永远是错误，因为那是 Workflow 自己写错了。

use std::sync::Arc;

use async_trait::async_trait;
use nivlo_application::ports::http::{HostPolicy, HttpError, HttpPort, HttpRequest};
use nivlo_domain::workflow::Step;

use crate::executor::{ErrorKind, RunContext, StepError, StepExecutor, step_kind};

/// `http` 的执行器。
pub struct HttpExecutor {
    /// 网络 Port。
    port: Arc<dyn HttpPort>,
}

impl HttpExecutor {
    /// 创建执行器。
    #[must_use]
    pub fn new(port: Arc<dyn HttpPort>) -> Self {
        Self { port }
    }
}

/// Port 的错误 → Step 的错误分类。
fn step_error(error: &HttpError) -> StepError {
    let kind = match error {
        HttpError::PermissionDenied { .. } => ErrorKind::PermissionDenied,
        HttpError::InvalidUrl(_) => ErrorKind::InvalidInput,
        HttpError::Timeout => ErrorKind::Timeout,
        HttpError::Network(_) => ErrorKind::Retryable,
        HttpError::TooLarge | HttpError::TooManyRedirects => ErrorKind::Fatal,
    };
    StepError {
        kind,
        message: error.to_string(),
        action: None,
    }
}

/// 非 2xx 状态码 → Step 的错误分类。
fn status_error(status: u16) -> StepError {
    let (kind, message) = match status {
        401 | 403 => (ErrorKind::UserActionRequired, "需要登录或没有访问权限"),
        429 => (ErrorKind::Retryable, "请求太频繁，被对方限流了"),
        500..=599 => (ErrorKind::Retryable, "对方服务暂时不可用"),
        _ => (ErrorKind::Fatal, "对方返回了错误"),
    };
    StepError {
        kind,
        message: format!("{message}（HTTP {status}）"),
        action: None,
    }
}

#[async_trait]
impl StepExecutor for HttpExecutor {
    /// 种类。
    fn kind(&self) -> &'static str {
        "http"
    }

    /// 发请求，正文存进 `vars.<into>`，最终地址存进 `vars.<into>_url`。
    async fn execute(&self, step: &Step, ctx: &mut RunContext<'_>) -> Result<(), StepError> {
        let Step::Http {
            url,
            into,
            optional,
            max_bytes,
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
        let target = ctx.render(url)?;
        let policy = HostPolicy::new(&ctx.permissions.hosts);
        let mut request = HttpRequest::get(target);
        if let Some(limit) = max_bytes {
            // 只能调小，不能超过默认上限。
            request.max_bytes = request
                .max_bytes
                .min(usize::try_from(*limit).unwrap_or(usize::MAX))
                .max(1);
        }
        let outcome = self.port.get(&request, &policy).await;
        let response = match outcome {
            Ok(response) if response.is_success() => response,
            Ok(response) if *optional => {
                tracing::debug!(
                    event = "http_step_skipped",
                    status = response.status,
                    "可选的 http Step 被跳过"
                );
                return Ok(());
            }
            Ok(response) => return Err(status_error(response.status)),
            // 配置错误（主机没声明、地址不合法）不会因为 optional 被吞掉。
            Err(error @ (HttpError::PermissionDenied { .. } | HttpError::InvalidUrl(_))) => {
                return Err(step_error(&error));
            }
            Err(error) if *optional => {
                tracing::debug!(event = "http_step_skipped", reason = %error, "可选的 http Step 被跳过");
                return Ok(());
            }
            Err(error) => return Err(step_error(&error)),
        };
        ctx.scope
            .insert(format!("vars.{into}_url"), response.final_url.clone());
        ctx.scope.insert(format!("vars.{into}"), response.text());
        Ok(())
    }
}
