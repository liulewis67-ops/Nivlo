//! 把进程内领域事件转发给前端窗口的后台任务。

use std::sync::Arc;

use starat_application::event::{EventBus, UiEvent, UiEventMapper};
use starat_domain::event::DomainEvent;
use tauri::async_runtime::JoinHandle;
use tauri::{AppHandle, Wry};
use tauri_specta::Event;
use tokio::sync::broadcast::Receiver;
use tokio::sync::broadcast::error::{RecvError, TryRecvError};
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

/// 一次最多合并多少个已经排队的事件，避免持续的事件流让一批永远收不完。
const MAX_BATCH: usize = 64;

/// 一批已经排队的领域事件，以及排队期间因为落后被丢弃的数量。
#[derive(Debug, Default)]
struct Batch {
    /// 按到达顺序排列的事件。
    events: Vec<DomainEvent>,
    /// 落后被丢弃的事件数。
    lagged: u64,
    /// 通道已经关闭（发布方都没了），发完这一批就该退出。
    closed: bool,
}

/// 在已经收到 `first` 之后，不等待地取走通道里已经排队的事件（最多 [`MAX_BATCH`] 个）。
///
/// 批量操作（整理、恢复、删除、合并标签）提交之后会连续发布 N 个事件；逐个转发会让每个窗口
/// 收到 N 次刷新信号、把同一组查询重取 N 次。合并成一批之后再去重、发送，
/// 前端收到的信号数就和真正变化的 Item 数一致，而且不引入任何等待。
fn drain_ready(receiver: &mut Receiver<DomainEvent>, first: DomainEvent) -> Batch {
    let mut batch = Batch {
        events: vec![first],
        ..Batch::default()
    };
    while batch.events.len() < MAX_BATCH {
        match receiver.try_recv() {
            Ok(event) => batch.events.push(event),
            Err(TryRecvError::Lagged(skipped)) => batch.lagged += skipped,
            Err(TryRecvError::Closed) => {
                batch.closed = true;
                break;
            }
            Err(TryRecvError::Empty) => break,
        }
    }
    batch
}

/// 把一批领域事件映射为 UI 事件并去重（保留第一次出现的顺序）。
///
/// 一次更新往往同时发布 `ItemUpdated` 与 `ScheduleChanged` 等，它们都映射为同一个
/// `ItemUpdated { item_id }`；UI 事件只是"该刷新了"的信号，重复的那一个没有任何信息量。
fn map_batch(mapper: &dyn UiEventMapper, events: &[DomainEvent]) -> Vec<UiEvent> {
    let mut out: Vec<UiEvent> = Vec::with_capacity(events.len());
    for ui_event in events.iter().filter_map(|event| mapper.map(event)) {
        if !out.contains(&ui_event) {
            out.push(ui_event);
        }
    }
    out
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
                    Ok(first) => {
                        let batch = drain_ready(&mut receiver, first);
                        if batch.lagged > 0 {
                            tracing::warn!(event = "ui_event_lagged", skipped = batch.lagged, "UI 事件转发落后，部分事件被丢弃");
                        }
                        for ui_event in map_batch(mapper.as_ref(), &batch.events) {
                            emit(&app, &ui_event);
                        }
                        if batch.closed {
                            break;
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
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use starat_application::event::{EventBus, EventPublisher, UiEvent};
    use starat_domain::event::DomainEvent;
    use starat_domain::id::ItemId;
    use uuid::Uuid;

    use super::{DATA_EVENT_TARGETS, MAX_BATCH, drain_ready, map_batch};
    use crate::events::mapper::DefaultUiEventMapper;
    use crate::windows::search::SEARCH_WINDOW_LABEL;
    use crate::windows::{FLOATING_WINDOW_LABEL, MAIN_WINDOW_LABEL};

    #[test]
    fn data_events_go_to_main_and_floating_but_not_the_hidden_search_box() {
        assert!(DATA_EVENT_TARGETS.contains(&MAIN_WINDOW_LABEL));
        assert!(DATA_EVENT_TARGETS.contains(&FLOATING_WINDOW_LABEL));
        assert!(!DATA_EVENT_TARGETS.contains(&SEARCH_WINDOW_LABEL));
    }

    fn id(n: u128) -> ItemId {
        ItemId::from_uuid(Uuid::from_u128(n))
    }

    #[tokio::test]
    async fn a_burst_of_events_is_taken_in_one_batch() {
        let bus = EventBus::new();
        let mut receiver = bus.subscribe();
        for n in 1..=5 {
            bus.publish(DomainEvent::ItemUpdated { item_id: id(n) });
        }
        let first = receiver.recv().await.unwrap();
        let batch = drain_ready(&mut receiver, first);
        assert_eq!(batch.events.len(), 5);
        assert_eq!(batch.lagged, 0);
        assert!(!batch.closed);
        assert!(receiver.try_recv().is_err(), "nothing is left behind");
    }

    #[tokio::test]
    async fn a_batch_is_capped_and_the_rest_waits_for_the_next_one() {
        let bus = EventBus::new();
        let mut receiver = bus.subscribe();
        for n in 0..(MAX_BATCH as u128 + 10) {
            bus.publish(DomainEvent::ItemUpdated { item_id: id(n) });
        }
        let first = receiver.recv().await.unwrap();
        assert_eq!(drain_ready(&mut receiver, first).events.len(), MAX_BATCH);
        let next = receiver.recv().await.unwrap();
        assert_eq!(drain_ready(&mut receiver, next).events.len(), 10);
    }

    #[test]
    fn duplicates_collapse_and_the_order_is_kept() {
        let events = [
            DomainEvent::ItemUpdated { item_id: id(1) },
            DomainEvent::ScheduleChanged { item_id: id(1) },
            DomainEvent::ItemCreated { item_id: id(2) },
            DomainEvent::ItemCompleted { item_id: id(1) },
            DomainEvent::TodayReordered,
            DomainEvent::TodayReordered,
        ];
        assert_eq!(
            map_batch(&DefaultUiEventMapper, &events),
            vec![
                UiEvent::ItemUpdated { item_id: id(1) },
                UiEvent::ItemCreated { item_id: id(2) },
                UiEvent::TodayReordered,
            ]
        );
    }
}
