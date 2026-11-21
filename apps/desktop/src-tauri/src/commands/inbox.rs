//! Inbox 相关的 Command。

use nivlo_application::inbox::{OrganizeAction, PreviousState};
use tauri::State;

use crate::app::AppState;
use crate::dto::{
    InboxEntryDto, IpcError, ItemDto, OrganizeActionDto, OrganizeResultDto, PreviousStateDto,
    parse_item_id,
};

/// 列出 Inbox：等待整理的 Item，捕获时间从新到旧，附带来源与附件（含被引用文件是否还在）。
///
/// # Errors
///
/// 存储错误（`STORAGE_UNAVAILABLE` / `STORAGE_CORRUPT`）。
#[tauri::command]
#[specta::specta]
pub async fn list_inbox(state: State<'_, AppState>) -> Result<Vec<InboxEntryDto>, IpcError> {
    let entries = state.services.inbox.list().await?;
    Ok(entries.iter().map(InboxEntryDto::from).collect())
}

/// Inbox 里有多少条等待整理（侧栏与悬浮窗的数字）。
///
/// # Errors
///
/// 存储错误。
#[tauri::command]
#[specta::specta]
pub async fn get_inbox_count(state: State<'_, AppState>) -> Result<u32, IpcError> {
    Ok(state.services.inbox.count().await?)
}

/// 对一批 Item 执行同一个整理动作（安排日期 / 转换类型 / 归档 / 移出 Inbox）。
///
/// 一个事务：任何一条失败整批不变。返回整理之后的 Item，以及整理之前的状态（用于撤销）。
///
/// # Errors
///
/// ID 或日期格式不对返回 `INVALID_INPUT`；Item 不存在返回 `ITEM_NOT_FOUND`；存储错误时没有任何改动。
#[tauri::command]
#[specta::specta]
pub async fn organize_items(
    state: State<'_, AppState>,
    item_ids: Vec<String>,
    action: OrganizeActionDto,
) -> Result<OrganizeResultDto, IpcError> {
    let ids = item_ids
        .iter()
        .map(|id| parse_item_id(id))
        .collect::<Result<Vec<_>, _>>()?;
    let action = OrganizeAction::try_from(action)?;
    let outcome = state.services.inbox.organize(&ids, action).await?;
    Ok(OrganizeResultDto::from(&outcome))
}

/// 精确撤销一次整理：把每个 Item 恢复到整理之前的状态。
///
/// # Errors
///
/// 参数格式不对返回 `INVALID_INPUT`；Item 已不存在返回 `ITEM_NOT_FOUND`；存储错误时没有任何改动。
#[tauri::command]
#[specta::specta]
pub async fn restore_items(
    state: State<'_, AppState>,
    previous: Vec<PreviousStateDto>,
) -> Result<Vec<ItemDto>, IpcError> {
    let previous = previous
        .into_iter()
        .map(PreviousState::try_from)
        .collect::<Result<Vec<_>, _>>()?;
    let items = state.services.inbox.restore(&previous).await?;
    Ok(items.iter().map(ItemDto::from).collect())
}
