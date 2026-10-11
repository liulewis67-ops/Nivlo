//! 删除与回收站相关的 Command（实施计划 3.5、D-08）。

use tauri::State;

use crate::app::AppState;
use crate::dto::{IpcError, TrashEntryDto, parse_item_id};

/// 解析一批 Item ID；任何一个格式不合法都整批拒绝。
fn parse_ids(ids: &[String]) -> Result<Vec<nivlo_domain::id::ItemId>, IpcError> {
    ids.iter()
        .map(|id| parse_item_id(id).map_err(IpcError::from))
        .collect()
}

/// 删除一批 Item：移进回收站（软删除），30 天内可以恢复。
///
/// 全部在一个事务里：任何一个不存在，整批不变。成功后界面通过 `item_updated` 事件刷新。
///
/// # Errors
///
/// ID 格式不合法返回 `INVALID_INPUT`，不存在返回 `ITEM_NOT_FOUND`。
#[tauri::command]
#[specta::specta]
pub async fn delete_items(state: State<'_, AppState>, ids: Vec<String>) -> Result<(), IpcError> {
    state.services.trash.delete(&parse_ids(&ids)?).await?;
    Ok(())
}

/// 从回收站恢复一批 Item（「删除」的撤销）。不在回收站里的被忽略。
///
/// # Errors
///
/// ID 格式不合法返回 `INVALID_INPUT`；存储失败时没有任何改动。
#[tauri::command]
#[specta::specta]
pub async fn restore_deleted_items(
    state: State<'_, AppState>,
    ids: Vec<String>,
) -> Result<(), IpcError> {
    state.services.trash.restore(&parse_ids(&ids)?).await?;
    Ok(())
}

/// 回收站里的全部 Item，最近删除的在前，附带到期（自动永久清除）时间。
///
/// # Errors
///
/// 存储失败时返回 [`IpcError`]。
#[tauri::command]
#[specta::specta]
pub async fn list_trash(state: State<'_, AppState>) -> Result<Vec<TrashEntryDto>, IpcError> {
    let entries = state.services.trash.list().await?;
    Ok(entries.iter().map(TrashEntryDto::from).collect())
}

/// 永久删除回收站里的这些 Item；不在回收站里的不会被删除。返回实际删除的数量。
///
/// 只删除数据库记录与 Nivlo 自己保存的文件，被引用的用户文件不受影响。
///
/// # Errors
///
/// ID 格式不合法返回 `INVALID_INPUT`；存储失败时没有删除任何东西。
#[tauri::command]
#[specta::specta]
pub async fn purge_items(state: State<'_, AppState>, ids: Vec<String>) -> Result<u32, IpcError> {
    let count = state.services.trash.purge(&parse_ids(&ids)?).await?;
    Ok(u32::try_from(count).unwrap_or(u32::MAX))
}

/// 清空回收站。返回删除的数量。
///
/// # Errors
///
/// 存储失败时没有删除任何东西。
#[tauri::command]
#[specta::specta]
pub async fn empty_trash(state: State<'_, AppState>) -> Result<u32, IpcError> {
    let count = state.services.trash.empty().await?;
    Ok(u32::try_from(count).unwrap_or(u32::MAX))
}
