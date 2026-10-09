//! Nivlo 桌面宿主入口（Composition Root）。
//!
//! 当前仅启动一个空白窗口；窗口架构、IPC 与服务装配在后续子阶段加入。

// 发布构建不显示额外的控制台窗口。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

/// 启动 Tauri 应用。
fn main() {
    let result = tauri::Builder::default().run(tauri::generate_context!());
    if let Err(error) = result {
        // 启动期日志系统尚未建立（P0.4 / P0.8），此处直接写 stderr 并以非零码退出。
        eprintln!("Nivlo 启动失败: {error}");
        std::process::exit(1);
    }
}
