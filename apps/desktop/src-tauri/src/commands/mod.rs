//! IPC Command。
//!
//! Command 是薄层：参数解析 → 调用 Application Service → 错误映射 → 返回 DTO
//! （后端规范 §4.5）。禁止提供 `execute_sql`、`read_file(path)`、`http_request` 之类的通用能力型
//! Command（架构文档 §14）。新增 Command 的步骤见 `docs/development/README.md`。

pub mod calendar;
pub mod capture;
pub mod data;
pub mod diagnostics;
pub mod inbox;
pub mod integration;
pub mod item;
pub mod organize;
pub mod settings;
pub mod shortcut;
pub mod skin;
pub mod source;
pub mod today;
pub mod trash;
pub mod update;
pub mod window;
pub mod workflow;
