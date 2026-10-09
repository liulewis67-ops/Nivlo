//! 窗口与应用生命周期相关的 Command。

use nivlo_application::error::{AppError, ErrorAction, ErrorCode};
use tauri::{AppHandle, Runtime};

use crate::dto::IpcError;
use crate::windows::show_main_window;

/// 打开（必要时创建）并聚焦主窗口。悬浮窗与主窗口都可以调用。
///
/// # Errors
///
/// 窗口创建或显示失败时返回 `WINDOW_UNAVAILABLE`（附带 `OPEN_DIAGNOSTICS` 动作）。
#[tauri::command]
#[specta::specta]
pub async fn open_main<R: Runtime>(app: AppHandle<R>) -> Result<(), IpcError> {
    show_main_window(&app).map_err(|error| {
        tracing::error!(event = "open_main_failed", %error, "打开主窗口失败");
        let mut app_error = AppError::new(ErrorCode::WindowUnavailable, error.to_string());
        app_error.action = Some(ErrorAction::OpenDiagnostics);
        IpcError::from(app_error)
    })
}

/// 退出应用：触发有序退出流程（后台任务停止、数据库关闭、日志刷写）。仅主窗口可调用。
///
/// 托盘菜单上线（实施计划 1.9）后，托盘的 Quit 走同一条路径。
#[tauri::command]
#[specta::specta]
pub async fn quit_app<R: Runtime>(app: AppHandle<R>) {
    app.exit(0);
}
