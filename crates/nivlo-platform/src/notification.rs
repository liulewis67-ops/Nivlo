//! 系统通知（`NotificationPort`，实施计划 4.6）。
//!
//! Scheduler 只关心「该通知用户了」，通知长什么样、发到哪里由平台适配器决定
//! （Windows 通知中心、macOS 通知中心……）。适配器必须带上应用名与图标。

use crate::error::PlatformError;

/// 一条要展示给用户的系统通知。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Notification {
    /// 标题（一行）。
    pub title: String,
    /// 正文。
    pub body: String,
    /// 关联的 Item（点击通知时打开它）；汇总通知没有。
    pub item_id: Option<String>,
}

/// 发送系统通知。
pub trait NotificationPort: Send + Sync {
    /// 发送一条通知。
    ///
    /// # Errors
    ///
    /// 平台拒绝（用户在系统里关闭了通知、当前平台不支持）时返回 [`PlatformError`]。
    fn notify(&self, notification: &Notification) -> Result<(), PlatformError>;
}

/// 通知激活用的自定义协议前缀：`nivlo://item/<Item ID>`（实施计划 10.6）。
pub const ACTIVATION_PREFIX: &str = "nivlo://item/";

/// 某个 Item 的激活地址；`item_id` 不是合法的 ID 文本（UUID）时返回 `None`。
#[must_use]
pub fn activation_uri(item_id: &str) -> Option<String> {
    is_item_id(item_id).then(|| format!("{ACTIVATION_PREFIX}{item_id}"))
}

/// 从命令行参数（或协议地址）里取出要打开的 Item ID；格式不对返回 `None`。
///
/// 只接受 `nivlo://item/<UUID>`（末尾允许一个 `/`）：参数来自任何能启动程序的来源，
/// 不能当作可信输入，所以严格校验，不做任何拼接或路径解析。
#[must_use]
pub fn parse_activation(arg: &str) -> Option<String> {
    let id = arg
        .trim()
        .strip_prefix(ACTIVATION_PREFIX)?
        .trim_end_matches('/');
    is_item_id(id).then(|| id.to_ascii_lowercase())
}

/// 是不是 UUID 文本（8-4-4-4-12 的十六进制）。
fn is_item_id(text: &str) -> bool {
    text.len() == 36
        && text.char_indices().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => c == '-',
            _ => c.is_ascii_hexdigit(),
        })
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::{activation_uri, parse_activation};

    const ID: &str = "01a12fef-947e-739f-b270-6185019bad96";

    #[test]
    fn activation_uris_round_trip() {
        let uri = activation_uri(ID).unwrap();
        assert_eq!(uri, format!("nivlo://item/{ID}"));
        assert_eq!(parse_activation(&uri).as_deref(), Some(ID));
        assert_eq!(parse_activation(&format!("{uri}/")).as_deref(), Some(ID));
        assert_eq!(
            parse_activation(&format!("nivlo://item/{}", ID.to_uppercase())).as_deref(),
            Some(ID)
        );
    }

    #[test]
    fn anything_else_is_rejected() {
        assert_eq!(activation_uri("not-an-id"), None);
        for bad in [
            "",
            "nivlo://item/",
            "nivlo://item/../../etc",
            "nivlo://other/01a12fef-947e-739f-b270-6185019bad96",
            "http://item/01a12fef-947e-739f-b270-6185019bad96",
            "nivlo://item/01a12fef-947e-739f-b270-6185019bad96?x=1",
            "nivlo://item/01a12fef-947e-739f-b270-6185019bad9z",
            "--autostarted",
        ] {
            assert_eq!(parse_activation(bad), None, "{bad:?}");
        }
    }
}
