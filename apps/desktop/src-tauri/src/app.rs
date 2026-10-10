//! 应用状态：`AppState { services, runtime }`（架构文档 §55）。
//!
//! `AppState` 是唯一注册到 Tauri 的 State；不使用全局可变静态变量。
//! 服务用 `Arc` 共享，长生命周期组件通过 Handle 访问。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use nivlo_application::capture::CaptureService;
use nivlo_application::event::EventBus;
use nivlo_application::inbox::InboxService;
use nivlo_application::item::ItemService;
use nivlo_application::settings::SettingsService;
use nivlo_application::today::TodayService;
use nivlo_common::clock::Clock;
use nivlo_common::logging::LogGuard;
use nivlo_storage::Database;
use tauri::async_runtime::JoinHandle;
use tokio_util::sync::CancellationToken;

use crate::windows::floating::FloatingHandle;

/// Application 层的 Use Case 服务集合。
pub struct ApplicationServices {
    /// Item 的创建 / 更新 / 读取 / 列表。
    pub items: ItemService,
    /// 业务设置（窗口位置、置顶等）。
    pub settings: SettingsService,
    /// Today 视图的查询。
    pub today: TodayService,
    /// 捕获（拖放 / 粘贴 / 快捷键 → Inbox）。
    pub capture: CaptureService,
    /// Inbox（列表与批量整理）。
    pub inbox: InboxService,
}

/// 运行时句柄：事件总线、后台任务与需要在退出时释放的资源。
pub struct RuntimeHandles {
    /// 进程内领域事件总线。
    pub event_bus: EventBus,
    /// 全应用共享的时钟（后台任务如日期切换监视器需要它）。
    pub clock: Arc<dyn Clock>,
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
    /// 悬浮窗的行为句柄；窗口创建之后才能设置，因此用 `OnceLock`。
    floating: OnceLock<Arc<dyn FloatingHandle>>,
    /// 悬浮窗请求主窗口打开的视图。主窗口可能还没创建 / 还没开始监听事件，所以先存在这里，
    /// 由主窗口启动时取走（事件只负责通知已经在运行的主窗口）。
    pending_main_view: Mutex<Option<String>>,
}

impl RuntimeHandles {
    /// 创建运行时句柄。
    ///
    /// `log_guard` 在测试中为 `None`（全局日志只能初始化一次）。
    pub fn new(
        event_bus: EventBus,
        database: Database,
        clock: Arc<dyn Clock>,
        log_guard: Option<LogGuard>,
    ) -> Self {
        Self {
            event_bus,
            clock,
            database,
            shutdown: CancellationToken::new(),
            tasks: Mutex::new(Vec::new()),
            log_guard: Mutex::new(log_guard),
            shutting_down: AtomicBool::new(false),
            floating: OnceLock::new(),
            pending_main_view: Mutex::new(None),
        }
    }

    /// 记录主窗口应当打开的视图。
    pub fn set_pending_main_view(&self, view: String) {
        if let Ok(mut pending) = self.pending_main_view.lock() {
            *pending = Some(view);
        }
    }

    /// 取走（并清除）主窗口应当打开的视图。
    pub fn take_pending_main_view(&self) -> Option<String> {
        self.pending_main_view
            .lock()
            .ok()
            .and_then(|mut pending| pending.take())
    }

    /// 设置悬浮窗的行为句柄；只能设置一次，重复设置被忽略。
    pub fn set_floating(&self, handle: Arc<dyn FloatingHandle>) {
        // 只在启动时调用一次；再次设置属于编程错误，保留第一个即可，不值得 panic。
        let _ = self.floating.set(handle);
    }

    /// 悬浮窗的行为句柄；窗口尚未创建时为 `None`。
    pub fn floating(&self) -> Option<&Arc<dyn FloatingHandle>> {
        self.floating.get()
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
    /// 3. 持久化窗口状态；停止 Scheduler 在 Phase 4（见下方 TODO）加入；
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

        // 持久化窗口状态：用户刚拖完就退出时，防抖定时器可能还没来得及保存。
        if let Some(floating) = self.floating.get() {
            floating.flush().await;
            tracing::info!(event = "shutdown_window_state_saved", "窗口状态已保存");
        }
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
