//! 附件文件的存取 Port。
//!
//! 文件默认只保存**引用**，不复制（架构文档 §34）；只有没有原始路径的内容——例如粘贴的截图——
//! 才由 Nivlo 保存到应用的 `attachments/` 目录，并负责清理。这个 Port 只管后者。

use async_trait::async_trait;
use nivlo_domain::capture::ImageData;
use nivlo_domain::id::AttachmentId;

use super::StorageError;

/// 一个已经保存到 `attachments/` 的文件。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredFile {
    /// 相对 `attachments/` 的路径（只有文件名，没有目录部分）。
    pub relative_path: String,
    /// 文件大小（字节）。
    pub size_bytes: u64,
}

/// 由 Nivlo 拥有的附件文件。
#[async_trait]
pub trait AttachmentFiles: Send + Sync {
    /// 把图片保存为 `attachments/` 下以附件 ID 命名的文件。
    ///
    /// # Errors
    ///
    /// 磁盘不可写 / 已满时返回 [`StorageError::Unavailable`]，此时不会留下半个文件。
    async fn store_image(
        &self,
        id: AttachmentId,
        image: &ImageData,
    ) -> Result<StoredFile, StorageError>;

    /// 删除一个由 Nivlo 保存的文件。文件已经不存在不算错误；其他失败只记录日志，
    /// 因为清理是尽力而为的（数据库记录已经处理完毕）。
    async fn remove(&self, relative_path: &str);
}
