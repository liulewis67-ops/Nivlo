//! Jira 集成（实施计划 9.3）：用 REST API 取一个 Issue 的完整字段。
//!
//! * **认证**：Jira Cloud（`*.atlassian.net`）用 Email + API Token（Basic，凭据库里保存 `email:token`）；
//!   Server / Data Center 用个人访问令牌 PAT（Bearer，凭据库里保存令牌本身）。凭据只在这里从
//!   [`CredentialPort`] 读取，经 [`HttpRequest::with_header`] 附在请求上，Workflow / 脚本 / 前端都拿不到。
//! * **接口版本**：统一用 REST v2——Cloud 与 Server / DC 都支持，`description` 是文本而不是 Cloud v3 的 ADF 文档。
//! * **内网 / 自托管**：用户**亲自连接过**的主机可以绕过 `HttpPort` 的私网地址限制（只对这个主机、
//!   只在这个集成里生效；重定向到别的内网地址仍然被拒绝）。
//! * **错误**：401 / 403 → [`IntegrationError::Unauthorized`]（界面提示重新连接）；没有凭据 →
//!   [`IntegrationError::NotConnected`]；404（不存在或没有权限，Jira 不区分）→ 确定性失败；
//!   429 / 5xx / 网络 → 可重试。降级链（API → 页面元数据 → URL + 标题）由内置 Workflow 的 Step 顺序实现。

use std::collections::BTreeMap;
use std::sync::Arc;

use async_trait::async_trait;
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use nivlo_application::ports::http::{HttpError, HttpRequest};
use nivlo_application::ports::integration::{
    Integration, IntegrationCall, IntegrationContext, IntegrationError, IntegrationOutput,
};
use nivlo_platform::credential::{CredentialKey, CredentialPort, Secret};
use serde_json::Value;

/// Jira Cloud 的主机后缀（Email + API Token）。
const CLOUD_SUFFIX: &str = ".atlassian.net";

/// 开始日期的自定义字段：Jira Cloud 的「Start date」默认是 `customfield_10015`。
const START_DATE_FIELD: &str = "customfield_10015";

/// Jira 集成。
pub struct JiraIntegration {
    /// 系统凭据库。
    credentials: Arc<dyn CredentialPort>,
}

impl JiraIntegration {
    /// 创建集成。
    #[must_use]
    pub fn new(credentials: Arc<dyn CredentialPort>) -> Self {
        Self { credentials }
    }
}

/// Issue Key 是否合法（`ABC-123`）。
fn valid_key(key: &str) -> bool {
    let Some((project, number)) = key.rsplit_once('-') else {
        return false;
    };
    let mut chars = project.chars();
    chars.next().is_some_and(|c| c.is_ascii_uppercase())
        && project
            .chars()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
        && !number.is_empty()
        && number.chars().all(|c| c.is_ascii_digit())
}

/// 主机（可带端口）是否合法：只允许字母、数字、`.`、`-`、`:`，不含路径 / 用户信息，避免拼出奇怪的 URL。
fn valid_host(host: &str) -> bool {
    !host.is_empty()
        && host.len() <= 200
        && host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':'))
}

/// 去掉端口，得到主机名（给私网豁免用）。
fn hostname(host: &str) -> &str {
    host.split(':').next().unwrap_or(host)
}

/// 构造 `Authorization` 头：Cloud 用 Basic，其余（Server / DC）用 Bearer PAT。
fn authorization(host: &str, secret: &Secret) -> Secret {
    if hostname(host).ends_with(CLOUD_SUFFIX) {
        Secret::new(format!("Basic {}", STANDARD.encode(secret.expose())))
    } else {
        Secret::new(format!("Bearer {}", secret.expose()))
    }
}

/// HTTP 层错误 → 集成错误。
fn http_error(error: &HttpError) -> IntegrationError {
    match error {
        HttpError::PermissionDenied { .. } => IntegrationError::PermissionDenied(error.to_string()),
        HttpError::InvalidUrl(message) => IntegrationError::InvalidInput(message.clone()),
        HttpError::Timeout => IntegrationError::Timeout,
        HttpError::Network(message) => IntegrationError::Retryable(message.clone()),
        HttpError::TooLarge | HttpError::TooManyRedirects => {
            IntegrationError::Fatal(error.to_string())
        }
    }
}

/// 取字符串字段；`null` / 缺失 / 非字符串都是空串。
fn text(value: &Value, pointer: &str) -> String {
    value
        .pointer(pointer)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

/// 把 Issue 的 JSON 映射成 Step 变量（缺失的字段为空串，配合模板的 `default` 使用）。
fn map_issue(
    issue: &Value,
    scheme: &str,
    host: &str,
) -> Result<IntegrationOutput, IntegrationError> {
    let key = text(issue, "/key");
    let title = text(issue, "/fields/summary");
    if key.is_empty() || title.is_empty() {
        return Err(IntegrationError::Fatal("响应里没有工单信息".to_owned()));
    }
    let labels = issue
        .pointer("/fields/labels")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join(",")
        })
        .unwrap_or_default();
    let mut out: BTreeMap<String, String> = BTreeMap::new();
    out.insert("url".to_owned(), format!("{scheme}://{host}/browse/{key}"));
    out.insert("key".to_owned(), key);
    out.insert("title".to_owned(), title);
    out.insert("description".to_owned(), text(issue, "/fields/description"));
    out.insert("status".to_owned(), text(issue, "/fields/status/name"));
    out.insert("priority".to_owned(), text(issue, "/fields/priority/name"));
    out.insert(
        "assignee".to_owned(),
        text(issue, "/fields/assignee/displayName"),
    );
    out.insert(
        "start".to_owned(),
        text(issue, &format!("/fields/{START_DATE_FIELD}")),
    );
    out.insert("due".to_owned(), text(issue, "/fields/duedate"));
    out.insert("labels".to_owned(), labels);
    out.insert("project".to_owned(), text(issue, "/fields/project/key"));
    out.insert(
        "project_name".to_owned(),
        text(issue, "/fields/project/name"),
    );
    Ok(out)
}

#[async_trait]
impl Integration for JiraIntegration {
    /// 标识。
    fn id(&self) -> &'static str {
        "jira"
    }

    /// 显示名。
    fn display_name(&self) -> &'static str {
        "Jira"
    }

    /// 支持的操作：`issue`（参数 `key`、`host`，可选 `scheme`）。
    async fn call(
        &self,
        call: &IntegrationCall,
        ctx: &IntegrationContext<'_>,
    ) -> Result<IntegrationOutput, IntegrationError> {
        if call.operation != "issue" {
            return Err(IntegrationError::InvalidInput(format!(
                "Jira 不支持操作 {}",
                call.operation
            )));
        }
        let param = |name: &str| call.params.get(name).map(|v| v.trim().to_owned());
        let key = param("key").unwrap_or_default();
        if !valid_key(&key) {
            return Err(IntegrationError::InvalidInput(
                "缺少合法的工单号（如 ABC-123）".to_owned(),
            ));
        }
        let host = param("host").unwrap_or_default().to_ascii_lowercase();
        if !valid_host(&host) {
            return Err(IntegrationError::InvalidInput(
                "缺少合法的 Jira 主机".to_owned(),
            ));
        }
        let scheme = match param("scheme").as_deref() {
            Some("http") => "http",
            _ => "https",
        };

        // 没有为这个主机保存过凭据 = 用户没有连接过它：不发任何请求。
        let credential_key = CredentialKey::new("jira", &host)
            .map_err(|_| IntegrationError::InvalidInput("Jira 主机不合法".to_owned()))?;
        let secret = match self.credentials.get(&credential_key) {
            Ok(Some(secret)) => secret,
            Ok(None) => return Err(IntegrationError::NotConnected),
            Err(error) => {
                tracing::warn!(event = "jira_credential_read_failed", %error, "读取 Jira 凭据失败");
                return Err(IntegrationError::Fatal("无法读取系统凭据库".to_owned()));
            }
        };

        let url = format!(
            "{scheme}://{host}/rest/api/2/issue/{key}?fields=summary,description,status,priority,assignee,duedate,labels,project,{START_DATE_FIELD}"
        );
        let request = HttpRequest::get(url)
            .with_header("Authorization", authorization(&host, &secret))
            .with_header("Accept", Secret::new("application/json"));
        // 用户连接过的内网 / 自托管主机可以绕过私网限制，其他地址不行。
        let policy = ctx
            .policy
            .clone()
            .with_configured_private_hosts([hostname(&host)]);
        let response = ctx
            .http
            .get(&request, &policy)
            .await
            .map_err(|e| http_error(&e))?;

        match response.status {
            200..=299 => {}
            401 | 403 => return Err(IntegrationError::Unauthorized),
            404 => {
                return Err(IntegrationError::Fatal(format!(
                    "找不到工单 {key}，或者没有权限查看"
                )));
            }
            429 => return Err(IntegrationError::Retryable("Jira 请求太频繁".to_owned())),
            500..=599 => return Err(IntegrationError::Retryable("Jira 暂时不可用".to_owned())),
            other => {
                return Err(IntegrationError::Fatal(format!(
                    "Jira 返回了错误（HTTP {other}）"
                )));
            }
        }
        let issue: Value = serde_json::from_slice(&response.body).map_err(|_| {
            // 登录失效时，部分自托管 Jira 会 200 返回登录页（HTML）：当作凭据失效。
            if response
                .content_type
                .as_deref()
                .is_some_and(|t| t.to_ascii_lowercase().contains("html"))
            {
                IntegrationError::Unauthorized
            } else {
                IntegrationError::Fatal("Jira 的响应格式不认识".to_owned())
            }
        })?;
        map_issue(&issue, scheme, &host)
    }
}

#[cfg(test)]
mod tests;
