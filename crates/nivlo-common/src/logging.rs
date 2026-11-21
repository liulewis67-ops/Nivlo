//! 日志初始化。
//!
//! 使用 `tracing`：按天滚动写入 `logs/`，开发模式同时输出到控制台（架构文档 §42）。
//! 日志默认**不得**包含 Token、Cookie、Authorization Header、完整 Clipboard、Note 全文、
//! 用户文件全文；敏感值请用 [`crate::secret::Secret`] 包装，业务字段只记录 ID 与长度。

use std::path::{Path, PathBuf};

use tracing_appender::non_blocking::WorkerGuard;
use tracing_appender::rolling::{InitError, RollingFileAppender, Rotation};
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::{EnvFilter, Layer};

/// 覆盖日志过滤规则的环境变量名（语法同 `RUST_LOG`）。
pub const LOG_FILTER_ENV: &str = "NIVLO_LOG";

/// 日志文件名前缀，最终文件名形如 `nivlo.2026-10-09.log`。
const LOG_FILE_PREFIX: &str = "nivlo";

/// 日志文件名后缀。
const LOG_FILE_SUFFIX: &str = "log";

/// 统一的结构化日志字段名，避免各处拼写不一致。
pub mod fields {
    /// 事件名，稳定的 snake_case 标识。
    pub const EVENT: &str = "event";
    /// Workflow 运行 ID。
    pub const RUN_ID: &str = "run_id";
    /// Workflow ID。
    pub const WORKFLOW_ID: &str = "workflow_id";
    /// Item ID。
    pub const ITEM_ID: &str = "item_id";
    /// 耗时（毫秒）。
    pub const DURATION_MS: &str = "duration_ms";
    /// 稳定的错误码。
    pub const ERROR_CODE: &str = "error_code";
}

/// 日志初始化错误。
#[derive(Debug, thiserror::Error)]
pub enum LogError {
    /// 创建日志文件写入器失败（目录不可写等）。
    #[error("初始化日志文件失败")]
    Appender(#[from] InitError),
    /// 过滤规则无法解析。
    #[error("日志过滤规则无效：{0}")]
    InvalidFilter(String),
    /// 全局日志订阅者已经设置过。
    #[error("日志系统已初始化")]
    AlreadyInitialized,
}

/// 日志配置。
#[derive(Debug, Clone)]
pub struct LogConfig {
    /// 日志目录。
    pub dir: PathBuf,
    /// 最多保留的日志文件数（按天滚动，即保留天数）。
    pub retention_days: usize,
    /// 是否同时输出到控制台（开发模式）。
    pub console: bool,
    /// 未设置 [`LOG_FILTER_ENV`] 时使用的默认过滤规则，例如 `"info"`。
    pub default_filter: String,
}

impl LogConfig {
    /// 创建默认配置：保留 14 天、关闭控制台输出、过滤级别 `info`。
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self {
            dir: dir.into(),
            retention_days: 14,
            console: false,
            default_filter: "info".to_string(),
        }
    }
}

/// 日志后台写入线程的守卫，必须持有到进程退出，否则缓冲中的日志可能丢失。
#[must_use = "守卫被丢弃后日志将停止写入"]
pub struct LogGuard {
    /// `tracing-appender` 的 worker 守卫，丢弃时会刷写缓冲。
    _worker: WorkerGuard,
}

/// 创建按天滚动、带保留数量限制的日志文件写入器。
///
/// 创建时会立即清理超出 `retention_days` 的旧文件。
///
/// # Errors
///
/// 目录不可写或无法创建文件时返回 [`LogError::Appender`]。
pub fn build_file_appender(
    dir: &Path,
    retention_days: usize,
) -> Result<RollingFileAppender, LogError> {
    Ok(RollingFileAppender::builder()
        .rotation(Rotation::DAILY)
        .filename_prefix(LOG_FILE_PREFIX)
        .filename_suffix(LOG_FILE_SUFFIX)
        .max_log_files(retention_days.max(1))
        .build(dir)?)
}

/// 初始化全局日志系统并返回守卫。
///
/// 文件日志不带 ANSI 颜色；控制台日志仅在 `config.console` 为真时启用。
/// 过滤规则优先取环境变量 [`LOG_FILTER_ENV`]，否则使用 `config.default_filter`。
///
/// # Errors
///
/// * [`LogError::Appender`] - 日志文件无法创建。
/// * [`LogError::InvalidFilter`] - 过滤规则无法解析。
/// * [`LogError::AlreadyInitialized`] - 全局订阅者已设置（进程内只能初始化一次）。
pub fn init_logging(config: &LogConfig) -> Result<LogGuard, LogError> {
    let filter = match std::env::var(LOG_FILTER_ENV) {
        Ok(spec) if !spec.is_empty() => spec,
        _ => config.default_filter.clone(),
    };
    // 文件层与控制台层各需要一份独立的 EnvFilter，因此解析两次。
    let parse = || EnvFilter::try_new(&filter).map_err(|e| LogError::InvalidFilter(e.to_string()));
    let file_filter = parse()?;
    let console_filter = parse()?;

    let appender = build_file_appender(&config.dir, config.retention_days)?;
    // 非阻塞写入：日志 IO 不会卡住调用线程（例如 UI 命令处理路径）。
    let (writer, worker) = tracing_appender::non_blocking(appender);

    let file_layer = tracing_subscriber::fmt::layer()
        .with_writer(writer)
        .with_ansi(false)
        .with_filter(file_filter);
    let console_layer = config
        .console
        .then(|| tracing_subscriber::fmt::layer().with_filter(console_filter));

    tracing_subscriber::registry()
        .with(file_layer)
        .with(console_layer)
        .try_init()
        .map_err(|_| LogError::AlreadyInitialized)?;

    Ok(LogGuard { _worker: worker })
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use std::io::Write;

    use super::*;

    #[test]
    fn appender_writes_into_dated_log_file() {
        let tmp = tempfile::tempdir().unwrap();
        let mut appender = build_file_appender(tmp.path(), 7).unwrap();
        appender.write_all(b"hello\n").unwrap();
        appender.flush().unwrap();
        let names: Vec<String> = std::fs::read_dir(tmp.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names.len(), 1);
        assert!(
            names[0].starts_with("nivlo.") && names[0].ends_with(".log"),
            "{names:?}"
        );
    }

    #[test]
    fn retention_prunes_old_files() {
        let tmp = tempfile::tempdir().unwrap();
        for day in 1..=5 {
            std::fs::write(tmp.path().join(format!("nivlo.2026-01-0{day}.log")), b"x").unwrap();
        }
        // 创建写入器时会清理旧文件；保留数量包含当天新建的文件。
        let mut appender = build_file_appender(tmp.path(), 3).unwrap();
        appender.write_all(b"today\n").unwrap();
        appender.flush().unwrap();
        let count = std::fs::read_dir(tmp.path()).unwrap().count();
        assert!(count <= 3, "保留数应不超过 3，实际 {count}");
    }

    #[test]
    fn unwritable_dir_is_reported() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("not-a-dir");
        std::fs::write(&file, b"x").unwrap();
        assert!(matches!(
            build_file_appender(&file, 3),
            Err(LogError::Appender(_))
        ));
    }

    #[test]
    fn default_config_is_conservative() {
        let config = LogConfig::new("logs");
        assert_eq!(config.retention_days, 14);
        assert!(!config.console);
    }
}
