//! 把进程内领域事件转发给前端窗口的后台任务。

use std::sync::Arc;

use nivlo_application::event::{EventBus, UiEvent, UiEventMapper};
use tauri::async_runtime::JoinHandle;
use tauri::{AppHandle, Wry};
use tauri_specta::Event;
use tokio::sync::broadcast::error::RecvError;
use tokio_util::sync::CancellationToken;

use super::{DayChangedEvent, ItemCreatedEvent, ItemUpdatedEvent, TodayReorderedEvent};

/// 发送一个 UI 事件到所有窗口。
///
/// TODO(P1.1): 悬浮窗与主窗口上线后改为 `emit_to` 只发给需要的窗口（后端规范 §5.2）。
fn emit(app: &AppHandle<Wry>, event: UiEvent) {
    let result = match event {
        UiEvent::ItemCreated { item_id } => ItemCreatedEvent {
            item_id: item_id.to_string(),
        }
        .emit(app),
        UiEvent::ItemUpdated { item_id } => ItemUpdatedEvent {
            item_id: item_id.to_string(),
        }
        .emit(app),
        UiEvent::TodayReordered => TodayReorderedEvent {}.emit(app),
        UiEvent::DayChanged { date } => DayChangedEvent {
            date: date.format("%Y-%m-%d").to_string(),
        }
        .emit(app),
    };
    if let Err(error) = result {
        // 窗口正在销毁等情况下发送会失败；事件只是刷新信号，丢失不影响数据正确性。
        tracing::warn!(event = "ui_event_emit_failed", %error, "向前端发送事件失败");
    }
}

/// 启动转发任务：订阅事件总线，映射后发送给前端，收到取消信号时退出。
///
/// 调用方应通过 `RuntimeHandles::track_task` 登记返回的句柄，以便退出时等待其结束。
pub fn spawn_forwarder(
    app: AppHandle<Wry>,
    bus: &EventBus,
    mapper: Arc<dyn UiEventMapper>,
    shutdown: CancellationToken,
) -> JoinHandle<()> {
    // 先订阅再 spawn：保证 spawn 之前发布的事件也不会漏掉。
    let mut receiver = bus.subscribe();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::select! {
                // biased：优先响应退出信号，避免被持续到来的事件拖延退出。
                biased;
                () = shutdown.cancelled() => break,
                received = receiver.recv() => match received {
                    Ok(event) => {
                        if let Some(ui_event) = mapper.map(&event) {
                            emit(&app, ui_event);
                        }
                    }
                    // 订阅者落后太多时旧事件已被丢弃；前端收到下一个事件后会刷新，这里只记录。
                    Err(RecvError::Lagged(skipped)) => {
                        tracing::warn!(event = "ui_event_lagged", skipped, "UI 事件转发落后，部分事件被丢弃");
                    }
                    Err(RecvError::Closed) => break,
                },
            }
        }
    })
}
