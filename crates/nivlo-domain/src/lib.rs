//! `nivlo-domain`：纯领域模型与业务规则（Item、Project、Tag、Source、Attachment、Domain Event）。
//!
//! 本 crate 纯同步、无 IO，也**不读取当前时间**：需要"现在"的操作都由调用方传入 `now`
//! （通常来自 `nivlo_common::clock::Clock`），因此所有规则都可以确定性地测试。
//!
//! 业务不变量通过类型和构造函数表达（如 [`item::Title`]、[`item::DatePoint`]），
//! 状态变化通过 [`item::Item`] 的方法完成，并返回 [`event::DomainEvent`] 或 [`error::DomainError`]。
//!
//! 禁止依赖：`tauri`、`sqlx`、`reqwest`、`rquickjs`、`windows`、`tokio`（运行时相关）
//! （参见后端规范 §3.1）。

pub mod attachment;
pub mod error;
pub mod event;
pub mod id;
pub mod item;
pub mod project;
pub mod source;
pub mod tag;
