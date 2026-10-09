//! Rust → UI 的事件（架构文档 §38）。
//!
//! Domain Event 不直接广播给前端：[`mapper::DefaultUiEventMapper`] 先把它们映射为 UI 需要的事件，
//! [`forwarder`] 再以 `tauri-specta` 的强类型事件发送。事件载荷只含 ID，前端收到后按需
//! 刷新查询缓存，因此不会泄漏 Note 全文等大字段（后端规范 §5.2）。

pub mod forwarder;
pub mod mapper;

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri_specta::Event;

/// 新建了一个 Item。
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
#[serde(rename_all = "camelCase")]
#[tauri_specta(event_name = "item_created")]
pub struct ItemCreatedEvent {
    /// 新 Item 的 ID。
    pub item_id: String,
}

/// 一个 Item 发生了变化。
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
#[serde(rename_all = "camelCase")]
#[tauri_specta(event_name = "item_updated")]
pub struct ItemUpdatedEvent {
    /// 变化的 Item ID。
    pub item_id: String,
}

/// 悬浮窗发现指针已经离开（由后端看门狗补发，弥补 WebView 漏发 `pointerleave`）。
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
#[serde(rename_all = "camelCase")]
#[tauri_specta(event_name = "floating_pointer_left")]
pub struct FloatingPointerLeftEvent {}

/// Today 的手动顺序被调整。
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
#[serde(rename_all = "camelCase")]
#[tauri_specta(event_name = "today_reordered")]
pub struct TodayReorderedEvent {}

/// 本地日期切换了（过了午夜、休眠唤醒或修改了系统时间），Today 需要重新取数。
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
#[serde(rename_all = "camelCase")]
#[tauri_specta(event_name = "day_changed")]
pub struct DayChangedEvent {
    /// 新的本地日期，`YYYY-MM-DD`。
    pub date: String,
}
