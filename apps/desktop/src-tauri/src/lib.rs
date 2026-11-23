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
pub mod backup;
pub mod clipboard;
pub mod commands;
mod context_create;
pub mod credentials;
pub mod diagnostics;
pub mod dto;
pub mod events;
pub mod integration_service;
pub mod lifecycle;
pub mod native_drop;
pub mod native_i18n;
pub mod open;
pub mod power;
pub mod scheduling;
pub mod script_grants;
pub mod shortcut;
pub mod source_app;
pub mod tab_drop;
pub mod tray;
pub mod updates;
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
                $crate::commands::item::search_items,
                $crate::commands::item::mark_item_opened,
                $crate::commands::item::get_item_detail,
                $crate::commands::item::update_item,
                $crate::commands::source::open_item_source::<$runtime>,
                $crate::commands::attachment::preview_item_attachment,
                $crate::commands::attachment::reveal_item_attachment::<$runtime>,
                $crate::commands::trash::delete_items,
                $crate::commands::trash::undo_created_item,
                $crate::commands::trash::restore_deleted_items,
                $crate::commands::trash::list_trash,
                $crate::commands::trash::purge_items,
                $crate::commands::diagnostics::export_diagnostics,
                $crate::commands::data::create_backup_file,
                $crate::commands::data::export_data,
                $crate::commands::data::restore_backup::<$runtime>,
                $crate::commands::data::reset_all_data,
                $crate::commands::data::restart_app::<$runtime>,
                $crate::commands::workflow::list_workflows,
                $crate::commands::workflow::set_workflow_enabled,
                $crate::commands::workflow::set_workflow_priority,
                $crate::commands::workflow::duplicate_workflow,
                $crate::commands::workflow::save_workflow,
                $crate::commands::workflow::delete_workflow,
                $crate::commands::workflow::dry_run_workflow,
                $crate::commands::workflow::list_workflow_runs,
                $crate::commands::workflow::rerun_workflow,
                $crate::commands::workflow::confirm_script_permissions,
                $crate::commands::workflow::export_workflow_file,
                $crate::commands::workflow::pick_workflow_import::<$runtime>,
                $crate::commands::workflow::import_workflow,
                $crate::commands::trash::empty_trash,
                $crate::commands::settings::get_app_settings::<$runtime>,
                $crate::commands::integration::list_integrations,
                $crate::commands::integration::connect_integration,
                $crate::commands::integration::disconnect_integration,
                $crate::commands::integration::test_integration,
                $crate::commands::update::check_for_update::<$runtime>,
                $crate::commands::update::install_update::<$runtime>,
                $crate::commands::settings::get_ui_pref::<$runtime>,
                $crate::commands::settings::set_ui_pref::<$runtime>,
                $crate::commands::skin::save_skin_asset,
                $crate::commands::skin::prune_skin_assets,
                $crate::commands::skin::get_skin_storage_usage,
                $crate::commands::skin::export_skin_pack,
                $crate::commands::skin::import_skin_pack::<$runtime>,
                $crate::commands::settings::set_autostart::<$runtime>,
                $crate::commands::settings::set_floating_always_on_top,
                $crate::commands::settings::set_search_prewarm::<$runtime>,
                $crate::commands::settings::set_later_rule,
                $crate::commands::calendar::get_calendar,
                $crate::commands::settings::set_week_start,
                $crate::commands::settings::set_onboarding_completed,
                $crate::commands::settings::set_notifications_paused::<$runtime>,
                $crate::commands::settings::set_reminder_flash_seconds,
                $crate::commands::settings::set_reminder_count,
                $crate::commands::organize::list_projects,
                $crate::commands::organize::create_project,
                $crate::commands::organize::rename_project,
                $crate::commands::organize::archive_project,
                $crate::commands::organize::unarchive_project,
                $crate::commands::organize::list_tags,
                $crate::commands::organize::tags_for_items,
                $crate::commands::organize::rename_tag,
                $crate::commands::organize::merge_tags,
                $crate::commands::organize::set_item_tags,
                $crate::commands::capture::capture,
                $crate::commands::capture::undo_capture,
                $crate::commands::capture::capture_from_clipboard,
                $crate::commands::capture::read_clipboard_text,
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
                $crate::commands::shortcut::set_shortcut::<$runtime>,
                $crate::commands::shortcut::suggest_shortcuts,
                $crate::commands::shortcut::disable_shortcut::<$runtime>,
                $crate::commands::window::open_main_at::<$runtime>,
                $crate::commands::window::take_pending_main_view,
                $crate::commands::window::quit_app::<$runtime>,
                $crate::commands::window::start_floating_drag::<$runtime>,
                $crate::commands::window::expand_floating,
                $crate::commands::window::collapse_floating,
                $crate::commands::window::get_reminder_attention_ms,
                $crate::commands::window::begin_floating_input,
                $crate::commands::window::end_floating_input,
                $crate::commands::window::open_item_in_main::<$runtime>,
                $crate::commands::window::hide_search::<$runtime>,
                $crate::commands::window::fit_search::<$runtime>,
            ])
            .events($crate::tauri_specta::collect_events![
                $crate::events::ItemCreatedEvent,
                $crate::events::ItemUpdatedEvent,
                $crate::events::FloatingPointerLeftEvent,
                $crate::events::ReminderAttentionEvent,
                $crate::events::TodayReorderedEvent,
                $crate::events::DayChangedEvent,
                $crate::events::MainViewRequestedEvent,
                $crate::events::QuickAddRequestedEvent,
                $crate::events::ContextCreateRequestedEvent,
                $crate::events::SearchWindowShownEvent
            ])
    };
}

/// 开了「预先准备全局搜索框」时，启动后等多久再创建它（让启动本身先完成）。
const SEARCH_PREWARM_DELAY: std::time::Duration = std::time::Duration::from_secs(10);

/// 后台补全最多同时做几件。
const ENRICH_CONCURRENCY: usize = 3;

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
        // 只读皮肤帧图协议：仅服务 `skins/assets/<sha256>.(webp|png)`，不暴露任意磁盘路径。
        .register_uri_scheme_protocol("nivlo-skin", |ctx, request| {
            serve_skin_asset(ctx.app_handle(), request.uri().path())
        })
        // 单实例插件必须最先注册：第二次启动只唤起已有进程的主窗口，然后立即退出。
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            // 点击通知会以 `nivlo://item/<ID>` 参数再启动一次程序：转给这里，打开对应的 Item。
            if windows::handle_activation(app, &args) {
                return;
            }
            if let Err(error) = windows::show_main_window(app) {
                tracing::warn!(event = "single_instance_show_failed", %error, "唤起主窗口失败");
            }
        }))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![autostart::AUTOSTART_ARG]),
        ))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(builder.invoke_handler())
        .on_window_event(windows::on_window_event)
        .setup(move |app| {
            builder.mount_events(app);

            // 阶段 1：路径与日志。失败时还没有日志，直接向上返回。
            let environment = startup::init_environment()?;

            // 阶段 1.5：如果上次选择了从备份恢复，趁数据库还没打开把数据换上
            // （当前数据整体挪到 replaced-<时间>/，不删除）。
            // 应用状态（以及它的 Clock）还没建好，这里直接用系统时钟，同样经过 Clock 接口。
            let stamp = {
                use nivlo_common::clock::{Clock, SystemClock};
                SystemClock::new()
                    .now_utc()
                    .format("%Y%m%d-%H%M%S")
                    .to_string()
            };
            // 「删除所有数据」同理：当前数据挪到 replaced-<时间>/，以空库启动。两者互斥（后选的取消先选的）。
            match backup::apply_pending_reset(&environment.paths, &stamp) {
                Ok(true) => tracing::info!(event = "reset_applied", "已清空数据（旧数据保留在 replaced- 目录）"),
                Ok(false) => {}
                Err(error) => {
                    tracing::error!(event = "reset_failed", %error, "清空数据失败，继续使用现有数据");
                }
            }
            match backup::apply_pending_restore(&environment.paths, &stamp) {
                Ok(true) => tracing::info!(event = "restore_applied", "已从备份恢复数据"),
                Ok(false) => {}
                Err(error) => {
                    tracing::error!(event = "restore_failed", %error, "应用备份恢复失败，继续使用现有数据");
                }
            }

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
            // 回收站里超过 30 天的条目自动永久清除：启动时一次，之后每 6 小时一次（常驻应用不会重启）。
            let trash = state.services.trash.clone();
            let shutdown = state.runtime.shutdown_token();
            let trash_purger = tauri::async_runtime::spawn(async move {
                loop {
                    match trash.purge_expired().await {
                        Ok(0) => {}
                        Ok(count) => {
                            tracing::info!(event = "trash_purged", count, "已清除过期的回收站条目");
                        }
                        Err(error) => {
                            tracing::warn!(event = "trash_purge_failed", %error, "清除过期的回收站条目失败");
                        }
                    }
                    tokio::select! {
                        () = shutdown.cancelled() => return,
                        () = tokio::time::sleep(std::time::Duration::from_secs(6 * 60 * 60)) => {}
                    }
                }
            });
            state.runtime.track_task(trash_purger);
            // 内置 Workflow 同步（升级时覆盖旧版本、保留用户的启用 / 优先级设置），再定期清理运行记录。
            let workflows = state.services.workflows.clone();
            let shutdown = state.runtime.shutdown_token();
            let workflow_maintainer = tauri::async_runtime::spawn(async move {
                if let Err(error) = workflows.sync_builtin(nivlo_workflow::builtin::builtin_workflows()).await {
                    tracing::warn!(event = "workflow_sync_failed", %error, "同步内置 Workflow 失败");
                }
                loop {
                    match workflows.prune_runs().await {
                        Ok(0) => {}
                        Ok(count) => {
                            tracing::info!(event = "workflow_runs_pruned", count, "已清理过期的 Workflow 运行记录");
                        }
                        Err(error) => {
                            tracing::warn!(event = "workflow_prune_failed", %error, "清理 Workflow 运行记录失败");
                        }
                    }
                    tokio::select! {
                        () = shutdown.cancelled() => return,
                        () = tokio::time::sleep(std::time::Duration::from_secs(6 * 60 * 60)) => {}
                    }
                }
            });
            state.runtime.track_task(workflow_maintainer);
            // 定期检查点：大量写入后让 WAL 文件回落（见 `Database::checkpoint`）。
            let database = state.runtime.database();
            let shutdown = state.runtime.shutdown_token();
            let wal_maintainer = tauri::async_runtime::spawn(async move {
                loop {
                    tokio::select! {
                        () = shutdown.cancelled() => return,
                        () = tokio::time::sleep(std::time::Duration::from_secs(20 * 60)) => {}
                    }
                    if let Err(error) = database.checkpoint().await {
                        tracing::warn!(event = "wal_checkpoint_failed", %error, "WAL 检查点失败");
                    }
                }
            });
            state.runtime.track_task(wal_maintainer);
            // 写入活动触发的检查点：每 100 个领域事件看一次 WAL 大小，超过 16 MiB 立刻截断
            // （大量捕获时界面持续在读，WAL 否则会一路涨到几百 MB）。事件驱动，没有定时器。
            let database = state.runtime.database();
            let shutdown = state.runtime.shutdown_token();
            let mut events = state.runtime.event_bus.subscribe();
            let wal_guard = tauri::async_runtime::spawn(async move {
                let mut seen = 0_u32;
                loop {
                    tokio::select! {
                        () = shutdown.cancelled() => return,
                        received = events.recv() => {
                            if matches!(received, Err(tokio::sync::broadcast::error::RecvError::Closed)) {
                                return;
                            }
                            seen += 1;
                            if seen >= 100 {
                                seen = 0;
                                match database.checkpoint_if_wal_exceeds(16 * 1024 * 1024).await {
                                    Ok(true) => tracing::info!(event = "wal_truncated", "WAL 超过阈值，已截断"),
                                    Ok(false) => {}
                                    Err(error) => tracing::warn!(event = "wal_checkpoint_failed", %error, "WAL 检查点失败"),
                                }
                            }
                        }
                    }
                }
            });
            state.runtime.track_task(wal_guard);
            // 联网的补全（网页标题与摘要）：最多同时做 ENRICH_CONCURRENCY 件——一个慢网站不会让
            // 后面拖进来的链接都排队等它的超时；退出时随令牌结束（未完成的任务随 JoinSet 一起取消）。
            if let Some(mut queue) = state.runtime.take_enrichment_queue() {
                let capture = state.services.capture.clone();
                let shutdown = state.runtime.shutdown_token();
                let enricher = tauri::async_runtime::spawn(async move {
                    let mut running = tokio::task::JoinSet::new();
                    loop {
                        if running.len() >= ENRICH_CONCURRENCY {
                            tokio::select! {
                                () = shutdown.cancelled() => return,
                                _ = running.join_next() => {}
                            }
                            continue;
                        }
                        tokio::select! {
                            () = shutdown.cancelled() => return,
                            job = queue.recv() => match job {
                                Some(job) => {
                                    let capture = capture.clone();
                                    running.spawn(async move {
                                        let updated = capture.enrich(job).await;
                                        tracing::debug!(event = "capture_enriched", updated, "后台补全完成");
                                    });
                                }
                                None => break,
                            },
                            Some(_) = running.join_next(), if !running.is_empty() => {}
                        }
                    }
                    // 队列关闭：做完手上的。
                    while running.join_next().await.is_some() {}
                });
                state.runtime.track_task(enricher);
            }
            state.runtime.set_paths(environment.paths.clone());
            app.manage(state);
            app.manage(scheduling::ReminderAttention::default());

            let floating = windows::create_floating_window(app)?;
            // 拖入文件的磁盘路径：WebView2 把 File 对象的路径交给宿主（实施计划 10.1）。
            #[cfg(target_os = "windows")]
            native_drop::install(app.handle(), &floating);
            // 浏览器标签页拖到悬浮窗上：不是系统拖放，改为识别窗口移动结束的位置。
            #[cfg(target_os = "windows")]
            tab_drop::install(&floating);
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
            // 每个动作一个独立的系统注册：一个被占用不影响另一个。
            app.manage(windows::search::SearchWindowState::default());
            for action in shortcut::ShortcutAction::ALL {
                let handle = app.handle().clone();
                let on_pressed: nivlo_platform::shortcut::ShortcutCallback = match action {
                    shortcut::ShortcutAction::QuickCreate => {
                        Arc::new(move || tray::request_quick_add(&handle))
                    }
                    shortcut::ShortcutAction::ContextCreate => {
                        Arc::new(move || context_create::request(&handle))
                    }
                    // 回调在快捷键的消息线程上，必须立刻返回；第一次要创建窗口（会阻塞），放到后台线程。
                    shortcut::ShortcutAction::Search => Arc::new(move || {
                        let handle = handle.clone();
                        drop(tauri::async_runtime::spawn_blocking(move || {
                            windows::search::toggle(&handle);
                        }));
                    }),
                };
                let controller = Arc::new(shortcut::ShortcutController::new(
                    action,
                    shortcut::platform_port(),
                    app.state::<AppState>().services.settings.clone(),
                    on_pressed,
                ));
                tauri::async_runtime::block_on(controller.start());
                app.state::<AppState>().runtime.set_shortcut(controller);
            }

            // Scheduler：提醒 / Tip / 截止的触发与唤醒后的 Reconcile；通知是尽力而为的，不影响启动。
            scheduling::spawn(app.handle(), &app.state::<AppState>());
            // 系统休眠恢复 / 时间被改动：立刻唤醒 Scheduler 去 Reconcile（偏差检测仍作为兜底）。
            power::start(app.handle());
            // 冷启动时就带着通知激活参数（应用没在运行时点击了通知）。
            let launch_args: Vec<String> = std::env::args().skip(1).collect();
            windows::handle_activation(app.handle(), &launch_args);

            // 托盘不是必需功能：创建失败只记录，应用继续以悬浮窗运行。
            let lang = tauri::async_runtime::block_on(native_i18n::current(
                &app.state::<AppState>().services.settings,
            ));
            if let Err(error) = tray::setup(app.handle(), lang) {
                tracing::warn!(event = "tray_setup_failed", %error, "创建托盘失败");
            }
            // 用户开了「预先准备全局搜索框」：启动完成、空闲下来之后（10 秒，一次性）在后台创建，
            // 不拖慢启动。
            {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let enabled = handle
                        .state::<AppState>()
                        .services
                        .settings
                        .get(nivlo_application::settings::keys::SEARCH_PREWARM)
                        .await
                        .ok()
                        .flatten()
                        .is_some_and(|value| value == "true");
                    if !enabled {
                        return;
                    }
                    tokio::time::sleep(SEARCH_PREWARM_DELAY).await;
                    drop(tauri::async_runtime::spawn_blocking(move || {
                        windows::search::prewarm(&handle);
                    }));
                });
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

/// 构造一个空体 HTTP 响应（供 `nivlo-skin://` 协议错误分支使用）。
fn empty_protocol_response(status: u16) -> tauri::http::Response<Vec<u8>> {
    tauri::http::Response::builder()
        .status(status)
        .body(Vec::new())
        .unwrap_or_else(|_| tauri::http::Response::new(Vec::new()))
}

/// 为 `nivlo-skin://localhost/<sha256>.(webp|png)` 提供只读文件响应。
fn serve_skin_asset<R: tauri::Runtime>(
    handle: &tauri::AppHandle<R>,
    raw_path: &str,
) -> tauri::http::Response<Vec<u8>> {
    let file_name = raw_path.trim_start_matches('/');
    if !nivlo_storage::is_valid_skin_asset_file_name(file_name) {
        return empty_protocol_response(400);
    }
    let Some((_, ext)) = file_name.split_once('.') else {
        return empty_protocol_response(400);
    };
    let Some(format) = nivlo_application::ports::SkinAssetFormat::from_extension(ext) else {
        return empty_protocol_response(400);
    };
    let Some(state) = handle.try_state::<AppState>() else {
        return empty_protocol_response(503);
    };
    let Some(paths) = state.runtime.paths() else {
        return empty_protocol_response(503);
    };
    let path = paths.skins_assets_dir().join(file_name);
    match std::fs::read(&path) {
        Ok(bytes) => tauri::http::Response::builder()
            .status(200)
            .header("Content-Type", format.mime_type())
            .header("Cache-Control", "public, max-age=31536000, immutable")
            .header("Access-Control-Allow-Origin", "*")
            .body(bytes)
            .unwrap_or_else(|_| empty_protocol_response(500)),
        Err(_) => empty_protocol_response(404),
    }
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
