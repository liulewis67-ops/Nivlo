//! 悬浮窗自定义皮肤本地帧图资源 Command（仅主窗口权限）。

use base64::Engine as _;
use nivlo_application::error::{AppError, ErrorCode};
use nivlo_application::ports::SkinAssetFormat;
use tauri::State;

use crate::app::AppState;
use crate::dto::{IpcError, SkinAssetDto, SkinStorageUsageDto};

/// 把一张皮肤帧图（Base64 编码）以内容寻址方式保存到 `skins/assets/`。
///
/// # Errors
///
/// 格式不受支持、Base64 无效、图片魔数不符、超限或磁盘写入失败时返回 [`IpcError`]。
#[tauri::command]
#[specta::specta]
pub async fn save_skin_asset(
    state: State<'_, AppState>,
    bytes_base64: String,
    format: String,
) -> Result<SkinAssetDto, IpcError> {
    let parsed_format = SkinAssetFormat::from_extension(&format).ok_or_else(|| {
        IpcError::from(AppError::new(
            ErrorCode::InvalidInput,
            format!("不支持的皮肤帧图格式：{format}"),
        ))
    })?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(bytes_base64.trim())
        .map_err(|_| {
            IpcError::from(AppError::new(
                ErrorCode::InvalidInput,
                "皮肤帧图不是有效的 Base64 数据",
            ))
        })?;
    let stored = state
        .services
        .skin_assets
        .store_bytes(bytes, parsed_format)
        .await
        .map_err(AppError::from)?;
    Ok(SkinAssetDto::from(stored))
}

/// 清理 `skins/assets/` 下未被清单引用的孤儿帧图，返回释放的字节数。
///
/// # Errors
///
/// 磁盘读取失败时返回 [`IpcError`]。
#[tauri::command]
#[specta::specta]
pub async fn prune_skin_assets(
    state: State<'_, AppState>,
    keep_files: Vec<String>,
) -> Result<u32, IpcError> {
    let freed = state
        .services
        .skin_assets
        .prune_unused(&keep_files)
        .await
        .map_err(AppError::from)?;
    Ok(u32::try_from(freed).unwrap_or(u32::MAX))
}

/// 统计当前 `skins/assets/` 目录的文件数量与磁盘占用。
///
/// # Errors
///
/// 磁盘读取失败时返回 [`IpcError`]。
#[tauri::command]
#[specta::specta]
pub async fn get_skin_storage_usage(
    state: State<'_, AppState>,
) -> Result<SkinStorageUsageDto, IpcError> {
    let usage = state
        .services
        .skin_assets
        .usage()
        .await
        .map_err(AppError::from)?;
    Ok(SkinStorageUsageDto::from(usage))
}
