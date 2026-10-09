//! `nivlo-application`：应用层 Use Case、Port 定义、事务边界与事件发布。
//!
//! * [`ports`]：Application 需要外部世界提供的能力（存储、时钟等）的 trait。
//!   Port 在本层定义，由 Adapter crate 实现（后端规范 §4.2）。
//! * 事务边界由本层通过 [`ports::UnitOfWork`] 控制：一个 Use Case 内的多次写入在同一事务中提交，
//!   Repository 自己不提交（架构文档 §56）。
//!
//! 禁止依赖：`tauri`、`sqlx`、`reqwest`、`rquickjs`、`windows`、任何 Adapter crate
//! （参见后端规范 §3.1）。

pub mod ports;
