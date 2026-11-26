//! Calendar 相关的 Command（仅主窗口，实施计划 4.2）。

use chrono::NaiveDate;
use stardeskbox_application::error::{AppError, ErrorCode};
use tauri::State;

use crate::app::AppState;
use crate::dto::{CalendarDto, CalendarRequest, IpcError};

/// 查询 Calendar：可见范围（月视图的整周网格 / 周视图的一周）内的计划与截止条目，
/// 以及还没有安排日期的待办。
///
/// 范围由后端按「一周从哪天开始」的设置计算，前端只负责排版。
///
/// # Errors
///
/// 锚点日期格式不对返回 `INVALID_INPUT`；存储失败时返回 [`IpcError`]。
#[tauri::command]
#[specta::specta]
pub async fn get_calendar(
    state: State<'_, AppState>,
    request: CalendarRequest,
) -> Result<CalendarDto, IpcError> {
    let anchor = NaiveDate::parse_from_str(&request.anchor, "%Y-%m-%d").map_err(|_| {
        IpcError::from(AppError::new(
            ErrorCode::InvalidInput,
            format!("无效的日期：{}", request.anchor),
        ))
    })?;
    let data = state
        .services
        .calendar
        .get_calendar(request.view.into(), anchor)
        .await?;
    Ok(CalendarDto::from(&data))
}
