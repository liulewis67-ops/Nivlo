//! 全局搜索框：按全局快捷键在任何应用之上弹出的独立搜索窗口。
//!
//! * **按需创建**：第一次按快捷键时才创建 WebView（和主窗口一样，不占常驻内存），之后只是隐藏 / 显示；
//! * **出现在鼠标所在的显示器**：水平居中、靠上（工作区高度的 [`TOP_RATIO`] 处），完整位于工作区内；
//! * **再按一次快捷键 / Esc / 点到别处** 都会隐藏；Esc 关闭时把焦点还给之前正在使用的窗口，
//!   失去焦点（用户已经点了别的窗口）时只隐藏，不抢回焦点；
//! * 窗口的 IPC 权限只有搜索、打开结果与隐藏自己（`capabilities/search.json`）。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use nivlo_platform::foreground::{ForegroundPort, UnsupportedForeground};
use tauri::webview::PageLoadEvent;
use tauri::{
    AppHandle, Manager, PhysicalPosition, Runtime, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};
use tauri_specta::Event;

use crate::events::SearchWindowShownEvent;

/// 搜索窗口的 label，与 `capabilities/search.json` 对应。
pub const SEARCH_WINDOW_LABEL: &str = "search";

/// 搜索窗口的宽度（logical px）。
pub const SEARCH_WIDTH: f64 = 640.0;

/// 搜索窗口的高度（logical px）：输入框 + 约 7 条结果 + 底部提示。
pub const SEARCH_HEIGHT: f64 = 440.0;

/// 窗口顶边位于工作区高度的这个比例处（和常见的启动器一样偏上，视线不用下移）。
pub const TOP_RATIO: f64 = 0.18;

/// 工作区（物理像素）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WorkArea {
    /// 左上角 x。
    pub x: i32,
    /// 左上角 y。
    pub y: i32,
    /// 宽度。
    pub width: u32,
    /// 高度。
    pub height: u32,
}

/// 计算搜索窗口左上角的位置（物理像素）：水平居中、顶边在 [`TOP_RATIO`] 处，并保证完整位于工作区内。
#[must_use]
pub fn search_origin(area: WorkArea, scale: f64) -> (i32, i32) {
    let width = SEARCH_WIDTH * scale;
    let height = SEARCH_HEIGHT * scale;
    let area_w = f64::from(area.width);
    let area_h = f64::from(area.height);
    let left = f64::from(area.x) + ((area_w - width) / 2.0).max(0.0);
    let top_offset = (area_h * TOP_RATIO).min((area_h - height).max(0.0));
    let top = f64::from(area.y) + top_offset;
    // 坐标远小于 i32 的范围，取整后转换不会溢出。
    #[allow(clippy::cast_possible_truncation)]
    (left.round() as i32, top.round() as i32)
}

/// 搜索窗口的运行时状态（注册为 Tauri 托管状态）。
#[derive(Default)]
pub struct SearchWindowState {
    /// 前台窗口的记忆与还原；窗口创建之后才有。
    foreground: Mutex<Option<Arc<dyn ForegroundPort>>>,
}

impl SearchWindowState {
    /// 前台窗口端口；窗口还没创建时为空操作的实现。
    fn foreground(&self) -> Arc<dyn ForegroundPort> {
        self.foreground
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
            .unwrap_or_else(|| Arc::new(UnsupportedForeground))
    }
}

/// 全局快捷键的动作：搜索框没在前台就显示（必要时创建），已经在前台就隐藏。
///
/// 会阻塞到窗口创建完成，所以要在后台线程上调用（不能在主线程，也不能在快捷键的消息线程）。
pub fn toggle<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window(SEARCH_WINDOW_LABEL) {
        let visible = window.is_visible().unwrap_or(false);
        let focused = window.is_focused().unwrap_or(false);
        if visible && focused {
            dismiss(app, true);
            return;
        }
        remember_foreground(app);
        present(app, &window);
        return;
    }
    match create(app, true) {
        Ok(window) => {
            install_foreground(app, &window);
            remember_foreground(app);
            place(app, &window);
            // 第一次创建时等页面加载完成再显示（见 `create`），避免先闪一个空白窗口。
        }
        Err(error) => {
            tracing::warn!(event = "search_window_create_failed", %error, "创建搜索窗口失败");
        }
    }
}

/// 预先创建（隐藏的）搜索窗口，让第一次按快捷键时不必再等创建与加载；已经存在时什么都不做。
///
/// 和 [`toggle`] 一样会阻塞到窗口创建完成，要在后台线程上调用。
pub fn prewarm<R: Runtime>(app: &AppHandle<R>) {
    if app.get_webview_window(SEARCH_WINDOW_LABEL).is_some() {
        return;
    }
    match create(app, false) {
        Ok(window) => {
            install_foreground(app, &window);
            tracing::info!(event = "search_window_prewarmed", "已预先创建全局搜索框");
        }
        Err(error) => {
            tracing::warn!(event = "search_window_prewarm_failed", %error, "预先创建搜索窗口失败");
        }
    }
}

/// 关掉预先创建、当前没有显示的搜索窗口（用户关闭了「预先准备」），释放它占用的内存。
/// 正在显示时不动，下次唤出前它就是普通的按需窗口。
pub fn release_prewarmed<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window(SEARCH_WINDOW_LABEL) else {
        return;
    };
    if window.is_visible().unwrap_or(false) {
        return;
    }
    if let Err(error) = window.destroy() {
        tracing::warn!(event = "search_window_release_failed", %error, "释放搜索窗口失败");
    }
}

/// 隐藏搜索窗口；`restore_focus` 为真时把焦点还给打开搜索之前的窗口。
pub fn dismiss<R: Runtime>(app: &AppHandle<R>, restore_focus: bool) {
    let Some(window) = app.get_webview_window(SEARCH_WINDOW_LABEL) else {
        return;
    };
    if let Err(error) = window.hide() {
        tracing::warn!(event = "search_window_hide_failed", %error, "隐藏搜索窗口失败");
    }
    if restore_focus
        && let Some(state) = app.try_state::<SearchWindowState>()
        && let Err(error) = state.foreground().restore()
    {
        tracing::debug!(event = "search_focus_restore_failed", %error, "无法把焦点还给之前的窗口");
    }
}

/// 创建（隐藏的）搜索窗口。`show_when_loaded` 为真（按了快捷键）时页面加载完成后显示；
/// 预先创建时保持隐藏，等真正按快捷键。
fn create<R: Runtime>(
    app: &AppHandle<R>,
    show_when_loaded: bool,
) -> tauri::Result<WebviewWindow<R>> {
    let handle = app.clone();
    // 只在第一次加载完成时自动显示；之后的重新加载（开发时的整页刷新）不应把窗口弹出来。
    let first_load = AtomicBool::new(show_when_loaded);
    WebviewWindowBuilder::new(
        app,
        SEARCH_WINDOW_LABEL,
        WebviewUrl::App("index.html".into()),
    )
    .title("Nivlo")
    .inner_size(SEARCH_WIDTH, SEARCH_HEIGHT)
    .decorations(false)
    // 不透明 + 系统阴影：Windows 11 上自动得到圆角与阴影，和系统其他浮层一致。
    .shadow(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .maximizable(false)
    .minimizable(false)
    .visible(false)
    .on_page_load(move |window, payload| {
        if payload.event() == PageLoadEvent::Finished && first_load.swap(false, Ordering::SeqCst) {
            present(&handle, &window);
        }
    })
    .build()
}

/// 把窗口放到鼠标所在的显示器上、显示、聚焦，并通知页面重置输入。
fn present<R: Runtime>(app: &AppHandle<R>, window: &WebviewWindow<R>) {
    place(app, window);
    if let Err(error) = window.show().and_then(|()| window.set_focus()) {
        tracing::warn!(event = "search_window_show_failed", %error, "显示搜索窗口失败");
        return;
    }
    let event = SearchWindowShownEvent {};
    if let Err(error) = event.emit_to(app, SEARCH_WINDOW_LABEL) {
        tracing::warn!(event = "search_window_shown_emit_failed", %error, "通知搜索窗口失败");
    }
}

/// 按鼠标所在的显示器（取不到时用主显示器）定位窗口。
fn place<R: Runtime>(app: &AppHandle<R>, window: &WebviewWindow<R>) {
    let monitor = app
        .cursor_position()
        .ok()
        .and_then(|cursor| app.monitor_from_point(cursor.x, cursor.y).ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten());
    let Some(monitor) = monitor else {
        return;
    };
    let rect = monitor.work_area();
    let area = WorkArea {
        x: rect.position.x,
        y: rect.position.y,
        width: rect.size.width,
        height: rect.size.height,
    };
    let (x, y) = search_origin(area, monitor.scale_factor());
    if let Err(error) = window.set_position(PhysicalPosition::new(x, y)) {
        tracing::debug!(event = "search_window_place_failed", %error, "定位搜索窗口失败");
    }
}

/// 窗口创建之后，装上前台窗口的记忆 / 还原（需要窗口句柄）。
fn install_foreground<R: Runtime>(app: &AppHandle<R>, window: &WebviewWindow<R>) {
    let Some(state) = app.try_state::<SearchWindowState>() else {
        return;
    };
    let port = super::foreground_port(window);
    *state
        .foreground
        .lock()
        .unwrap_or_else(PoisonError::into_inner) = Some(port);
}

/// 记住当前前台窗口，Esc 关闭时还给它。
fn remember_foreground<R: Runtime>(app: &AppHandle<R>) {
    if let Some(state) = app.try_state::<SearchWindowState>() {
        let _ = state.foreground().remember();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FULL_HD: WorkArea = WorkArea {
        x: 0,
        y: 0,
        width: 1920,
        height: 1040,
    };

    #[test]
    fn centred_horizontally_and_placed_high() {
        let (x, y) = search_origin(FULL_HD, 1.0);
        assert_eq!(x, (1920 - 640) / 2);
        assert_eq!(y, (1040.0 * TOP_RATIO).round() as i32);
    }

    #[test]
    fn respects_the_scale_factor_and_monitor_offset() {
        let area = WorkArea {
            x: -2560,
            y: 100,
            width: 2560,
            height: 1400,
        };
        let (x, y) = search_origin(area, 1.5);
        assert_eq!(x, -2560 + (2560 - 960) / 2);
        assert_eq!(y, 100 + (1400.0 * TOP_RATIO).round() as i32);
    }

    #[test]
    fn stays_inside_a_short_work_area() {
        let area = WorkArea {
            x: 0,
            y: 0,
            width: 600,
            height: 460,
        };
        let (x, y) = search_origin(area, 1.0);
        assert_eq!(x, 0, "比窗口还窄时贴左边，不跑到屏幕外");
        assert_eq!(y, 20, "顶边下移会让底边出界时上移");
    }
}
