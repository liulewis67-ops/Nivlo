//! 窗口行为测试（mock 运行时）：只有悬浮窗在启动时存在，主窗口按需创建并复用。
//!
//! "关闭主窗口只是隐藏"依赖真实的窗口消息循环，mock 运行时不会分发 `CloseRequested`，
//! 因此该行为在真实应用中手动验证（见实施计划 1.1 完成记录）。

#![allow(
    missing_docs,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::missing_docs_in_private_items
)]

use stardeskbox_desktop_lib::windows::{
    FLOATING_WINDOW_LABEL, MAIN_WINDOW_LABEL, create_floating_window, on_window_event,
    show_main_window,
};
use tauri::test::{MockRuntime, mock_builder, mock_context, noop_assets};
use tauri::{App, Manager};

/// 创建带窗口事件处理的 mock 应用。
fn app() -> App<MockRuntime> {
    mock_builder()
        .on_window_event(on_window_event)
        .build(mock_context(noop_assets()))
        .unwrap()
}

#[test]
fn only_the_floating_window_exists_after_startup() {
    let app = app();
    create_floating_window(&app).unwrap();
    assert!(app.get_webview_window(FLOATING_WINDOW_LABEL).is_some());
    assert!(app.get_webview_window(MAIN_WINDOW_LABEL).is_none());
}

#[test]
fn main_window_is_created_on_demand_and_reused() {
    let app = app();
    create_floating_window(&app).unwrap();

    show_main_window(app.handle()).unwrap();
    let main = app.get_webview_window(MAIN_WINDOW_LABEL).unwrap();
    assert!(main.is_visible().unwrap());

    // 再次调用复用同一个窗口，而不是创建第二个 WebView。
    show_main_window(app.handle()).unwrap();
    assert_eq!(app.webview_windows().len(), 2);
}
