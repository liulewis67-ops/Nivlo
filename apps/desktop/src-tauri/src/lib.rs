//! `nivlo-desktop`：Tauri 桌面宿主，也是 Composition Root。
//!
//! 本 crate 只做装配与适配：
//!
//! * [`lifecycle`]：启动顺序、Migration 失败的恢复对话框、退出流程。
//! * [`commands`]：薄层 IPC Command（参数解析 → Application → 错误映射 → DTO）。
//! * [`dto`]：IPC 的 DTO，由 `tauri-specta` 生成 TypeScript Binding。
//! * [`events`]：领域事件到前端事件的映射与转发。
//! * [`app::AppState`]：唯一注册到 Tauri 的状态。
//!
//! 业务规则不在这里实现，都在 `nivlo-domain` / `nivlo-application`。

pub mod app;
pub mod autostart;
pub mod clipboard;
pub mod commands;
pub mod dto;
pub mod events;
pub mod lifecycle;
pub mod open;
pub mod shortcut;
pub mod tray;
pub mod windows;

use std::error::Error;
use std::sync::Arc;

use tauri::{Manager, RunEvent, Wry};
use tauri_specta::Event;

use nivlo_application::day_change::run_day_change_watcher;

use crate::app::AppState;
use crate::events::FloatingPointerLeftEvent;
use crate::events::forwarder::spawn_forwarder;
use crate::events::mapper::DefaultUiEventMapper;
use crate::lifecycle::{recovery, startup};
use crate::windows::floating::FloatingController;
use crate::windows::floating_port::TauriFloatingWindow;

/// 重新导出 `tauri_specta`，供 [`bindings_builder!`] 在其他 crate（测试、example）中展开时使用。
#[doc(hidden)]
pub use tauri_specta;

/// 构建 `tauri-specta` Builder：登记所有 Command 与事件，供运行时注册与 Binding 生成共用。
///
/// 做成宏而不是泛型函数，是因为 `collect_commands!` 内部生成的函数无法使用外层函数的泛型参数；
/// 宏把运行时类型 `$runtime` 直接展开进每个 Command 的类型实参：生产使用 `tauri::Wry`，
/// 测试使用 `tauri::test::MockRuntime`。
///
/// 新增 Command 后必须同时：加入此处、`build.rs` 的 `COMMANDS`、对应窗口的 Capability，
/// 并执行 `pnpm gen:bindings`。
#[macro_export]
macro_rules! bindings_builder {
    ($runtime:ty) => {
        $crate::tauri_specta::Builder::<$runtime>::new()
            .commands($crate::tauri_specta::collect_commands![
                $crate::commands::item::create_item,
                $crate::commands::item::get_item,
                $crate::commands::item::list_items,
                $crate::commands::item::get_item_detail,
                $crate::commands::item::update_item,
                $crate::commands::source::open_item_source::<$runtime>,
                $crate::commands::organize::list_projects,
                $crate::commands::organize::create_project,
                $crate::commands::organize::rename_project,
                $crate::commands::organize::archive_project,
                $crate::commands::organize::unarchive_project,
                $crate::commands::organize::list_tags,
                $crate::commands::organize::rename_tag,
                $crate::commands::organize::merge_tags,
                $crate::commands::organize::set_item_tags,
                $crate::commands::capture::capture,
                $crate::commands::capture::undo_capture,
                $crate::commands::capture::capture_from_clipboard,
                $crate::commands::inbox::list_inbox,
                $crate::commands::inbox::get_inbox_count,
                $crate::commands::inbox::organize_items,
                $crate::commands::inbox::restore_items,
                $crate::commands::item::quick_create,
                $crate::commands::item::complete_item,
                $crate::commands::item::reopen_item,
                $crate::commands::item::reschedule_item,
                $crate::commands::today::get_today,
                $crate::commands::today::reorder_today,
                $crate::commands::window::open_main::<$runtime>,
                $crate::commands::shortcut::get_shortcut_status,
                $crate::commands::shortcut::set_quick_create_shortcut,
                $crate::commands::window::open_main_at::<$runtime>,
                $crate::commands::window::take_pending_main_view,
                $crate::commands::window::quit_app::<$runtime>,
                $crate::commands::window::start_floating_drag::<$runtime>,
                $crate::commands::window::expand_floating,
                $crate::commands::window::collapse_floating,
                $crate::commands::window::begin_floating_input,
                $crate::commands::window::end_floating_input,
            ])
            .events($crate::tauri_specta::collect_events![
                $crate::events::ItemCreatedEvent,
                $crate::events::ItemUpdatedEvent,
                $crate::events::FloatingPointerLeftEvent,
                $crate::events::TodayReorderedEvent,
                $crate::events::DayChangedEvent,
                $crate::events::MainViewRequestedEvent,
                $crate::events::QuickAddRequestedEvent
            ])
    };
}

/// 运行桌面应用，直到退出。
///
/// 启动顺序见 [`lifecycle`]。数据库 Migration 失败时显示恢复对话框并返回错误，
/// 不会启动任何业务窗口或后台任务。
///
/// # Errors
///
/// 启动失败（数据目录、日志、数据库、窗口创建）或 Tauri 运行时出错时返回错误。
pub fn run() -> Result<(), Box<dyn Error>> {
    let builder = bindings_builder!(Wry);

    let app = tauri::Builder::default()
        // 单实例插件必须最先注册：第二次启动只唤起已有进程的主窗口，然后立即退出。
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Err(error) = windows::show_main_window(app) {
                tracing::warn!(event = "single_instance_show_failed", %error, "唤起主窗口失败");
            }
        }))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![autostart::AUTOSTART_ARG]),
        ))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(builder.invoke_handler())
        .on_window_event(windows::on_window_event)
        .setup(move |app| {
            builder.mount_events(app);

            // 阶段 1：路径与日志。失败时还没有日志，直接向上返回。
            let environment = startup::init_environment()?;

            // 阶段 2：打开数据库并迁移。失败时进入恢复流程，不启动业务 Runtime。
            let database = match tauri::async_runtime::block_on(startup::open_database(&environment.paths))
            {
                Ok(database) => database,
                Err(error) => {
                    tracing::error!(event = "startup_database_failed", %error, "数据库启动失败，进入恢复流程");
                    recovery::run_recovery_dialog(app.handle(), &environment.paths, &error);
                    return Err(startup::StartupError::Storage(error).into());
                }
            };

            // 阶段 3：装配服务与运行时，启动后台任务，最后才创建窗口。
            let state = startup::build_app_state(
                database,
                environment.paths.attachments_dir(),
                Some(environment.log_guard),
            );
            let forwarder = spawn_forwarder(
                app.handle().clone(),
                &state.runtime.event_bus,
                Arc::new(DefaultUiEventMapper),
                state.runtime.shutdown_token(),
            );
            state.runtime.track_task(forwarder);
            // 本地日期切换监视器：睡到下一个本地午夜再醒来，不轮询；退出时随令牌结束。
            let shutdown = state.runtime.shutdown_token();
            let day_watcher = tauri::async_runtime::spawn(run_day_change_watcher(
                state.runtime.clock.clone(),
                Arc::new(state.runtime.event_bus.clone()),
                async move { shutdown.cancelled().await },
            ));
            state.runtime.track_task(day_watcher);
            app.manage(state);

            let floating = windows::create_floating_window(app)?;
            let foreground = windows::foreground_port(&floating);
            let controller = FloatingController::new(
                Arc::new(TauriFloatingWindow::new(floating)),
                app.state::<AppState>().services.settings.clone(),
                tauri::async_runtime::handle().inner().clone(),
                app.state::<AppState>().runtime.shutdown_token(),
                {
                    let handle = app.handle().clone();
                    Arc::new(move || {
                        // 只通知悬浮窗自己；发送失败（窗口正在销毁）可以忽略，下次展开会重新兜底。
                        let event = FloatingPointerLeftEvent {};
                        if let Err(error) = event.emit_to(&handle, windows::FLOATING_WINDOW_LABEL) {
                            tracing::warn!(
                                event = "floating_pointer_left_emit_failed",
                                %error,
                                "发送指针离开事件失败"
                            );
                        }
                    })
                },
                foreground,
            );
            // 先还原位置再开始观察移动事件，避免把"还原"本身当成用户拖动。
            tauri::async_runtime::block_on(controller.restore());
            app.state::<AppState>().runtime.set_floating(controller);

            // 全局快捷键不是必需功能：注册失败（被占用）只记录并在界面提示，应用照常运行。
            {
                let handle = app.handle().clone();
                let controller = Arc::new(shortcut::ShortcutController::new(
                    shortcut::platform_port(),
                    app.state::<AppState>().services.settings.clone(),
                    Arc::new(move || tray::request_quick_add(&handle)),
                ));
                tauri::async_runtime::block_on(controller.start());
                app.state::<AppState>().runtime.set_shortcut(controller);
            }

            // 托盘不是必需功能：创建失败只记录，应用继续以悬浮窗运行。
            if let Err(error) = tray::setup(app.handle()) {
                tracing::warn!(event = "tray_setup_failed", %error, "创建托盘失败");
            }
            // 首次运行询问一次是否开机自启（默认关闭）。
            tauri::async_runtime::spawn(autostart::prompt_once(
                app.handle().clone(),
                app.state::<AppState>().services.settings.clone(),
            ));
            tracing::info!(event = "startup_completed", "启动完成");
            Ok(())
        })
        .build(tauri::generate_context!())?;

    app.run(|handle, event| {
        if let RunEvent::ExitRequested { api, .. } = event {
            on_exit_requested(handle, &api);
        }
    });
    Ok(())
}

/// 处理退出请求：第一次拦截并异步执行有序退出，完成后再真正退出。
///
/// 退出流程是异步的（要等后台任务、关闭数据库），所以不能让 Tauri 立即退出；
/// 流程结束后再次调用 `exit`，此时 `begin_shutdown` 返回 `false`，放行退出。
fn on_exit_requested(handle: &tauri::AppHandle<Wry>, api: &tauri::ExitRequestApi) {
    // 启动失败时没有 AppState，直接允许退出。
    let Some(state) = handle.try_state::<AppState>() else {
        return;
    };
    if !state.runtime.begin_shutdown() {
        return;
    }
    api.prevent_exit();
    let handle = handle.clone();
    tauri::async_runtime::spawn(async move {
        if let Some(state) = handle.try_state::<AppState>() {
            state.runtime.shutdown().await;
        }
        handle.exit(0);
    });
}
