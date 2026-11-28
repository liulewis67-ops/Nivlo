//! Windows Toast 通知（`NotificationPort`，实施计划 10.6）。
//!
//! 通知的 XML 带 `activationType="protocol"` 与 `launch="asterjot://item/<ID>"`：用户点击通知时，
//! Windows 按注册的 `asterjot://` 协议启动 `asterjot-desktop.exe "<地址>"`——应用已在运行时由单实例机制
//! 把参数转给运行中的实例，未运行时就是冷启动并带着参数。不需要 COM 激活器。
//!
//! 通知用安装包为开始菜单快捷方式登记的 AppUserModelID 发送，所以显示正确的应用名与图标；
//! 没有安装（开发模式）时 Windows 可能不显示，调用方应当降级到别的通知通道。

// 本模块含 Win32 / WinRT 调用（后端规范 §9.4）：每个 `unsafe` 块都有 SAFETY 注释。
#![allow(unsafe_code)]

use asterjot_platform::error::PlatformError;
use asterjot_platform::notification::{Notification, NotificationPort, activation_uri};
use windows::Data::Xml::Dom::XmlDocument;
use windows::UI::Notifications::{ToastNotification, ToastNotificationManager};
use windows::Win32::System::Com::{COINIT_MULTITHREADED, CoInitializeEx};
use windows::core::HSTRING;

/// XML 文本转义（属性与文本节点都适用）。
fn escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            // XML 1.0 不允许大多数控制字符。
            c if (c as u32) < 0x20 && !matches!(c, '\n' | '\t') => {}
            c => out.push(c),
        }
    }
    out
}

/// 生成 Toast 的 XML。有 `launch` 时点击通知会按协议激活。
#[must_use]
pub fn toast_xml(title: &str, body: &str, launch: Option<&str>) -> String {
    let activation = launch.map_or_else(String::new, |uri| {
        format!(" activationType=\"protocol\" launch=\"{}\"", escape(uri))
    });
    format!(
        "<toast{activation}><visual><binding template=\"ToastGeneric\"><text>{}</text><text>{}</text></binding></visual></toast>",
        escape(title),
        escape(body)
    )
}

/// 基于 WinRT 的通知发送器。
#[derive(Debug, Clone)]
pub struct WindowsToast {
    /// 应用的 AppUserModelID（要与开始菜单快捷方式上的一致）。
    aumid: String,
}

impl WindowsToast {
    /// 创建发送器。
    #[must_use]
    pub fn new(aumid: impl Into<String>) -> Self {
        Self {
            aumid: aumid.into(),
        }
    }
}

/// WinRT 失败的统一包装。
fn failed(error: &windows::core::Error) -> PlatformError {
    PlatformError::Failed(format!("Toast 通知失败：{error}"))
}

impl NotificationPort for WindowsToast {
    /// 发送一条 Toast；带 Item 时点击会打开它。
    fn notify(&self, notification: &Notification) -> Result<(), PlatformError> {
        // SAFETY: 初始化当前线程的 COM；线程已经初始化过（返回 S_FALSE / 模式不同）时忽略结果即可。
        let _ = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        let launch = notification.item_id.as_deref().and_then(activation_uri);
        let xml = toast_xml(&notification.title, &notification.body, launch.as_deref());
        let document = XmlDocument::new().map_err(|e| failed(&e))?;
        document
            .LoadXml(&HSTRING::from(xml))
            .map_err(|e| failed(&e))?;
        let toast =
            ToastNotification::CreateToastNotification(&document).map_err(|e| failed(&e))?;
        ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(self.aumid.as_str()))
            .and_then(|notifier| notifier.Show(&toast))
            .map_err(|e| failed(&e))
    }
}

#[cfg(test)]
mod tests {
    use super::{escape, toast_xml};

    #[test]
    fn text_and_attributes_are_escaped() {
        assert_eq!(escape("a<b>&\"c'"), "a&lt;b&gt;&amp;&quot;c&apos;");
        let xml = toast_xml("<提醒>", "买 & 煮", Some("asterjot://item/x\"y"));
        assert!(xml.contains("&lt;提醒&gt;"));
        assert!(xml.contains("买 &amp; 煮"));
        assert!(xml.contains("launch=\"asterjot://item/x&quot;y\""));
        assert!(xml.contains("activationType=\"protocol\""));
    }

    #[test]
    fn without_a_launch_target_the_toast_has_no_activation() {
        let xml = toast_xml("t", "b", None);
        assert!(!xml.contains("launch"));
        assert!(xml.starts_with("<toast>"));
    }
}
