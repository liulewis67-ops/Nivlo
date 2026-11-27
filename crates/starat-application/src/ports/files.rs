//! 附件文件的存取 Port。
//!
//! 文件默认只保存**引用**，不复制（架构文档 §34）；只有没有原始路径的内容——例如粘贴的截图——
//! 才由 StarAt 保存到应用的 `attachments/` 目录，并负责清理。这个 Port 只管后者。

use async_trait::async_trait;
use starat_domain::capture::ImageData;
use starat_domain::id::AttachmentId;

use super::StorageError;

/// 一个已经保存到 `attachments/` 的文件。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredFile {
    /// 相对 `attachments/` 的路径（只有文件名，没有目录部分）。
    pub relative_path: String,
    /// 文件大小（字节）。
    pub size_bytes: u64,
}

/// 由 StarAt 拥有的附件文件。
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

    /// 删除一个由 StarAt 保存的文件。文件已经不存在不算错误；其他失败只记录日志，
    /// 因为清理是尽力而为的（数据库记录已经处理完毕）。
    async fn remove(&self, relative_path: &str);
}

/// 皮肤帧图的存储格式。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SkinAssetFormat {
    /// WebP 图像。
    Webp,
    /// PNG 图像。
    Png,
}

impl SkinAssetFormat {
    /// 对应的小写文件扩展名（不含前导点）。
    #[must_use]
    pub const fn extension(self) -> &'static str {
        match self {
            Self::Webp => "webp",
            Self::Png => "png",
        }
    }

    /// 对应的 HTTP `Content-Type`。
    #[must_use]
    pub const fn mime_type(self) -> &'static str {
        match self {
            Self::Webp => "image/webp",
            Self::Png => "image/png",
        }
    }

    /// 从扩展名解析格式。
    #[must_use]
    pub fn from_extension(ext: &str) -> Option<Self> {
        match ext {
            "webp" => Some(Self::Webp),
            "png" => Some(Self::Png),
            _ => None,
        }
    }
}

/// 已落盘的皮肤帧图元数据。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredSkinAsset {
    /// 内容寻址 ID（64 位小写 SHA-256 十六进制）。
    pub id: String,
    /// 文件格式。
    pub format: SkinAssetFormat,
    /// 文件大小（字节）。
    pub size_bytes: u64,
}

/// 皮肤资源目录的磁盘占用概况。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SkinStorageUsage {
    /// 资源文件数。
    pub file_count: u64,
    /// 已占用总字节数。
    pub total_bytes: u64,
    /// 允许的最大配额（字节）。
    pub quota_bytes: u64,
}

/// 悬浮窗自定义皮肤帧图的本地文件存储 Port。
#[async_trait]
pub trait SkinAssetStore: Send + Sync {
    /// 校验图片魔数、大小与总配额后，以内容寻址方式原子落盘；若内容已存在则直接去重复用。
    ///
    /// # Errors
    ///
    /// 图片格式不合法、超过单文件或总配额上限，或磁盘写入失败时返回 [`StorageError`]。
    async fn store_bytes(
        &self,
        bytes: Vec<u8>,
        format: SkinAssetFormat,
    ) -> Result<StoredSkinAsset, StorageError>;

    /// 读取已保存的帧图字节（只接受合法的纯文件名 `<sha256>.<ext>`）。
    ///
    /// # Errors
    ///
    /// 文件名非法、文件不存在或读取失败时返回 [`StorageError`]。
    async fn read_bytes(&self, file_name: &str) -> Result<Vec<u8>, StorageError>;

    /// 删除 `skins/assets/` 下不在 `keep_files` 列表中的孤儿文件，返回释放的字节数。
    ///
    /// # Errors
    ///
    /// 读取目录失败时返回 [`StorageError`]。
    async fn prune_unused(&self, keep_files: &[String]) -> Result<u64, StorageError>;

    /// 统计当前皮肤资源目录的文件数与占用字节数。
    ///
    /// # Errors
    ///
    /// 读取目录失败时返回 [`StorageError`]。
    async fn usage(&self) -> Result<SkinStorageUsage, StorageError>;
}
