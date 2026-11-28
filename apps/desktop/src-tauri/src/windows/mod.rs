//! 窗口创建与显示。
//!
//! 长期窗口（架构文档 §10）：
//!
//! * `floating`：悬浮窗，启动时创建，常驻；
//! * `main`：主窗口，**按需**创建（第一次打开时才创建 WebView，节省常驻内存），
//!   之后关闭只是隐藏，不退出应用；
//! * `search`：全局搜索框，按全局快捷键时按需创建，之后只隐藏 / 显示（见 [`search`]）。
//!
//! 两个窗口的 IPC 权限由 `capabilities/` 下各自的文件决定（架构文档 §13）。
//! 悬浮窗的位置、吸附与持久化见 [`floating`]。

pub mod detail;
pub mod floating;
pub mod floating_port;
pub mod search;

use asterjot_platform::placement::{
    COLLAPSED_HEIGHT_LOGICAL_PX, COLLAPSED_WIDTH_LOGICAL_PX, Point,
};
use tauri::{
    AppHandle, Manager, Runtime, WebviewUrl, WebviewWindow, WebviewWindowBuilder, Window,
    WindowEvent,
};

use std::sync::Arc;

use asterjot_platform::foreground::{ForegroundPort, UnsupportedForeground};

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
    .title("AsterJot")
    .inner_size(COLLAPSED_WIDTH_LOGICAL_PX, COLLAPSED_HEIGHT_LOGICAL_PX)
    .decorations(false)
    .transparent(true)
    .shadow(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    // D-10（ADR-011）：关闭 Tauri 原生拖放，让 WebView2 把浏览器拖来的链接 / 文本 / 图片
    // 以 HTML5 drop 事件交给页面；原生拖放开启时这些内容根本到不了前端。
    .disable_drag_drop_handler()
    // 悬浮窗出现时不能把焦点从用户正在使用的应用抢走（架构文档 §61 风险 3）。
    .focused(false)
    .build()
    .inspect(suppress_bare_alt_menu)
}

/// 单独按一下 Alt 不让窗口进入键盘菜单模式（否则所有页面都不再响应，直到按 Esc，看起来像卡死）。
///
/// 每个窗口创建后调用一次；子类过程必须装在创建窗口的线程上，所以转到主线程执行。
/// 失败只记日志：窗口照常可用，只是 Alt 仍会进入菜单模式。
pub fn suppress_bare_alt_menu<R: Runtime>(window: &WebviewWindow<R>) {
    #[cfg(target_os = "windows")]
    {
        let label = window.label().to_owned();
        let hwnd = match window.hwnd() {
            Ok(hwnd) => hwnd.0 as isize,
            Err(error) => {
                tracing::warn!(event = "alt_menu_hwnd_unavailable", window = %label, %error, "无法获取窗口句柄");
                return;
            }
        };
        let result = window.run_on_main_thread(move || {
            if let Err(error) = asterjot_platform_windows::menu_key::suppress_bare_alt_menu(hwnd) {
                tracing::warn!(event = "alt_menu_suppress_failed", window = %label, %error, "无法屏蔽单独按 Alt 的菜单模式");
            }
        });
        if let Err(error) = result {
            tracing::warn!(event = "alt_menu_suppress_failed", %error, "无法屏蔽单独按 Alt 的菜单模式");
        }
    }
    #[cfg(not(target_os = "windows"))]
    let _ = window;
}

/// 创建悬浮窗使用的前台窗口记忆 / 还原：Windows 上用 Win32 实现，其他平台降级为空操作。
///
/// 取不到悬浮窗自己的窗口句柄时同样降级（Quick Create 仍可用，只是结束后焦点不会自动还回去）。
pub fn foreground_port<R: Runtime>(window: &WebviewWindow<R>) -> Arc<dyn ForegroundPort> {
    #[cfg(target_os = "windows")]
    {
        match window.hwnd() {
            Ok(hwnd) => {
                return Arc::new(
                    asterjot_platform_windows::foreground::new_windows_foreground(hwnd.0 as isize),
                );
            }
            Err(error) => {
                tracing::warn!(event = "floating_hwnd_unavailable", %error, "无法获取悬浮窗句柄，不还原前台窗口");
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    let _ = window;
    Arc::new(UnsupportedForeground)
}

/// 显示并聚焦主窗口；尚未创建时先创建。
///
/// 主窗口是按需创建的：第一次调用会创建 WebView（有一次性的启动开销），
/// 普通窗口在显示前居中，最大化和全屏窗口保留原有状态。
///
/// # Errors
///
/// 窗口创建或显示失败时返回 Tauri 错误。
pub fn show_main_window<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let window = match app.get_webview_window(MAIN_WINDOW_LABEL) {
        Some(window) => window,
        None => {
            WebviewWindowBuilder::new(app, MAIN_WINDOW_LABEL, WebviewUrl::App("index.html".into()))
                .title("AsterJot")
                .inner_size(MAIN_WIDTH, MAIN_HEIGHT)
                .decorations(false)
                .visible(false)
                .zoom_hotkeys_enabled(cfg!(target_os = "windows"))
                // 日历需要 WebView2 传来的 HTML5 文本拖放。
                .disable_drag_drop_handler()
                .build()
                .inspect(suppress_bare_alt_menu)?
        }
    };
    if window.is_minimized()? {
        window.unminimize()?;
    }
    if !window.is_maximized()? && !window.is_fullscreen()? {
        window.center()?;
    }
    window.show()?;
    window.set_focus()?;
    Ok(())
}

/// 按命令行参数处理「通知被点击」的激活（`asterjot://item/<ID>`）：打开主窗口并定位到对应的 Item。
///
/// 参数来自任何能启动程序的来源，只接受严格校验过的地址（见 `asterjot_platform::notification::parse_activation`）。
/// 返回是否识别并处理了激活参数；没有时由调用方照常显示主窗口。
pub fn handle_activation<R: Runtime>(app: &AppHandle<R>, args: &[String]) -> bool {
    let Some(item_id) = args
        .iter()
        .find_map(|arg| asterjot_platform::notification::parse_activation(arg))
    else {
        return false;
    };
    if let Err(error) = open_item_in_main(app, &item_id) {
        tracing::warn!(event = "activation_show_failed", %error, "通知激活时无法显示主窗口");
        return true;
    }
    tracing::info!(event = "notification_activated", "已按通知打开对应的 Item");
    true
}

/// 打开一个事项的独立详情窗口（点击通知、全局搜索选中结果）。
///
/// `item_id` 必须已经校验过。
///
/// # Errors
///
/// 主窗口创建或显示失败时返回 Tauri 错误。
pub fn open_item_in_main<R: Runtime>(app: &AppHandle<R>, item_id: &str) -> tauri::Result<()> {
    if let Some(state) = app.try_state::<AppState>()
        && let Some(floating) = state.runtime.floating()
    {
        floating.cancel_focus_return();
    }
    detail::show(app, item_id)
}

/// 处理窗口事件。
///
/// * 主窗口：关闭只是隐藏，应用与悬浮窗继续运行；只有显式"退出"（托盘菜单、`quit_app`）才结束应用。
/// * 悬浮窗：移动事件交给位置控制器做防抖、吸附与保存。回调运行在主线程上，不能阻塞，
///   所以这里只转发，真正的工作在控制器派生的后台任务里。
/// * 搜索窗口：失去焦点（用户点了别的窗口）就隐藏，像系统的其他弹出层一样；关闭只是隐藏。
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
        (FLOATING_WINDOW_LABEL, WindowEvent::Focused(true)) => {
            if let Some(state) = window.app_handle().try_state::<AppState>()
                && let Some(floating) = state.runtime.floating()
            {
                floating.on_focused();
            }
        }
        (search::SEARCH_WINDOW_LABEL, WindowEvent::Focused(false)) => {
            search::dismiss(window.app_handle(), false);
        }
        (
            search::SEARCH_WINDOW_LABEL,
            WindowEvent::ScaleFactorChanged { .. } | WindowEvent::Moved(_),
        ) => {
            search::reflow(window.app_handle());
        }
        (search::SEARCH_WINDOW_LABEL, WindowEvent::CloseRequested { api, .. }) => {
            api.prevent_close();
            search::dismiss(window.app_handle(), false);
        }
        _ => {}
    }
}
