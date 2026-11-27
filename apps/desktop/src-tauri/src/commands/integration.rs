//! 集成连接管理相关的 Command（仅主窗口，实施计划 9.5）。
//!
//! 秘密只会**写入**系统凭据库：没有任何 Command 返回凭据内容，参数里的秘密也不会被日志记录。

use serde::{Deserialize, Serialize};
use specta::Type;
use starat_application::error::{AppError, ErrorCode};
use tauri::State;

use crate::app::AppState;
use crate::dto::IpcError;
use crate::integration_service::Connection;

/// 一个已连接的账号（IPC 表示；不含任何秘密）。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationConnectionDto {
    /// 集成标识（`jira` / `github`）。
    pub integration: String,
    /// 账号标识（Jira 的主机，GitHub 为 `github.com`）。
    pub account: String,
    /// `http` / `https`。
    pub scheme: String,
    /// 连接时间（RFC 3339，UTC）。
    pub connected_at: String,
    /// 最近一次测试连接的时间。
    pub last_checked_at: Option<String>,
    /// 最近一次测试失败的原因。
    pub last_error: Option<String>,
}

impl From<Connection> for IntegrationConnectionDto {
    /// 内部记录 → DTO。
    fn from(value: Connection) -> Self {
        Self {
            integration: value.integration,
            account: value.account,
            scheme: value.scheme,
            connected_at: value.connected_at,
            last_checked_at: value.last_checked_at,
            last_error: value.last_error,
        }
    }
}

/// 测试连接的结果（IPC 表示）。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationTestDto {
    /// `ok` / `notConnected` / `authFailed` / `permissionDenied` / `network` / `failed`。
    pub status: String,
    /// 说明（成功时是账号名）；不含任何凭据。
    pub message: String,
}

/// 全部已连接的账号。
///
/// # Errors
///
/// 存储失败时返回 [`IpcError`]。
#[tauri::command]
#[specta::specta]
pub async fn list_integrations(
    state: State<'_, AppState>,
) -> Result<Vec<IntegrationConnectionDto>, IpcError> {
    let all = state.services.integrations.list().await?;
    Ok(all.into_iter().map(Into::into).collect())
}

/// 连接（或更新凭据）。`account` 对 Jira 是地址，对 GitHub 被忽略；`secret` 对 Jira Cloud 是
/// `邮箱:API Token`，其余是令牌。秘密只写入系统凭据库，之后无法读回。
///
/// # Errors
///
/// 地址 / 凭据不合法返回 `INVALID_INPUT`；凭据库不可用返回 `SYSTEM_SETTING_FAILED`。
#[tauri::command]
#[specta::specta]
pub async fn connect_integration(
    state: State<'_, AppState>,
    integration: String,
    account: String,
    secret: String,
) -> Result<IntegrationConnectionDto, IpcError> {
    let connection = state
        .services
        .integrations
        .connect(&integration, &account, &secret)
        .await?;
    Ok(connection.into())
}

/// 断开：从系统凭据库删除凭据并移除记录。
///
/// # Errors
///
/// 凭据库不可用返回 `SYSTEM_SETTING_FAILED`（记录保留）。
#[tauri::command]
#[specta::specta]
pub async fn disconnect_integration(
    state: State<'_, AppState>,
    integration: String,
    account: String,
) -> Result<(), IpcError> {
    state
        .services
        .integrations
        .disconnect(&integration, &account)
        .await?;
    Ok(())
}

/// 测试连接：区分成功 / 没连接 / 认证失败 / 权限不足 / 网络问题 / 其他，并记下最近一次的结果。
///
/// # Errors
///
/// 集成不存在返回 `INVALID_INPUT`；存储失败返回存储错误。测试本身的失败体现在返回值里。
#[tauri::command]
#[specta::specta]
pub async fn test_integration(
    state: State<'_, AppState>,
    integration: String,
    account: String,
) -> Result<IntegrationTestDto, IpcError> {
    let outcome = state
        .services
        .integrations
        .test(&integration, &account)
        .await
        .map_err(|e: AppError| {
            if e.code == ErrorCode::InvalidInput {
                e
            } else {
                AppError::new(e.code, "测试连接失败")
            }
        })?;
    Ok(IntegrationTestDto {
        status: outcome.status().to_owned(),
        message: outcome.message(),
    })
}
