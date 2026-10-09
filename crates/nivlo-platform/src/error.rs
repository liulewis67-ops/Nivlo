//! 平台层错误。

/// 平台能力调用失败。
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum PlatformError {
    /// 当前平台不支持该能力；调用方应当降级而不是视为致命错误。
    #[error("当前平台不支持：{0}")]
    Unsupported(String),
    /// 平台调用失败（窗口已销毁、系统 API 返回错误等）。
    #[error("平台调用失败：{0}")]
    Failed(String),
}
