//! 自动更新相关的 Command（仅主窗口，实施计划 7.6）。

use stardeskbox_application::error::{AppError, ErrorCode};
use tauri::{AppHandle, Runtime, State};

use crate::app::AppState;
use crate::backup;
use crate::dto::IpcError;
use crate::updates::{self, UpdateInfoDto};

/// 更新失败：记日志（只含系统给的原因），返回 `UPDATE_FAILED`。
fn failed(what: &str, reason: &str) -> IpcError {
    tracing::warn!(event = "update_failed", what, reason, "更新失败");
    IpcError::from(AppError::new(
        ErrorCode::UpdateFailed,
        format!("{what}：{reason}"),
    ))
}

/// 检查更新：有新版本时返回版本与说明，已经是最新返回 `null`。
///
/// # Errors
///
/// 更新服务器连不上或清单不合法时返回 `UPDATE_FAILED`。
#[tauri::command]
#[specta::specta]
pub async fn check_for_update<R: Runtime>(
    app: AppHandle<R>,
) -> Result<Option<UpdateInfoDto>, IpcError> {
    updates::check(&app)
        .await
        .map_err(|e| failed("检查更新失败", &e))
}

/// 安装更新并重启：先为当前数据做一份备份，再下载、校验签名、安装，最后重启应用。
///
/// # Errors
///
/// 备份失败（此时不安装）、下载或签名校验失败时返回 `UPDATE_FAILED`，当前版本保持不变。
#[tauri::command]
#[specta::specta]
pub async fn install_update<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
) -> Result<(), IpcError> {
    let paths = state
        .runtime
        .paths()
        .cloned()
        .ok_or_else(|| failed("更新失败", "应用目录尚未就绪"))?;
    let now = state.runtime.clock.now_utc();
    let name = format!(
        "stardeskbox-before-update-{}.zip",
        now.format("%Y%m%d-%H%M%S")
    );
    // 升级之前先留一份可恢复的备份；备份不成功就不升级。
    backup::create_backup(
        &state.runtime.database(),
        &paths,
        &name,
        &now.to_rfc3339(),
        env!("CARGO_PKG_VERSION"),
    )
    .await
    .map_err(|e| failed("更新前备份失败", &e.to_string()))?;
    updates::download_and_install(&app)
        .await
        .map_err(|e| failed("安装更新失败", &e))?;
    app.restart();
}
