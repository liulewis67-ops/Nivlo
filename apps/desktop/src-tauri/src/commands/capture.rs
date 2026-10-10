//! 捕获相关的 Command。

use nivlo_application::error::{AppError, ErrorCode};
use nivlo_domain::capture::{CaptureOrigin, CaptureRequest};
use tauri::State;

use crate::app::AppState;
use crate::dto::{CaptureRequestDto, CaptureResultDto, IpcError, parse_item_id};

/// 捕获一次输入（文本 / URL / 文件 / 图片），创建 Item + Source + Attachment 并放进 Inbox。
///
/// 整个过程是一个事务；失败时不留下任何记录。返回创建的 Item 与撤销句柄。
///
/// # Errors
///
/// 没有可捕获的内容、图片无法识别返回 `INVALID_INPUT`；存储失败返回
/// `STORAGE_UNAVAILABLE`，此时没有留下任何数据。
#[tauri::command]
#[specta::specta]
pub async fn capture(
    state: State<'_, AppState>,
    request: CaptureRequestDto,
) -> Result<CaptureResultDto, IpcError> {
    let request = CaptureRequest::try_from(request)?;
    let result = state.services.capture.capture(request).await?;
    Ok(CaptureResultDto::from(&result))
}

/// 撤销一次捕获：删除它创建的全部 Item 及其来源 / 附件记录（用户被引用的文件不受影响）。
///
/// # Errors
///
/// ID 格式不合法返回 `INVALID_INPUT`；存储失败时没有删除任何东西。
#[tauri::command]
#[specta::specta]
pub async fn undo_capture(
    state: State<'_, AppState>,
    item_ids: Vec<String>,
) -> Result<(), IpcError> {
    let ids = item_ids
        .iter()
        .map(|id| parse_item_id(id))
        .collect::<Result<Vec<_>, _>>()?;
    state.services.capture.undo(&ids).await?;
    Ok(())
}

/// 把剪贴板里的内容收进 Inbox（用户按了粘贴）：文件 → 文本 → 图片，优先级见
/// [`nivlo_capture::normalize_clipboard`]。
///
/// 读取剪贴板可能因为被其他程序占用而短暂重试，所以放在阻塞线程里，不占用异步运行时。
///
/// # Errors
///
/// 剪贴板里没有可收集的内容返回 `CLIPBOARD_EMPTY`；读取失败（被占用、平台不支持）返回
/// `CLIPBOARD_UNAVAILABLE`；存储失败返回 `STORAGE_UNAVAILABLE`，此时没有留下任何数据。
#[tauri::command]
#[specta::specta]
pub async fn capture_from_clipboard(
    state: State<'_, AppState>,
) -> Result<CaptureResultDto, IpcError> {
    let unavailable =
        |reason: String| IpcError::from(AppError::new(ErrorCode::ClipboardUnavailable, reason));
    let content =
        tauri::async_runtime::spawn_blocking(|| crate::clipboard::platform_clipboard().read())
            .await
            .map_err(|error| unavailable(error.to_string()))?
            .map_err(|error| unavailable(error.to_string()))?;
    let input =
        nivlo_capture::normalize_clipboard(&content.files, content.text.as_deref(), content.image)
            .ok_or_else(|| {
                IpcError::from(AppError::new(
                    ErrorCode::ClipboardEmpty,
                    "剪贴板里没有可收集的内容".to_owned(),
                ))
            })?;
    let result = state
        .services
        .capture
        .capture(CaptureRequest::new(input, CaptureOrigin::Paste))
        .await?;
    Ok(CaptureResultDto::from(&result))
}
