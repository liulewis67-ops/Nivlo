//! 启动步骤。拆成独立函数，便于在没有窗口的情况下测试（尤其是 Migration 失败路径）。

use std::path::PathBuf;
use std::sync::Arc;

use nivlo_application::calendar::CalendarService;
use nivlo_application::capture::CaptureService;
use nivlo_application::event::EventBus;
use nivlo_application::inbox::InboxService;
use nivlo_application::item::ItemService;
use nivlo_application::organize::{ProjectService, TagService};
use nivlo_application::ports::StorageError;
use nivlo_application::settings::SettingsService;
use nivlo_application::today::TodayService;
use nivlo_application::trash::TrashService;
use nivlo_application::workflow::{WorkflowEngine, WorkflowService};
use nivlo_common::clock::SystemClock;
use nivlo_common::logging::{LogConfig, LogError, LogGuard, init_logging};
use nivlo_common::paths::{AppPaths, PathsError};
use nivlo_storage::{Database, FsAttachmentFiles};
use nivlo_workflow::WorkflowEngineAdapter;

use crate::app::{AppState, ApplicationServices, RuntimeHandles};

/// 启动过程中的致命错误。
#[derive(Debug, thiserror::Error)]
pub enum StartupError {
    /// 无法确定或创建数据目录。
    #[error("数据目录不可用")]
    Paths(#[from] PathsError),
    /// 日志系统初始化失败。
    #[error("日志系统初始化失败")]
    Logging(#[from] LogError),
    /// 数据库无法打开或 Migration 失败。
    #[error("数据库不可用")]
    Storage(#[from] StorageError),
}

/// 启动早期得到的环境：路径与日志。
pub struct Environment {
    /// 数据目录布局。
    pub paths: AppPaths,
    /// 日志守卫，需持有到退出。
    pub log_guard: LogGuard,
}

/// 解析并创建数据目录，然后初始化日志。
///
/// 日志必须先于数据库初始化，这样 Migration 失败时也有日志可查；
/// 开发构建同时输出到控制台。
///
/// # Errors
///
/// 路径无法解析 / 创建，或日志文件无法创建时返回 [`StartupError`]。
pub fn init_environment() -> Result<Environment, StartupError> {
    let paths = AppPaths::resolve_default()?;
    paths.ensure_dirs()?;
    let mut log_config = LogConfig::new(paths.logs_dir());
    log_config.console = cfg!(debug_assertions);
    let log_guard = init_logging(&log_config)?;
    tracing::info!(event = "startup_environment_ready", root = %paths.root().display(), "数据目录与日志已就绪");
    Ok(Environment { paths, log_guard })
}

/// 打开数据库并运行 Migration。
///
/// # Errors
///
/// 数据库无法打开返回 [`StorageError::Unavailable`]；Migration 失败返回
/// [`StorageError::Migration`]，此时调用方**不得**继续启动业务 Runtime，而应进入恢复流程。
/// Migration 失败时连接池会被关闭，避免恢复期间还有连接占用数据库文件（导出副本时需要）。
pub async fn open_database(paths: &AppPaths) -> Result<Database, StorageError> {
    let database = Database::open(&paths.database_file()).await?;
    if let Err(error) = database.migrate().await {
        database.close().await;
        return Err(error);
    }
    Ok(database)
}

/// 装配 Repository、Service 与运行时句柄，得到唯一的 [`AppState`]。
///
/// 这是 Composition Root：只有这里同时认识 Application 的 Port 与 Storage 的实现。
/// 测试传入 `None` 作为日志守卫（全局日志只能初始化一次）。
pub fn build_app_state(
    database: Database,
    attachments_dir: PathBuf,
    log_guard: Option<LogGuard>,
) -> AppState {
    let event_bus = EventBus::new();
    let clock = Arc::new(SystemClock::new());
    let items = ItemService::new(
        Arc::new(database.clone()),
        clock.clone(),
        Arc::new(event_bus.clone()),
    );
    let settings = SettingsService::new(Arc::new(database.clone()), clock.clone());
    let today = TodayService::new(
        Arc::new(database.clone()),
        clock.clone(),
        Arc::new(event_bus.clone()),
    );
    // 网络只通过 HttpPort：Workflow 声明了 hosts 才能访问，初始化失败时退回没有 http Step 的引擎。
    // 文件内容只通过 FileInspector：只读被拖入的那个文件，有大小上限。
    let http: Option<Arc<dyn nivlo_application::ports::http::HttpPort>> =
        match nivlo_integrations::ReqwestHttp::new() {
            Ok(http) => Some(Arc::new(http)),
            Err(error) => {
                tracing::warn!(event = "http_unavailable", %error, "网络组件初始化失败，http Step 不可用");
                None
            }
        };
    let engine: Arc<dyn WorkflowEngine> = Arc::new(WorkflowEngineAdapter::with_ports(
        http,
        Some(Arc::new(nivlo_capture::FsFileInspector)),
    ));
    // 网页标题等联网的补全在后台队列里做，捕获本身不等网络。
    let (enrichment_tx, enrichment_rx) = tokio::sync::mpsc::unbounded_channel();
    let capture = CaptureService::new(
        Arc::new(database.clone()),
        clock.clone(),
        Arc::new(event_bus.clone()),
        Arc::new(FsAttachmentFiles::new(attachments_dir.clone())),
    )
    .with_workflows(engine.clone())
    .with_enrichment(enrichment_tx);
    let workflows = WorkflowService::new(Arc::new(database.clone()), clock.clone(), engine);
    let inbox = InboxService::new(
        Arc::new(database.clone()),
        clock.clone(),
        Arc::new(event_bus.clone()),
    );
    let projects = ProjectService::new(Arc::new(database.clone()), clock.clone());
    let tags = TagService::new(
        Arc::new(database.clone()),
        clock.clone(),
        Arc::new(event_bus.clone()),
    );
    let trash = TrashService::new(
        Arc::new(database.clone()),
        clock.clone(),
        Arc::new(event_bus.clone()),
        Arc::new(FsAttachmentFiles::new(attachments_dir.clone())),
    );
    let calendar = CalendarService::new(Arc::new(database.clone()), clock.clone());
    let runtime = RuntimeHandles::new(event_bus, database, clock, log_guard);
    runtime.set_enrichment_queue(enrichment_rx);
    AppState {
        services: ApplicationServices {
            items,
            settings,
            today,
            capture,
            inbox,
            projects,
            tags,
            trash,
            calendar,
            workflows,
        },
        runtime,
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use sqlx::ConnectOptions;
    use sqlx::Connection;
    use sqlx::sqlite::SqliteConnectOptions;

    use super::*;

    #[tokio::test]
    async fn open_database_migrates_a_fresh_data_dir() {
        let dir = tempfile::tempdir().unwrap();
        let paths = AppPaths::from_root(dir.path().join("Nivlo"));
        paths.ensure_dirs().unwrap();
        let database = open_database(&paths).await.unwrap();
        assert_eq!(database.schema_version().await.unwrap(), Some(6));
    }

    #[tokio::test]
    async fn broken_migration_is_reported_and_leaves_the_file_unlocked() {
        let dir = tempfile::tempdir().unwrap();
        let paths = AppPaths::from_root(dir.path().join("Nivlo"));
        paths.ensure_dirs().unwrap();
        open_database(&paths).await.unwrap().close().await;

        // 模拟"已合入的 Migration 被改动"。
        let mut conn = SqliteConnectOptions::new()
            .filename(paths.database_file())
            .connect()
            .await
            .unwrap();
        sqlx::query("UPDATE _sqlx_migrations SET checksum = X'00'")
            .execute(&mut conn)
            .await
            .unwrap();
        conn.close().await.unwrap();

        let error = open_database(&paths).await.unwrap_err();
        assert!(matches!(error, StorageError::Migration(_)), "{error:?}");
        // 恢复流程需要复制数据库文件；连接池已关闭时文件必须可以被读取。
        assert!(std::fs::copy(paths.database_file(), dir.path().join("copy.db")).is_ok());
    }
}
