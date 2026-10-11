//! 系统电源 / 时钟事件接入 Scheduler（实施计划 10.5）。
//!
//! Windows 上由原生监听窗口在系统休眠恢复、时间被改动时通知这里，立即唤醒 Scheduler 做 Reconcile，
//! 不必等偏差检测；其他平台没有原生监听，仍靠 Scheduler 自己的偏差检测兜底。

use nivlo_scheduler::Control;

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
pub fn start(state: &AppState) {
    #[cfg(target_os = "windows")]
    {
        use nivlo_platform_windows::power::{PowerEvent, PowerEventListener};

        let control = state.runtime.scheduler_control();
        let callback = std::sync::Arc::new(move |event: PowerEvent| {
            let kind = match event {
                PowerEvent::Resumed => "resumed",
                PowerEvent::TimeChanged => "time_changed",
            };
            on_system_event(&control, kind);
        });
        match PowerEventListener::start(callback) {
            Ok(listener) => state.runtime.keep_alive(Box::new(listener)),
            Err(error) => {
                tracing::warn!(event = "power_listener_failed", %error, "无法监听系统电源事件，改用偏差检测");
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = state;
    }
}
