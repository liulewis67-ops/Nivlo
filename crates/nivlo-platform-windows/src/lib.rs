//! `nivlo-platform-windows`：Windows 平台 Adapter（`cfg(target_os = "windows")` 隔离，其他平台编译为空）。
//!
//! 提供 [`clipboard::WindowsClipboard`]（读取剪贴板）、[`shortcut::WindowsShortcut`]（全局快捷键，`RegisterHotKey`）与 [`foreground::WindowsForeground`]：记住并还原用户的前台窗口，供悬浮窗的
//! Quick Create 在结束后把焦点还给之前的应用。后续的原生 Drop、No-Activate、电源事件等
//! 在 Phase 10 加入。
//!
//! 本 crate 含 `unsafe`（Win32 调用），每个 `unsafe` 块都有 `SAFETY` 注释（后端规范 §9.4）。
//!
//! 禁止依赖：其他 Adapter 的内部实现（参见后端规范 §3.1）。
#![cfg(target_os = "windows")]

pub mod clipboard;
pub mod credential;
pub mod foreground;
pub mod shortcut;
pub mod source_app;
