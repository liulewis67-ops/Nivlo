//! 启动失败时的恢复 / 诊断对话框（架构文档 §30、实施计划 0.8）。
//!
//! Migration 失败时业务 Runtime 不会启动，用户看到的是一个原生对话框，提供三个出口：
//! 打开日志目录、导出数据库副本、退出。使用原生对话框而不是 WebView，是因为此时
//! 前端依赖的服务（数据库、IPC）都不可用。

use std::io;
use std::path::Path;

use nivlo_common::paths::AppPaths;

use crate::native_i18n::Lang;
use tauri::{AppHandle, Wry};
use tauri_plugin_dialog::{
    DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult,
};
use tauri_plugin_opener::OpenerExt;

/// 一种语言下的对话框文案。
struct Text {
    /// 打开日志目录按钮。
    open_logs: &'static str,
    /// 导出数据库副本按钮。
    export: &'static str,
    /// 退出按钮。
    quit: &'static str,
    /// 对话框标题。
    title: &'static str,
}

/// 按语言选择文案。
fn text(lang: Lang) -> Text {
    match lang {
        Lang::ZhCn => Text {
            open_logs: "打开日志目录",
            export: "导出数据库副本",
            quit: "退出",
            title: "Nivlo 无法启动",
        },
        Lang::En => Text {
            open_logs: "Open log folder",
            export: "Export database copy",
            quit: "Quit",
            title: "Nivlo can't start",
        },
    }
}

/// 对话框正文。
fn message(lang: Lang, error: &dyn std::fmt::Display) -> String {
    match lang {
        Lang::ZhCn => format!(
            "Nivlo 无法升级本地数据库，已停止启动以保护你的数据。

原因：{error}

             你可以打开日志目录查看详情，或导出一份数据库副本发给开发者。"
        ),
        Lang::En => format!(
            "Nivlo couldn't upgrade the local database and stopped to protect your data.

Reason: {error}

             You can open the log folder for details, or export a copy of the database to send to the developer."
        ),
    }
}

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
fn parse_choice(result: MessageDialogResult, words: &Text) -> RecoveryChoice {
    match result {
        MessageDialogResult::Custom(label) if label == words.open_logs => RecoveryChoice::OpenLogs,
        MessageDialogResult::Custom(label) if label == words.export => {
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
    // 数据库不可用，读不到保存的语言偏好：按系统语言显示。
    let words = text(Lang::from_system());
    let message = message(Lang::from_system(), error);
    loop {
        let result = app
            .dialog()
            .message(&message)
            .title(words.title)
            .kind(MessageDialogKind::Error)
            .buttons(MessageDialogButtons::YesNoCancelCustom(
                words.open_logs.to_owned(),
                words.export.to_owned(),
                words.quit.to_owned(),
            ))
            .blocking_show_with_result();
        match parse_choice(result, &words) {
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
            parse_choice(
                MessageDialogResult::Custom(text(Lang::En).open_logs.to_owned()),
                &text(Lang::En)
            ),
            RecoveryChoice::OpenLogs
        );
        assert_eq!(
            parse_choice(
                MessageDialogResult::Custom(text(Lang::ZhCn).export.to_owned()),
                &text(Lang::ZhCn)
            ),
            RecoveryChoice::ExportDatabase
        );
    }

    #[test]
    fn anything_else_quits() {
        assert_eq!(
            parse_choice(
                MessageDialogResult::Custom(text(Lang::En).quit.to_owned()),
                &text(Lang::En)
            ),
            RecoveryChoice::Quit
        );
        assert_eq!(
            parse_choice(MessageDialogResult::Cancel, &text(Lang::En)),
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
