//! 启动失败时的恢复 / 诊断对话框（架构文档 §30、实施计划 0.8）。
//!
//! Migration 失败时业务 Runtime 不会启动，用户看到的是一个原生对话框，提供三个出口：
//! 打开日志目录、导出数据库副本、退出。使用原生对话框而不是 WebView，是因为此时
//! 前端依赖的服务（数据库、IPC）都不可用。

use std::io;
use std::path::Path;

use nivlo_common::paths::AppPaths;
use tauri::{AppHandle, Wry};
use tauri_plugin_dialog::{
    DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult,
};
use tauri_plugin_opener::OpenerExt;

/// 对话框按钮文案。
// TODO(P0.9): 接入 i18n 后改为从资源文件读取（实施计划 D-06）。
const BUTTON_OPEN_LOGS: &str = "打开日志目录";
/// 导出数据库副本按钮文案。
const BUTTON_EXPORT: &str = "导出数据库副本";
/// 退出按钮文案。
const BUTTON_QUIT: &str = "退出";

/// 用户在恢复对话框中的选择。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RecoveryChoice {
    /// 打开日志目录。
    OpenLogs,
    /// 导出数据库副本。
    ExportDatabase,
    /// 退出应用。
    Quit,
}

/// 把对话框返回值解析为选择；关闭对话框等价于退出。
fn parse_choice(result: MessageDialogResult) -> RecoveryChoice {
    match result {
        MessageDialogResult::Custom(label) if label == BUTTON_OPEN_LOGS => RecoveryChoice::OpenLogs,
        MessageDialogResult::Custom(label) if label == BUTTON_EXPORT => {
            RecoveryChoice::ExportDatabase
        }
        _ => RecoveryChoice::Quit,
    }
}

/// 复制数据库文件到 `destination`，返回复制的字节数。
///
/// 只复制主数据库文件：此时连接池已关闭，WAL 已被检查点合并或随下次打开恢复，
/// 副本可以交给开发者排查。
///
/// # Errors
///
/// 源文件不存在或复制失败时返回 IO 错误。
pub fn export_database_copy(database_file: &Path, destination: &Path) -> io::Result<u64> {
    std::fs::copy(database_file, destination)
}

/// 显示恢复对话框并循环处理用户选择，直到用户选择退出。
///
/// 阻塞调用，只应在启动阶段（事件循环尚未处理业务窗口时）使用。
pub fn run_recovery_dialog(app: &AppHandle<Wry>, paths: &AppPaths, error: &dyn std::fmt::Display) {
    let message = format!(
        "Nivlo 无法升级本地数据库，已停止启动以保护你的数据。\n\n原因：{error}\n\n\
         你可以打开日志目录查看详情，或导出一份数据库副本发给开发者。"
    );
    loop {
        let result = app
            .dialog()
            .message(&message)
            .title("Nivlo 无法启动")
            .kind(MessageDialogKind::Error)
            .buttons(MessageDialogButtons::YesNoCancelCustom(
                BUTTON_OPEN_LOGS.to_owned(),
                BUTTON_EXPORT.to_owned(),
                BUTTON_QUIT.to_owned(),
            ))
            .blocking_show_with_result();
        match parse_choice(result) {
            RecoveryChoice::OpenLogs => {
                let logs = paths.logs_dir().to_string_lossy().into_owned();
                if let Err(open_error) = app.opener().open_path(logs, None::<&str>) {
                    tracing::warn!(event = "recovery_open_logs_failed", %open_error, "无法打开日志目录");
                }
            }
            RecoveryChoice::ExportDatabase => export_with_save_dialog(app, paths),
            RecoveryChoice::Quit => break,
        }
    }
}

/// 让用户选择保存位置并导出数据库副本。
fn export_with_save_dialog(app: &AppHandle<Wry>, paths: &AppPaths) {
    let Some(target) = app
        .dialog()
        .file()
        .set_file_name("nivlo-database-copy.db")
        .blocking_save_file()
    else {
        return;
    };
    let Some(destination) = target.as_path() else {
        tracing::warn!(
            event = "recovery_export_unsupported_path",
            "所选位置不是本地文件路径"
        );
        return;
    };
    match export_database_copy(&paths.database_file(), destination) {
        Ok(bytes) => tracing::info!(event = "recovery_export_done", bytes, "数据库副本已导出"),
        Err(export_error) => {
            tracing::error!(event = "recovery_export_failed", %export_error, "导出数据库副本失败");
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn custom_buttons_map_to_choices() {
        assert_eq!(
            parse_choice(MessageDialogResult::Custom(BUTTON_OPEN_LOGS.to_owned())),
            RecoveryChoice::OpenLogs
        );
        assert_eq!(
            parse_choice(MessageDialogResult::Custom(BUTTON_EXPORT.to_owned())),
            RecoveryChoice::ExportDatabase
        );
    }

    #[test]
    fn anything_else_quits() {
        assert_eq!(
            parse_choice(MessageDialogResult::Custom(BUTTON_QUIT.to_owned())),
            RecoveryChoice::Quit
        );
        assert_eq!(
            parse_choice(MessageDialogResult::Cancel),
            RecoveryChoice::Quit
        );
    }

    #[test]
    fn export_copies_the_database_file() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("nivlo.db");
        std::fs::write(&source, b"sqlite bytes").unwrap();
        let destination = dir.path().join("copy.db");
        assert_eq!(export_database_copy(&source, &destination).unwrap(), 12);
        assert_eq!(std::fs::read(&destination).unwrap(), b"sqlite bytes");
    }

    #[test]
    fn export_of_a_missing_file_fails() {
        let dir = tempfile::tempdir().unwrap();
        assert!(export_database_copy(&dir.path().join("none.db"), &dir.path().join("x")).is_err());
    }
}
