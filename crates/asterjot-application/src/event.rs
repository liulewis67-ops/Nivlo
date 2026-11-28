//! 进程内事件总线与 UI 事件映射接口（架构文档 §38）。
//!
//! Use Case 在事务**提交成功之后**通过 [`EventPublisher`] 发布 [`DomainEvent`]；
//! Scheduler、搜索索引、UI Event Mapper 等订阅者通过 [`EventBus::subscribe`] 接收。
//! 总线是进程内的 `tokio::sync::broadcast`：发布不会阻塞，慢订阅者落后过多时会丢失旧事件
//! （收到 `Lagged`），因此订阅者应当把事件当作"该刷新了"的信号，并在需要时重新查询。

use asterjot_domain::event::DomainEvent;
use asterjot_domain::id::ItemId;
use chrono::NaiveDate;
use tokio::sync::broadcast;

/// 事件总线的缓冲容量。
///
/// 事件只携带 ID，体积很小；256 足以覆盖订阅者短暂的处理停顿。
const BUS_CAPACITY: usize = 256;

/// 发布领域事件的 Port。
pub trait EventPublisher: Send + Sync {
    /// 发布一个事件；没有订阅者时静默丢弃。
    fn publish(&self, event: DomainEvent);
}

/// 基于 `broadcast` 的进程内事件总线。
#[derive(Debug, Clone)]
pub struct EventBus {
    /// 广播发送端；克隆共享同一个通道。
    sender: broadcast::Sender<DomainEvent>,
}

impl EventBus {
    /// 创建一个新的事件总线。
    pub fn new() -> Self {
        let (sender, _) = broadcast::channel(BUS_CAPACITY);
        Self { sender }
    }

    /// 订阅事件。接收端只会收到订阅之后发布的事件。
    pub fn subscribe(&self) -> broadcast::Receiver<DomainEvent> {
        self.sender.subscribe()
    }
}

impl Default for EventBus {
    /// 等价于 [`EventBus::new`]。
    fn default() -> Self {
        Self::new()
    }
}

impl EventPublisher for EventBus {
    /// 广播事件；没有订阅者时 `send` 返回错误，这是正常情况，忽略即可。
    fn publish(&self, event: DomainEvent) {
        let _ = self.sender.send(event);
    }
}

/// 需要推送给前端的事件。
///
/// 与 [`DomainEvent`] 分离：并非所有领域事件都需要通知 UI，UI 事件的形状也可以独立演进。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UiEvent {
    /// 新建了 Item。
    ItemCreated {
        /// 新 Item 的 ID。
        item_id: ItemId,
    },
    /// Item 发生了变化（字段、完成状态、归档等）。
    ItemUpdated {
        /// 变化的 Item。
        item_id: ItemId,
    },
    /// Today 的手动顺序被调整。
    TodayReordered,
    /// 本地日期切换了，Today 需要重新取数。
    DayChanged {
        /// 新的本地日期。
        date: NaiveDate,
    },
}

/// 把领域事件映射为 UI 事件的接口。
///
/// Application 只定义接口；具体映射随宿主一起在 `src-tauri` 中实现（实施计划 0.8），
/// 这样 UI 事件的命名不会反向污染领域层。
pub trait UiEventMapper: Send + Sync {
    /// 映射一个领域事件；不需要通知 UI 的事件返回 `None`。
    fn map(&self, event: &DomainEvent) -> Option<UiEvent>;
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use uuid::Uuid;

    use super::*;

    #[tokio::test]
    async fn subscribers_receive_published_events() {
        let bus = EventBus::new();
        let mut rx = bus.subscribe();
        let id = ItemId::from_uuid(Uuid::from_u128(1));
        bus.publish(DomainEvent::ItemCreated { item_id: id });
        assert_eq!(
            rx.recv().await.unwrap(),
            DomainEvent::ItemCreated { item_id: id }
        );
    }

    #[test]
    fn publishing_without_subscribers_does_not_panic() {
        EventBus::new().publish(DomainEvent::TodayReordered);
    }

    #[tokio::test]
    async fn clones_share_the_channel() {
        let bus = EventBus::new();
        let mut rx = bus.subscribe();
        bus.clone().publish(DomainEvent::TodayReordered);
        assert_eq!(rx.recv().await.unwrap(), DomainEvent::TodayReordered);
    }
}
