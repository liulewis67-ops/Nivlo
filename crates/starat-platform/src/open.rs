//! 打开外部资源（`OpenPort`，实施计划 3.1、ADR-010）。
//!
//! 只提供两个**受限**的动作：用默认浏览器打开网址、在资源管理器里定位文件。
//! 不提供「打开任意路径 / 执行任意命令」——Shell 能力在 MVP 不开放。
//! 网址只允许 `http` / `https`，其他协议（`file:`、`javascript:`、自定义协议）一律拒绝，
//! 避免被保存下来的内容变成启动其他程序的入口。

use crate::error::PlatformError;

/// 打开外部资源。
pub trait OpenPort: Send + Sync {
    /// 用默认浏览器打开网址。
    ///
    /// # Errors
    ///
    /// 不是 `http` / `https` 网址返回 [`PlatformError::Failed`]；系统打开失败同样返回它。
    fn open_url(&self, url: &str) -> Result<(), PlatformError>;

    /// 在资源管理器里定位文件（选中它）。
    ///
    /// # Errors
    ///
    /// 路径为空或系统打开失败时返回 [`PlatformError::Failed`]。
    fn reveal_file(&self, path: &str) -> Result<(), PlatformError>;
}

/// 校验网址只能是 `http` / `https`（大小写不敏感），并且主机部分非空。
///
/// # Errors
///
/// 协议不被允许或网址残缺时返回 [`PlatformError::Failed`]。
pub fn check_openable_url(url: &str) -> Result<(), PlatformError> {
    let trimmed = url.trim();
    let lower = trimmed.to_ascii_lowercase();
    let rest = lower
        .strip_prefix("https://")
        .or_else(|| lower.strip_prefix("http://"))
        .ok_or_else(|| PlatformError::Failed(format!("只允许打开 http / https 网址：{trimmed}")))?;
    if rest.is_empty() || rest.starts_with('/') || rest.chars().any(char::is_whitespace) {
        return Err(PlatformError::Failed(format!("网址不完整：{trimmed}")));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_http_and_https_are_openable() {
        for ok in [
            "https://example.com",
            "HTTP://Example.com/a?x=1#y",
            "  https://example.com/path  ",
        ] {
            assert!(check_openable_url(ok).is_ok(), "{ok}");
        }
        for bad in [
            "file:///C:/Windows/System32/calc.exe",
            "javascript:alert(1)",
            "ms-settings:privacy",
            "ftp://example.com",
            "C:\\Windows\\notepad.exe",
            "example.com",
            "",
        ] {
            assert!(check_openable_url(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn incomplete_urls_are_rejected() {
        for bad in ["https://", "https:///path", "http://exa mple.com"] {
            assert!(check_openable_url(bad).is_err(), "{bad}");
        }
    }
}
