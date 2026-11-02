//! 全局搜索框：按全局快捷键在任何应用之上弹出的独立搜索窗口。
//!
//! * **按需创建**：第一次按快捷键时才创建 WebView（和主窗口一样，不占常驻内存），之后只是隐藏 / 显示；
//! * **出现在鼠标所在的显示器**：水平居中、靠上（工作区高度的 [`TOP_RATIO`] 处），完整位于工作区内；
//! * **再按一次快捷键 / Esc / 点到别处** 都会隐藏；Esc 关闭时把焦点还给之前正在使用的窗口，
//!   失去焦点（用户已经点了别的窗口）时只隐藏，不抢回焦点；
//! * **高度跟随内容**：页面量出内容的自然高度后请求调整（[`fit`]），结果少时窗口就矮，
//!   不留一大片空白；最高 [`SEARCH_HEIGHT`]，超出时列表在窗口内滚动；顶边不动；
//! * 窗口的 IPC 权限只有搜索、打开结果、调整自己的高度与隐藏自己（`capabilities/search.json`）。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Instant;

use nivlo_platform::foreground::{ForegroundPort, UnsupportedForeground};
use tauri::webview::PageLoadEvent;
use tauri::{
    AppHandle, LogicalSize, Manager, PhysicalPosition, Runtime, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};
use tauri_specta::Event;

use crate::events::SearchWindowShownEvent;

/// 搜索窗口的 label，与 `capabilities/search.json` 对应。
pub const SEARCH_WINDOW_LABEL: &str = "search";

/// 搜索窗口的宽度（logical px）。
pub const SEARCH_WIDTH: f64 = 640.0;

/// 搜索窗口的最大高度（logical px）：输入框 + 约 7 条结果 + 底部提示。也是创建时的高度，
/// 页面量出内容高度后再收矮（见 [`fit`]）。
pub const SEARCH_HEIGHT: f64 = 440.0;

/// 搜索窗口的最小高度（logical px）：只剩输入框一行。
pub const SEARCH_MIN_HEIGHT: f64 = 56.0;

/// 最窄仍可容纳命令入口、关键词与 Esc 的内容宽度；更窄时明确拒绝显示。
pub const SEARCH_MIN_WIDTH: f64 = 240.0;

/// 搜索窗口与工作区四边保留的逻辑像素。
pub const SEARCH_MARGIN: f64 = 16.0;

/// 把页面请求的高度限制在 [`SEARCH_MIN_HEIGHT`]..=[`SEARCH_HEIGHT`] 之内；不是有限数时用最大高度。
#[must_use]
pub fn fit_height(requested: f64) -> f64 {
    if requested.is_finite() {
        requested.clamp(SEARCH_MIN_HEIGHT, SEARCH_HEIGHT)
    } else {
        SEARCH_HEIGHT
    }
}

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

/// 适配后的逻辑尺寸与物理位置；只有原生适配器负责 DPI 换算。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SearchGeometry {
    /// 内容宽度（logical px）。
    pub width: f64,
    /// 内容高度（logical px）。
    pub height: f64,
    /// 左边（physical px）。
    pub x: i32,
    /// 顶边（physical px）。
    pub y: i32,
}

/// 工作区只转换一次到逻辑单位；尺寸与位置均受工作区约束。
/// 无效缩放或连最小输入栏都放不下时返回 `None`。
/// 顶边以该工作区的最大可用高度计算，不随页面内容来回移动。
#[must_use]
pub fn search_geometry(area: WorkArea, scale: f64, requested: f64) -> Option<SearchGeometry> {
    if !scale.is_finite() || scale <= 0.0 {
        return None;
    }
    let area_w = f64::from(area.width) / scale;
    let area_h = f64::from(area.height) / scale;
    if !area_w.is_finite() || !area_h.is_finite() {
        return None;
    }
    let width = SEARCH_WIDTH.min(area_w - 2.0 * SEARCH_MARGIN);
    let max_height = SEARCH_HEIGHT.min(area_h - 2.0 * SEARCH_MARGIN);
    if width < SEARCH_MIN_WIDTH || max_height < SEARCH_MIN_HEIGHT {
        return None;
    }
    let height = fit_height(requested).min(max_height);
    let left = f64::from(area.x) + (area_w - width) * scale / 2.0;
    let top_offset = (area_h * TOP_RATIO).clamp(
        SEARCH_MARGIN,
        (area_h - max_height - SEARCH_MARGIN).max(SEARCH_MARGIN),
    );
    let top = f64::from(area.y) + top_offset * scale;
    // 坐标远小于 i32 的范围，取整后转换不会溢出。
    #[allow(clippy::cast_possible_truncation)]
    Some(SearchGeometry {
        width,
        height,
        x: left.round() as i32,
        y: top.round() as i32,
    })
}

/// 搜索窗口的运行时状态（注册为 Tauri 托管状态）。
pub struct SearchWindowState {
    /// 前台窗口的记忆与还原；窗口创建之后才有。
    foreground: Mutex<Option<Arc<dyn ForegroundPort>>>,
    /// 最新页面高度；显示器变化时重算尺寸，不要求页面重复发送相同请求。
    requested_height: Mutex<f64>,
}

impl Default for SearchWindowState {
    fn default() -> Self {
        Self {
            foreground: Mutex::new(None),
            requested_height: Mutex::new(SEARCH_HEIGHT),
        }
    }
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

/// CSS 内容高度乘渲染 DPR 再除显示器缩放；省略 DPR 的旧调用保留原生逻辑单位。
#[must_use]
pub fn content_height(height: f64, content_scale: Option<f64>, window_scale: f64) -> f64 {
    let zoom = content_scale
        .filter(|scale| scale.is_finite() && *scale > 0.0)
        .filter(|_| window_scale.is_finite() && window_scale > 0.0)
        .map_or(1.0, |scale| scale / window_scale);
    fit_height(height * zoom)
}

/// 保存页面量出的内容高度，在当前工作区上约束；同一工作区内保持顶边稳定。
pub fn fit<R: Runtime>(app: &AppHandle<R>, height: f64, content_scale: Option<f64>) {
    let window_scale = app
        .get_webview_window(SEARCH_WINDOW_LABEL)
        .and_then(|window| window.scale_factor().ok())
        .unwrap_or(1.0);
    if let Some(state) = app.try_state::<SearchWindowState>() {
        *state
            .requested_height
            .lock()
            .unwrap_or_else(PoisonError::into_inner) =
            content_height(height, content_scale, window_scale);
    }
    reflow(app);
}

/// DPI、移动或工作区变化时用当前显示器重新约束；不重新获取焦点、不重置页面。
pub fn reflow<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window(SEARCH_WINDOW_LABEL) else {
        return;
    };
    let monitor = window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| app.primary_monitor().ok().flatten());
    if let Some(monitor) = monitor
        && !apply_geometry(app, &window, &monitor)
    {
        dismiss(app, false);
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
    // 记录第一次唤出的耗时分布（创建窗口与 WebView / 加载页面），每次启动至多一条，用于性能基线。
    let started = Instant::now();
    WebviewWindowBuilder::new(
        app,
        SEARCH_WINDOW_LABEL,
        WebviewUrl::App("index.html".into()),
    )
    .title("Nivlo")
    .inner_size(SEARCH_WIDTH, SEARCH_HEIGHT)
    .zoom_hotkeys_enabled(cfg!(target_os = "windows"))
    .decorations(false)
    // 不透明 + 系统阴影：Windows 11 上自动得到圆角与阴影，和系统其他浮层一致。
    .shadow(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .maximizable(false)
    .minimizable(false)
    .visible(false)
    // 创建时不抢前台：创建之后才记住用户原来的窗口（要拿到搜索框自己的句柄），创建时就激活的话会把
    // 搜索框自己当成「原来的窗口」，退回到上一个其他进程的窗口——从主窗口唤出时 Esc 会把焦点交给别的应用。
    // 页面加载完成后由 `present` 显示并聚焦。
    .focused(false)
    .on_page_load(move |window, payload| {
        if payload.event() == PageLoadEvent::Finished && first_load.swap(false, Ordering::SeqCst) {
            present(&handle, &window);
            tracing::info!(
                event = "search_window_page_loaded",
                elapsed_ms = started.elapsed().as_millis(),
                "全局搜索框页面加载完成并已显示"
            );
        }
    })
    .build()
    .inspect(|window| {
        tracing::info!(
            event = "search_window_created",
            elapsed_ms = started.elapsed().as_millis(),
            "已创建全局搜索框窗口"
        );
        super::suppress_bare_alt_menu(window);
    })
}

/// 把窗口放到鼠标所在的显示器上、显示、聚焦，并通知页面重置输入。
fn present<R: Runtime>(app: &AppHandle<R>, window: &WebviewWindow<R>) {
    if !place(app, window) {
        return;
    }
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
fn place<R: Runtime>(app: &AppHandle<R>, window: &WebviewWindow<R>) -> bool {
    let monitor = app
        .cursor_position()
        .ok()
        .and_then(|cursor| app.monitor_from_point(cursor.x, cursor.y).ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten());
    let Some(monitor) = monitor else {
        tracing::warn!(
            event = "search_work_area_unavailable",
            "无法取得搜索窗口工作区"
        );
        return false;
    };
    apply_geometry(app, window, &monitor)
}

/// 比较实际物理尺寸/位置再写入，避免 Moved / DPI / 页面测量事件相互触发调整循环。
fn apply_geometry<R: Runtime>(
    app: &AppHandle<R>,
    window: &WebviewWindow<R>,
    monitor: &tauri::Monitor,
) -> bool {
    let rect = monitor.work_area();
    let area = WorkArea {
        x: rect.position.x,
        y: rect.position.y,
        width: rect.size.width,
        height: rect.size.height,
    };
    let requested = app
        .try_state::<SearchWindowState>()
        .map_or(SEARCH_HEIGHT, |state| {
            *state
                .requested_height
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
        });
    let scale = monitor.scale_factor();
    let Some(bounds) = search_geometry(area, scale, requested) else {
        tracing::warn!(
            event = "search_work_area_unsupported",
            ?area,
            scale,
            "工作区无法容纳搜索输入栏"
        );
        return false;
    };
    let position = PhysicalPosition::new(bounds.x, bounds.y);
    if window.outer_position().ok() != Some(position)
        && let Err(error) = window.set_position(position)
    {
        tracing::debug!(event = "search_window_place_failed", %error, "定位搜索窗口失败");
        return false;
    }
    let size = LogicalSize::new(bounds.width, bounds.height).to_physical::<u32>(scale);
    if window.inner_size().ok() != Some(size)
        && let Err(error) = window.set_size(size)
    {
        tracing::debug!(event = "search_window_fit_failed", %error, "调整搜索窗口尺寸失败");
        return false;
    }
    true
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
    fn centred_horizontally_and_placed_high() -> Result<(), &'static str> {
        let SearchGeometry { x, y, .. } = search_geometry(FULL_HD, 1.0, SEARCH_HEIGHT)
            .ok_or("fixture work area supports the input bar")?;
        assert_eq!(x, (1920 - 640) / 2);
        assert_eq!(y, (1040.0 * TOP_RATIO).round() as i32);
        Ok(())
    }

    #[test]
    fn respects_the_scale_factor_and_monitor_offset() -> Result<(), &'static str> {
        let area = WorkArea {
            x: -2560,
            y: 100,
            width: 2560,
            height: 1400,
        };
        let SearchGeometry { x, y, .. } = search_geometry(area, 1.5, SEARCH_HEIGHT)
            .ok_or("fixture work area supports the input bar")?;
        assert_eq!(x, -2560 + (2560 - 960) / 2);
        assert_eq!(y, 100 + (1400.0 * TOP_RATIO).round() as i32);
        Ok(())
    }

    #[test]
    fn fit_height_is_clamped_to_the_bar_and_the_maximum() {
        assert_eq!(fit_height(200.0), 200.0);
        assert_eq!(fit_height(10.0), SEARCH_MIN_HEIGHT, "至少留下输入框");
        assert_eq!(fit_height(5000.0), SEARCH_HEIGHT, "不超过最大高度");
        assert_eq!(fit_height(f64::NAN), SEARCH_HEIGHT);
        assert_eq!(fit_height(f64::INFINITY), SEARCH_HEIGHT);
    }

    #[test]
    fn content_zoom_is_separate_from_monitor_scale_and_legacy_units() {
        assert_eq!(content_height(174.0, Some(1.25), 1.25), 174.0);
        assert_eq!(content_height(174.0, Some(2.5), 1.25), 348.0);
        assert_eq!(content_height(174.0, Some(4.0), 2.0), 348.0);
        assert_eq!(content_height(300.0, Some(2.5), 1.25), SEARCH_HEIGHT);
        assert_eq!(content_height(174.0, None, 1.25), 174.0);
        assert_eq!(content_height(174.0, Some(f64::NAN), 1.25), 174.0);
        assert_eq!(content_height(174.0, Some(2.5), 0.0), 174.0);
    }

    #[test]
    fn stays_inside_a_short_work_area() -> Result<(), &'static str> {
        let area = WorkArea {
            x: 0,
            y: 0,
            width: 600,
            height: 460,
        };
        let bounds = search_geometry(area, 1.0, SEARCH_HEIGHT)
            .ok_or("fixture work area supports the input bar")?;
        assert_eq!(
            bounds,
            SearchGeometry {
                x: 16,
                y: 16,
                width: 568.0,
                height: 428.0
            }
        );
        Ok(())
    }

    #[test]
    fn narrow_mixed_dpi_work_areas_bound_size_and_position() {
        for scale in [1.0, 1.25, 1.5, 2.0] {
            for (width, height) in [(1920, 1040), (600, 460), (480, 240), (272, 88)] {
                let area = WorkArea {
                    x: -2560,
                    y: 120,
                    width,
                    height,
                };
                let Some(bounds) = search_geometry(area, scale, 5000.0) else {
                    assert!(
                        f64::from(width) / scale < SEARCH_MIN_WIDTH + 32.0
                            || f64::from(height) / scale < SEARCH_MIN_HEIGHT + 32.0
                    );
                    continue;
                };
                assert!(bounds.width >= SEARCH_MIN_WIDTH && bounds.width <= SEARCH_WIDTH);
                assert!(bounds.height >= SEARCH_MIN_HEIGHT && bounds.height <= SEARCH_HEIGHT);
                let margin = SEARCH_MARGIN * scale;
                assert!(f64::from(bounds.x - area.x) >= margin - 0.5);
                assert!(f64::from(bounds.y - area.y) >= margin - 0.5);
                assert!(
                    f64::from(bounds.x - area.x) + (bounds.width * scale).round()
                        <= f64::from(width) - margin + 1.0
                );
                assert!(
                    f64::from(bounds.y - area.y) + (bounds.height * scale).round()
                        <= f64::from(height) - margin + 1.0
                );
            }
        }
    }

    #[test]
    fn fitting_content_does_not_shift_the_anchor_or_alternate_sizes() -> Result<(), &'static str> {
        let area = WorkArea {
            x: 50,
            y: -700,
            width: 780,
            height: 600,
        };
        let original = search_geometry(area, 1.5, SEARCH_HEIGHT)
            .ok_or("fixture work area supports the input bar")?;
        for height in [56.0, 120.0, 440.0, f64::NAN, 800.0] {
            let bounds = search_geometry(area, 1.5, height)
                .ok_or("fixture work area supports the input bar")?;
            assert_eq!(
                (bounds.x, bounds.y, bounds.width),
                (original.x, original.y, original.width)
            );
            assert_eq!(Some(bounds), search_geometry(area, 1.5, bounds.height));
        }
        Ok(())
    }

    #[test]
    fn unsupported_work_areas_and_invalid_scales_are_explicit() -> Result<(), &'static str> {
        for scale in [0.0, -1.0, f64::NAN, f64::INFINITY, f64::MIN_POSITIVE] {
            assert_eq!(search_geometry(FULL_HD, scale, SEARCH_HEIGHT), None);
        }
        for (width, height) in [(271, 1000), (1920, 87), (0, 0)] {
            assert_eq!(
                search_geometry(
                    WorkArea {
                        x: 0,
                        y: 0,
                        width,
                        height
                    },
                    1.0,
                    SEARCH_HEIGHT
                ),
                None
            );
        }
        assert_eq!(
            search_geometry(
                WorkArea {
                    x: 0,
                    y: 0,
                    width: 272,
                    height: 88
                },
                1.0,
                1.0
            )
            .ok_or("fixture work area supports the input bar")?
            .height,
            SEARCH_MIN_HEIGHT
        );
        Ok(())
    }
}
