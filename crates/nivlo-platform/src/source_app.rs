//! 来源应用识别（`SourceApplicationPort`，实施计划 10.4）。
//!
//! 用户把内容从浏览器、资源管理器、编辑器拖进悬浮窗（或粘贴）时，知道它来自哪个应用，
//! Workflow 就可以用 `source.application` 匹配（例如「来自 Chrome 的链接」）。
//!
//! 只在捕获发生的那一刻读取一次「用户之前所在的应用」，没有任何监听历史或轮询；
//! 结果只是一个应用的显示名（如 `Chrome`），不含窗口标题、文档名或路径。

/// 识别用户之前所在的应用。
pub trait SourceApplicationPort: Send + Sync {
    /// 用户之前所在应用的显示名；识别不到（没有前台窗口、权限不足、平台不支持）时为 `None`。
    fn source_application(&self) -> Option<String>;
}

/// 把可执行文件名（不含扩展名）整理成显示名：常见应用用约定的名字，其余保持原样。
///
/// 比较不区分大小写，所以 `chrome`、`Chrome`、`CHROME` 都得到 `Chrome`。
#[must_use]
pub fn friendly_app_name(executable_stem: &str) -> String {
    match executable_stem.to_ascii_lowercase().as_str() {
        "chrome" => "Chrome".to_owned(),
        "msedge" => "Edge".to_owned(),
        "firefox" => "Firefox".to_owned(),
        "brave" => "Brave".to_owned(),
        "opera" => "Opera".to_owned(),
        "explorer" => "Explorer".to_owned(),
        "code" | "code - insiders" => "VS Code".to_owned(),
        "outlook" | "olk" => "Outlook".to_owned(),
        "winword" => "Word".to_owned(),
        "excel" => "Excel".to_owned(),
        "powerpnt" => "PowerPoint".to_owned(),
        "slack" => "Slack".to_owned(),
        "wechat" | "weixin" => "WeChat".to_owned(),
        _ => executable_stem.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::friendly_app_name;

    #[test]
    fn well_known_applications_get_their_conventional_names() {
        for (stem, name) in [
            ("chrome", "Chrome"),
            ("CHROME", "Chrome"),
            ("msedge", "Edge"),
            ("Explorer", "Explorer"),
            ("Code", "VS Code"),
            ("OUTLOOK", "Outlook"),
        ] {
            assert_eq!(friendly_app_name(stem), name, "{stem}");
        }
    }

    #[test]
    fn unknown_applications_keep_their_executable_name() {
        assert_eq!(friendly_app_name("Obsidian"), "Obsidian");
        assert_eq!(friendly_app_name("my-tool"), "my-tool");
        assert_eq!(friendly_app_name(""), "");
    }
}
