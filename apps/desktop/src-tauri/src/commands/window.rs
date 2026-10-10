//! 窗口与应用生命周期相关的 Command。

use std::sync::Arc;

use nivlo_application::error::{AppError, ErrorAction, ErrorCode};
use nivlo_platform::error::PlatformError;
use tauri::{AppHandle, Runtime, State, WebviewWindow};
use tauri_specta::Event;

use crate::app::AppState;
use crate::dto::{ExpandFloatingRequest, ExpandedLayoutDto, IpcError};
use crate::events::MainViewRequestedEvent;
use crate::windows::floating::FloatingHandle;
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

/// 主窗口里可以被直接打开的视图。
const MAIN_VIEWS: &[&str] = &["inbox", "today", "calendar", "notes", "projects"];

/// 打开主窗口并切换到指定视图（悬浮窗上的收集箱入口）。
///
/// 视图先记在应用状态里，再通知已经在运行的主窗口：主窗口可能刚刚才被创建、还没来得及监听事件，
/// 这时它会在启动时取走记下的视图。
///
/// # Errors
///
/// 视图名不认识返回 `INVALID_INPUT`；窗口创建或显示失败返回 `WINDOW_UNAVAILABLE`。
#[tauri::command]
#[specta::specta]
pub async fn open_main_at<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    view: String,
) -> Result<(), IpcError> {
    if !MAIN_VIEWS.contains(&view.as_str()) {
        return Err(IpcError::from(AppError::new(
            ErrorCode::InvalidInput,
            format!("不认识的视图：{view}"),
        )));
    }
    state.runtime.set_pending_main_view(view.clone());
    open_main(app.clone()).await?;
    let event = MainViewRequestedEvent { view };
    if let Err(error) = event.emit_to(&app, crate::windows::MAIN_WINDOW_LABEL) {
        tracing::warn!(event = "main_view_event_failed", %error, "通知主窗口切换视图失败");
    }
    Ok(())
}

/// 取走悬浮窗请求主窗口打开的视图（主窗口启动时调用一次）；没有请求时为 `None`。
#[tauri::command]
#[specta::specta]
pub async fn take_pending_main_view(
    state: State<'_, AppState>,
) -> Result<Option<String>, IpcError> {
    Ok(state.runtime.take_pending_main_view())
}

/// 退出应用：触发有序退出流程（后台任务停止、数据库关闭、日志刷写）。仅主窗口可调用。
///
/// 托盘菜单上线（实施计划 1.9）后，托盘的 Quit 走同一条路径。
#[tauri::command]
#[specta::specta]
pub async fn quit_app<R: Runtime>(app: AppHandle<R>) {
    app.exit(0);
}

/// 开始拖动悬浮窗（由悬浮窗在检测到"按下并移动超过阈值"之后调用）。
///
/// 把拖动交给操作系统的原生窗口拖动，保证跟手；拖动结束后的吸附与保存由
/// `FloatingController` 在收到连续的移动事件之后完成。窗口位置始终由 Rust 控制，
/// 前端不直接使用 window API 移动窗口（前端规范 §9）。
///
/// # Errors
///
/// 系统无法开始拖动（窗口已销毁等）时返回 `WINDOW_UNAVAILABLE`。
#[tauri::command]
#[specta::specta]
pub async fn start_floating_drag<R: Runtime>(window: WebviewWindow<R>) -> Result<(), IpcError> {
    window.start_dragging().map_err(|error| {
        tracing::warn!(event = "floating_drag_failed", %error, "开始拖动悬浮窗失败");
        IpcError::from(AppError::new(
            ErrorCode::WindowUnavailable,
            error.to_string(),
        ))
    })
}

/// 把悬浮窗展开为 Today 面板（Hover 展开时调用）。
///
/// 这是窗口几何命令，**不查询任何业务数据**：Hover 期间唯一允许发出的 IPC 就是
/// 展开 / 收起（前端规范 §9）。面板朝屏幕内侧展开，完整位于当前显示器工作区内；
/// 返回的布局告诉前端面板是从徽标所在的哪个角长出来的。
///
/// # Errors
///
/// 尺寸不合法返回 `INVALID_INPUT`；窗口不可用返回 `WINDOW_UNAVAILABLE`。
#[tauri::command]
#[specta::specta]
pub async fn expand_floating(
    state: State<'_, AppState>,
    request: ExpandFloatingRequest,
) -> Result<ExpandedLayoutDto, IpcError> {
    let panel = request.validated()?;
    let floating = floating_handle(&state)?;
    floating
        .expand(panel)
        .map(ExpandedLayoutDto::from)
        .map_err(window_error)
}

/// 把悬浮窗收起回徽标，位置与展开前一致。未展开时是空操作。
///
/// # Errors
///
/// 窗口不可用时返回 `WINDOW_UNAVAILABLE`。
#[tauri::command]
#[specta::specta]
pub async fn collapse_floating(state: State<'_, AppState>) -> Result<(), IpcError> {
    floating_handle(&state)?.collapse().map_err(window_error)
}

/// 取出悬浮窗的行为句柄；启动尚未完成时返回 `WINDOW_UNAVAILABLE`。
fn floating_handle<'a>(
    state: &'a State<'_, AppState>,
) -> Result<&'a Arc<dyn FloatingHandle>, IpcError> {
    state.runtime.floating().ok_or_else(|| {
        IpcError::from(AppError::new(
            ErrorCode::WindowUnavailable,
            "悬浮窗尚未创建",
        ))
    })
}

/// 把平台错误转换为 IPC 错误并记录日志。
fn window_error(error: PlatformError) -> IpcError {
    tracing::warn!(event = "floating_window_command_failed", %error, "悬浮窗命令失败");
    let mut app_error = AppError::new(ErrorCode::WindowUnavailable, error.to_string());
    app_error.action = Some(ErrorAction::OpenDiagnostics);
    IpcError::from(app_error)
}

/// 开始悬浮窗的文本输入（Quick Create）：悬浮窗临时可聚焦并获得键盘焦点。
///
/// 会先记住用户当前的前台窗口，输入结束后由 [`end_floating_input`] 把焦点还回去；
/// 这是悬浮窗唯一会主动抢焦点的时刻（架构文档 §61 风险 3）。
///
/// # Errors
///
/// 窗口无法聚焦时返回 `WINDOW_UNAVAILABLE`，此时悬浮窗已恢复为不可聚焦。
#[tauri::command]
#[specta::specta]
pub async fn begin_floating_input(state: State<'_, AppState>) -> Result<(), IpcError> {
    floating_handle(&state)?.begin_input().map_err(window_error)
}

/// 结束悬浮窗的文本输入：恢复不可聚焦，并把焦点还给用户之前的应用。可以重复调用。
///
/// # Errors
///
/// 窗口不可用时返回 `WINDOW_UNAVAILABLE`。
#[tauri::command]
#[specta::specta]
pub async fn end_floating_input(state: State<'_, AppState>) -> Result<(), IpcError> {
    floating_handle(&state)?.end_input().map_err(window_error)
}
