//! `nivlo-platform`：跨平台 Port 定义。
//!
//! 每种平台能力是一个**独立的小 trait**，不做拥有几十个方法的 God Trait（架构文档 §7.9、ADR-006）：
//!
//! * [`clipboard::ClipboardPort`]：读取剪贴板（只在用户粘贴时调用，没有监听接口）。
//! * [`floating_window::FloatingWindowPort`]：悬浮窗的位置 / 尺寸 / 置顶 / 焦点。
//! * [`foreground::ForegroundPort`]：记住并还原用户的前台窗口（Quick Create 结束后还回焦点）。
//! * [`shortcut::ShortcutPort`]：注册全局快捷键；[`shortcut::Accelerator`] 是平台无关的快捷键描述与解析。
//! * [`placement`]：悬浮窗位置的纯计算（吸附、跨显示器、DPI），与具体窗口库无关，便于测试。
//! * [`error::PlatformError`]：平台能力不足时返回明确的 `Unsupported`，而不是 panic（架构文档 §53）。
//!
//! 后续阶段会继续加入 `DropPort`、`CredentialPort`、`NotificationPort`、
//! `AutostartPort`、`OpenPort`。
//!
//! 禁止依赖：任何具体平台库（参见后端规范 §3.1）。

pub mod clipboard;
pub mod error;
pub mod floating_window;
pub mod foreground;
pub mod placement;
pub mod shortcut;
