//! `nivlo-storage`：SQLite / SQLx 存储 Adapter。
//!
//! 实现 `nivlo-application` 中定义的 [`UnitOfWork`](nivlo_application::ports::UnitOfWork)
//! 与各 Repository Port：
//!
//! * [`Database`]：连接池（WAL、外键、busy_timeout）与 Migration。
//! * 数据库行类型与 Domain 类型分离，转换集中在 `codec` 与 `item_repository` 中。
//!
//! SQLite 是 Domain State 的唯一 Source of Truth（ADR-003）。
//! 查询使用 SQLx 的编译期校验宏，离线元数据提交在仓库根目录的 `.sqlx/` 中。
//!
//! 禁止依赖：`tauri`、其他 Adapter 的内部实现（参见后端规范 §3.1）。

mod codec;
mod database;
mod error;
mod item_repository;

pub use database::Database;
