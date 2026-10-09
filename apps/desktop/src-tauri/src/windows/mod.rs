//! 窗口创建与显示。
//!
//! MVP 只有两个长期窗口（架构文档 §10）：
//!
//! * `floating`：悬浮窗，启动时创建，常驻；
//! * `main`：主窗口，**按需**创建（第一次打开时才创建 WebView，节省常驻内存），
//!   之后关闭只是隐藏，不退出应用。
//!
//! 两个窗口的 IPC 权限由 `capabilities/` 下各自的文件决定（架构文档 §13）。

use tauri::{
    AppHandle, Manager, PhysicalPosition, Runtime, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
    Window, WindowEvent,
};

/// 悬浮窗的 label，与 `capabilities/floating.json` 对应。
pub const FLOATING_WINDOW_LABEL: &str = "floating";

/// 主窗口的 label，与 `capabilities/main.json` 对应。
pub const MAIN_WINDOW_LABEL: &str = "main";

/// 悬浮窗收起态的初始宽度（logical px）。
const FLOATING_INITIAL_WIDTH: f64 = 88.0;

/// 悬浮窗收起态的初始高度（logical px）。
const FLOATING_INITIAL_HEIGHT: f64 = 40.0;

/// 悬浮窗初始位置距离屏幕边缘的间距（logical px）。
const FLOATING_EDGE_MARGIN: f64 = 24.0;

/// 主窗口的默认宽度（logical px）。
const MAIN_WIDTH: f64 = 960.0;

/// 主窗口的默认高度（logical px）。
const MAIN_HEIGHT: f64 = 640.0;

/// 创建悬浮窗：无边框、透明、置顶、不出现在任务栏、不可调整大小，且创建时不抢焦点。
///
/// 初始位置放在主显示器右上角；位置的持久化与吸附在实施计划 1.2 实现。
///
/// # Errors
///
/// 窗口创建失败（如 WebView2 缺失）时返回 Tauri 错误。
pub fn create_floating_window<R: Runtime, M: Manager<R>>(manager: &M) -> tauri::Result<()> {
    let window = WebviewWindowBuilder::new(
        manager,
        FLOATING_WINDOW_LABEL,
        WebviewUrl::App("index.html".into()),
    )
    .title("Nivlo")
    .inner_size(FLOATING_INITIAL_WIDTH, FLOATING_INITIAL_HEIGHT)
    .decorations(false)
    .transparent(true)
    .shadow(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    // 悬浮窗出现时不能把焦点从用户正在使用的应用抢走（架构文档 §61 风险 3）。
    .focused(false)
    .build()?;
    place_at_top_right(&window);
    Ok(())
}

/// 把悬浮窗放到主显示器的右上角。
///
/// 位置计算失败（拿不到显示器信息）时保持系统默认位置，不视为错误：
/// 悬浮窗仍然可见，用户可以拖动它。
fn place_at_top_right<R: Runtime>(window: &WebviewWindow<R>) {
    let Ok(Some(monitor)) = window.primary_monitor() else {
        tracing::warn!(
            event = "floating_placement_skipped",
            "无法获取主显示器，使用默认位置"
        );
        return;
    };
    // 先转为物理像素再计算：不同 DPI 的显示器上 logical 尺寸对应不同的物理尺寸。
    let scale = monitor.scale_factor();
    let width = FLOATING_INITIAL_WIDTH * scale;
    let margin = FLOATING_EDGE_MARGIN * scale;
    let origin = monitor.position();
    let x = f64::from(origin.x) + f64::from(monitor.size().width) - width - margin;
    let y = f64::from(origin.y) + margin;
    // 取整到物理像素；坐标远小于 i32 范围，转换不会溢出。
    #[allow(clippy::cast_possible_truncation)]
    let position = PhysicalPosition::new(x.round() as i32, y.round() as i32);
    if let Err(error) = window.set_position(position) {
        tracing::warn!(event = "floating_placement_failed", %error, "设置悬浮窗位置失败");
    }
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

/// 处理窗口事件：关闭主窗口只是隐藏，应用与悬浮窗继续运行。
///
/// 只有显式"退出"（托盘菜单、`quit_app`）才会结束应用。
pub fn on_window_event<R: Runtime>(window: &Window<R>, event: &WindowEvent) {
    if window.label() != MAIN_WINDOW_LABEL {
        return;
    }
    if let WindowEvent::CloseRequested { api, .. } = event {
        api.prevent_close();
        if let Err(error) = window.hide() {
            tracing::warn!(event = "main_window_hide_failed", %error, "隐藏主窗口失败");
        }
    }
}
