//! 文件系统版 [`FileInspector`]：在阻塞线程池里按需读被拖入文件的某几段。

use std::fs::{File, Metadata};
use std::io::{Read, Seek, SeekFrom};

use async_trait::async_trait;
use starat_application::ports::inspect::{FileInspector, InspectError, MAX_READ_BYTES};

/// 读本地文件的实现。
#[derive(Debug, Clone, Copy, Default)]
pub struct FsFileInspector;

/// 文件是不是只在云端的占位文件（OneDrive、iCloud for Windows 等）：读内容会触发下载。
///
/// 只看元数据（读元数据不会触发下载）。非 Windows 平台没有这种标记，一律视为在本机。
#[must_use]
pub fn is_cloud_only(metadata: &Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        /// `FILE_ATTRIBUTE_OFFLINE`。
        const OFFLINE: u32 = 0x1000;
        /// `FILE_ATTRIBUTE_RECALL_ON_OPEN`。
        const RECALL_ON_OPEN: u32 = 0x0004_0000;
        /// `FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS`。
        const RECALL_ON_DATA_ACCESS: u32 = 0x0040_0000;
        metadata.file_attributes() & (OFFLINE | RECALL_ON_OPEN | RECALL_ON_DATA_ACCESS) != 0
    }
    #[cfg(not(windows))]
    {
        let _ = metadata;
        false
    }
}

/// IO 错误 → 检查错误。
fn io_error(error: &std::io::Error) -> InspectError {
    match error.kind() {
        std::io::ErrorKind::NotFound => InspectError::Missing,
        kind => InspectError::Io(kind.to_string()),
    }
}

/// 读元数据并排除文件夹与云端占位文件。
fn checked_metadata(path: &str) -> Result<Metadata, InspectError> {
    let metadata = std::fs::metadata(path).map_err(|e| io_error(&e))?;
    if metadata.is_dir() {
        return Err(InspectError::Directory);
    }
    if is_cloud_only(&metadata) {
        return Err(InspectError::CloudOnly);
    }
    Ok(metadata)
}

/// 同步读取一段（在 `spawn_blocking` 里调用）。
fn read_range(path: &str, offset: u64, len: u64) -> Result<Vec<u8>, InspectError> {
    let size = checked_metadata(path)?.len();
    let len = len.min(MAX_READ_BYTES).min(size.saturating_sub(offset));
    let mut file = File::open(path).map_err(|e| io_error(&e))?;
    file.seek(SeekFrom::Start(offset))
        .map_err(|e| io_error(&e))?;
    let mut content = Vec::with_capacity(usize::try_from(len).unwrap_or(0));
    file.take(len)
        .read_to_end(&mut content)
        .map_err(|e| io_error(&e))?;
    Ok(content)
}

/// 在阻塞线程池里跑一个同步读取。
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, InspectError> + Send + 'static,
) -> Result<T, InspectError> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|e| InspectError::Io(e.to_string()))?
}

#[async_trait]
impl FileInspector for FsFileInspector {
    async fn stat(&self, path: &str) -> Result<u64, InspectError> {
        let path = path.to_owned();
        blocking(move || checked_metadata(&path).map(|m| m.len())).await
    }

    async fn read_at(&self, path: &str, offset: u64, len: u64) -> Result<Vec<u8>, InspectError> {
        let path = path.to_owned();
        blocking(move || read_range(&path, offset, len)).await
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use std::time::{Duration, Instant};

    use super::*;

    #[tokio::test]
    async fn ranges_are_read_and_clamped_to_the_end_of_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.md");
        std::fs::write(&path, "# 标题\n正文").unwrap();
        let path = path.to_str().unwrap();
        let size = FsFileInspector.stat(path).await.unwrap();
        assert_eq!(size, "# 标题\n正文".len() as u64);
        assert_eq!(
            FsFileInspector.read_at(path, 0, 1024).await.unwrap(),
            "# 标题\n正文".as_bytes()
        );
        assert_eq!(
            FsFileInspector.read_at(path, 2, 6).await.unwrap(),
            "标题".as_bytes()
        );
        assert!(
            FsFileInspector
                .read_at(path, 999, 10)
                .await
                .unwrap()
                .is_empty()
        );
    }

    #[tokio::test]
    async fn huge_files_only_have_the_requested_range_read() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("huge.bin");
        // 500 MB 的稀疏文件：只读末尾一小段，不应花时间。
        let file = File::create(&path).unwrap();
        file.set_len(500 * 1024 * 1024).unwrap();
        let path = path.to_str().unwrap();
        let started = Instant::now();
        let size = FsFileInspector.stat(path).await.unwrap();
        assert_eq!(size, 500 * 1024 * 1024);
        let tail = FsFileInspector
            .read_at(path, size - 4096, u64::MAX)
            .await
            .unwrap();
        assert_eq!(tail.len(), 4096);
        assert!(started.elapsed() < Duration::from_millis(500));
    }

    #[tokio::test]
    async fn missing_and_directories_are_reported() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            FsFileInspector
                .stat(dir.path().join("nope").to_str().unwrap())
                .await,
            Err(InspectError::Missing)
        );
        assert_eq!(
            FsFileInspector.stat(dir.path().to_str().unwrap()).await,
            Err(InspectError::Directory)
        );
        assert_eq!(
            FsFileInspector
                .read_at(dir.path().to_str().unwrap(), 0, 10)
                .await,
            Err(InspectError::Directory)
        );
    }
}
