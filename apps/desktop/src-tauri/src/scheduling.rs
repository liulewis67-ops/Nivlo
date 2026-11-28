//! Scheduler 的宿主装配：系统通知适配器、后台任务、「暂停通知」状态（实施计划 4.4–4.6）。

use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use asterjot_application::settings::keys;
use asterjot_domain::event::DomainEvent;
use asterjot_platform::error::PlatformError;
use asterjot_platform::notification::{Notification, NotificationPort};
use asterjot_scheduler::{Scheduler, service::MAX_REMINDER_COUNT};
use tauri::menu::CheckMenuItem;
use tauri::{AppHandle, Manager, Wry};
use tauri_plugin_notification::NotificationExt;
use tauri_specta::Event;

use crate::app::AppState;
use crate::events::ReminderAttentionEvent;
use crate::windows::FLOATING_WINDOW_LABEL;

/// Initial reminder animation duration before the saved preference is loaded.
const DEFAULT_FLASH_SECONDS: u8 = 8;

/// 设置页可配置的单次提醒时长（秒）。
pub const FLASH_SECONDS_OPTIONS: [u8; 7] = [3, 5, 8, 10, 15, 20, 30];

/// 保留最近一次提醒的动画结束时间，供尚未完成加载的悬浮窗读取。
pub struct ReminderAttention {
    /// Animation duration to use when the next reminder starts.
    flash_seconds: AtomicU8,
    /// End time of the currently active reminder animation, if any.
    deadline: Mutex<Option<Instant>>,
}

impl Default for ReminderAttention {
    fn default() -> Self {
        Self {
            flash_seconds: AtomicU8::new(DEFAULT_FLASH_SECONDS),
            deadline: Mutex::default(),
        }
    }
}

impl ReminderAttention {
    /// 修改之后每次提醒的时长；已经开始的提示保持自己的结束时间。
    pub fn set_flash_seconds(&self, seconds: u8) {
        self.flash_seconds.store(seconds, Ordering::Relaxed);
    }

    /// 当前配置的单次提醒时长（秒）。
    pub fn flash_seconds(&self) -> u8 {
        self.flash_seconds.load(Ordering::Relaxed)
    }

    /// Start a new attention interval and return its duration in milliseconds.
    fn start(&self) -> u32 {
        let duration_ms = u32::from(self.flash_seconds()) * 1_000;
        let mut deadline = self
            .deadline
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        *deadline = Some(Instant::now() + Duration::from_millis(u64::from(duration_ms)));
        duration_ms
    }

    /// 返回剩余毫秒数。读取不延长提醒，以便窗口重载时仍按时停止。
    pub fn remaining_ms(&self) -> u32 {
        self.deadline
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .map_or(0, |deadline| {
                u32::try_from(
                    deadline
                        .saturating_duration_since(Instant::now())
                        .as_millis(),
                )
                .unwrap_or(0)
            })
    }
}

/// 通知适配器：Windows 上优先用原生 Toast（点击通知可以打开对应的 Item，实施计划 10.6），失败时
/// 退回 Tauri 通知插件（只能显示，点击没有回调）；其他平台直接用插件。通知的应用名与图标由应用标识提供。
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
        let attention = ReminderAttentionEvent {
            duration_ms: self.app.state::<ReminderAttention>().start(),
        };
        if let Err(error) = attention.emit_to(&self.app, FLOATING_WINDOW_LABEL) {
            tracing::warn!(event = "reminder_attention_event_failed", %error, "通知悬浮窗显示提醒失败");
        }

        #[cfg(target_os = "windows")]
        {
            let toast = asterjot_platform_windows::toast::WindowsToast::new(
                self.app.config().identifier.clone(),
            );
            match toast.notify(notification) {
                Ok(()) => return Ok(()),
                Err(error) => {
                    tracing::warn!(event = "native_toast_failed", %error, "原生 Toast 失败，改用通知插件");
                }
            }
        }
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
    let flash_seconds = tauri::async_runtime::block_on(settings.get(keys::REMINDER_FLASH_SECONDS))
        .ok()
        .flatten()
        .and_then(|value| value.parse().ok())
        .filter(|value| FLASH_SECONDS_OPTIONS.contains(value))
        .unwrap_or(DEFAULT_FLASH_SECONDS);
    app.state::<ReminderAttention>()
        .set_flash_seconds(flash_seconds);
    let repeat_count = tauri::async_runtime::block_on(settings.get(keys::REMINDER_COUNT))
        .ok()
        .flatten()
        .and_then(|value| value.parse().ok())
        .filter(|count| (1..=MAX_REMINDER_COUNT).contains(count))
        .unwrap_or(1);
    control.set_repeat_count(repeat_count);
    control
        .set_locale(tauri::async_runtime::block_on(crate::native_i18n::current(&settings)).into());

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
) -> Result<(), asterjot_application::error::AppError> {
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
