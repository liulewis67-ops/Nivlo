//! 文件系统版 [`SkinAssetStore`]：把悬浮窗自定义皮肤的帧图以内容寻址方式保存在 `skins/assets/`。
//!
//! 所有文件名严格为 `<64位小写SHA-256>.(webp|png)`，既实现跨状态自动去重，也从根源杜绝路径穿越。

use std::collections::HashSet;
use std::fmt::Write as _;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use async_trait::async_trait;
use nivlo_application::ports::{
    SkinAssetFormat, SkinAssetStore, SkinStorageUsage, StorageError, StoredSkinAsset,
};
use sha2::{Digest, Sha256};

/// 单张皮肤帧图的最大字节数（512 KiB）。
pub const MAX_SKIN_ASSET_BYTES: usize = 512 * 1024;

/// 皮肤资源目录的总磁盘配额（50 MiB）。
pub const MAX_SKIN_STORAGE_BYTES: u64 = 50 * 1024 * 1024;

/// PNG 文件魔数。
const PNG_MAGIC: &[u8; 8] = b"\x89PNG\r\n\x1a\n";

/// 校验文件名是否为合法的内容寻址皮肤资源文件名（`<64位小写hex>.(webp|png)`）。
#[must_use]
pub fn is_valid_skin_asset_file_name(file_name: &str) -> bool {
    let Some((stem, ext)) = file_name.split_once('.') else {
        return false;
    };
    stem.len() == 64
        && stem
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        && SkinAssetFormat::from_extension(ext).is_some()
        && !file_name.contains(['/', '\\'])
}

/// 校验字节流头部是否匹配声明的图片格式。
fn matches_magic(bytes: &[u8], format: SkinAssetFormat) -> bool {
    match format {
        SkinAssetFormat::Png => bytes.len() >= PNG_MAGIC.len() && &bytes[..8] == PNG_MAGIC,
        SkinAssetFormat::Webp => {
            bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP"
        }
    }
}

/// 计算字节切片的 64 位小写 SHA-256 十六进制字符串。
fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut hex = String::with_capacity(64);
    for byte in digest {
        let _ = write!(&mut hex, "{byte:02x}");
    }
    hex
}

/// 统计目录下已有的合法皮肤资源文件数与总字节数。
fn scan_usage(dir: &Path) -> std::io::Result<(u64, u64)> {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok((0, 0)),
        Err(error) => return Err(error),
    };
    let mut count = 0_u64;
    let mut total = 0_u64;
    for entry in entries.filter_map(Result::ok) {
        let Ok(file_name) = entry.file_name().into_string() else {
            continue;
        };
        if !is_valid_skin_asset_file_name(&file_name) {
            continue;
        }
        if let Ok(meta) = entry.metadata()
            && meta.is_file()
        {
            count += 1;
            total = total.saturating_add(meta.len());
        }
    }
    Ok((count, total))
}

/// 把底层 IO 错误映射为 [`StorageError::Unavailable`]。
fn unavailable(context: &str, error: &impl std::fmt::Display) -> StorageError {
    StorageError::Unavailable(format!("{context}：{error}"))
}

/// 保存在 `skins/assets/` 目录下的本地皮肤资源库。
#[derive(Debug, Clone)]
pub struct FsSkinAssetStore {
    /// `skins/assets/` 目录路径。
    dir: PathBuf,
    /// 允许的最大磁盘配额（字节）。
    quota_bytes: u64,
}

impl FsSkinAssetStore {
    /// 创建适配器，使用默认 50 MiB 配额；目录会在首次写入时自动创建。
    #[must_use]
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self {
            dir: dir.into(),
            quota_bytes: MAX_SKIN_STORAGE_BYTES,
        }
    }

    /// 创建带自定义配额的适配器（测试用）。
    #[must_use]
    pub fn with_quota(dir: impl Into<PathBuf>, quota_bytes: u64) -> Self {
        Self {
            dir: dir.into(),
            quota_bytes,
        }
    }
}

#[async_trait]
impl SkinAssetStore for FsSkinAssetStore {
    async fn store_bytes(
        &self,
        bytes: Vec<u8>,
        format: SkinAssetFormat,
    ) -> Result<StoredSkinAsset, StorageError> {
        if bytes.is_empty() || bytes.len() > MAX_SKIN_ASSET_BYTES {
            return Err(StorageError::Unavailable(format!(
                "皮肤帧图大小超出限制（上限 {} KiB）",
                MAX_SKIN_ASSET_BYTES / 1024
            )));
        }
        if !matches_magic(&bytes, format) {
            return Err(StorageError::Unavailable(format!(
                "皮肤帧图内容与声明的 {} 格式不匹配",
                format.extension()
            )));
        }

        let id = sha256_hex(&bytes);
        let file_name = format!("{id}.{}", format.extension());
        let dir = self.dir.clone();
        let quota_bytes = self.quota_bytes;
        let size_bytes = bytes.len() as u64;

        tokio::task::spawn_blocking(move || -> Result<u64, StorageError> {
            std::fs::create_dir_all(&dir).map_err(|e| unavailable("创建皮肤目录失败", &e))?;
            let final_path = dir.join(&file_name);
            if let Ok(existing) = std::fs::metadata(&final_path)
                && existing.is_file()
            {
                return Ok(existing.len());
            }
            let (_, used) = scan_usage(&dir).map_err(|e| unavailable("统计皮肤占用失败", &e))?;
            if used.saturating_add(size_bytes) > quota_bytes {
                return Err(StorageError::Unavailable(format!(
                    "皮肤资源占用已达上限（{} MiB），请先清理未使用的帧",
                    quota_bytes / (1024 * 1024)
                )));
            }
            let temp_path = dir.join(format!("{file_name}.part"));
            let write = std::fs::write(&temp_path, &bytes)
                .and_then(|()| std::fs::rename(&temp_path, &final_path));
            if write.is_err() {
                let _ = std::fs::remove_file(&temp_path);
            }
            write
                .map(|()| size_bytes)
                .map_err(|e| unavailable("写入皮肤帧图失败", &e))
        })
        .await
        .map_err(|e| unavailable("写入皮肤帧图任务中断", &e))??;

        Ok(StoredSkinAsset {
            id,
            format,
            size_bytes,
        })
    }

    async fn read_bytes(&self, file_name: &str) -> Result<Vec<u8>, StorageError> {
        if !is_valid_skin_asset_file_name(file_name) {
            return Err(StorageError::Unavailable("非法的皮肤资源文件名".to_owned()));
        }
        let path = self.dir.join(file_name);
        tokio::task::spawn_blocking(move || std::fs::read(&path))
            .await
            .map_err(|e| unavailable("读取皮肤帧图任务中断", &e))?
            .map_err(|e| unavailable("读取皮肤帧图失败", &e))
    }

    async fn prune_unused(&self, keep_files: &[String]) -> Result<u64, StorageError> {
        let keep: HashSet<String> = keep_files
            .iter()
            .filter(|name| is_valid_skin_asset_file_name(name))
            .cloned()
            .collect();
        let dir = self.dir.clone();
        tokio::task::spawn_blocking(move || -> std::io::Result<u64> {
            let entries = match std::fs::read_dir(&dir) {
                Ok(entries) => entries,
                Err(error) if error.kind() == ErrorKind::NotFound => return Ok(0),
                Err(error) => return Err(error),
            };
            let mut freed = 0_u64;
            for entry in entries.filter_map(Result::ok) {
                let Ok(file_name) = entry.file_name().into_string() else {
                    continue;
                };
                if !is_valid_skin_asset_file_name(&file_name) || keep.contains(&file_name) {
                    continue;
                }
                let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
                if std::fs::remove_file(entry.path()).is_ok() {
                    freed = freed.saturating_add(size);
                }
            }
            Ok(freed)
        })
        .await
        .map_err(|e| unavailable("清理皮肤帧图任务中断", &e))?
        .map_err(|e| unavailable("清理皮肤帧图失败", &e))
    }

    async fn usage(&self) -> Result<SkinStorageUsage, StorageError> {
        let dir = self.dir.clone();
        let quota_bytes = self.quota_bytes;
        let (file_count, total_bytes) = tokio::task::spawn_blocking(move || scan_usage(&dir))
            .await
            .map_err(|e| unavailable("统计皮肤占用任务中断", &e))?
            .map_err(|e| unavailable("统计皮肤占用失败", &e))?;
        Ok(SkinStorageUsage {
            file_count,
            total_bytes,
            quota_bytes,
        })
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    /// 构造一个带有效 PNG 魔数的测试字节流。
    fn fake_png(payload: &[u8]) -> Vec<u8> {
        let mut bytes = PNG_MAGIC.to_vec();
        bytes.extend_from_slice(payload);
        bytes
    }

    /// 构造一个带有效 WebP 魔数的测试字节流。
    fn fake_webp(payload: &[u8]) -> Vec<u8> {
        let mut bytes = b"RIFF\x00\x00\x00\x00WEBP".to_vec();
        bytes.extend_from_slice(payload);
        bytes
    }

    #[test]
    fn validates_content_addressed_file_names() {
        let good = format!("{}.webp", "a".repeat(64));
        assert!(is_valid_skin_asset_file_name(&good));
        assert!(is_valid_skin_asset_file_name(&format!(
            "{}.png",
            "0123456789abcdef".repeat(4)
        )));
        assert!(!is_valid_skin_asset_file_name("../secret.png"));
        assert!(!is_valid_skin_asset_file_name(&format!(
            "{}.jpg",
            "a".repeat(64)
        )));
        assert!(!is_valid_skin_asset_file_name(&format!(
            "{}.webp",
            "A".repeat(64)
        )));
        assert!(!is_valid_skin_asset_file_name("short.png"));
    }

    #[tokio::test]
    async fn stores_deduplicates_reads_and_prunes_assets() {
        let dir = tempfile::tempdir().unwrap();
        let store = FsSkinAssetStore::new(dir.path().join("skins/assets"));

        let first = store
            .store_bytes(fake_webp(b"frame-1"), SkinAssetFormat::Webp)
            .await
            .unwrap();
        let dup = store
            .store_bytes(fake_webp(b"frame-1"), SkinAssetFormat::Webp)
            .await
            .unwrap();
        assert_eq!(first, dup);

        let second = store
            .store_bytes(fake_png(b"frame-2"), SkinAssetFormat::Png)
            .await
            .unwrap();
        let usage = store.usage().await.unwrap();
        assert_eq!(usage.file_count, 2);
        assert_eq!(usage.total_bytes, first.size_bytes + second.size_bytes);

        let file_one = format!("{}.webp", first.id);
        assert_eq!(
            store.read_bytes(&file_one).await.unwrap(),
            fake_webp(b"frame-1")
        );

        let freed = store.prune_unused(&[file_one]).await.unwrap();
        assert_eq!(freed, second.size_bytes);
        assert_eq!(store.usage().await.unwrap().file_count, 1);
    }

    #[tokio::test]
    async fn rejects_bad_magic_oversized_and_quota_exceeded() {
        let dir = tempfile::tempdir().unwrap();
        let store = FsSkinAssetStore::with_quota(dir.path().join("assets"), 32);

        assert!(
            store
                .store_bytes(b"not-a-png".to_vec(), SkinAssetFormat::Png)
                .await
                .is_err()
        );
        assert!(
            store
                .store_bytes(
                    fake_png(&vec![0_u8; MAX_SKIN_ASSET_BYTES]),
                    SkinAssetFormat::Png
                )
                .await
                .is_err()
        );
        assert!(
            store
                .store_bytes(fake_png(&[1_u8; 40]), SkinAssetFormat::Png)
                .await
                .is_err()
        );
        assert!(store.read_bytes("../evil.png").await.is_err());
    }
}
