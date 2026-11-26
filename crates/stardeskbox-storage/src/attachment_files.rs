//! 文件系统版 [`AttachmentFiles`]：把粘贴的图片保存到应用的 `attachments/` 目录。
//!
//! 只有**没有原始路径**的内容才会走到这里；用户自己的文件只保存引用，永远不会被复制，
//! 也永远不会被本模块删除——`remove` 只接受 `attachments/` 下的纯文件名，拒绝任何带目录
//! 部分的路径，所以即使数据库里的路径被篡改，也不可能借它删到目录之外的文件。

use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use async_trait::async_trait;
use stardeskbox_application::ports::{AttachmentFiles, StorageError, StoredFile};
use stardeskbox_domain::capture::ImageData;
use stardeskbox_domain::id::AttachmentId;

/// 保存在 `attachments/` 目录下的附件文件。
#[derive(Debug, Clone)]
pub struct FsAttachmentFiles {
    /// `attachments/` 目录。
    dir: PathBuf,
}

impl FsAttachmentFiles {
    /// 创建适配器；目录在第一次保存时才会创建。
    #[must_use]
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    /// 相对路径是否是一个纯文件名（没有分隔符、没有 `..`、不是绝对路径）。
    fn is_plain_file_name(relative_path: &str) -> bool {
        let path = Path::new(relative_path);
        !relative_path.is_empty()
            && path.components().count() == 1
            && path
                .file_name()
                .is_some_and(|name| name == path.as_os_str())
            && !relative_path.contains(['/', '\\'])
    }
}

/// 把阻塞的文件操作错误统一转换为 [`StorageError::Unavailable`]。
fn unavailable(error: &impl std::fmt::Display) -> StorageError {
    StorageError::Unavailable(format!("附件文件写入失败：{error}"))
}

#[async_trait]
impl AttachmentFiles for FsAttachmentFiles {
    /// 先写临时文件再重命名：写到一半失败（磁盘已满）时不会留下半个图片。
    async fn store_image(
        &self,
        id: AttachmentId,
        image: &ImageData,
    ) -> Result<StoredFile, StorageError> {
        let file_name = format!("{id}.{}", image.format.extension());
        let dir = self.dir.clone();
        let bytes = image.bytes.clone();
        let name = file_name.clone();
        tokio::task::spawn_blocking(move || -> std::io::Result<u64> {
            std::fs::create_dir_all(&dir)?;
            let final_path = dir.join(&name);
            let temp_path = dir.join(format!("{name}.part"));
            let write = std::fs::write(&temp_path, &bytes)
                .and_then(|()| std::fs::rename(&temp_path, &final_path));
            if write.is_err() {
                // 清理半成品；清理失败也不掩盖原始错误。
                let _ = std::fs::remove_file(&temp_path);
            }
            write.map(|()| bytes.len() as u64)
        })
        .await
        .map_err(|e| unavailable(&e))?
        .map(|size_bytes| StoredFile {
            relative_path: file_name,
            size_bytes,
        })
        .map_err(|e| unavailable(&e))
    }

    /// 删除一个文件；不存在不算错误，其他失败只记录日志。
    async fn remove(&self, relative_path: &str) {
        if !Self::is_plain_file_name(relative_path) {
            tracing::warn!(
                event = "attachment_remove_rejected",
                "拒绝删除带目录部分的附件路径"
            );
            return;
        }
        let path = self.dir.join(relative_path);
        let result = tokio::task::spawn_blocking(move || std::fs::remove_file(path)).await;
        match result {
            Ok(Ok(())) => {}
            Ok(Err(error)) if error.kind() == ErrorKind::NotFound => {}
            Ok(Err(error)) => {
                tracing::warn!(event = "attachment_remove_failed", %error, "删除附件文件失败");
            }
            Err(error) => {
                tracing::warn!(event = "attachment_remove_failed", %error, "删除附件文件失败");
            }
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use stardeskbox_domain::capture::ImageFormat;
    use uuid::Uuid;

    use super::*;

    /// 一张测试图片。
    fn image() -> ImageData {
        ImageData {
            bytes: vec![1, 2, 3, 4, 5],
            format: ImageFormat::Png,
        }
    }

    #[tokio::test]
    async fn stores_an_image_named_after_the_attachment_id_without_leaving_temp_files() {
        let dir = tempfile::tempdir().unwrap();
        let files = FsAttachmentFiles::new(dir.path().join("attachments"));
        let id = AttachmentId::from_uuid(Uuid::from_u128(7));

        let stored = files.store_image(id, &image()).await.unwrap();

        assert_eq!(stored.relative_path, format!("{id}.png"));
        assert_eq!(stored.size_bytes, 5);
        let on_disk = dir.path().join("attachments").join(&stored.relative_path);
        assert_eq!(std::fs::read(on_disk).unwrap(), vec![1, 2, 3, 4, 5]);
        let leftovers: Vec<_> = std::fs::read_dir(dir.path().join("attachments"))
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(leftovers.len(), 1);
    }

    #[tokio::test]
    async fn remove_deletes_the_file_and_tolerates_missing_ones() {
        let dir = tempfile::tempdir().unwrap();
        let files = FsAttachmentFiles::new(dir.path());
        let id = AttachmentId::from_uuid(Uuid::from_u128(8));
        let stored = files.store_image(id, &image()).await.unwrap();

        files.remove(&stored.relative_path).await;
        assert!(!dir.path().join(&stored.relative_path).exists());
        files.remove(&stored.relative_path).await;
        files.remove("从来没有过.png").await;
    }

    #[tokio::test]
    async fn remove_refuses_paths_that_escape_the_attachments_directory() {
        let root = tempfile::tempdir().unwrap();
        let attachments = root.path().join("attachments");
        std::fs::create_dir_all(&attachments).unwrap();
        let precious = root.path().join("用户的文件.txt");
        std::fs::write(&precious, "不能删").unwrap();
        let files = FsAttachmentFiles::new(&attachments);

        for evil in [
            "../用户的文件.txt",
            r"..\用户的文件.txt",
            &precious.to_string_lossy(),
            "sub/x.png",
            "",
            "..",
            ".",
        ] {
            files.remove(evil).await;
        }

        assert!(precious.exists());
    }

    #[test]
    fn plain_file_names_are_recognized() {
        assert!(FsAttachmentFiles::is_plain_file_name("a.png"));
        assert!(FsAttachmentFiles::is_plain_file_name("图片 1.png"));
        assert!(!FsAttachmentFiles::is_plain_file_name("a/b.png"));
        assert!(!FsAttachmentFiles::is_plain_file_name(".."));
        assert!(!FsAttachmentFiles::is_plain_file_name(""));
    }
}
