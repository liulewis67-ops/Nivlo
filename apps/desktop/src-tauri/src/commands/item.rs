//! Item 相关的 Command。

use tauri::State;

use crate::app::AppState;
use crate::dto::{CreateItemRequest, IpcError, ItemDto, ListItemsRequest, parse_item_id};

/// 创建一个 Item。
///
/// # Errors
///
/// 请求格式不合法（`INVALID_INPUT`）、违反领域规则（如 `ITEM_TITLE_EMPTY`）或存储失败时
/// 返回 [`IpcError`]。
#[tauri::command]
#[specta::specta]
pub async fn create_item(
    state: State<'_, AppState>,
    request: CreateItemRequest,
) -> Result<ItemDto, IpcError> {
    let item = state
        .services
        .items
        .create_item(request.try_into()?)
        .await?;
    Ok(ItemDto::from(&item))
}

/// 按 ID 读取一个 Item。
///
/// # Errors
///
/// ID 格式不合法返回 `INVALID_INPUT`，不存在返回 `ITEM_NOT_FOUND`。
#[tauri::command]
#[specta::specta]
pub async fn get_item(state: State<'_, AppState>, id: String) -> Result<ItemDto, IpcError> {
    let item = state.services.items.get_item(parse_item_id(&id)?).await?;
    Ok(ItemDto::from(&item))
}

/// 列出 Item，创建时间从新到旧。
///
/// # Errors
///
/// 存储失败时返回 [`IpcError`]。
#[tauri::command]
#[specta::specta]
pub async fn list_items(
    state: State<'_, AppState>,
    request: ListItemsRequest,
) -> Result<Vec<ItemDto>, IpcError> {
    let items = state.services.items.list_items(request.into()).await?;
    Ok(items.iter().map(ItemDto::from).collect())
}
