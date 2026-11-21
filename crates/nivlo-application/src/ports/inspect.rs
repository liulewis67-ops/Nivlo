//! 读取被拖入文件的少量内容用于提取标题（实施计划 6.6）。
//!
//! 只读、按需：调用方先 [`FileInspector::stat`] 拿到大小，再用 [`FileInspector::read_at`] 读它需要的那几段
//! （Markdown 读开头，PDF 读头尾，Office / EPUB 先读末尾的 zip 目录再读那一个条目）——
//! 拖入几百 MB 的文件只读几百 KB，不会卡住界面或吃掉内存。单次读取不超过 [`MAX_READ_BYTES`]。
//!
//! Port 只接受 Workflow 输入里的那个文件路径，不提供「读任意路径」的能力
//! （实现者不得把它扩展成通用的文件读取）。

use async_trait::async_trait;

/// 单次 [`FileInspector::read_at`] 最多读多少字节（32 MiB）。
pub const MAX_READ_BYTES: u64 = 32 * 1024 * 1024;

/// 读取失败。
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum InspectError {
    /// 文件不存在或已被移动。
    #[error("文件不存在")]
    Missing,
    /// 是文件夹，没有可读的内容。
    #[error("这是一个文件夹")]
    Directory,
    /// 文件只在云端（OneDrive 等的占位文件）：读内容会触发下载，所以不读。
    #[error("文件只在云端，没有下载到本机")]
    CloudOnly,
    /// 读取失败（权限、占用……）。
    #[error("无法读取文件：{0}")]
    Io(String),
}

/// 文件检查 Port。实现必须在阻塞线程池里做 IO。
#[async_trait]
pub trait FileInspector: Send + Sync {
    /// 文件大小（字节）；不读内容，也不会让云端占位文件开始下载。
    ///
    /// # Errors
    ///
    /// 见 [`InspectError`]。
    async fn stat(&self, path: &str) -> Result<u64, InspectError>;

    /// 从 `offset` 开始读最多 `len` 字节（被截到 [`MAX_READ_BYTES`]）；读到文件末尾就返回较短的结果。
    ///
    /// # Errors
    ///
    /// 见 [`InspectError`]。
    async fn read_at(&self, path: &str, offset: u64, len: u64) -> Result<Vec<u8>, InspectError>;
}
