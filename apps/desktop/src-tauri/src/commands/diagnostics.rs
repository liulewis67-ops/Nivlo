//! 诊断包导出 Command（实施计划 7.3）。

use asterjot_application::error::{AppError, ErrorCode};
use tauri::State;

use crate::app::AppState;
use crate::diagnostics::{self, Environment, WorkflowMeta};
use crate::dto::IpcError;

/// 导出失败：记日志，返回 `EXPORT_FAILED`。
fn export_failed(error: &dyn std::fmt::Display) -> IpcError {
    tracing::error!(event = "export_diagnostics_failed", %error, "导出诊断包失败");
    IpcError::from(AppError::new(ErrorCode::ExportFailed, error.to_string()))
}

/// 导出诊断包：运行环境、Workflow 元数据与最近的日志（已脱敏）打成一个 zip，
/// 写在导出目录里并在文件管理器中显示。返回 zip 的完整路径。
///
/// 不包含笔记 / 待办的标题与内容、剪贴板、用户文件、任何令牌（见 `diagnostics` 模块）。
///
/// # Errors
///
/// 读取或写入失败返回 `EXPORT_FAILED`。
#[tauri::command]
#[specta::specta]
pub async fn export_diagnostics(state: State<'_, AppState>) -> Result<String, IpcError> {
    let paths = state
        .runtime
        .paths()
        .cloned()
        .ok_or_else(|| export_failed(&"应用目录尚未就绪"))?;
    let workflows = state
        .services
        .workflows
        .list()
        .await?
        .iter()
        .map(|stored| WorkflowMeta {
            id: stored.workflow.id.to_string(),
            name: stored.workflow.name.clone(),
            source: format!("{:?}", stored.workflow.source).to_lowercase(),
            version: stored.workflow.version,
            enabled: stored.workflow.enabled,
            priority: stored.workflow.priority,
            step_count: stored.workflow.steps.len(),
            network: stored.workflow.uses_network(),
        })
        .collect();
    let now = state.runtime.clock.now_utc();
    let environment = Environment {
        app_version: env!("CARGO_PKG_VERSION").to_owned(),
        os: std::env::consts::OS.to_owned(),
        arch: std::env::consts::ARCH.to_owned(),
        webview_version: tauri::webview_version().ok(),
        schema_version: state
            .runtime
            .database()
            .schema_version()
            .await
            .ok()
            .flatten(),
        exported_at: now.to_rfc3339(),
        workflows,
    };
    let logs_dir = paths.logs_dir();
    let exports_dir = paths.exports_dir();
    let file_name = format!("asterjot-diagnostics-{}.zip", now.format("%Y%m%d-%H%M%S"));
    let written = tokio::task::spawn_blocking(move || {
        let logs = diagnostics::collect_logs(&logs_dir);
        let bytes = diagnostics::build_zip(&environment, &logs).map_err(|e| e.to_string())?;
        std::fs::create_dir_all(&exports_dir).map_err(|e| e.to_string())?;
        let target = exports_dir.join(file_name);
        std::fs::write(&target, bytes).map_err(|e| e.to_string())?;
        Ok::<_, String>(target)
    })
    .await
    .map_err(|e| export_failed(&e))?
    .map_err(|e| export_failed(&e))?;
    // 在文件管理器里选中它；打不开不影响导出本身。
    if let Err(error) = tauri_plugin_opener::reveal_item_in_dir(&written) {
        tracing::warn!(event = "reveal_export_failed", %error, "无法在文件管理器中显示诊断包");
    }
    Ok(written.to_string_lossy().into_owned())
}
