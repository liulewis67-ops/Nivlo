//! 把浏览器标签页拖到悬浮窗上（Chromium 的标签页拖动不是系统拖放，HTML5 Drop 收不到）。
//!
//! 识别与读网址在 `stardeskbox_platform_windows::browser_tab`；这里把结果换算成悬浮窗页面里的坐标，
//! 用 Tauri 事件 [`EVENT`] 发给悬浮窗，由页面走与普通拖放相同的流程（新建事项 / 收进收集箱）。仅 Windows。

use serde::Serialize;

/// 发给悬浮窗页面的事件名。
pub const EVENT: &str = "stardeskbox-tab-drop";

/// 发给页面的事件内容。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TabDropPayload {
    /// 页面网址。
    pub url: String,
    /// 页面标题；认不出时为 `None`。
    pub title: Option<String>,
    /// 松手位置在页面里的坐标（逻辑像素），用来判断松在哪个放置区。
    pub x: f64,
    /// 同上。
    pub y: f64,
}

/// 在悬浮窗上开始识别标签页拖入；失败只记日志（其他拖放不受影响）。必须在主线程调用。
#[cfg(target_os = "windows")]
pub fn install<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) {
    use tauri::Emitter;

    let hwnd = match window.hwnd() {
        Ok(hwnd) => hwnd.0 as isize,
        Err(error) => {
            tracing::warn!(event = "tab_drop_hwnd_unavailable", %error, "无法获取悬浮窗句柄");
            return;
        }
    };
    let target = window.clone();
    let callback: stardeskbox_platform_windows::browser_tab::TabDropCallback =
        std::sync::Arc::new(move |drop| {
            let (origin, scale) = match (target.inner_position(), target.scale_factor()) {
                (Ok(origin), Ok(scale)) if scale > 0.0 => (origin, scale),
                _ => return,
            };
            let payload = TabDropPayload {
                url: drop.url,
                title: drop.title,
                x: f64::from(drop.screen_x - origin.x) / scale,
                y: f64::from(drop.screen_y - origin.y) / scale,
            };
            tracing::info!(event = "tab_drop", "浏览器标签页拖到了悬浮窗上");
            if let Err(error) = target.emit_to(target.label(), EVENT, payload) {
                tracing::warn!(event = "tab_drop_emit_failed", %error, "发送标签页拖入事件失败");
            }
        });
    if let Err(error) = stardeskbox_platform_windows::browser_tab::watch_tab_drops(hwnd, callback) {
        tracing::warn!(
            event = "tab_drop_install_failed",
            error,
            "无法识别浏览器标签页拖入"
        );
    }
}
