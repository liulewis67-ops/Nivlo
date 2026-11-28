//! 悬浮窗自定义皮肤本地帧图资源与皮肤包导入/导出 Command（仅主窗口权限）。

use std::fs::File;
use std::io::{Read, Write};
use std::path::Path;

use asterjot_application::error::{AppError, ErrorCode};
use asterjot_application::ports::SkinAssetFormat;
use asterjot_storage::{MAX_SKIN_ASSET_BYTES, is_valid_skin_asset_file_name};
use base64::Engine as _;
use tauri::{AppHandle, Runtime, State};
use tauri_plugin_dialog::DialogExt;

use crate::app::AppState;
use crate::dto::{IpcError, SkinAssetDto, SkinStorageUsageDto};

/// 皮肤包内 `manifest.json` 的最大字节数（256 KiB）。
const MAX_SKIN_MANIFEST_BYTES: usize = 256 * 1024;

/// 皮肤包内允许的最大帧图文件数量。
const MAX_SKIN_PACK_ASSETS: usize = 180;

/// Validated manifest and decoded image payloads read from a skin pack.
type SkinPackContents = (String, Vec<(SkinAssetFormat, Vec<u8>)>);

/// 把导出/导入文件操作错误统一转换为 `EXPORT_FAILED`。
fn pack_failed(error: &impl std::fmt::Display) -> IpcError {
    IpcError::from(AppError::new(
        ErrorCode::ExportFailed,
        format!("皮肤包操作失败：{error}"),
    ))
}

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

/// 将清单 JSON 与引用的帧图原子打包到 `target` zip 文件。
fn write_skin_pack_zip(
    target: &Path,
    manifest_json: &str,
    asset_files: &[(String, Vec<u8>)],
) -> Result<(), IpcError> {
    let partial = target.with_extension("zip.part");
    let outcome = (|| -> Result<(), std::io::Error> {
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        let mut writer = zip::ZipWriter::new(File::create(&partial)?);
        writer.start_file("manifest.json", options)?;
        writer.write_all(manifest_json.as_bytes())?;
        for (file_name, bytes) in asset_files {
            writer.start_file(format!("assets/{file_name}"), options)?;
            writer.write_all(bytes)?;
        }
        writer.finish()?;
        std::fs::rename(&partial, target)?;
        Ok(())
    })();
    if outcome.is_err() {
        let _ = std::fs::remove_file(&partial);
    }
    outcome.map_err(|e| pack_failed(&e))
}

/// 校验并解包皮肤 zip，返回 `(manifest_json, Vec<(SkinAssetFormat, bytes)>)`。
fn read_skin_pack_zip(source: &Path) -> Result<SkinPackContents, IpcError> {
    let file = File::open(source).map_err(|e| pack_failed(&e))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| pack_failed(&e))?;

    let manifest_json = {
        let mut entry = archive
            .by_name("manifest.json")
            .map_err(|_| pack_failed(&"皮肤包缺少 manifest.json"))?;
        let mut text = String::new();
        entry
            .by_ref()
            .take((MAX_SKIN_MANIFEST_BYTES + 1) as u64)
            .read_to_string(&mut text)
            .map_err(|e| pack_failed(&e))?;
        if text.len() > MAX_SKIN_MANIFEST_BYTES {
            return Err(pack_failed(&"皮肤包清单过大"));
        }
        let _: serde_json::Value =
            serde_json::from_str(&text).map_err(|_| pack_failed(&"manifest.json 格式无效"))?;
        text
    };

    let mut assets = Vec::new();
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|e| pack_failed(&e))?;
        let name = entry.name().to_owned();
        if entry.is_dir() || name == "manifest.json" {
            continue;
        }
        let Some(file_name) = name.strip_prefix("assets/") else {
            return Err(pack_failed(&format!("皮肤包包含不允许的路径：{name}")));
        };
        if !is_valid_skin_asset_file_name(file_name) {
            return Err(pack_failed(&format!(
                "皮肤包包含非法资源文件名：{file_name}"
            )));
        }
        if assets.len() >= MAX_SKIN_PACK_ASSETS {
            return Err(pack_failed(&"皮肤包内帧图数量超过上限"));
        }
        let Some((_, ext)) = file_name.split_once('.') else {
            return Err(pack_failed(&"缺少扩展名"));
        };
        let Some(format) = SkinAssetFormat::from_extension(ext) else {
            return Err(pack_failed(&"不支持的帧图格式"));
        };
        let mut bytes = Vec::new();
        entry
            .by_ref()
            .take((MAX_SKIN_ASSET_BYTES + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|e| pack_failed(&e))?;
        if bytes.len() > MAX_SKIN_ASSET_BYTES {
            return Err(pack_failed(&"皮肤包内单张帧图超过大小上限"));
        }
        assets.push((format, bytes));
    }

    Ok((manifest_json, assets))
}

/// 将当前皮肤清单与引用的本地帧图导出为 `.asterjot-skin.zip`（写入 `exports/` 并在文件管理器中显示）。
///
/// # Errors
///
/// 清单过大或无效、引用的帧图缺失或写文件失败时返回 [`IpcError`]。
#[tauri::command]
#[specta::specta]
pub async fn export_skin_pack(
    state: State<'_, AppState>,
    manifest_json: String,
    asset_files: Vec<String>,
) -> Result<String, IpcError> {
    if manifest_json.len() > MAX_SKIN_MANIFEST_BYTES {
        return Err(pack_failed(&"皮肤清单过大"));
    }
    let _: serde_json::Value =
        serde_json::from_str(&manifest_json).map_err(|_| pack_failed(&"皮肤清单不是有效 JSON"))?;

    let paths = state
        .runtime
        .paths()
        .cloned()
        .ok_or_else(|| pack_failed(&"应用目录尚未就绪"))?;

    let mut payload = Vec::new();
    for file_name in asset_files {
        if !is_valid_skin_asset_file_name(&file_name) {
            continue;
        }
        let bytes = state
            .services
            .skin_assets
            .read_bytes(&file_name)
            .await
            .map_err(AppError::from)?;
        payload.push((file_name, bytes));
    }

    let exports_dir = paths.exports_dir();
    let stamp = state
        .runtime
        .clock
        .now_utc()
        .format("%Y%m%d-%H%M%S")
        .to_string();
    let target = exports_dir.join(format!("asterjot-skin-{stamp}.asterjot-skin.zip"));
    let target_clone = target.clone();
    tokio::task::spawn_blocking(move || -> Result<(), IpcError> {
        std::fs::create_dir_all(&exports_dir).map_err(|e| pack_failed(&e))?;
        write_skin_pack_zip(&target_clone, &manifest_json, &payload)
    })
    .await
    .map_err(|e| pack_failed(&e))??;

    if let Err(error) = tauri_plugin_opener::reveal_item_in_dir(&target) {
        tracing::warn!(event = "reveal_skin_pack_failed", %error, "无法在文件管理器中显示导出的皮肤包");
    }
    Ok(target.to_string_lossy().into_owned())
}

/// 弹出文件选择框导入 `.asterjot-skin.zip`，校验并落盘全部帧图后返回清单 JSON；用户取消返回 `null`。
///
/// # Errors
///
/// 压缩包损坏、含非法路径或图片魔数/配额校验失败时返回 [`IpcError`]。
#[tauri::command]
#[specta::specta]
pub async fn import_skin_pack<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
) -> Result<Option<String>, IpcError> {
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .add_filter("AsterJot Skin Pack", &["zip"])
            .blocking_pick_file()
    })
    .await
    .map_err(|e| pack_failed(&e))?;
    let Some(picked) = picked else {
        return Ok(None);
    };
    let path = picked.into_path().map_err(|e| pack_failed(&e))?;
    let (manifest_json, assets) = tokio::task::spawn_blocking(move || read_skin_pack_zip(&path))
        .await
        .map_err(|e| pack_failed(&e))??;

    for (format, bytes) in assets {
        state
            .services
            .skin_assets
            .store_bytes(bytes, format)
            .await
            .map_err(AppError::from)?;
    }
    Ok(Some(manifest_json))
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    /// 构造一个带合法 WebP 魔数的测试帧图。
    fn sample_webp(tag: &[u8]) -> Vec<u8> {
        let mut bytes = b"RIFF\x00\x00\x00\x00WEBP".to_vec();
        bytes.extend_from_slice(tag);
        bytes
    }

    #[test]
    fn skin_pack_zip_round_trips_and_rejects_traversal() {
        let dir = tempfile::tempdir().unwrap();
        let good_zip = dir.path().join("good.asterjot-skin.zip");
        let file_name = format!("{}.webp", "a".repeat(64));
        let manifest = r#"{"version":2,"mode":"image"}"#;
        write_skin_pack_zip(&good_zip, manifest, &[(file_name, sample_webp(b"ok"))]).unwrap();

        let (read_manifest, assets) = read_skin_pack_zip(&good_zip).unwrap();
        assert_eq!(read_manifest, manifest);
        assert_eq!(assets.len(), 1);
        assert_eq!(assets[0].0, SkinAssetFormat::Webp);

        // 构造含非法路径的恶意 zip，必须拒绝。
        let evil_zip = dir.path().join("evil.zip");
        {
            let options = zip::write::SimpleFileOptions::default();
            let mut writer = zip::ZipWriter::new(File::create(&evil_zip).unwrap());
            writer.start_file("manifest.json", options).unwrap();
            writer.write_all(manifest.as_bytes()).unwrap();
            writer.start_file("../escape.png", options).unwrap();
            writer.write_all(b"evil").unwrap();
            writer.finish().unwrap();
        }
        assert!(read_skin_pack_zip(&evil_zip).is_err());
    }
}
