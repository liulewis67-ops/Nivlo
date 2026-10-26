//! 把进程内领域事件转发给前端窗口的后台任务。

use std::sync::Arc;

use nivlo_application::event::{EventBus, UiEvent, UiEventMapper};
use tauri::async_runtime::JoinHandle;
use tauri::{AppHandle, Wry};
use tauri_specta::Event;
use tokio::sync::broadcast::error::RecvError;
use tokio_util::sync::CancellationToken;

use super::{DayChangedEvent, ItemCreatedEvent, ItemUpdatedEvent, TodayReorderedEvent};
use crate::windows::{FLOATING_WINDOW_LABEL, MAIN_WINDOW_LABEL};

/// 收数据变化事件的窗口（后端规范 §5.2：用 `emit_to` 只发给需要的窗口）。
///
/// 全局搜索框不在其中：它几乎一直隐藏，每次出现都会丢掉旧数据重新读取；
/// 广播给它只会让隐藏的 WebView 在每次修改后白白重新查询。
pub const DATA_EVENT_TARGETS: [&str; 2] = [MAIN_WINDOW_LABEL, FLOATING_WINDOW_LABEL];

/// 把一个 UI 事件发给 [`DATA_EVENT_TARGETS`] 里的窗口。还没创建的窗口（主窗口按需创建）自然收不到，
/// 它创建时会自己读取最新数据。
fn emit(app: &AppHandle<Wry>, event: &UiEvent) {
    for target in DATA_EVENT_TARGETS {
        let result = match event {
            UiEvent::ItemCreated { item_id } => ItemCreatedEvent {
                item_id: item_id.to_string(),
            }
            .emit_to(app, target),
            UiEvent::ItemUpdated { item_id } => ItemUpdatedEvent {
                item_id: item_id.to_string(),
            }
            .emit_to(app, target),
            UiEvent::TodayReordered => TodayReorderedEvent {}.emit_to(app, target),
            UiEvent::DayChanged { date } => DayChangedEvent {
                date: date.format("%Y-%m-%d").to_string(),
            }
            .emit_to(app, target),
        };
        if let Err(error) = result {
            // 窗口正在销毁等情况下发送会失败；事件只是刷新信号，丢失不影响数据正确性。
            tracing::warn!(event = "ui_event_emit_failed", %error, target, "向前端发送事件失败");
        }
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
                            emit(&app, &ui_event);
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

#[cfg(test)]
mod tests {
    use super::DATA_EVENT_TARGETS;
    use crate::windows::search::SEARCH_WINDOW_LABEL;
    use crate::windows::{FLOATING_WINDOW_LABEL, MAIN_WINDOW_LABEL};

    #[test]
    fn data_events_go_to_main_and_floating_but_not_the_hidden_search_box() {
        assert!(DATA_EVENT_TARGETS.contains(&MAIN_WINDOW_LABEL));
        assert!(DATA_EVENT_TARGETS.contains(&FLOATING_WINDOW_LABEL));
        assert!(!DATA_EVENT_TARGETS.contains(&SEARCH_WINDOW_LABEL));
    }
}
