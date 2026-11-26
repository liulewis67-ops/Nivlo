//! `stardeskbox-storage`：SQLite / SQLx 存储 Adapter。
//!
//! 实现 `stardeskbox-application` 中定义的 [`UnitOfWork`](stardeskbox_application::ports::UnitOfWork)
//! 与各 Repository Port：
//!
//! * [`Database`]：连接池（WAL、外键、busy_timeout）与 Migration。
//! * 数据库行类型与 Domain 类型分离，转换集中在 `codec` 与 `item_repository` 中。
//!
//! SQLite 是 Domain State 的唯一 Source of Truth（ADR-003）。
//! 查询使用 SQLx 的编译期校验宏，离线元数据提交在仓库根目录的 `.sqlx/` 中。
//!
//! 禁止依赖：`tauri`、其他 Adapter 的内部实现（参见后端规范 §3.1）。

mod attachment_files;
mod codec;
mod database;
mod error;
mod item_repository;
mod organize_repository;
mod pinyin_initials;
mod skin_files;
mod trash_repository;
mod trigger_repository;
mod workflow_repository;

pub use attachment_files::FsAttachmentFiles;
pub use database::Database;
pub use skin_files::{
    FsSkinAssetStore, MAX_SKIN_ASSET_BYTES, MAX_SKIN_STORAGE_BYTES, is_valid_skin_asset_file_name,
};
