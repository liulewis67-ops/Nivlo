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
