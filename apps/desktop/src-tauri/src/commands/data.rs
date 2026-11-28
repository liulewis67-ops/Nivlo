//! 数据导出、备份与恢复 Command（实施计划 7.4）。

use asterjot_application::error::{AppError, ErrorCode};
use asterjot_application::export::{ExportFormat, ExportedFile};
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Runtime, State};
use tauri_plugin_dialog::DialogExt;

use crate::app::AppState;
use crate::backup;
use crate::dto::IpcError;

/// 导出 / 备份失败：记日志，返回 `EXPORT_FAILED`。
fn failed(error: &dyn std::fmt::Display) -> IpcError {
    tracing::error!(event = "data_export_failed", %error, "导出 / 备份失败");
    IpcError::from(AppError::new(ErrorCode::ExportFailed, error.to_string()))
}

/// 在文件管理器里选中文件；失败只记日志。
fn reveal(path: &std::path::Path) {
    if let Err(error) = tauri_plugin_opener::reveal_item_in_dir(path) {
        tracing::warn!(event = "reveal_export_failed", %error, "无法在文件管理器中显示导出的文件");
    }
}

/// 导出结果。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ExportResultDto {
    /// 写出的文件或文件夹（压缩包）路径。
    pub path: String,
    /// 导出了多少个 Item。
    pub item_count: u32,
}

/// 创建备份：数据库快照 + 附件打成一个压缩包，写在导出目录并在文件管理器中显示。返回路径。
///
/// # Errors
///
/// 失败返回 `EXPORT_FAILED`，不会留下半成品。
#[tauri::command]
#[specta::specta]
pub async fn create_backup_file(state: State<'_, AppState>) -> Result<String, IpcError> {
    let paths = state
        .runtime
        .paths()
        .cloned()
        .ok_or_else(|| failed(&"应用目录尚未就绪"))?;
    let now = state.runtime.clock.now_utc();
    let name = format!("asterjot-backup-{}.zip", now.format("%Y%m%d-%H%M%S"));
    let path = backup::create_backup(
        &state.runtime.database(),
        &paths,
        &name,
        &now.to_rfc3339(),
        env!("CARGO_PKG_VERSION"),
    )
    .await
    .map_err(|e| failed(&e))?;
    reveal(&path);
    Ok(path.to_string_lossy().into_owned())
}

/// 导出全部笔记 / 待办。`format`：`json`、`markdown`（单文件）、`markdownFiles`（每条一个文件，打成压缩包）。
///
/// # Errors
///
/// 格式不认识返回 `INVALID_INPUT`；写入失败返回 `EXPORT_FAILED`。
#[tauri::command]
#[specta::specta]
pub async fn export_data(
    state: State<'_, AppState>,
    format: String,
) -> Result<ExportResultDto, IpcError> {
    let format = match format.as_str() {
        "json" => ExportFormat::Json,
        "markdown" => ExportFormat::Markdown,
        "markdownFiles" => ExportFormat::MarkdownFiles,
        other => {
            return Err(IpcError::from(AppError::new(
                ErrorCode::InvalidInput,
                format!("不认识的导出格式：{other}"),
            )));
        }
    };
    let paths = state
        .runtime
        .paths()
        .cloned()
        .ok_or_else(|| failed(&"应用目录尚未就绪"))?;
    let bundle = state.services.export.export(format).await?;
    let stamp = state
        .runtime
        .clock
        .now_utc()
        .format("%Y%m%d-%H%M%S")
        .to_string();
    let exports = paths.exports_dir();
    let item_count = u32::try_from(bundle.item_count).unwrap_or(u32::MAX);
    let written =
        tokio::task::spawn_blocking(move || write_bundle(&exports, &stamp, format, bundle.files))
            .await
            .map_err(|e| failed(&e))?
            .map_err(|e| failed(&e))?;
    reveal(&written);
    Ok(ExportResultDto {
        path: written.to_string_lossy().into_owned(),
        item_count,
    })
}

/// 把导出的文件写到导出目录；多文件打成 zip。
fn write_bundle(
    exports: &std::path::Path,
    stamp: &str,
    format: ExportFormat,
    files: Vec<ExportedFile>,
) -> Result<std::path::PathBuf, String> {
    use std::io::Write;
    std::fs::create_dir_all(exports).map_err(|e| e.to_string())?;
    match format {
        ExportFormat::Json | ExportFormat::Markdown => {
            let file = files.into_iter().next().ok_or("没有可导出的内容")?;
            let extension = if format == ExportFormat::Json {
                "json"
            } else {
                "md"
            };
            let target = exports.join(format!("asterjot-export-{stamp}.{extension}"));
            std::fs::write(&target, file.bytes).map_err(|e| e.to_string())?;
            Ok(target)
        }
        ExportFormat::MarkdownFiles => {
            let target = exports.join(format!("asterjot-export-{stamp}.zip"));
            let mut writer =
                zip::ZipWriter::new(std::fs::File::create(&target).map_err(|e| e.to_string())?);
            let options = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated);
            for file in files {
                writer
                    .start_file(file.path, options)
                    .map_err(|e| e.to_string())?;
                writer.write_all(&file.bytes).map_err(|e| e.to_string())?;
            }
            writer.finish().map_err(|e| e.to_string())?;
            Ok(target)
        }
    }
}

/// 选中的备份已经暂存，等待重启后应用。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RestoreStagedDto {
    /// 备份的创建时间（RFC 3339）。
    pub created_at: String,
    /// 创建备份的应用版本。
    pub app_version: String,
    /// 恢复前自动为当前数据做的备份的路径。
    pub safety_backup: String,
}

/// 从备份恢复：弹出文件选择框选一个备份包 → 校验 → **先为当前数据自动做一份备份** → 暂存。
/// 数据在下次启动时替换（调用 `restart_app` 立即重启）。用户取消选择时返回 `null`。
///
/// # Errors
///
/// 备份包无效返回 `EXPORT_FAILED`（原数据不受影响）。
#[tauri::command]
#[specta::specta]
pub async fn restore_backup<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
) -> Result<Option<RestoreStagedDto>, IpcError> {
    let paths = state
        .runtime
        .paths()
        .cloned()
        .ok_or_else(|| failed(&"应用目录尚未就绪"))?;
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .add_filter("AsterJot备份", &["zip"])
            .blocking_pick_file()
    })
    .await
    .map_err(|e| failed(&e))?;
    let Some(picked) = picked else {
        return Ok(None);
    };
    let picked = picked.into_path().map_err(|e| failed(&e))?;
    // 先验证再动手：无效的备份不应该触发任何备份 / 暂存。
    let now = state.runtime.clock.now_utc();
    let safety_name = format!(
        "asterjot-before-restore-{}.zip",
        now.format("%Y%m%d-%H%M%S")
    );
    let manifest = backup::stage_restore(&picked, &paths)
        .await
        .map_err(|e| failed(&e))?;
    let safety = backup::create_backup(
        &state.runtime.database(),
        &paths,
        &safety_name,
        &now.to_rfc3339(),
        env!("CARGO_PKG_VERSION"),
    )
    .await;
    let safety = match safety {
        Ok(path) => path,
        Err(error) => {
            // 没能保住当前数据的备份就不继续替换。
            let _ = std::fs::remove_dir_all(paths.root().join("restore-staging"));
            return Err(failed(&error));
        }
    };
    Ok(Some(RestoreStagedDto {
        created_at: manifest.created_at,
        app_version: manifest.app_version,
        safety_backup: safety.to_string_lossy().into_owned(),
    }))
}

/// 删除所有数据：**先为当前数据自动做一份备份**，再暂存清空；下次启动（调用 `restart_app` 立即重启）时
/// 当前数据库与附件挪到 `replaced-<时间>/`，应用以全新的空库启动。返回那份备份的路径。
///
/// 卸载程序不删除数据目录，这里是清空数据的入口。
///
/// # Errors
///
/// 备份或暂存失败返回 `EXPORT_FAILED`，此时什么都不会被清空。
#[tauri::command]
#[specta::specta]
pub async fn reset_all_data(state: State<'_, AppState>) -> Result<String, IpcError> {
    let paths = state
        .runtime
        .paths()
        .cloned()
        .ok_or_else(|| failed(&"应用目录尚未就绪"))?;
    let now = state.runtime.clock.now_utc();
    let safety_name = format!("asterjot-before-reset-{}.zip", now.format("%Y%m%d-%H%M%S"));
    // 没能保住当前数据的备份就不清空。
    let safety = backup::create_backup(
        &state.runtime.database(),
        &paths,
        &safety_name,
        &now.to_rfc3339(),
        env!("CARGO_PKG_VERSION"),
    )
    .await
    .map_err(|e| failed(&e))?;
    backup::stage_reset(&paths).map_err(|e| failed(&e))?;
    tracing::info!(event = "reset_staged", "已暂存删除所有数据，重启后执行");
    Ok(safety.to_string_lossy().into_owned())
}

/// 重启应用（恢复备份后使用）。
#[tauri::command]
#[specta::specta]
pub async fn restart_app<R: Runtime>(app: AppHandle<R>) {
    app.restart();
}
