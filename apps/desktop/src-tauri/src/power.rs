//! 系统电源 / 时钟事件接入 Scheduler（实施计划 10.5）。
//!
//! Windows 上由原生监听窗口在系统休眠恢复、时间被改动时通知这里，立即唤醒 Scheduler 做 Reconcile，
//! 不必等偏差检测；其他平台没有原生监听，仍靠 Scheduler 自己的偏差检测兜底。

use asterjot_scheduler::Control;

use crate::app::AppState;

/// 收到系统事件时的处理：记日志（作为「唤醒后 Reconcile 在 2 秒内触发」的证据）并唤醒 Scheduler。
pub fn on_system_event(control: &Control, kind: &str) {
    tracing::info!(
        event = "scheduler_native_wake",
        kind,
        "收到系统电源 / 时钟事件，唤醒 Scheduler 重新核对触发点"
    );
    control.wake();
}

/// 启动原生事件监听（仅 Windows）；失败只记日志，Scheduler 仍有偏差检测兜底。
///
/// * 休眠恢复 / 时间被改动 → 唤醒 Scheduler（实施计划 10.5）；
/// * 显示器配置变化 → 悬浮窗重新定位到可见区域（实施计划 10.3）。
pub fn start(app: &tauri::AppHandle<tauri::Wry>) {
    #[cfg(target_os = "windows")]
    {
        use asterjot_platform_windows::power::{PowerEvent, PowerEventListener};
        use tauri::Manager;

        let handle = app.clone();
        let callback = std::sync::Arc::new(move |event: PowerEvent| {
            let state = handle.state::<AppState>();
            let kind = match event {
                PowerEvent::Resumed => "resumed",
                PowerEvent::TimeChanged => "time_changed",
                PowerEvent::DisplayChanged => {
                    crate::windows::search::reflow(&handle);
                    if let Some(floating) = state.runtime.floating() {
                        let floating = floating.clone();
                        tauri::async_runtime::spawn(async move {
                            floating.on_display_changed().await;
                        });
                    }
                    return;
                }
            };
            on_system_event(&state.runtime.scheduler_control(), kind);
        });
        match PowerEventListener::start(callback) {
            Ok(listener) => app
                .state::<AppState>()
                .runtime
                .keep_alive(Box::new(listener)),
            Err(error) => {
                tracing::warn!(event = "power_listener_failed", %error, "无法监听系统电源事件，改用偏差检测");
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
    }
}
