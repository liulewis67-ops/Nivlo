//! 集成的连接管理（实施计划 9.5）：连接、测试连接、断开，以及连接状态与最近一次错误。
//!
//! * **秘密只在系统凭据库里**：Token / 密码经 [`CredentialPort`] 保存与删除；`settings` 表里的
//!   `integrations.connections` 只存非秘密的元数据（集成、账号、协议、连接时间、最近一次测试结果）。
//! * 前端只能「写入」凭据，没有任何接口读回它。
//! * 测试连接由对应的 [`Integration::test_connection`](asterjot_application::ports::integration::Integration::test_connection) 完成，并把结果区分成：成功 / 没连接 /
//!   认证失败 / 权限不足 / 网络问题 / 其他。

use std::sync::Arc;

use asterjot_application::error::{AppError, ErrorCode};
use asterjot_application::ports::http::{HostPolicy, HttpPort};
use asterjot_application::ports::integration::{
    IntegrationContext, IntegrationError, IntegrationRegistry,
};
use asterjot_application::settings::{SettingsService, keys};
use asterjot_common::clock::Clock;
use asterjot_platform::credential::{CredentialKey, CredentialPort, Secret};
use chrono::SecondsFormat;
use serde::{Deserialize, Serialize};

/// 秘密允许的最大长度（PAT / API Token 都远小于此）。
const MAX_SECRET_CHARS: usize = 2000;

/// 一个已连接的账号（只含非秘密信息，存进 `settings` 表）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Connection {
    /// 集成标识（`jira` / `github`）。
    pub integration: String,
    /// 账号标识：Jira 是主机（可带端口），GitHub 固定为 `github.com`。
    pub account: String,
    /// `http` / `https`（内网 Jira 可能只有 http）。
    pub scheme: String,
    /// 连接时间（RFC 3339）。
    pub connected_at: String,
    /// 最近一次测试连接的时间。
    #[serde(default)]
    pub last_checked_at: Option<String>,
    /// 最近一次测试失败的原因；成功后清空。
    #[serde(default)]
    pub last_error: Option<String>,
}

/// 测试连接的结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TestOutcome {
    /// 成功，附账号名。
    Ok(String),
    /// 还没有保存凭据。
    NotConnected,
    /// 认证失败（Token 无效 / 过期）。
    AuthFailed,
    /// 凭据有效但权限不足。
    PermissionDenied(String),
    /// 网络问题（连不上、超时、服务暂时不可用）。
    Network(String),
    /// 其他失败。
    Failed(String),
}

impl TestOutcome {
    /// 稳定的状态文本（IPC 与界面使用）。
    #[must_use]
    pub fn status(&self) -> &'static str {
        match self {
            Self::Ok(_) => "ok",
            Self::NotConnected => "notConnected",
            Self::AuthFailed => "authFailed",
            Self::PermissionDenied(_) => "permissionDenied",
            Self::Network(_) => "network",
            Self::Failed(_) => "failed",
        }
    }

    /// 面向用户的说明（不含任何凭据）。
    #[must_use]
    pub fn message(&self) -> String {
        match self {
            Self::Ok(account) => account.clone(),
            Self::NotConnected => "还没有连接".to_owned(),
            Self::AuthFailed => "认证失败：Token 无效或已过期".to_owned(),
            Self::PermissionDenied(message) | Self::Network(message) | Self::Failed(message) => {
                message.clone()
            }
        }
    }
}

/// 集成连接管理。
#[derive(Clone)]
pub struct IntegrationService {
    /// 设置（保存非秘密的连接元数据）。
    settings: SettingsService,
    /// 系统凭据库（秘密只在这里）。
    credentials: Arc<dyn CredentialPort>,
    /// 已注册的集成。
    registry: Arc<IntegrationRegistry>,
    /// 网络 Port（测试连接用）；初始化失败时为 `None`。
    http: Option<Arc<dyn HttpPort>>,
    /// 时钟。
    clock: Arc<dyn Clock>,
}

/// 凭据库 / 设置的失败：记日志（不含秘密），返回通用错误。
fn store_failed(what: &str, error: &dyn std::fmt::Display) -> AppError {
    tracing::warn!(event = "integration_store_failed", what, %error, "集成连接信息读写失败");
    AppError::new(ErrorCode::SystemSettingFailed, format!("{what}失败"))
}

/// 凭据库里的账号标识：Jira 把连接协议编进去（见 `asterjot_integrations::jira_credential_account`），其他集成就是账号本身。
fn credential_key(
    integration: &str,
    scheme: &str,
    account: &str,
) -> Result<CredentialKey, AppError> {
    let stored = if integration == "jira" {
        asterjot_integrations::jira_credential_account(scheme, account)
    } else {
        account.to_owned()
    };
    CredentialKey::new(integration, &stored).map_err(|_| invalid("账号不合法"))
}

/// 校验失败。
fn invalid(message: &str) -> AppError {
    AppError::new(ErrorCode::InvalidInput, message)
}

/// 把用户填写的 Jira 地址整理成 (协议, 主机[:端口])：接受 `https://acme.atlassian.net/`、`jira.corp:8080`。
fn parse_jira_account(input: &str) -> Result<(String, String), AppError> {
    let trimmed = input.trim();
    let (scheme, rest) = if let Some(rest) = trimmed.strip_prefix("https://") {
        ("https", rest)
    } else if let Some(rest) = trimmed.strip_prefix("http://") {
        ("http", rest)
    } else {
        ("https", trimmed)
    };
    let host = rest
        .split(['/', '?', '#'])
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    let valid = !host.is_empty()
        && host.len() <= 200
        && host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':'));
    if valid {
        Ok((scheme.to_owned(), host))
    } else {
        Err(invalid(
            "请填写 Jira 的地址，例如 https://your-team.atlassian.net",
        ))
    }
}

impl IntegrationService {
    /// 创建服务。
    #[must_use]
    pub fn new(
        settings: SettingsService,
        credentials: Arc<dyn CredentialPort>,
        registry: Arc<IntegrationRegistry>,
        http: Option<Arc<dyn HttpPort>>,
        clock: Arc<dyn Clock>,
    ) -> Self {
        Self {
            settings,
            credentials,
            registry,
            http,
            clock,
        }
    }

    /// 读取全部连接（按集成、账号排序）。
    ///
    /// # Errors
    ///
    /// 存储失败时返回错误；内容损坏时视为没有连接（不让设置页打不开）。
    pub async fn list(&self) -> Result<Vec<Connection>, AppError> {
        let raw = self
            .settings
            .get(keys::INTEGRATION_CONNECTIONS)
            .await
            .map_err(|e| store_failed("读取连接信息", &e))?;
        let mut connections: Vec<Connection> = raw
            .as_deref()
            .and_then(|text| serde_json::from_str(text).ok())
            .unwrap_or_default();
        connections.sort_by(|a, b| (&a.integration, &a.account).cmp(&(&b.integration, &b.account)));
        Ok(connections)
    }

    /// 保存连接列表。
    async fn save(&self, connections: &[Connection]) -> Result<(), AppError> {
        let json =
            serde_json::to_string(connections).map_err(|e| store_failed("保存连接信息", &e))?;
        self.settings
            .set(keys::INTEGRATION_CONNECTIONS, &json)
            .await
            .map_err(|e| store_failed("保存连接信息", &e))
    }

    /// 连接（或更新凭据）：校验 → 秘密写入系统凭据库 → 记录元数据。
    ///
    /// `account` 对 Jira 是地址（`https://acme.atlassian.net`），对 GitHub 被忽略；
    /// `secret` 对 Jira Cloud 是 `邮箱:API Token`，其余是令牌本身。秘密不会被日志、设置表记录。
    ///
    /// # Errors
    ///
    /// 集成不存在 / 地址或凭据不合法返回 `INVALID_INPUT`；凭据库不可用返回 `SYSTEM_SETTING_FAILED`。
    pub async fn connect(
        &self,
        integration: &str,
        account: &str,
        secret: &str,
    ) -> Result<Connection, AppError> {
        if self.registry.get(integration).is_none() {
            return Err(invalid("不支持这个集成"));
        }
        let secret = secret.trim();
        if secret.is_empty() || secret.chars().count() > MAX_SECRET_CHARS {
            return Err(invalid("请填写有效的令牌"));
        }
        let (scheme, account) = match integration {
            "jira" => {
                let (scheme, host) = parse_jira_account(account)?;
                if host
                    .trim_end_matches(|c: char| c.is_ascii_digit() || c == ':')
                    .ends_with(".atlassian.net")
                    && !secret.contains(':')
                {
                    return Err(invalid("Jira Cloud 需要填写「邮箱:API Token」"));
                }
                (scheme, host)
            }
            _ => ("https".to_owned(), "github.com".to_owned()),
        };
        let key = credential_key(integration, &scheme, &account)?;
        // 同一个主机换了协议重新连接：旧协议的凭据要删掉，免得留下一份可能被用来降级的明文通道。
        if integration == "jira" {
            let other = if scheme == "http" { "https" } else { "http" };
            let _ = self
                .credentials
                .delete(&credential_key(integration, other, &account)?);
        }
        self.credentials
            .set(&key, &Secret::new(secret))
            .map_err(|e| store_failed("保存凭据", &e))?;

        let connection = Connection {
            integration: integration.to_owned(),
            account,
            scheme,
            connected_at: self
                .clock
                .now_utc()
                .to_rfc3339_opts(SecondsFormat::Secs, true),
            last_checked_at: None,
            last_error: None,
        };
        let mut all = self.list().await?;
        all.retain(|c| {
            !(c.integration == connection.integration && c.account == connection.account)
        });
        all.push(connection.clone());
        self.save(&all).await?;
        tracing::info!(event = "integration_connected", integration, "已连接集成");
        Ok(connection)
    }

    /// 断开：先从系统凭据库删除凭据，再移除记录。
    ///
    /// # Errors
    ///
    /// 凭据库不可用返回 `SYSTEM_SETTING_FAILED`（此时记录保留，避免出现「界面显示已断开、凭据还在」）。
    pub async fn disconnect(&self, integration: &str, account: &str) -> Result<(), AppError> {
        let mut all = self.list().await?;
        // 按记录里的协议找到凭据；没有记录时两种协议的凭据都尝试删除。
        let schemes: Vec<String> = match all
            .iter()
            .find(|c| c.integration == integration && c.account == account)
        {
            Some(c) => vec![c.scheme.clone()],
            None => vec!["https".to_owned(), "http".to_owned()],
        };
        for scheme in schemes {
            let key = credential_key(integration, &scheme, account)?;
            self.credentials
                .delete(&key)
                .map_err(|e| store_failed("删除凭据", &e))?;
        }
        all.retain(|c| !(c.integration == integration && c.account == account));
        self.save(&all).await?;
        tracing::info!(
            event = "integration_disconnected",
            integration,
            "已断开集成"
        );
        Ok(())
    }

    /// 测试连接，并把结果（时间与最近一次错误）记到连接记录上。
    ///
    /// # Errors
    ///
    /// 存储失败返回错误；测试本身的失败体现在返回的 [`TestOutcome`] 里。
    pub async fn test(&self, integration: &str, account: &str) -> Result<TestOutcome, AppError> {
        let Some(adapter) = self.registry.get(integration) else {
            return Err(invalid("不支持这个集成"));
        };
        let mut all = self.list().await?;
        let scheme = all
            .iter()
            .find(|c| c.integration == integration && c.account == account)
            .map_or_else(|| "https".to_owned(), |c| c.scheme.clone());
        let outcome = match &self.http {
            None => TestOutcome::Network("网络组件不可用".to_owned()),
            Some(http) => {
                let policy = HostPolicy::new(["*"]);
                let ctx = IntegrationContext {
                    http: http.as_ref(),
                    policy: &policy,
                };
                match adapter.test_connection(account, &scheme, &ctx).await {
                    Ok(name) => TestOutcome::Ok(name),
                    Err(IntegrationError::NotConnected) => TestOutcome::NotConnected,
                    Err(IntegrationError::Unauthorized) => TestOutcome::AuthFailed,
                    Err(IntegrationError::Forbidden(message)) => {
                        TestOutcome::PermissionDenied(message)
                    }
                    Err(IntegrationError::Retryable(message)) => TestOutcome::Network(message),
                    Err(IntegrationError::Timeout) => TestOutcome::Network("请求超时".to_owned()),
                    Err(other) => TestOutcome::Failed(other.to_string()),
                }
            }
        };
        let now = self
            .clock
            .now_utc()
            .to_rfc3339_opts(SecondsFormat::Secs, true);
        if let Some(connection) = all
            .iter_mut()
            .find(|c| c.integration == integration && c.account == account)
        {
            connection.last_checked_at = Some(now);
            connection.last_error = match &outcome {
                TestOutcome::Ok(_) => None,
                other => Some(other.message()),
            };
            self.save(&all).await?;
        }
        Ok(outcome)
    }
}

#[cfg(test)]
mod tests;
