//! 剪贴板的平台选择。
//!
//! 用户明确粘贴或导入时才调用 [`ClipboardPort::read`]，没有监听或轮询。

use std::sync::Arc;

use asterjot_platform::clipboard::ClipboardPort;

/// 当前平台的剪贴板读取：Windows 用 Win32，其他平台暂不支持（返回 `Unsupported`）。
#[must_use]
pub fn platform_clipboard() -> Arc<dyn ClipboardPort> {
    #[cfg(target_os = "windows")]
    {
        Arc::new(asterjot_platform_windows::clipboard::WindowsClipboard)
    }
    #[cfg(not(target_os = "windows"))]
    {
        Arc::new(UnsupportedClipboard)
    }
}

/// 不支持剪贴板读取的平台。
#[cfg(not(target_os = "windows"))]
struct UnsupportedClipboard;

#[cfg(not(target_os = "windows"))]
impl ClipboardPort for UnsupportedClipboard {
    /// 总是返回 `Unsupported`。
    fn read(
        &self,
    ) -> Result<
        asterjot_platform::clipboard::ClipboardContent,
        asterjot_platform::error::PlatformError,
    > {
        Err(asterjot_platform::error::PlatformError::Unsupported(
            "剪贴板读取".to_owned(),
        ))
    }
}
