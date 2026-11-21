//! 自动更新（实施计划 7.6）：检查 → 下载并校验签名 → 安装 → 重启。
//!
//! * 更新包由 Tauri Updater 校验 minisign 签名（公钥写在 `tauri.conf.json`），签名不对一律拒绝；
//! * **安装之前先给当前数据做一份备份**（和恢复备份时一样的 `create_backup`），升级出问题也能回到升级前；
//! * 用户数据目录与安装目录分离，安装 / 升级 / 卸载都不会动数据。
//! * 更新端点在 `tauri.conf.json` 的 `plugins.updater.endpoints`。

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Runtime};
use tauri_plugin_updater::UpdaterExt;

/// 有新版本时的信息（IPC 表示）。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfoDto {
    /// 新版本号。
    pub version: String,
    /// 当前版本号。
    pub current_version: String,
    /// 更新说明（来自更新清单的 `notes`）。
    pub notes: Option<String>,
}

/// 检查是否有新版本；没有返回 `None`。
///
/// # Errors
///
/// 更新端点不可用 / 清单格式不对时返回错误文本（不含任何用户数据）。
pub async fn check<R: Runtime>(app: &AppHandle<R>) -> Result<Option<UpdateInfoDto>, String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    let update = updater.check().await.map_err(|e| e.to_string())?;
    Ok(update.map(|u| UpdateInfoDto {
        version: u.version.clone(),
        current_version: u.current_version.clone(),
        notes: u.body.clone(),
    }))
}

/// 下载并安装新版本（签名校验失败会报错并保持原版本）。安装完成后由调用方重启。
///
/// # Errors
///
/// 没有新版本、下载失败或签名校验失败时返回错误文本。
pub async fn download_and_install<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
        return Err("已经是最新版本".to_owned());
    };
    update
        .download_and_install(|_chunk, _total| {}, || {})
        .await
        .map_err(|e| e.to_string())
}
