//! Today 相关的 Command。

use tauri::State;

use crate::app::AppState;
use crate::dto::{IpcError, TodayViewDto};

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
