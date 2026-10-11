//! Scheduler 的宿主装配：系统通知适配器、后台任务、「暂停通知」状态（实施计划 4.4–4.6）。

use std::sync::Arc;

use nivlo_application::settings::keys;
use nivlo_domain::event::DomainEvent;
use nivlo_platform::error::PlatformError;
use nivlo_platform::notification::{Notification, NotificationPort};
use nivlo_scheduler::Scheduler;
use tauri::menu::CheckMenuItem;
use tauri::{AppHandle, Manager, Wry};
use tauri_plugin_notification::NotificationExt;

use crate::app::AppState;

/// Tauri 通知插件的适配器：通知带应用名与图标（由 Tauri 的应用标识提供）。
pub struct TauriNotifier {
    /// 应用句柄。
    app: AppHandle<Wry>,
}

impl TauriNotifier {
    /// 创建适配器。
    pub fn new(app: AppHandle<Wry>) -> Self {
        Self { app }
    }
}

impl NotificationPort for TauriNotifier {
    /// 发送一条系统通知。
    fn notify(&self, notification: &Notification) -> Result<(), PlatformError> {
        self.app
            .notification()
            .builder()
            .title(&notification.title)
            .body(&notification.body)
            .show()
            .map_err(|error| PlatformError::Failed(error.to_string()))
    }
}

/// 托盘里「暂停通知」勾选项的句柄，设置页修改状态时用它同步托盘。
pub struct PauseMenuItem(pub CheckMenuItem<Wry>);

/// 这个领域事件是否可能改变触发点（需要 Scheduler 重新计算）。
fn affects_triggers(event: &DomainEvent) -> bool {
    matches!(
        event,
        DomainEvent::ItemCreated { .. }
            | DomainEvent::ItemUpdated { .. }
            | DomainEvent::ItemTypeChanged { .. }
            | DomainEvent::ItemCompleted { .. }
            | DomainEvent::ItemReopened { .. }
            | DomainEvent::ItemArchived { .. }
            | DomainEvent::ItemUnarchived { .. }
            | DomainEvent::ScheduleChanged { .. }
            | DomainEvent::ItemDeleted { .. }
            | DomainEvent::DayChanged { .. }
    )
}

/// 启动 Scheduler 与「Schedule 变化 → 唤醒」的监听任务；退出时随取消令牌结束。
///
/// 读取上次保存的「暂停通知」状态：暂停期间到点的提醒不会丢，恢复后汇总通知。
pub fn spawn(app: &AppHandle<Wry>, state: &AppState) {
    let control = state.runtime.scheduler_control();
    let settings = state.services.settings.clone();
    let paused_before = tauri::async_runtime::block_on(settings.get(keys::NOTIFICATIONS_PAUSED))
        .ok()
        .flatten()
        .is_some_and(|value| value == "true");
    control.set_paused(paused_before);

    let scheduler = Arc::new(Scheduler::new(
        Arc::new(state.runtime.database()),
        state.runtime.clock.clone(),
        Arc::new(TauriNotifier::new(app.clone())),
        control.clone(),
    ));
    let shutdown = state.runtime.shutdown_token();
    let runner = {
        let shutdown = shutdown.clone();
        tauri::async_runtime::spawn(async move {
            scheduler
                .run(async move { shutdown.cancelled().await })
                .await;
        })
    };
    state.runtime.track_task(runner);

    // Schedule 相关的变化立即唤醒 Scheduler 重新计算最近的触发点。
    let mut events = state.runtime.event_bus.subscribe();
    let waker = tauri::async_runtime::spawn(async move {
        loop {
            tokio::select! {
                () = shutdown.cancelled() => return,
                received = events.recv() => match received {
                    Ok(event) if affects_triggers(&event) => control.wake(),
                    Ok(_) => {}
                    // 落后了就保守地重新计算一次。
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => control.wake(),
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => return,
                },
            }
        }
    });
    state.runtime.track_task(waker);
}

/// 暂停 / 恢复通知：更新 Scheduler、保存设置、同步托盘勾选状态。
///
/// # Errors
///
/// 保存设置失败时返回应用错误；此时 Scheduler 与托盘保持修改之前的状态。
pub async fn set_paused<R: tauri::Runtime>(
    app: &AppHandle<R>,
    state: &AppState,
    paused: bool,
) -> Result<(), nivlo_application::error::AppError> {
    state
        .services
        .settings
        .set(
            keys::NOTIFICATIONS_PAUSED,
            if paused { "true" } else { "false" },
        )
        .await?;
    state.runtime.scheduler_control().set_paused(paused);
    if let Some(item) = app.try_state::<PauseMenuItem>()
        && let Err(error) = item.0.set_checked(paused)
    {
        tracing::warn!(event = "tray_pause_sync_failed", %error, "同步托盘的暂停通知状态失败");
    }
    Ok(())
}
