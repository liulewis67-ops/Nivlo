//! 来源相关的 Command：打开 Item 的来源。

use stardeskbox_application::error::{AppError, ErrorCode};
use stardeskbox_platform::open::OpenPort;
use tauri::{AppHandle, Runtime, State};

use crate::app::AppState;
use crate::dto::{IpcError, parse_item_id};
use crate::open::TauriOpen;

/// 打开 Item 的来源：网址用默认浏览器打开，文件在资源管理器里定位。
///
/// 前端只传 Item ID，**不传网址或路径**：要打开什么由后端从已保存的来源 / 附件里决定
/// （没有「打开任意路径」的通用能力，ADR-010）。网址只允许 http(s)。
///
/// # Errors
///
/// * `ITEM_NOT_FOUND` - Item 不存在。
/// * `SOURCE_FILE_MISSING` - 来源是文件，但它已经不在原处（UI 提示「文件不存在」）。
/// * `SOURCE_OPEN_FAILED` - 没有可打开的来源、网址不是 http(s)，或系统打开失败。
#[tauri::command]
#[specta::specta]
pub async fn open_item_source<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    id: String,
) -> Result<(), IpcError> {
    let detail = state
        .services
        .items
        .get_item_detail(parse_item_id(&id)?)
        .await?;
    let failed =
        |reason: String| IpcError::from(AppError::new(ErrorCode::SourceOpenFailed, reason));
    let port = TauriOpen::new(app);

    if let Some(url) = detail
        .sources
        .iter()
        .find_map(|source| source.source_url.as_deref())
    {
        return port
            .open_url(url)
            .map_err(|error| failed(error.to_string()));
    }
    // 文件：优先用附件里保存的原始路径，其次是来源记录里的路径。
    let path = detail
        .attachments
        .iter()
        .find(|attachment| !attachment.owns_file())
        .map(|attachment| attachment.path.as_str())
        .or_else(|| {
            detail
                .sources
                .iter()
                .find_map(|source| source.source_path.as_deref())
        });
    let Some(path) = path else {
        return Err(failed("这个条目没有可打开的来源".to_owned()));
    };
    if !stardeskbox_capture::reference_exists(path) {
        return Err(IpcError::from(AppError::new(
            ErrorCode::SourceFileMissing,
            format!("文件不存在：{path}"),
        )));
    }
    port.reveal_file(path)
        .map_err(|error| failed(error.to_string()))
}
