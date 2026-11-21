//! 剪贴板读取（`ClipboardPort`，实施计划 2.5、架构文档 §17）。
//!
//! 用户明确粘贴或导入时才读取。这个 Port 没有订阅、监听或轮询。

use crate::error::PlatformError;

/// 剪贴板里此刻的内容。可以同时有多种格式（例如从浏览器复制图片时既有图片也有网址）。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ClipboardContent {
    /// 资源管理器里复制的文件 / 文件夹的完整路径。
    pub files: Vec<String>,
    /// 图片字节（PNG 优先，否则是 BMP），识别格式由调用方按魔数完成。
    pub image: Option<Vec<u8>>,
    /// 纯文本。
    pub text: Option<String>,
}

impl ClipboardContent {
    /// 是否什么都没有。
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.files.is_empty()
            && self.image.is_none()
            && self.text.as_deref().is_none_or(str::is_empty)
    }
}

/// 读取剪贴板。
pub trait ClipboardPort: Send + Sync {
    /// 读取剪贴板当前的内容；剪贴板是空的或只有不认识的格式时返回空的 [`ClipboardContent`]。
    ///
    /// # Errors
    ///
    /// * [`PlatformError::Unsupported`] - 当前平台不支持。
    /// * [`PlatformError::Failed`] - 剪贴板被其他程序占用且重试后仍然打不开等系统错误。
    fn read(&self) -> Result<ClipboardContent, PlatformError>;

    /// 读取用于预填草稿的纯文本。
    ///
    /// # Errors
    ///
    /// 与 [`Self::read`] 相同。
    fn read_text(&self) -> Result<Option<String>, PlatformError> {
        self.read().map(|content| content.text)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_means_no_files_image_or_text() {
        assert!(ClipboardContent::default().is_empty());
        let blank = ClipboardContent {
            text: Some(String::new()),
            ..ClipboardContent::default()
        };
        assert!(blank.is_empty());
        let with_text = ClipboardContent {
            text: Some("x".to_owned()),
            ..ClipboardContent::default()
        };
        assert!(!with_text.is_empty());
        let with_file = ClipboardContent {
            files: vec!["C:\\a.txt".to_owned()],
            ..ClipboardContent::default()
        };
        assert!(!with_file.is_empty());
    }
}
