//! 剪贴板的平台选择。
//!
//! **只在用户明确粘贴时读取**（架构文档 §17）：全仓库里调用 [`ClipboardPort::read`] 的只有
//! `capture_from_clipboard` 这一个 Command，它由「粘贴」按钮或粘贴快捷键触发；没有任何监听或轮询。

use std::sync::Arc;

use nivlo_platform::clipboard::ClipboardPort;

/// 当前平台的剪贴板读取：Windows 用 Win32，其他平台暂不支持（返回 `Unsupported`）。
#[must_use]
pub fn platform_clipboard() -> Arc<dyn ClipboardPort> {
    #[cfg(target_os = "windows")]
    {
        Arc::new(nivlo_platform_windows::clipboard::WindowsClipboard)
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
    ) -> Result<nivlo_platform::clipboard::ClipboardContent, nivlo_platform::error::PlatformError>
    {
        Err(nivlo_platform::error::PlatformError::Unsupported(
            "剪贴板读取".to_owned(),
        ))
    }
}
