//! 窗口与应用生命周期相关的 Command。

use std::sync::Arc;

use nivlo_application::error::{AppError, ErrorAction, ErrorCode};
use nivlo_platform::error::PlatformError;
use tauri::{AppHandle, Manager, PhysicalPosition, Runtime, State, WebviewWindow};
use tauri_specta::Event;

use crate::app::AppState;
use crate::dto::{
    CollapseFloatingRequest, DragGrabPoint, ExpandFloatingRequest, ExpandedLayoutDto, IpcError,
};
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
    // 点悬浮窗打开主窗口时，悬浮窗刚被点击激活、正准备把焦点还给之前的应用：取消它，
    // 否则主窗口创建好之前焦点就被还回去，主窗口出现在别的应用后面。
    if let Some(state) = app.try_state::<AppState>()
        && let Some(floating) = state.runtime.floating()
    {
        floating.cancel_focus_return();
    }
    show_main_window(&app).map_err(|error| {
        tracing::error!(event = "open_main_failed", %error, "打开主窗口失败");
        let mut app_error = AppError::new(ErrorCode::WindowUnavailable, error.to_string());
        app_error.action = Some(ErrorAction::OpenDiagnostics);
        IpcError::from(app_error)
    })
}

/// 主窗口里可以被直接打开的视图。
const MAIN_VIEWS: &[&str] = &[
    "inbox",
    "today",
    "calendar",
    "notes",
    "projects",
    "workflows",
    "trash",
    "settings",
];

/// 打开主窗口并切换到指定视图（悬浮窗上的收集箱入口、全局搜索框的「前往」命令）。
///
/// 全局搜索框开着时一并隐藏它（不把焦点还给之前的应用：焦点要留在主窗口）。
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
    crate::windows::search::dismiss(&app, false);
    open_main(app.clone()).await?;
    let event = MainViewRequestedEvent { view };
    if let Err(error) = event.emit_to(&app, crate::windows::MAIN_WINDOW_LABEL) {
        tracing::warn!(event = "main_view_event_failed", %error, "通知主窗口切换视图失败");
    }
    Ok(())
}

/// 打开主窗口并定位到一个 Item 的详情（全局搜索框选中结果时调用），同时隐藏搜索框。
///
/// # Errors
///
/// ID 格式不对返回 `INVALID_INPUT`；窗口创建或显示失败返回 `WINDOW_UNAVAILABLE`。
#[tauri::command]
#[specta::specta]
pub async fn open_item_in_main<R: Runtime>(app: AppHandle<R>, id: String) -> Result<(), IpcError> {
    let id = crate::dto::parse_item_id(&id)?;
    crate::windows::search::dismiss(&app, false);
    crate::windows::open_item_in_main(&app, &id.to_string()).map_err(|error| {
        tracing::error!(event = "open_item_in_main_failed", %error, "打开主窗口失败");
        let mut app_error = AppError::new(ErrorCode::WindowUnavailable, error.to_string());
        app_error.action = Some(ErrorAction::OpenDiagnostics);
        IpcError::from(app_error)
    })
}

/// 隐藏全局搜索框（Esc）：焦点还给打开搜索之前正在使用的窗口。
#[tauri::command]
#[specta::specta]
pub async fn hide_search<R: Runtime>(app: AppHandle<R>) {
    crate::windows::search::dismiss(&app, true);
}

/// 全局搜索框：按内容自然高度调整；可选渲染比例将 CSS px 换算为原生 logical px。
/// 旧调用省略 `content_scale` 时保留原来的原生 logical px 语义。
#[tauri::command]
#[specta::specta]
pub async fn fit_search<R: Runtime>(app: AppHandle<R>, height: f64, content_scale: Option<f64>) {
    crate::windows::search::fit(&app, height, content_scale);
}

/// 取走悬浮窗请求主窗口打开的视图（主窗口启动时调用一次）；没有请求时为 `None`。
///
/// # Errors
///
/// 不会失败；返回 `Result` 只是为了和其他 Command 保持同一个 IPC 形状。
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

/// 让窗口内的 `grab`（logical px）正好落在光标 `cursor`（物理像素）下时，窗口左上角应在的位置。
///
/// # Arguments
///
/// * `cursor` - 光标的屏幕位置（物理像素）。
/// * `grab` - 按下时在窗口内的位置（logical px）。
/// * `scale` - 窗口所在显示器的缩放比例。
fn grab_aligned_position(
    cursor: (f64, f64),
    grab: (f64, f64),
    scale: f64,
) -> PhysicalPosition<i32> {
    #[allow(clippy::cast_possible_truncation)]
    let round = |value: f64| value.round() as i32;
    PhysicalPosition::new(
        round(cursor.0 - grab.0 * scale),
        round(cursor.1 - grab.1 * scale),
    )
}

/// 开始拖动悬浮窗（由悬浮窗在检测到"按下并移动超过阈值"之后调用）。
///
/// 把拖动交给操作系统的原生窗口拖动，保证跟手；拖动结束后的吸附与保存由
/// `FloatingController` 在收到连续的移动事件之后完成。窗口位置始终由 Rust 控制，
/// 前端不直接使用 window API 移动窗口（前端规范 §9）。
///
/// 系统的拖动以它接手那一刻的光标为基准；那时光标已经移过了判定阈值，还可能在 IPC 期间继续移动。
/// 给了 `grab`（按下的位置）时，先把窗口挪到「按下的那一点在光标下」再交给系统，徽标不会从光标下滑开。
/// 同步 Command 在 UI 线程执行：读取光标、对齐与开始拖动不能分成跨线程排队的窗口消息。
///
/// # Errors
///
/// `grab` 不合法返回 `INVALID_INPUT`；系统无法开始拖动（窗口已销毁等）时返回 `WINDOW_UNAVAILABLE`。
#[tauri::command]
#[specta::specta]
pub fn start_floating_drag<R: Runtime>(
    window: WebviewWindow<R>,
    grab: Option<DragGrabPoint>,
) -> Result<(), IpcError> {
    if let Some(grab) = grab {
        let grab = grab.validated()?;
        // 对齐失败不影响拖动本身：只是回到旧的行为（窗口落后光标几像素）。
        match (window.cursor_position(), window.scale_factor()) {
            (Ok(cursor), Ok(scale)) => {
                let target = grab_aligned_position((cursor.x, cursor.y), grab, scale);
                if let Err(error) = window.set_position(target) {
                    tracing::debug!(event = "floating_drag_align_failed", %error, "拖动前对齐窗口失败");
                }
            }
            (Err(error), _) | (_, Err(error)) => {
                tracing::debug!(event = "floating_drag_align_failed", %error, "拖动前读取光标位置失败");
            }
        }
    }
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

/// 把悬浮窗收起回徽标，位置与展开前一致。
///
/// `request` 是当前形状 / 皮肤下徽标的尺寸：前端启动时与形状变化时也会调用，尺寸变了就按原位置
/// 换成新尺寸；未展开且尺寸没变时是空操作。
///
/// # Errors
///
/// 尺寸不合法返回 `INVALID_INPUT`；窗口不可用返回 `WINDOW_UNAVAILABLE`。
#[tauri::command]
#[specta::specta]
pub async fn collapse_floating(
    state: State<'_, AppState>,
    request: CollapseFloatingRequest,
) -> Result<(), IpcError> {
    let badge = request.validated()?;
    floating_handle(&state)?
        .collapse(badge)
        .map_err(window_error)
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
pub async fn begin_floating_input(
    state: State<'_, AppState>,
    configuration: Option<bool>,
) -> Result<(), IpcError> {
    let handle = floating_handle(&state)?;
    handle.begin_input().map_err(window_error)?;
    if configuration.unwrap_or(false)
        && let Err(error) = handle.configure_input()
    {
        let _ = handle.end_input();
        return Err(window_error(error));
    }
    Ok(())
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_grabbed_point_ends_up_under_the_cursor() {
        // 125% 缩放：在徽标 (40, 20) 处按下，光标已经移到 (1500, 300)。
        let position = grab_aligned_position((1500.0, 300.0), (40.0, 20.0), 1.25);
        assert_eq!(position, PhysicalPosition::new(1450, 275));
        // 100% 缩放下就是简单的相减。
        assert_eq!(
            grab_aligned_position((100.0, 100.0), (10.0, 10.0), 1.0),
            PhysicalPosition::new(90, 90)
        );
    }

    #[test]
    fn grab_points_outside_any_window_are_rejected() {
        assert!(DragGrabPoint { x: 10.0, y: 5.0 }.validated().is_ok());
        assert!(DragGrabPoint { x: -1.0, y: 5.0 }.validated().is_err());
        assert!(
            DragGrabPoint {
                x: f64::NAN,
                y: 5.0
            }
            .validated()
            .is_err()
        );
        assert!(DragGrabPoint { x: 10.0, y: 1.0e9 }.validated().is_err());
    }
}
