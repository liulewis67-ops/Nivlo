//! 文件系统版 [`FileInspector`]：在阻塞线程池里读被拖入的文件。

use std::fs::File;
use std::io::Read;

use async_trait::async_trait;
use nivlo_application::ports::inspect::{
    FileInspector, FileSample, InspectError, MAX_INSPECT_BYTES,
};

/// 读本地文件的实现。
#[derive(Debug, Clone, Copy, Default)]
pub struct FsFileInspector;

/// 同步读取（在 `spawn_blocking` 里调用）。
fn read_sample(path: &str) -> Result<FileSample, InspectError> {
    let metadata = std::fs::metadata(path).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => InspectError::Missing,
        _ => InspectError::Io(e.kind().to_string()),
    })?;
    if metadata.is_dir() {
        return Err(InspectError::Directory);
    }
    let size = metadata.len();
    if size > MAX_INSPECT_BYTES {
        // 太大：不读内容，只保存引用。
        return Ok(FileSample {
            size,
            content: None,
        });
    }
    let mut content = Vec::with_capacity(usize::try_from(size).unwrap_or(0));
    File::open(path)
        .and_then(|file| file.take(MAX_INSPECT_BYTES).read_to_end(&mut content))
        .map_err(|e| InspectError::Io(e.kind().to_string()))?;
    Ok(FileSample {
        size,
        content: Some(content),
    })
}

#[async_trait]
impl FileInspector for FsFileInspector {
    async fn sample(&self, path: &str) -> Result<FileSample, InspectError> {
        let path = path.to_owned();
        tokio::task::spawn_blocking(move || read_sample(&path))
            .await
            .map_err(|e| InspectError::Io(e.to_string()))?
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use std::time::{Duration, Instant};

    use super::*;

    #[tokio::test]
    async fn small_files_are_read_whole() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.md");
        std::fs::write(&path, "# 标题\n正文").unwrap();
        let sample = FsFileInspector
            .sample(path.to_str().unwrap())
            .await
            .unwrap();
        assert_eq!(sample.content.as_deref(), Some("# 标题\n正文".as_bytes()));
    }

    #[tokio::test]
    async fn huge_files_are_not_read_only_referenced() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("huge.bin");
        // 500 MB 的稀疏文件：不应读取，也不应花时间。
        let file = File::create(&path).unwrap();
        file.set_len(500 * 1024 * 1024).unwrap();
        let started = Instant::now();
        let sample = FsFileInspector
            .sample(path.to_str().unwrap())
            .await
            .unwrap();
        assert_eq!(sample.size, 500 * 1024 * 1024);
        assert!(sample.content.is_none());
        assert!(started.elapsed() < Duration::from_millis(500));
    }

    #[tokio::test]
    async fn missing_and_directories_are_reported() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            FsFileInspector
                .sample(dir.path().join("nope").to_str().unwrap())
                .await,
            Err(InspectError::Missing)
        );
        assert_eq!(
            FsFileInspector.sample(dir.path().to_str().unwrap()).await,
            Err(InspectError::Directory)
        );
    }
}
