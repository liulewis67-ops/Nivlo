//! 应用状态：`AppState { services, runtime }`（架构文档 §55）。
//!
//! `AppState` 是唯一注册到 Tauri 的 State；不使用全局可变静态变量。
//! 服务用 `Arc` 共享，长生命周期组件通过 Handle 访问。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use nivlo_application::calendar::CalendarService;
use nivlo_application::capture::CaptureService;
use nivlo_application::event::EventBus;
use nivlo_application::export::ExportService;
use nivlo_application::inbox::InboxService;
use nivlo_application::item::ItemService;
use nivlo_application::organize::{ProjectService, TagService};
use nivlo_application::settings::SettingsService;
use nivlo_application::today::TodayService;
use nivlo_application::trash::TrashService;
use nivlo_application::workflow::WorkflowService;
use nivlo_common::clock::Clock;
use nivlo_common::logging::LogGuard;
use nivlo_storage::Database;
use tauri::async_runtime::JoinHandle;
use tokio_util::sync::CancellationToken;

use crate::shortcut::{ShortcutAction, ShortcutController};
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
    /// 项目（创建 / 重命名 / 归档 / 列表）。
    pub projects: ProjectService,
    /// 标签（列表 / 重命名 / 合并 / 设置到 Item 上）。
    pub tags: TagService,
    /// 删除与回收站（恢复、永久清除、30 天自动清除）。
    pub trash: TrashService,
    /// Calendar 查询。
    pub calendar: CalendarService,
    /// Workflow 管理（列表 / 编辑 / 试运行 / 运行记录）。
    pub workflows: WorkflowService,
    /// 数据导出（JSON / Markdown）。
    pub export: ExportService,
    /// 第三方集成的连接管理（凭据只在系统凭据库里）。
    pub integrations: crate::integration_service::IntegrationService,
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
    /// Scheduler 的外部控制（唤醒、暂停通知）。
    scheduler_control: Arc<nivlo_scheduler::Control>,
    /// Quick Create 的全局快捷键控制器；窗口创建之后才能构造（回调要用 `AppHandle`），因此用 `OnceLock`。
    shortcut: OnceLock<Arc<ShortcutController>>,
    /// 全局搜索的快捷键控制器。
    search_shortcut: OnceLock<Arc<ShortcutController>>,
    /// 从选区或剪贴板新建的快捷键控制器。
    context_create_shortcut: OnceLock<Arc<ShortcutController>>,
    /// 应用目录布局；启动时登记，导出诊断包 / 备份时使用。
    paths: OnceLock<nivlo_common::paths::AppPaths>,
    /// 需要和应用同寿命的系统监听器（电源事件窗口等）；退出时一并释放。
    keep_alive: Mutex<Vec<Box<dyn std::any::Any + Send>>>,
    /// Script Worker（QuickJS 沙箱线程）；退出时停止并等待线程结束。
    script_worker: OnceLock<nivlo_script::ScriptWorker>,
    /// 后台补全队列的接收端：由启动流程取走并交给后台任务（只能取一次）。
    enrichment_queue: Mutex<
        Option<tokio::sync::mpsc::UnboundedReceiver<nivlo_application::capture::EnrichmentJob>>,
    >,
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
            shortcut: OnceLock::new(),
            search_shortcut: OnceLock::new(),
            context_create_shortcut: OnceLock::new(),
            enrichment_queue: Mutex::new(None),
            paths: OnceLock::new(),
            script_worker: OnceLock::new(),
            keep_alive: Mutex::new(Vec::new()),
            scheduler_control: Arc::new(nivlo_scheduler::Control::new()),
        }
    }

    /// 让一个系统监听器活到应用退出（释放它会停止监听）。
    pub fn keep_alive(&self, item: Box<dyn std::any::Any + Send>) {
        self.keep_alive
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(item);
    }

    /// 登记 Script Worker（只能登记一次），返回给 Executor 用的句柄。
    pub fn set_script_worker(
        &self,
        worker: nivlo_script::ScriptWorker,
    ) -> nivlo_script::ScriptHandle {
        let handle = worker.handle();
        let _ = self.script_worker.set(worker);
        handle
    }

    /// 登记应用目录布局（只能登记一次）。
    pub fn set_paths(&self, paths: nivlo_common::paths::AppPaths) {
        let _ = self.paths.set(paths);
    }

    /// 应用目录布局；启动完成之前为 `None`。
    pub fn paths(&self) -> Option<&nivlo_common::paths::AppPaths> {
        self.paths.get()
    }

    /// 登记后台补全队列的接收端。
    pub fn set_enrichment_queue(
        &self,
        queue: tokio::sync::mpsc::UnboundedReceiver<nivlo_application::capture::EnrichmentJob>,
    ) {
        *self
            .enrichment_queue
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(queue);
    }

    /// 取走后台补全队列的接收端（只能取一次）。
    pub fn take_enrichment_queue(
        &self,
    ) -> Option<tokio::sync::mpsc::UnboundedReceiver<nivlo_application::capture::EnrichmentJob>>
    {
        self.enrichment_queue
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take()
    }

    /// Scheduler 的外部控制句柄。
    pub fn scheduler_control(&self) -> Arc<nivlo_scheduler::Control> {
        self.scheduler_control.clone()
    }

    /// 数据库句柄的克隆（Scheduler 用它开启事务）。
    pub fn database(&self) -> Database {
        self.database.clone()
    }

    /// 登记一个动作的全局快捷键控制器；每个动作只能设置一次，重复设置被忽略。
    pub fn set_shortcut(&self, controller: Arc<ShortcutController>) {
        let _ = self.shortcut_slot(controller.action()).set(controller);
    }

    /// 一个动作的全局快捷键控制器；启动完成之前为 `None`。
    pub fn shortcut(&self, action: ShortcutAction) -> Option<Arc<ShortcutController>> {
        self.shortcut_slot(action).get().cloned()
    }

    /// 动作对应的存放位置。
    fn shortcut_slot(&self, action: ShortcutAction) -> &OnceLock<Arc<ShortcutController>> {
        match action {
            ShortcutAction::QuickCreate => &self.shortcut,
            ShortcutAction::Search => &self.search_shortcut,
            ShortcutAction::ContextCreate => &self.context_create_shortcut,
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
    /// 3. 持久化窗口状态（Scheduler 是受跟踪的任务，已在第 1 步随取消信号停止）；
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

        // 先取消全局快捷键：退出过程中不应再被它唤起 Quick Create / 搜索。
        for shortcut in ShortcutAction::ALL
            .map(|action| self.shortcut_slot(action).get())
            .into_iter()
            .flatten()
        {
            shortcut.stop();
        }

        // 持久化窗口状态：用户刚拖完就退出时，防抖定时器可能还没来得及保存。
        if let Some(floating) = self.floating.get() {
            floating.flush().await;
            tracing::info!(event = "shutdown_window_state_saved", "窗口状态已保存");
        }
        if let Some(worker) = self.script_worker.get() {
            worker.shutdown();
        }
        // 停止系统监听器（电源事件窗口与线程）。
        self.keep_alive
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clear();

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
