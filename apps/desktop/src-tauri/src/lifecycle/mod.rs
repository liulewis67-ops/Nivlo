//! 应用生命周期：启动顺序、故障恢复与退出。
//!
//! 启动顺序遵循架构文档 §54：日志 → 路径 → SQLite → Migration → Repository → …
//! → 创建窗口。Migration 失败时**不启动业务 Runtime**，改为显示恢复对话框（架构文档 §30）。
//! 退出流程见 [`crate::app::RuntimeHandles::shutdown`]。

pub mod recovery;
pub mod startup;
