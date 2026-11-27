//! 拖入文件的磁盘路径接入悬浮窗（实施计划 10.1，D-15）。
//!
//! 悬浮窗用 HTML5 Drop，页面里的 `File` 对象没有磁盘路径；这里在悬浮窗的 WebView 上监听页面发来的
//! `chrome.webview.postMessageWithAdditionalObjects("starat:drop-files:<id>", files)`（原理见
//! `starat_platform_windows::webview_files`），拿到路径后用 Tauri 事件 [`EVENT`] 发回页面。仅 Windows。

use serde::Serialize;

/// 把路径发回页面的事件名。
pub const EVENT: &str = "starat-drop-paths";

/// 发回页面的事件内容。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DropPaths {
    /// 页面给的关联 ID（让页面把路径与那次拖放对上）。
    pub id: String,
    /// 磁盘路径（与拖入的 `File` 顺序一致）。
    pub paths: Vec<String>,
}

/// 在窗口的 WebView 上安装监听；失败只记日志（悬浮窗仍可用，只是文件拖入拿不到路径）。
#[cfg(target_os = "windows")]
pub fn install<R: tauri::Runtime>(app: &tauri::AppHandle<R>, window: &tauri::WebviewWindow<R>) {
    use tauri::Emitter;

    let app = app.clone();
    let result = window.with_webview(move |webview| {
        let callback: starat_platform_windows::webview_files::DropCallback =
            std::sync::Arc::new(move |id, paths| {
                tracing::info!(
                    event = "native_drop_paths",
                    count = paths.len(),
                    "收到拖入文件的磁盘路径"
                );
                if let Err(error) = app.emit(EVENT, DropPaths { id, paths }) {
                    tracing::warn!(event = "native_drop_emit_failed", %error, "发送拖入路径事件失败");
                }
            });
        if let Err(error) =
            starat_platform_windows::webview_files::watch_file_drops(&webview.controller(), callback)
        {
            tracing::warn!(event = "native_drop_install_failed", %error, "无法安装拖入文件路径处理器");
        }
    });
    if let Err(error) = result {
        tracing::warn!(event = "native_drop_unavailable", %error, "无法安装拖入文件路径处理器");
    }
}
