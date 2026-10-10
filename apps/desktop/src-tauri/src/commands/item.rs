//! Item 相关的 Command。

use tauri::State;

use crate::app::AppState;
use crate::dto::{
    CreateItemRequest, IpcError, ItemDto, ListItemsRequest, QuickCreateRequest,
    RescheduleTargetDto, parse_item_id,
};

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

/// 快速创建一个 Item（悬浮窗的 Quick Create）：只需要类型与标题。
///
/// 默认值由后端决定：Todo 与 Tip 的计划日期是今天（用户本地日期），Note 没有日期。
/// 悬浮窗只拥有这个命令，没有完整的 `create_item`（最小权限，架构文档 §13）。
///
/// # Errors
///
/// 标题为空返回 `ITEM_TITLE_EMPTY`，其余同 `create_item`。
#[tauri::command]
#[specta::specta]
pub async fn quick_create(
    state: State<'_, AppState>,
    request: QuickCreateRequest,
) -> Result<ItemDto, IpcError> {
    let item = state
        .services
        .items
        .quick_create(request.item_type.into(), &request.title)
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

/// 完成一个 Todo。完成不清理 Today 顺序，撤销后回到原来的位置。
///
/// # Errors
///
/// ID 格式不合法返回 `INVALID_INPUT`，不存在返回 `ITEM_NOT_FOUND`，
/// 不是待办 / 已完成 / 已归档分别返回对应的领域错误码。
#[tauri::command]
#[specta::specta]
pub async fn complete_item(state: State<'_, AppState>, id: String) -> Result<ItemDto, IpcError> {
    let item = state
        .services
        .items
        .complete_item(parse_item_id(&id)?)
        .await?;
    Ok(ItemDto::from(&item))
}

/// 重新打开已完成的 Todo（"完成"的撤销）。
///
/// # Errors
///
/// 同 `complete_item`；尚未完成时返回 `ITEM_NOT_COMPLETED`。
#[tauri::command]
#[specta::specta]
pub async fn reopen_item(state: State<'_, AppState>, id: String) -> Result<ItemDto, IpcError> {
    let item = state
        .services
        .items
        .reopen_item(parse_item_id(&id)?)
        .await?;
    Ok(ItemDto::from(&item))
}

/// 改期（推迟）一个 Item：今天 / 明天 / 稍后（下周一）/ 收集箱，或精确恢复（撤销）。
///
/// Item 同时离开 Today 的手动顺序；成功后界面通过 `item_updated` 事件刷新。
///
/// # Errors
///
/// ID 或日期格式不合法返回 `INVALID_INPUT`，不存在返回 `ITEM_NOT_FOUND`。
#[tauri::command]
#[specta::specta]
pub async fn reschedule_item(
    state: State<'_, AppState>,
    id: String,
    target: RescheduleTargetDto,
) -> Result<ItemDto, IpcError> {
    let item = state
        .services
        .items
        .reschedule_item(parse_item_id(&id)?, target.try_into()?)
        .await?;
    Ok(ItemDto::from(&item))
}
