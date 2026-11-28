//! 连接池、Migration 与事务工厂。

use std::path::Path;
use std::time::Duration;

use asterjot_application::ports::{StorageError, Transaction, UnitOfWork};
use async_trait::async_trait;
use sha2::{Digest, Sha384};
use sqlx::SqlitePool;
use sqlx::migrate::{Migrate, Migrator};
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous};

use crate::error::map_sqlx;
use crate::item_repository::SqliteTransaction;
use crate::pinyin_initials::title_initials;

/// 编译期嵌入的 Migration。已合入的 Migration 不得修改（sqlx 会校验 checksum）。
static MIGRATOR: Migrator = sqlx::migrate!("../../migrations");

/// v0.1.2 的原始脚本；v0.1.3 更名时只改动了注释，却改变了 SQLx 的校验和。
/// 保留精确原文，仅接受这两个已发布版本，不放宽其他迁移的完整性检查。
const LEGACY_MIGRATIONS: &[(i64, &[u8])] = &[
    (2, include_bytes!("legacy_migrations/0002_item_source.sql")),
    (4, include_bytes!("legacy_migrations/0004_trash.sql")),
];

/// 连接池大小。
///
/// AsterJot 是单用户桌面应用，不需要 Web Server 级别的连接池（架构文档 §29）。
const MAX_CONNECTIONS: u32 = 4;

/// 检查点之后 WAL 文件最多保留的字节数（32 MiB）。
const WAL_SIZE_LIMIT_BYTES: &str = "33554432";

/// 事务一开始就拿写锁。
///
/// 默认的 `BEGIN` 是延迟事务：先读后写时，如果别的连接在这期间提交过写入，WAL 下 SQLite 会在升级为
/// 写事务的那一刻直接返回 `SQLITE_BUSY_SNAPSHOT`（不等 [`BUSY_TIMEOUT`]），表现为偶发的
/// `STORAGE_UNAVAILABLE`。`BEGIN IMMEDIATE` 让第二个写事务在开始时就排队等待，最多等 `BUSY_TIMEOUT`。
/// 只读的事务用 [`UnitOfWork::begin_read`]（延迟事务），不受影响。
const BEGIN_WRITE: &str = "BEGIN IMMEDIATE";

/// 等待数据库锁的最长时间。
const BUSY_TIMEOUT: Duration = Duration::from_secs(5);

/// SQLite 数据库句柄。克隆开销很小，所有克隆共享同一个连接池。
#[derive(Debug, Clone)]
pub struct Database {
    /// 底层连接池。
    pool: SqlitePool,
    /// WAL 文件的路径（`<库文件>-wal`），用来查看它有多大。
    wal_path: std::path::PathBuf,
}

impl Database {
    /// 打开（必要时创建）数据库文件并建立连接池。
    ///
    /// 启用 WAL、`foreign_keys=ON` 与 `busy_timeout`（架构文档 §29）。本函数**不**运行 Migration，
    /// 调用方需随后调用 [`Database::migrate`]；两步分开，是为了 Migration 失败时
    /// 宿主还能拿到句柄做恢复 / 诊断（架构文档 §30）。
    ///
    /// # Errors
    ///
    /// 文件无法创建或打开时返回 [`StorageError::Unavailable`]。
    pub async fn open(path: &Path) -> Result<Self, StorageError> {
        let options = SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal)
            // WAL 模式下 NORMAL 足以保证不损坏，且比默认的 FULL 少很多 fsync。
            .synchronous(SqliteSynchronous::Normal)
            .foreign_keys(true)
            // WAL 文件在一次检查点之后最多保留这么大，超出的部分截断（默认不限制：大量写入后 WAL 会一直保持峰值大小）。
            .pragma("journal_size_limit", WAL_SIZE_LIMIT_BYTES)
            .busy_timeout(BUSY_TIMEOUT);
        let pool = SqlitePoolOptions::new()
            .max_connections(MAX_CONNECTIONS)
            .connect_with(options)
            .await
            .map_err(map_sqlx)?;
        let mut wal = path.as_os_str().to_owned();
        wal.push("-wal");
        Ok(Self {
            pool,
            wal_path: std::path::PathBuf::from(wal),
        })
    }

    /// 当前程序认识的最新 Schema 版本：恢复备份时拒绝比它更新的数据库（来自更新版本的应用）。
    #[must_use]
    pub fn latest_schema_version() -> i64 {
        MIGRATOR.iter().map(|m| m.version).max().unwrap_or(0)
    }

    /// 运行全部尚未应用的 Migration；重复调用是幂等的。
    ///
    /// # Errors
    ///
    /// Migration 失败（SQL 错误、checksum 不匹配、版本比应用更新）时返回
    /// [`StorageError::Migration`]。此时宿主**不得**启动业务 Runtime。
    /// 回填拼音首字母失败时返回存储错误。
    pub async fn migrate(&self) -> Result<(), StorageError> {
        let mut conn = self.pool.acquire().await.map_err(map_sqlx)?;
        conn.ensure_migrations_table()
            .await
            .map_err(|e| StorageError::Migration(e.to_string()))?;
        let applied = conn
            .list_applied_migrations()
            .await
            .map_err(|e| StorageError::Migration(e.to_string()))?;
        let mut migrations = MIGRATOR.migrations.to_vec();
        for migration in &mut migrations {
            if let Some((_, original)) = LEGACY_MIGRATIONS
                .iter()
                .find(|(version, _)| *version == migration.version)
                && let Some(record) = applied
                    .iter()
                    .find(|record| record.version == migration.version)
                && record.checksum.as_ref() == Sha384::digest(original).as_slice()
            {
                // 只调整本次校验所期待的值，不重写用户库的历史，也不重新执行已应用 SQL。
                migration.checksum = record.checksum.clone();
            }
        }
        let migrator = Migrator {
            migrations: migrations.into(),
            ..Migrator::DEFAULT
        };
        migrator
            .run(&mut *conn)
            .await
            .map_err(|e| StorageError::Migration(e.to_string()))?;
        drop(conn);
        tracing::info!(event = "migrations_applied", "数据库迁移完成");
        self.backfill_title_initials().await
    }

    /// 给还没算过拼音首字母的 Item 补上（`0008_title_initials.sql` 之前写入的数据）。
    ///
    /// 之后的写入由 Repository 维护；没有汉字的标题存空字符串，所以这里只在升级后第一次有活干。
    async fn backfill_title_initials(&self) -> Result<(), StorageError> {
        let rows = sqlx::query!(
            "SELECT id AS \"id!\", title AS \"title!\" FROM items WHERE title_initials IS NULL"
        )
        .fetch_all(&self.pool)
        .await
        .map_err(map_sqlx)?;
        if rows.is_empty() {
            return Ok(());
        }
        let mut tx = self.pool.begin_with(BEGIN_WRITE).await.map_err(map_sqlx)?;
        for row in &rows {
            let initials = title_initials(&row.title);
            sqlx::query!(
                "UPDATE items SET title_initials = ? WHERE id = ?",
                initials,
                row.id
            )
            .execute(&mut *tx)
            .await
            .map_err(map_sqlx)?;
        }
        tx.commit().await.map_err(map_sqlx)?;
        tracing::info!(
            event = "title_initials_backfilled",
            count = rows.len(),
            "已回填拼音首字母"
        );
        Ok(())
    }

    /// 返回已应用的最新 Schema 版本；尚未运行过任何 Migration 时返回 `None`。
    ///
    /// # Errors
    ///
    /// 数据库不可用时返回 [`StorageError::Unavailable`]。
    pub async fn schema_version(&self) -> Result<Option<i64>, StorageError> {
        // `_sqlx_migrations` 由 sqlx 在第一次 Migration 时创建，之前查询会失败，需先判断表是否存在。
        let exists: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = '_sqlx_migrations'",
        )
        .fetch_one(&self.pool)
        .await
        .map_err(map_sqlx)?;
        if exists == 0 {
            return Ok(None);
        }
        // 只统计成功应用的版本；失败的 Migration 以 success=0 记录。
        sqlx::query_scalar("SELECT MAX(version) FROM _sqlx_migrations WHERE success = 1")
            .fetch_one(&self.pool)
            .await
            .map_err(map_sqlx)
    }

    /// 把当前数据写成一份**事务一致**的快照文件（`VACUUM INTO`）：应用照常运行也可以备份，
    /// 快照里没有 WAL 残留，是一个独立、紧凑的 SQLite 文件。目标文件必须不存在。
    ///
    /// # Errors
    ///
    /// 目标已存在、磁盘已满或数据库不可用时返回 [`StorageError::Unavailable`]。
    pub async fn snapshot_to(&self, dest: &Path) -> Result<(), StorageError> {
        let dest = dest
            .to_str()
            .ok_or_else(|| StorageError::Unavailable("路径不是合法的 UTF-8".to_owned()))?;
        sqlx::query("VACUUM INTO ?1")
            .bind(dest)
            .execute(&self.pool)
            .await
            .map_err(map_sqlx)?;
        Ok(())
    }

    /// 校验一个数据库文件（备份 / 恢复前用）：只读打开，`PRAGMA integrity_check` 必须为 ok，
    /// 返回它的 Schema 版本。不会修改文件。
    ///
    /// # Errors
    ///
    /// 文件打不开、不是 SQLite 或完整性检查失败时返回 [`StorageError::Corrupt`] / [`StorageError::Unavailable`]。
    pub async fn verify_file(path: &Path) -> Result<Option<i64>, StorageError> {
        let options = SqliteConnectOptions::new().filename(path).read_only(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .map_err(map_sqlx)?;
        let outcome = async {
            let verdict: String = sqlx::query_scalar("PRAGMA integrity_check")
                .fetch_one(&pool)
                .await
                .map_err(|e| StorageError::Corrupt(e.to_string()))?;
            if verdict != "ok" {
                return Err(StorageError::Corrupt(verdict));
            }
            Self {
                pool: pool.clone(),
                wal_path: std::path::PathBuf::new(),
            }
            .schema_version()
            .await
        }
        .await;
        pool.close().await;
        outcome
    }

    /// 执行一次 `wal_checkpoint(TRUNCATE)`：把 WAL 里的内容写回主文件并把 WAL 截断。
    ///
    /// 持续有读事务时自动检查点没有机会重置 WAL，大量写入之后 WAL 文件会一直保持峰值大小（实测 3000 次捕获后
    /// 148 MB）；宿主定期调用它，让磁盘占用回落。有读事务占着时 SQLite 会等到 `busy_timeout` 再放弃。
    ///
    /// # Errors
    ///
    /// 数据库不可用时返回 [`StorageError`]。
    pub async fn checkpoint(&self) -> Result<(), StorageError> {
        sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
            .execute(&self.pool)
            .await
            .map(|_| ())
            .map_err(map_sqlx)
    }

    /// WAL 文件现在有多大（字节）；文件不存在时为 0。
    #[must_use]
    pub fn wal_size(&self) -> u64 {
        std::fs::metadata(&self.wal_path).map_or(0, |m| m.len())
    }

    /// WAL 超过 `limit` 字节时做一次 [`Database::checkpoint`]，返回是否做了。
    ///
    /// 由写入活动触发（见宿主），不需要额外的定时器：大量写入时 WAL 会在界面持续读取的情况下一直增长，
    /// 超过阈值就立刻截断，而不是等定时检查点。
    ///
    /// # Errors
    ///
    /// 检查点失败时返回 [`StorageError`]。
    pub async fn checkpoint_if_wal_exceeds(&self, limit: u64) -> Result<bool, StorageError> {
        if self.wal_size() <= limit {
            return Ok(false);
        }
        self.checkpoint().await?;
        Ok(true)
    }

    /// 关闭连接池，等待所有连接归还并刷写 WAL。
    pub async fn close(&self) {
        self.pool.close().await;
    }
}

#[async_trait]
impl UnitOfWork for Database {
    /// 从连接池取一个连接并开启 `BEGIN IMMEDIATE` 事务，立即取得写锁。
    async fn begin(&self) -> Result<Box<dyn Transaction>, StorageError> {
        let tx = self.pool.begin_with(BEGIN_WRITE).await.map_err(map_sqlx)?;
        Ok(Box::new(SqliteTransaction::new(tx)))
    }

    /// 从连接池取一个连接并开启延迟事务：只在第一次读取时拿快照，不占写锁。
    async fn begin_read(&self) -> Result<Box<dyn Transaction>, StorageError> {
        let tx = self.pool.begin().await.map_err(map_sqlx)?;
        Ok(Box::new(SqliteTransaction::new(tx)))
    }
}
