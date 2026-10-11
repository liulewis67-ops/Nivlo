//! 第三方服务集成（`Integration`、`IntegrationRegistry`，实施计划 9.2）。
//!
//! Workflow 引擎只认识这里的抽象：一个 `integration` Step 带着「集成名 + 操作 + 参数」来调用，
//! 引擎里没有任何 Jira / GitHub 的具体代码；具体集成（9.3、9.4）在 `nivlo-integrations` 里实现
//! [`Integration`] 并注册到 [`IntegrationRegistry`]。
//!
//! 凭据只在集成适配器内部读取（经 `CredentialPort`），再通过 [`HttpRequest::with_header`] 附在请求上——
//! 引擎、脚本和前端都拿不到。没有凭据 / 被拒绝（401、403）统一表现为
//! [`IntegrationError::NotConnected`] / [`IntegrationError::Unauthorized`]，界面据此提示「需要连接 Jira」
//! 并提供跳转到集成设置的按钮，而不是显示 HTTP 错误堆栈。
//!
//! [`HttpRequest::with_header`]: crate::ports::http::HttpRequest::with_header

use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

use async_trait::async_trait;

use crate::ports::http::{HostPolicy, HttpPort};

/// 一次集成调用。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IntegrationCall {
    /// 操作名，如 `issue`（取一个 Issue）。
    pub operation: String,
    /// 参数（已经渲染好的文本）。
    pub params: BTreeMap<String, String>,
}

/// 集成调用的结果：字段名 → 文本，Step 把它们写进 `vars.<into>_<字段>`。
pub type IntegrationOutput = BTreeMap<String, String>;

/// 集成调用失败。
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum IntegrationError {
    /// 还没有连接（没有保存凭据）。
    #[error("还没有连接")]
    NotConnected,
    /// 凭据被服务拒绝（401 / 403）：过期、撤销或权限不够。
    #[error("凭据被拒绝，需要重新连接")]
    Unauthorized,
    /// 访问被权限策略拒绝（主机没有声明）。
    #[error("没有访问权限：{0}")]
    PermissionDenied(String),
    /// 参数不对（缺少必填参数、操作不存在）。
    #[error("{0}")]
    InvalidInput(String),
    /// 暂时性失败（网络、限流、服务端 5xx），重试可能成功。
    #[error("{0}")]
    Retryable(String),
    /// 超时。
    #[error("请求超时")]
    Timeout,
    /// 确定性失败。
    #[error("{0}")]
    Fatal(String),
}

/// 调用时可用的基础设施。
pub struct IntegrationContext<'a> {
    /// 网络 Port。
    pub http: &'a dyn HttpPort,
    /// Workflow 声明的主机策略；每个请求（含重定向）都要过它。
    pub policy: &'a HostPolicy,
}

/// 一个集成（Jira、GitHub……）。
#[async_trait]
pub trait Integration: Send + Sync {
    /// 稳定的标识（小写，如 `jira`），Workflow 里用它引用。
    fn id(&self) -> &'static str;

    /// 面向用户的名称（如 `Jira`），用于「需要连接 Jira」之类的提示。
    fn display_name(&self) -> &'static str;

    /// 执行一次调用。
    ///
    /// # Errors
    ///
    /// 见 [`IntegrationError`]。
    async fn call(
        &self,
        call: &IntegrationCall,
        ctx: &IntegrationContext<'_>,
    ) -> Result<IntegrationOutput, IntegrationError>;
}

/// 已注册的集成。
#[derive(Default, Clone)]
pub struct IntegrationRegistry {
    /// 标识 → 集成。
    map: HashMap<&'static str, Arc<dyn Integration>>,
}

impl IntegrationRegistry {
    /// 空注册表。
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// 注册一个集成（同一标识后注册的覆盖先注册的）。
    pub fn register(&mut self, integration: Arc<dyn Integration>) {
        self.map.insert(integration.id(), integration);
    }

    /// 按标识查找。
    #[must_use]
    pub fn get(&self, id: &str) -> Option<&Arc<dyn Integration>> {
        self.map.get(id)
    }

    /// 已注册的标识（排序后，便于显示与测试）。
    #[must_use]
    pub fn ids(&self) -> Vec<&'static str> {
        let mut ids: Vec<&'static str> = self.map.keys().copied().collect();
        ids.sort_unstable();
        ids
    }
}

impl std::fmt::Debug for IntegrationRegistry {
    /// 只列出标识。
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("IntegrationRegistry")
            .field("ids", &self.ids())
            .finish()
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    /// 只回显参数的假集成。
    struct Echo;

    #[async_trait]
    impl Integration for Echo {
        fn id(&self) -> &'static str {
            "echo"
        }

        fn display_name(&self) -> &'static str {
            "Echo"
        }

        async fn call(
            &self,
            call: &IntegrationCall,
            _ctx: &IntegrationContext<'_>,
        ) -> Result<IntegrationOutput, IntegrationError> {
            Ok(call.params.clone())
        }
    }

    #[test]
    fn the_registry_finds_what_was_registered() {
        let mut registry = IntegrationRegistry::new();
        assert!(registry.get("echo").is_none());
        registry.register(Arc::new(Echo));
        assert_eq!(registry.ids(), ["echo"]);
        assert_eq!(registry.get("echo").unwrap().display_name(), "Echo");
    }
}
