//! 应用数据目录布局。
//!
//! 所有持久化文件都位于同一个根目录之下（架构文档 §29）：
//!
//! ```text
//! Nivlo/
//! ├── database/nivlo.db
//! ├── config/
//! ├── logs/
//! ├── cache/
//! ├── workflows/
//! └── attachments/
//! ```
//!
//! 根目录按操作系统约定解析（也可由环境变量 [`DATA_DIR_ENV`] 覆盖，便于开发与 E2E 隔离数据），
//! 首次启动时由 [`AppPaths::ensure_dirs`] 自动创建全部子目录。

use std::io;
use std::path::{Path, PathBuf};

/// 覆盖数据根目录的环境变量名。
pub const DATA_DIR_ENV: &str = "NIVLO_DATA_DIR";

/// 数据库文件名。
const DATABASE_FILE: &str = "nivlo.db";

/// 路径解析与目录创建过程中的错误。
#[derive(Debug, thiserror::Error)]
pub enum PathsError {
    /// 无法确定操作系统的应用数据目录（缺少必要的环境变量）。
    #[error("无法确定应用数据目录：缺少环境变量 {missing}")]
    DataRootUnavailable {
        /// 缺失的环境变量名。
        missing: &'static str,
    },
    /// 创建目录失败。
    #[error("创建目录 {path} 失败")]
    CreateDir {
        /// 创建失败的目录。
        path: PathBuf,
        /// 底层 IO 错误。
        #[source]
        source: io::Error,
    },
}

/// 用于选择目录约定的操作系统。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    /// Windows：`%APPDATA%\Nivlo`。
    Windows,
    /// macOS：`~/Library/Application Support/Nivlo`。
    MacOs,
    /// Linux 及其他类 Unix：`$XDG_DATA_HOME/nivlo` 或 `~/.local/share/nivlo`。
    Linux,
}

impl Platform {
    /// 返回当前编译目标对应的平台。
    pub fn current() -> Self {
        if cfg!(target_os = "windows") {
            Self::Windows
        } else if cfg!(target_os = "macos") {
            Self::MacOs
        } else {
            Self::Linux
        }
    }
}

/// 应用数据目录布局。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppPaths {
    /// 数据根目录。
    root: PathBuf,
}

impl AppPaths {
    /// 以给定根目录创建布局（不触碰文件系统）。
    pub fn from_root(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    /// 按当前操作系统与进程环境变量解析默认数据目录。
    ///
    /// # Errors
    ///
    /// 缺少定位用户目录所需的环境变量时返回 [`PathsError::DataRootUnavailable`]。
    pub fn resolve_default() -> Result<Self, PathsError> {
        Self::resolve(Platform::current(), |name| std::env::var(name).ok())
    }

    /// 使用显式的平台与环境变量读取函数解析数据目录，便于测试。
    ///
    /// 优先使用 [`DATA_DIR_ENV`]；否则按平台约定从 `APPDATA` / `HOME` / `XDG_DATA_HOME` 推导。
    ///
    /// # Errors
    ///
    /// 缺少定位用户目录所需的环境变量时返回 [`PathsError::DataRootUnavailable`]。
    pub fn resolve(
        platform: Platform,
        env: impl Fn(&str) -> Option<String>,
    ) -> Result<Self, PathsError> {
        // 空字符串视同未设置，避免把相对路径 "" 当成根目录。
        let get = |name: &str| env(name).filter(|value| !value.is_empty());

        if let Some(custom) = get(DATA_DIR_ENV) {
            return Ok(Self::from_root(custom));
        }
        let root = match platform {
            Platform::Windows => {
                let appdata =
                    get("APPDATA").ok_or(PathsError::DataRootUnavailable { missing: "APPDATA" })?;
                PathBuf::from(appdata).join("Nivlo")
            }
            Platform::MacOs => {
                let home =
                    get("HOME").ok_or(PathsError::DataRootUnavailable { missing: "HOME" })?;
                PathBuf::from(home)
                    .join("Library")
                    .join("Application Support")
                    .join("Nivlo")
            }
            Platform::Linux => match get("XDG_DATA_HOME") {
                Some(xdg) => PathBuf::from(xdg).join("nivlo"),
                None => {
                    let home =
                        get("HOME").ok_or(PathsError::DataRootUnavailable { missing: "HOME" })?;
                    PathBuf::from(home)
                        .join(".local")
                        .join("share")
                        .join("nivlo")
                }
            },
        };
        Ok(Self::from_root(root))
    }

    /// 创建根目录及全部子目录；目录已存在时不报错。
    ///
    /// # Errors
    ///
    /// 任一目录创建失败时返回 [`PathsError::CreateDir`]。
    pub fn ensure_dirs(&self) -> Result<(), PathsError> {
        for dir in [
            self.root(),
            &self.database_dir(),
            &self.config_dir(),
            &self.logs_dir(),
            &self.cache_dir(),
            &self.workflows_dir(),
            &self.attachments_dir(),
        ] {
            std::fs::create_dir_all(dir).map_err(|source| PathsError::CreateDir {
                path: dir.to_path_buf(),
                source,
            })?;
        }
        Ok(())
    }

    /// 数据根目录。
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// 数据库目录。
    pub fn database_dir(&self) -> PathBuf {
        self.root.join("database")
    }

    /// SQLite 数据库文件路径（`database/nivlo.db`）。
    pub fn database_file(&self) -> PathBuf {
        self.database_dir().join(DATABASE_FILE)
    }

    /// 配置目录。
    pub fn config_dir(&self) -> PathBuf {
        self.root.join("config")
    }

    /// 日志目录。
    pub fn logs_dir(&self) -> PathBuf {
        self.root.join("logs")
    }

    /// 缓存目录。
    pub fn cache_dir(&self) -> PathBuf {
        self.root.join("cache")
    }

    /// 用户 Workflow 定义目录。
    pub fn workflows_dir(&self) -> PathBuf {
        self.root.join("workflows")
    }

    /// 导出目录：诊断包、备份、数据导出都写在这里（按需创建）。
    pub fn exports_dir(&self) -> PathBuf {
        self.root.join("exports")
    }

    /// 附件目录（仅存放没有原始路径的内容，如粘贴的截图）。
    pub fn attachments_dir(&self) -> PathBuf {
        self.root.join("attachments")
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use std::collections::HashMap;

    use super::*;

    /// 由键值表构造环境变量读取函数。
    fn env_of(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let map: HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
            .collect();
        move |name| map.get(name).cloned()
    }

    #[test]
    fn windows_uses_appdata() {
        let paths = AppPaths::resolve(
            Platform::Windows,
            env_of(&[("APPDATA", "C:\\Users\\a\\AppData\\Roaming")]),
        )
        .unwrap();
        assert_eq!(
            paths.root(),
            Path::new("C:\\Users\\a\\AppData\\Roaming").join("Nivlo")
        );
    }

    #[test]
    fn macos_uses_application_support() {
        let paths = AppPaths::resolve(Platform::MacOs, env_of(&[("HOME", "/Users/a")])).unwrap();
        assert_eq!(
            paths.root(),
            Path::new("/Users/a")
                .join("Library")
                .join("Application Support")
                .join("Nivlo")
        );
    }

    #[test]
    fn linux_prefers_xdg_then_home() {
        let xdg = AppPaths::resolve(
            Platform::Linux,
            env_of(&[("XDG_DATA_HOME", "/data"), ("HOME", "/home/a")]),
        )
        .unwrap();
        assert_eq!(xdg.root(), Path::new("/data").join("nivlo"));

        let home = AppPaths::resolve(Platform::Linux, env_of(&[("HOME", "/home/a")])).unwrap();
        assert_eq!(
            home.root(),
            Path::new("/home/a")
                .join(".local")
                .join("share")
                .join("nivlo")
        );
    }

    #[test]
    fn override_env_wins() {
        let paths = AppPaths::resolve(
            Platform::Windows,
            env_of(&[(DATA_DIR_ENV, "D:\\data"), ("APPDATA", "C:\\x")]),
        )
        .unwrap();
        assert_eq!(paths.root(), Path::new("D:\\data"));
    }

    #[test]
    fn missing_env_is_an_error() {
        let err = AppPaths::resolve(Platform::Windows, env_of(&[])).unwrap_err();
        assert!(matches!(
            err,
            PathsError::DataRootUnavailable { missing: "APPDATA" }
        ));
        let empty = AppPaths::resolve(Platform::Linux, env_of(&[("HOME", "")])).unwrap_err();
        assert!(matches!(
            empty,
            PathsError::DataRootUnavailable { missing: "HOME" }
        ));
    }

    #[test]
    fn layout_matches_architecture() {
        let paths = AppPaths::from_root("/r");
        assert_eq!(
            paths.database_file(),
            Path::new("/r").join("database").join("nivlo.db")
        );
        assert_eq!(paths.logs_dir(), Path::new("/r").join("logs"));
        assert_eq!(paths.attachments_dir(), Path::new("/r").join("attachments"));
    }

    #[test]
    fn ensure_dirs_creates_everything_and_is_idempotent() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = AppPaths::from_root(tmp.path().join("Nivlo"));
        paths.ensure_dirs().unwrap();
        paths.ensure_dirs().unwrap();
        for dir in [
            paths.database_dir(),
            paths.config_dir(),
            paths.logs_dir(),
            paths.cache_dir(),
            paths.workflows_dir(),
            paths.attachments_dir(),
        ] {
            assert!(dir.is_dir(), "{dir:?} 应已创建");
        }
    }

    #[test]
    fn ensure_dirs_reports_failure() {
        let tmp = tempfile::tempdir().unwrap();
        // 根路径是一个已存在的文件，创建子目录必然失败。
        let file = tmp.path().join("file");
        std::fs::write(&file, b"x").unwrap();
        let err = AppPaths::from_root(&file).ensure_dirs().unwrap_err();
        assert!(matches!(err, PathsError::CreateDir { .. }));
    }
}
