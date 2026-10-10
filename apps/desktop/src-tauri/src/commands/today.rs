//! Today 相关的 Command。

use tauri::State;

use crate::app::AppState;
use crate::dto::{IpcError, TodayViewDto, parse_item_id};

/// 读取今天的视图：待办（已按 Today Order 排序，含逾期）、提示与今日已完成。
///
/// 悬浮窗只在**启动时**调用一次，之后由事件（`item_created`、`item_updated`、
/// `today_reordered`、`day_changed`）驱动缓存刷新；Hover 展开不会调用本命令（架构文档 §12）。
///
/// # Errors
///
/// 存储失败时返回 [`IpcError`]。
#[tauri::command]
#[specta::specta]
pub async fn get_today(state: State<'_, AppState>) -> Result<TodayViewDto, IpcError> {
    let view = state.services.today.get_today().await?;
    Ok(TodayViewDto::from(&view))
}

/// 保存用户拖出来的 Today 顺序（界面看到的待办 ID，从上到下）。
///
/// 后端会规范化：忽略不在 Today 里的 ID，把界面不知道的新待办追加在末尾，
/// 所以界面快照过时也不会丢失任何待办。成功后发出 `today_reordered` 事件。
///
/// # Errors
///
/// 任一 ID 格式不合法返回 `INVALID_INPUT`；存储失败时返回 [`IpcError`]。
#[tauri::command]
#[specta::specta]
pub async fn reorder_today(
    state: State<'_, AppState>,
    ordered_ids: Vec<String>,
) -> Result<(), IpcError> {
    let ids = ordered_ids
        .iter()
        .map(|id| parse_item_id(id))
        .collect::<Result<Vec<_>, _>>()?;
    state.services.today.reorder_today(&ids).await?;
    Ok(())
}
