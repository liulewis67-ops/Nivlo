//! 窗口创建与显示。
//!
//! MVP 只有两个长期窗口（架构文档 §10）：
//!
//! * `floating`：悬浮窗，启动时创建，常驻；
//! * `main`：主窗口，**按需**创建（第一次打开时才创建 WebView，节省常驻内存），
//!   之后关闭只是隐藏，不退出应用。
//!
//! 两个窗口的 IPC 权限由 `capabilities/` 下各自的文件决定（架构文档 §13）。
//! 悬浮窗的位置、吸附与持久化见 [`floating`]。

pub mod floating;
pub mod floating_port;

use nivlo_platform::placement::{COLLAPSED_HEIGHT_LOGICAL_PX, COLLAPSED_WIDTH_LOGICAL_PX, Point};
use tauri::{
    AppHandle, Manager, Runtime, WebviewUrl, WebviewWindow, WebviewWindowBuilder, Window,
    WindowEvent,
};

use crate::app::AppState;

/// 悬浮窗的 label，与 `capabilities/floating.json` 对应。
pub const FLOATING_WINDOW_LABEL: &str = "floating";

/// 主窗口的 label，与 `capabilities/main.json` 对应。
pub const MAIN_WINDOW_LABEL: &str = "main";

/// 主窗口的默认宽度（logical px）。
const MAIN_WIDTH: f64 = 960.0;

/// 主窗口的默认高度（logical px）。
const MAIN_HEIGHT: f64 = 640.0;

/// 创建悬浮窗：无边框、透明、置顶、不出现在任务栏、不可调整大小，且创建时不抢焦点。
///
/// 注意：Windows 创建顶层窗口时会把宽度夹到系统最小宽度（SM_CXMIN，约 136 logical px），
/// 比徽标更宽；创建之后用 SetWindowPos 再缩小是允许的，所以收起到徽标大小的步骤放在
/// [`floating::FloatingController::restore`] 中（通过 `FloatingWindowPort::collapse`）。
///
/// 返回的窗口位于系统默认位置，随后由 [`floating::FloatingController::restore`]
/// 还原到保存的位置（或默认位置）。
///
/// # Errors
///
/// 窗口创建失败（如 WebView2 缺失）时返回 Tauri 错误。
pub fn create_floating_window<R: Runtime, M: Manager<R>>(
    manager: &M,
) -> tauri::Result<WebviewWindow<R>> {
    WebviewWindowBuilder::new(
        manager,
        FLOATING_WINDOW_LABEL,
        WebviewUrl::App("index.html".into()),
    )
    .title("Nivlo")
    .inner_size(COLLAPSED_WIDTH_LOGICAL_PX, COLLAPSED_HEIGHT_LOGICAL_PX)
    .decorations(false)
    .transparent(true)
    .shadow(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    // 悬浮窗出现时不能把焦点从用户正在使用的应用抢走（架构文档 §61 风险 3）。
    .focused(false)
    .build()
}

/// 显示并聚焦主窗口；尚未创建时先创建。
///
/// 主窗口是按需创建的：第一次调用会创建 WebView（有一次性的启动开销），
/// 之后只是显示被隐藏的窗口。
///
/// # Errors
///
/// 窗口创建或显示失败时返回 Tauri 错误。
pub fn show_main_window<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let window = match app.get_webview_window(MAIN_WINDOW_LABEL) {
        Some(window) => window,
        None => {
            WebviewWindowBuilder::new(app, MAIN_WINDOW_LABEL, WebviewUrl::App("index.html".into()))
                .title("Nivlo")
                .inner_size(MAIN_WIDTH, MAIN_HEIGHT)
                .build()?
        }
    };
    window.unminimize()?;
    window.show()?;
    window.set_focus()?;
    Ok(())
}

/// 处理窗口事件。
///
/// * 主窗口：关闭只是隐藏，应用与悬浮窗继续运行；只有显式"退出"（托盘菜单、`quit_app`）才结束应用。
/// * 悬浮窗：移动事件交给位置控制器做防抖、吸附与保存。回调运行在主线程上，不能阻塞，
///   所以这里只转发，真正的工作在控制器派生的后台任务里。
pub fn on_window_event<R: Runtime>(window: &Window<R>, event: &WindowEvent) {
    match (window.label(), event) {
        (MAIN_WINDOW_LABEL, WindowEvent::CloseRequested { api, .. }) => {
            api.prevent_close();
            if let Err(error) = window.hide() {
                tracing::warn!(event = "main_window_hide_failed", %error, "隐藏主窗口失败");
            }
        }
        (FLOATING_WINDOW_LABEL, WindowEvent::Moved(position)) => {
            let Some(state) = window.app_handle().try_state::<AppState>() else {
                return;
            };
            if let Some(floating) = state.runtime.floating() {
                floating.on_moved(Point {
                    x: position.x,
                    y: position.y,
                });
            }
        }
        _ => {}
    }
}
