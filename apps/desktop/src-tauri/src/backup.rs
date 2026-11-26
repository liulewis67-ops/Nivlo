//! 备份与恢复（实施计划 7.4）。
//!
//! 备份包是一个 zip：
//!
//! * `manifest.json`：格式、版本、创建时间、应用版本、Schema 版本；
//! * `stardeskbox.db`：用 `VACUUM INTO` 做的**事务一致**快照（应用运行时也能备份）。Workflow 与设置都在库里；
//!   备份里**没有任何 Secret**（Secret 本来就不在数据库里，见架构文档 §36）；
//! * `attachments/…`：StarDeskBox 自己保存的附件（粘贴的图片）。被引用的用户文件不在其中——它们本来就不归 StarDeskBox 管。
//!
//! 恢复分两步，因为运行中的应用不能替换自己正在使用的数据库文件：
//!
//! 1. [`stage_restore`]：校验备份（格式、路径安全、SQLite 完整性、Schema 版本不比本程序新），
//!    解到 `restore-staging/`，并写下就绪标记；调用方在此之前应先做一份当前数据的备份；
//! 2. [`apply_pending_restore`]：**下次启动、打开数据库之前**把当前数据整体挪到 `replaced-<时间>/`
//!    （不删除，随时可以找回），再把暂存的数据换上。
//!
//! 「删除所有数据」（[`stage_reset`] / [`apply_pending_reset`]）走同一条路：下次启动时把当前数据挪到
//! `replaced-<时间>/`，但不换上任何数据，应用以全新的空库启动。卸载程序不再删除数据目录，这是清空数据的唯一入口。
//! 暂存恢复与暂存清空互相取消：以用户最后一次的选择为准。

use std::fs::File;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use stardeskbox_common::paths::AppPaths;
use stardeskbox_storage::Database;

/// 备份包格式名。
pub const BACKUP_FORMAT: &str = "stardeskbox-backup";

/// 备份包格式版本。
pub const BACKUP_VERSION: u32 = 1;

/// 暂存目录名（在数据根目录下）。
const STAGING_DIR: &str = "restore-staging";

/// 暂存就绪标记文件名（在暂存目录里；有它才会在下次启动时应用）。
const READY_MARKER: &str = "READY";

/// 「删除所有数据」待执行标记（在数据根目录下）。
const RESET_MARKER: &str = "RESET-PENDING";

/// 备份 / 恢复失败。
#[derive(Debug, thiserror::Error)]
pub enum BackupError {
    /// 文件系统错误。
    #[error("文件操作失败：{0}")]
    Io(String),
    /// 数据库错误。
    #[error("数据库错误：{0}")]
    Database(String),
    /// 备份包不合法（格式、版本、路径、完整性）。
    #[error("备份包无效：{0}")]
    Invalid(String),
}

impl From<std::io::Error> for BackupError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error.to_string())
    }
}

impl From<zip::result::ZipError> for BackupError {
    fn from(error: zip::result::ZipError) -> Self {
        Self::Invalid(error.to_string())
    }
}

impl From<stardeskbox_application::ports::StorageError> for BackupError {
    fn from(error: stardeskbox_application::ports::StorageError) -> Self {
        Self::Database(error.to_string())
    }
}

/// 备份清单。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    /// 固定为 [`BACKUP_FORMAT`]。
    pub format: String,
    /// 格式版本。
    pub version: u32,
    /// 创建时间（RFC 3339）。
    pub created_at: String,
    /// 创建它的应用版本。
    pub app_version: String,
    /// 数据库 Schema 版本。
    pub schema_version: i64,
}

/// 递归列出目录下的所有文件（相对路径，`/` 分隔）。
fn walk(root: &Path) -> Vec<(String, PathBuf)> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.filter_map(Result::ok) {
            let path = entry.path();
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_dir() {
                stack.push(path);
            } else if kind.is_file()
                && let Ok(relative) = path.strip_prefix(root)
            {
                let name = relative
                    .components()
                    .filter_map(|c| c.as_os_str().to_str())
                    .collect::<Vec<_>>()
                    .join("/");
                out.push((name, path));
            }
        }
    }
    out.sort();
    out
}

/// 创建备份包，返回写出的文件路径。
///
/// # Errors
///
/// 快照、压缩或写入失败时返回 [`BackupError`]；失败时不会留下半成品。
pub async fn create_backup(
    database: &Database,
    paths: &AppPaths,
    file_name: &str,
    created_at: &str,
    app_version: &str,
) -> Result<PathBuf, BackupError> {
    let exports = paths.exports_dir();
    std::fs::create_dir_all(&exports)?;
    let snapshot = exports.join(format!(".{file_name}.snapshot.db"));
    let target = exports.join(file_name);
    let partial = exports.join(format!(".{file_name}.partial"));
    let _ = std::fs::remove_file(&snapshot);
    database.snapshot_to(&snapshot).await?;
    let schema_version = Database::verify_file(&snapshot).await?.unwrap_or(0);

    let attachments_dir = paths.attachments_dir();
    let skins_dir = paths.skins_dir();
    let manifest = Manifest {
        format: BACKUP_FORMAT.to_owned(),
        version: BACKUP_VERSION,
        created_at: created_at.to_owned(),
        app_version: app_version.to_owned(),
        schema_version,
    };
    let (snapshot_path, partial_path, target_path) =
        (snapshot.clone(), partial.clone(), target.clone());
    let outcome = tokio::task::spawn_blocking(move || -> Result<(), BackupError> {
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated)
            .large_file(true);
        let mut writer = zip::ZipWriter::new(File::create(&partial_path)?);
        writer.start_file("manifest.json", options)?;
        let json =
            serde_json::to_vec_pretty(&manifest).map_err(|e| BackupError::Io(e.to_string()))?;
        writer.write_all(&json)?;
        writer.start_file("stardeskbox.db", options)?;
        std::io::copy(&mut File::open(&snapshot_path)?, &mut writer)?;
        for (name, path) in walk(&attachments_dir) {
            writer.start_file(format!("attachments/{name}"), options)?;
            std::io::copy(&mut File::open(path)?, &mut writer)?;
        }
        for (name, path) in walk(&skins_dir) {
            writer.start_file(format!("skins/{name}"), options)?;
            std::io::copy(&mut File::open(path)?, &mut writer)?;
        }
        writer.finish()?;
        std::fs::rename(&partial_path, &target_path)?;
        Ok(())
    })
    .await
    .map_err(|e| BackupError::Io(e.to_string()))?;
    let _ = std::fs::remove_file(&snapshot);
    if outcome.is_err() {
        let _ = std::fs::remove_file(&partial);
    }
    outcome?;
    Ok(target)
}

/// 压缩包里的路径是否安全：相对、无 `..`、无盘符。
fn safe_relative(name: &str) -> bool {
    let path = Path::new(name);
    !name.is_empty()
        && !name.contains('\\')
        && path.components().all(|c| matches!(c, Component::Normal(_)))
}

/// 校验备份包并暂存，等待下次启动时应用。返回清单。
///
/// # Errors
///
/// 格式不对、含不安全路径、数据库损坏、Schema 比本程序新时返回 [`BackupError::Invalid`]；
/// 此时不会留下暂存数据。
pub async fn stage_restore(backup: &Path, paths: &AppPaths) -> Result<Manifest, BackupError> {
    let staging = paths.root().join(STAGING_DIR);
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging)?;
    let (backup_path, staging_path) = (backup.to_path_buf(), staging.clone());
    let extracted = tokio::task::spawn_blocking(move || extract(&backup_path, &staging_path))
        .await
        .map_err(|e| BackupError::Io(e.to_string()))?;
    let manifest = match extracted {
        Ok(manifest) => manifest,
        Err(error) => {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(error);
        }
    };
    let verified = Database::verify_file(&staging.join("stardeskbox.db")).await;
    let fail = |message: String| {
        let _ = std::fs::remove_dir_all(&staging);
        Err(BackupError::Invalid(message))
    };
    match verified {
        Ok(Some(version)) if version <= Database::latest_schema_version() => {}
        Ok(Some(version)) => {
            return fail(format!(
                "备份来自更新版本的StarDeskBox（数据库版本 {version}），请先升级应用"
            ));
        }
        Ok(None) => return fail("备份里的数据库是空的".to_owned()),
        Err(error) => return fail(format!("备份里的数据库已损坏：{error}")),
    }
    std::fs::write(staging.join(READY_MARKER), b"1")?;
    // 最后的选择为准：恢复取消之前暂存的「删除所有数据」。
    let _ = std::fs::remove_file(paths.root().join(RESET_MARKER));
    Ok(manifest)
}

/// 把备份包解到目录里（同步）。
fn extract(backup: &Path, staging: &Path) -> Result<Manifest, BackupError> {
    let mut archive = zip::ZipArchive::new(File::open(backup)?)?;
    let manifest: Manifest = {
        let mut entry = archive
            .by_name("manifest.json")
            .map_err(|_| BackupError::Invalid("缺少 manifest.json".to_owned()))?;
        let mut text = String::new();
        entry.by_ref().take(64 * 1024).read_to_string(&mut text)?;
        serde_json::from_str(&text).map_err(|e| BackupError::Invalid(e.to_string()))?
    };
    if (manifest.format != BACKUP_FORMAT && manifest.format != "nivlo-backup")
        || manifest.version > BACKUP_VERSION
    {
        return Err(BackupError::Invalid(
            "不是StarDeskBox的备份包，或来自更新的版本".to_owned(),
        ));
    }
    let mut has_database = false;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index)?;
        let name = entry.name().to_owned();
        if entry.is_dir() || name == "manifest.json" {
            continue;
        }
        let name = if name == "nivlo.db" && manifest.format == "nivlo-backup" {
            "stardeskbox.db".to_owned()
        } else {
            name
        };
        let allowed = name == "stardeskbox.db"
            || name.strip_prefix("attachments/").is_some()
            || name.strip_prefix("skins/").is_some();
        if !allowed || !safe_relative(&name) {
            return Err(BackupError::Invalid(format!("包含不允许的文件：{name}")));
        }
        let destination = staging.join(&name);
        if let Some(parent) = destination.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::io::copy(&mut entry, &mut File::create(&destination)?)?;
        has_database |= name == "stardeskbox.db";
    }
    if !has_database {
        return Err(BackupError::Invalid("缺少 stardeskbox.db".to_owned()));
    }
    Ok(manifest)
}

/// 是否有等待应用的恢复。
#[must_use]
pub fn has_pending_restore(paths: &AppPaths) -> bool {
    paths.root().join(STAGING_DIR).join(READY_MARKER).is_file()
}

/// 已挪走的路径（原位置, 新位置），用于失败时回滚。
type Moved = Vec<(PathBuf, PathBuf)>;

/// 把当前数据库文件（含 WAL / SHM）和附件目录挪到 `replaced` 里（不删除）。
/// 出错时返回已挪走的部分，由调用方回滚。
fn move_current_aside(
    paths: &AppPaths,
    replaced: &Path,
    moved: &mut Moved,
) -> Result<(), BackupError> {
    std::fs::create_dir_all(replaced)?;
    let mut move_aside = |from: PathBuf, to: PathBuf| -> Result<(), BackupError> {
        if from.exists() {
            std::fs::rename(&from, &to)?;
            moved.push((from, to));
        }
        Ok(())
    };
    let database_file = paths.database_file();
    for suffix in ["", "-wal", "-shm"] {
        let mut name = database_file.clone().into_os_string();
        name.push(suffix);
        let from = PathBuf::from(name);
        let file_name = from
            .file_name()
            .map(std::ffi::OsStr::to_os_string)
            .unwrap_or_default();
        move_aside(from, replaced.join(file_name))?;
    }
    move_aside(paths.attachments_dir(), replaced.join("attachments"))?;
    move_aside(paths.skins_dir(), replaced.join("skins"))
}

/// 回滚 [`move_current_aside`]：把挪走的放回去（反向）。
fn roll_back(moved: Moved) {
    for (from, to) in moved.into_iter().rev() {
        if from.exists() {
            let _ = std::fs::remove_file(&from).or_else(|_| std::fs::remove_dir_all(&from));
        }
        let _ = std::fs::rename(&to, &from);
    }
}

/// 应用暂存的恢复：**必须在打开数据库之前调用**。当前数据整体挪到 `replaced-<stamp>/`（不删除）。
///
/// # Errors
///
/// 文件操作失败时返回 [`BackupError::Io`]；失败时尽量回滚到原状。
pub fn apply_pending_restore(paths: &AppPaths, stamp: &str) -> Result<bool, BackupError> {
    if !has_pending_restore(paths) {
        return Ok(false);
    }
    let staging = paths.root().join(STAGING_DIR);
    let replaced = paths.root().join(format!("replaced-{stamp}"));
    let mut moved = Moved::new();
    let outcome = (|| -> Result<(), BackupError> {
        // 1. 把当前数据挪走。
        move_current_aside(paths, &replaced, &mut moved)?;
        // 2. 换上暂存的数据。
        std::fs::rename(staging.join("stardeskbox.db"), paths.database_file())?;
        let staged_attachments = staging.join("attachments");
        if staged_attachments.is_dir() {
            std::fs::rename(staged_attachments, paths.attachments_dir())?;
        } else {
            std::fs::create_dir_all(paths.attachments_dir())?;
        }
        let staged_skins = staging.join("skins");
        if staged_skins.is_dir() {
            std::fs::rename(staged_skins, paths.skins_dir())?;
        } else {
            std::fs::create_dir_all(paths.skins_assets_dir())?;
        }
        Ok(())
    })();
    if let Err(error) = outcome {
        roll_back(moved);
        return Err(error);
    }
    let _ = std::fs::remove_dir_all(&staging);
    Ok(true)
}

/// 暂存「删除所有数据」：下次启动时执行（调用方应先做一份当前数据的备份）。
/// 同时取消已暂存的恢复——以用户最后一次的选择为准。
///
/// # Errors
///
/// 写不了标记文件时返回 [`BackupError::Io`]。
pub fn stage_reset(paths: &AppPaths) -> Result<(), BackupError> {
    let _ = std::fs::remove_dir_all(paths.root().join(STAGING_DIR));
    std::fs::write(paths.root().join(RESET_MARKER), b"1")?;
    Ok(())
}

/// 是否有等待执行的「删除所有数据」。
#[must_use]
pub fn has_pending_reset(paths: &AppPaths) -> bool {
    paths.root().join(RESET_MARKER).is_file()
}

/// 执行暂存的「删除所有数据」：**必须在打开数据库之前调用**。当前数据库与附件挪到
/// `replaced-<stamp>/`（不删除），随后应用以全新的空库启动。
///
/// # Errors
///
/// 文件操作失败时返回 [`BackupError::Io`]；失败时回滚，标记保留以便下次重试。
pub fn apply_pending_reset(paths: &AppPaths, stamp: &str) -> Result<bool, BackupError> {
    if !has_pending_reset(paths) {
        return Ok(false);
    }
    let replaced = paths.root().join(format!("replaced-{stamp}"));
    let mut moved = Moved::new();
    if let Err(error) = move_current_aside(paths, &replaced, &mut moved) {
        roll_back(moved);
        return Err(error);
    }
    std::fs::create_dir_all(paths.attachments_dir())?;
    std::fs::create_dir_all(paths.skins_assets_dir())?;
    let _ = std::fs::remove_file(paths.root().join(RESET_MARKER));
    Ok(true)
}

#[cfg(test)]
mod tests;
