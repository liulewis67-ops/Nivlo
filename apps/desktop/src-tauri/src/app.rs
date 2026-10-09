//! 应用状态：`AppState { services, runtime }`（架构文档 §55）。
//!
//! `AppState` 是唯一注册到 Tauri 的 State；不使用全局可变静态变量。
//! 服务用 `Arc` 共享，长生命周期组件通过 Handle 访问。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use nivlo_application::event::EventBus;
use nivlo_application::item::ItemService;
use nivlo_application::settings::SettingsService;
use nivlo_common::logging::LogGuard;
use nivlo_storage::Database;
use tauri::async_runtime::JoinHandle;
use tokio_util::sync::CancellationToken;

use crate::windows::floating::MoveObserver;

/// Application 层的 Use Case 服务集合。
pub struct ApplicationServices {
    /// Item 的创建 / 更新 / 读取 / 列表。
    pub items: ItemService,
    /// 业务设置（窗口位置、置顶等）。
    pub settings: SettingsService,
}

/// 运行时句柄：事件总线、后台任务与需要在退出时释放的资源。
pub struct RuntimeHandles {
    /// 进程内领域事件总线。
    pub event_bus: EventBus,
    /// 数据库句柄，退出时关闭。
    database: Database,
    /// 取消令牌：退出时通知全部后台任务停止。
    shutdown: CancellationToken,
    /// 受管的后台任务；退出时逐个等待结束，不允许"发射后不管"（后端规范 §7）。
    tasks: Mutex<Vec<JoinHandle<()>>>,
    /// 日志守卫，必须最后释放，才能把退出过程中的日志也刷写到磁盘。
    log_guard: Mutex<Option<LogGuard>>,
    /// 是否已进入退出流程，避免重复执行。
    shutting_down: AtomicBool,
    /// 悬浮窗移动事件的观察者；窗口创建之后才能设置，因此用 `OnceLock`。
    move_observer: OnceLock<Arc<dyn MoveObserver>>,
}

impl RuntimeHandles {
    /// 创建运行时句柄。
    ///
    /// `log_guard` 在测试中为 `None`（全局日志只能初始化一次）。
    pub fn new(event_bus: EventBus, database: Database, log_guard: Option<LogGuard>) -> Self {
        Self {
            event_bus,
            database,
            shutdown: CancellationToken::new(),
            tasks: Mutex::new(Vec::new()),
            log_guard: Mutex::new(log_guard),
            shutting_down: AtomicBool::new(false),
            move_observer: OnceLock::new(),
        }
    }

    /// 设置悬浮窗移动事件的观察者；只能设置一次，重复设置被忽略。
    pub fn set_move_observer(&self, observer: Arc<dyn MoveObserver>) {
        // 只在启动时调用一次；再次设置属于编程错误，保留第一个即可，不值得 panic。
        let _ = self.move_observer.set(observer);
    }

    /// 悬浮窗移动事件的观察者；窗口尚未创建时为 `None`。
    pub fn move_observer(&self) -> Option<&Arc<dyn MoveObserver>> {
        self.move_observer.get()
    }

    /// 返回退出信号的令牌克隆，供后台任务在 `select!` 中监听。
    pub fn shutdown_token(&self) -> CancellationToken {
        self.shutdown.clone()
    }

    /// 登记一个后台任务，退出时会等待它结束。
    pub fn track_task(&self, handle: JoinHandle<()>) {
        self.tasks
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(handle);
    }

    /// 标记进入退出流程。
    ///
    /// # Returns
    ///
    /// 第一次调用返回 `true`（调用方应当执行 [`RuntimeHandles::shutdown`]），之后返回 `false`。
    pub fn begin_shutdown(&self) -> bool {
        !self.shutting_down.swap(true, Ordering::SeqCst)
    }

    /// 按架构文档 §41 的顺序有序退出，不调用 `process::exit()`。
    ///
    /// 1. 取消后台任务并等待它们结束（含"停止接收新的 Workflow"）；
    /// 2. 刷写关键写入——所有写入都在已提交事务中，这里无待刷数据；
    /// 3. 持久化窗口状态、停止 Scheduler——对应组件在 TODO 所列子阶段加入；
    /// 4. 关闭数据库（刷写 WAL）；
    /// 5. 最后释放日志守卫。
    pub async fn shutdown(&self) {
        tracing::info!(event = "shutdown_started", "开始退出流程");
        self.shutdown.cancel();

        let tasks = std::mem::take(
            &mut *self
                .tasks
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner),
        );
        for task in tasks {
            if let Err(error) = task.await {
                tracing::warn!(event = "task_join_failed", %error, "后台任务退出时出错");
            }
        }
        tracing::info!(event = "shutdown_tasks_stopped", "后台任务已停止");

        // TODO(P1.2): 持久化悬浮窗位置等窗口状态。
        // TODO(P4.4): 停止 Scheduler Actor。

        self.database.close().await;
        tracing::info!(event = "shutdown_database_closed", "数据库已关闭");

        tracing::info!(event = "shutdown_completed", "退出流程完成");
        // 释放日志守卫会刷写缓冲；此后不再有日志输出。
        self.log_guard
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
    }
}

/// 注册到 Tauri 的唯一应用状态。
pub struct AppState {
    /// Use Case 服务。
    pub services: ApplicationServices,
    /// 运行时句柄。
    pub runtime: RuntimeHandles,
}
