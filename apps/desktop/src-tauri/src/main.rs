//! StarAt 桌面宿主的可执行入口，实际逻辑在库 crate `starat_desktop_lib` 中。

// 发布构建不显示额外的控制台窗口。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::process::ExitCode;

/// 进程入口：运行应用，启动失败时以非零退出码结束（不使用 `process::exit`）。
fn main() -> ExitCode {
    match starat_desktop_lib::run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            // 日志系统可能尚未建立，启动失败只能写到 stderr。
            eprintln!("StarAt 启动失败: {error}");
            ExitCode::FAILURE
        }
    }
}
