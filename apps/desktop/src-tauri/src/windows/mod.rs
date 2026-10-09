//! 窗口创建。
//!
//! 当前只有主窗口；悬浮窗与窗口行为在 Phase 1（实施计划 1.1、1.2）加入。

use tauri::{App, WebviewUrl, WebviewWindowBuilder};

/// 主窗口的 label，与 `capabilities/main.json` 中的 `windows` 对应。
pub const MAIN_WINDOW_LABEL: &str = "main";

/// 创建并显示主窗口。
///
/// 窗口在启动成功之后才创建：数据库迁移失败时不会出现任何业务窗口。
///
/// # Errors
///
/// 窗口创建失败（如 WebView2 缺失）时返回 Tauri 错误。
pub fn create_main_window(app: &App) -> tauri::Result<()> {
    WebviewWindowBuilder::new(app, MAIN_WINDOW_LABEL, WebviewUrl::App("index.html".into()))
        .title("Nivlo")
        .inner_size(960.0, 640.0)
        .build()?;
    Ok(())
}
