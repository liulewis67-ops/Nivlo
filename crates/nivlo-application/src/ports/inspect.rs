//! 读取被拖入文件的少量内容用于提取标题（实施计划 6.6）。
//!
//! 只读、有大小上限：超过 [`MAX_INSPECT_BYTES`] 的文件**不读内容**，Workflow 只保存引用——
//! 拖入几百 MB 的文件不会卡住界面或吃掉内存。Port 只接受 Workflow 输入里的那个文件路径，
//! 不提供「读任意路径」的能力（实现者不得把它扩展成通用的文件读取）。

use async_trait::async_trait;

/// 最多完整读取多大的文件（32 MiB）；超过的只保存引用。
pub const MAX_INSPECT_BYTES: u64 = 32 * 1024 * 1024;

/// 读取失败。
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum InspectError {
    /// 文件不存在或已被移动。
    #[error("文件不存在")]
    Missing,
    /// 是文件夹，没有可读的内容。
    #[error("这是一个文件夹")]
    Directory,
    /// 读取失败（权限、占用……）。
    #[error("无法读取文件：{0}")]
    Io(String),
}

/// 一个文件的内容样本。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileSample {
    /// 文件大小（字节）。
    pub size: u64,
    /// 完整内容；超过 [`MAX_INSPECT_BYTES`] 时为 `None`（只保存引用）。
    pub content: Option<Vec<u8>>,
}

/// 文件检查 Port。
#[async_trait]
pub trait FileInspector: Send + Sync {
    /// 读取一个文件的内容样本。实现必须在阻塞线程池里做 IO，并遵守大小上限。
    ///
    /// # Errors
    ///
    /// 见 [`InspectError`]。
    async fn sample(&self, path: &str) -> Result<FileSample, InspectError>;
}
