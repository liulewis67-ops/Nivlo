//! `nivlo-platform-macos`：macOS 平台 Adapter（`cfg(target_os = "macos")` 隔离，其他平台编译为空）。
//!
//! 禁止依赖：其他 Adapter 的内部实现（参见后端规范 §3.1）。
#![cfg(target_os = "macos")]
