//! GitHub 集成（实施计划 9.4）：用 REST API 取 Issue / Pull Request 的详细信息。
//!
//! * **认证**：个人访问令牌（PAT），凭据库里按 `github` + `github.com` 保存；经 `Authorization: Bearer`
//!   附在请求上。配置 Token 后私有仓库也能读取；没有 Token 时返回 `NotConnected`，
//!   内置 Workflow 会继续走原有的匿名公开 API / 页面标题路径。
//! * **只访问 `api.github.com`**（GitHub Enterprise 不在本阶段范围）。
//! * **错误**：401 → 凭据失效（`Unauthorized`）；403 若是限流 → 可重试，否则当作凭据权限不足
//!   （`Unauthorized`，提示重新连接并检查 Token 的权限）；404 → 找不到，或私有仓库的 Token 没有权限
//!   （GitHub 对两者都返回 404）；5xx / 429 / 网络 → 可重试。

use std::collections::BTreeMap;
use std::sync::Arc;

use async_trait::async_trait;
use nivlo_application::ports::http::{HttpError, HttpRequest};
use nivlo_application::ports::integration::{
    Integration, IntegrationCall, IntegrationContext, IntegrationError, IntegrationOutput,
};
use nivlo_platform::credential::{CredentialKey, CredentialPort, Secret};
use serde_json::Value;

/// API 主机。
const API_HOST: &str = "api.github.com";

/// 凭据库里的账号标识（GitHub 只有一个公共实例）。
const ACCOUNT: &str = "github.com";

/// GitHub 集成。
pub struct GithubIntegration {
    /// 系统凭据库。
    credentials: Arc<dyn CredentialPort>,
}

impl GithubIntegration {
    /// 创建集成。
    #[must_use]
    pub fn new(credentials: Arc<dyn CredentialPort>) -> Self {
        Self { credentials }
    }
}

/// 仓库的 owner / name 是否合法（GitHub 允许字母、数字、`-`、`_`、`.`）。
fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 100
        && !matches!(name, "." | "..")
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
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

/// 取对象数组里每个元素的某个字符串字段，用逗号连接。
fn join(value: &Value, array: &str, field: &str) -> String {
    value
        .pointer(array)
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|item| item.get(field).and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join(",")
        })
        .unwrap_or_default()
}

/// 把 Issue / PR 的 JSON 映射成 Step 变量。
fn map_item(item: &Value, kind: &str) -> Result<IntegrationOutput, IntegrationError> {
    let title = text(item, "/title");
    if title.is_empty() {
        return Err(IntegrationError::Fatal("响应里没有标题".to_owned()));
    }
    // PR 的状态：已合并比 closed 更有用；草稿单独标出。
    let mut state = text(item, "/state");
    if item.pointer("/merged").and_then(Value::as_bool) == Some(true) {
        state = "merged".to_owned();
    }
    let draft = item.pointer("/draft").and_then(Value::as_bool) == Some(true);
    let mut out: BTreeMap<String, String> = BTreeMap::new();
    out.insert("kind".to_owned(), kind.to_owned());
    out.insert("title".to_owned(), title);
    out.insert("state".to_owned(), state);
    out.insert("draft".to_owned(), draft.to_string());
    out.insert("body".to_owned(), text(item, "/body"));
    out.insert("author".to_owned(), text(item, "/user/login"));
    out.insert("labels".to_owned(), join(item, "/labels", "name"));
    out.insert("assignees".to_owned(), join(item, "/assignees", "login"));
    out.insert("milestone".to_owned(), text(item, "/milestone/title"));
    out.insert("url".to_owned(), text(item, "/html_url"));
    Ok(out)
}

#[async_trait]
impl Integration for GithubIntegration {
    /// 标识。
    fn id(&self) -> &'static str {
        "github"
    }

    /// 显示名。
    fn display_name(&self) -> &'static str {
        "GitHub"
    }

    /// 支持的操作：`issue` / `pull`（参数 `owner`、`repo`、`number`）。
    async fn call(
        &self,
        call: &IntegrationCall,
        ctx: &IntegrationContext<'_>,
    ) -> Result<IntegrationOutput, IntegrationError> {
        let (kind, path) = match call.operation.as_str() {
            "issue" => ("issue", "issues"),
            "pull" => ("pull", "pulls"),
            other => {
                return Err(IntegrationError::InvalidInput(format!(
                    "GitHub 不支持操作 {other}"
                )));
            }
        };
        let param = |name: &str| call.params.get(name).map_or("", |v| v.trim());
        let (owner, repo, number) = (param("owner"), param("repo"), param("number"));
        if !valid_name(owner)
            || !valid_name(repo)
            || number.is_empty()
            || !number.chars().all(|c| c.is_ascii_digit())
            || number.len() > 10
        {
            return Err(IntegrationError::InvalidInput(
                "缺少合法的仓库或编号".to_owned(),
            ));
        }

        let credential_key = CredentialKey::new("github", ACCOUNT)
            .map_err(|_| IntegrationError::Fatal("凭据标识不合法".to_owned()))?;
        let secret = match self.credentials.get(&credential_key) {
            Ok(Some(secret)) => secret,
            Ok(None) => return Err(IntegrationError::NotConnected),
            Err(error) => {
                tracing::warn!(event = "github_credential_read_failed", %error, "读取 GitHub 凭据失败");
                return Err(IntegrationError::Fatal("无法读取系统凭据库".to_owned()));
            }
        };

        let url = format!("https://{API_HOST}/repos/{owner}/{repo}/{path}/{number}");
        let request = HttpRequest::get(url)
            .with_header(
                "Authorization",
                Secret::new(format!("Bearer {}", secret.expose())),
            )
            .with_header("Accept", Secret::new("application/vnd.github+json"))
            .with_header("X-GitHub-Api-Version", Secret::new("2022-11-28"));
        let response = ctx
            .http
            .get(&request, ctx.policy)
            .await
            .map_err(|e| http_error(&e))?;

        match response.status {
            200..=299 => {}
            401 => return Err(IntegrationError::Unauthorized),
            403 => {
                // 限流与权限不足都是 403，靠响应里的说明区分。
                let body = String::from_utf8_lossy(&response.body).to_ascii_lowercase();
                return Err(if body.contains("rate limit") {
                    IntegrationError::Retryable("GitHub 请求被限流".to_owned())
                } else {
                    IntegrationError::Unauthorized
                });
            }
            404 => {
                return Err(IntegrationError::Fatal(format!(
                    "找不到 {owner}/{repo}#{number}，或者当前的 Token 没有权限访问这个仓库"
                )));
            }
            429 => return Err(IntegrationError::Retryable("GitHub 请求被限流".to_owned())),
            500..=599 => {
                return Err(IntegrationError::Retryable("GitHub 暂时不可用".to_owned()));
            }
            other => {
                return Err(IntegrationError::Fatal(format!(
                    "GitHub 返回了错误（HTTP {other}）"
                )));
            }
        }
        let item: Value = serde_json::from_slice(&response.body)
            .map_err(|_| IntegrationError::Fatal("GitHub 的响应格式不认识".to_owned()))?;
        map_item(&item, kind)
    }
}

#[cfg(test)]
mod tests;
