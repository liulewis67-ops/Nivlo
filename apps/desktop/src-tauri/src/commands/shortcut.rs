//! 全局快捷键相关的 Command（仅主窗口）。

use nivlo_application::error::{AppError, ErrorCode};
use tauri::State;

use crate::app::AppState;
use crate::dto::{IpcError, ShortcutStatusDto};

/// 取得全局快捷键控制器；启动完成之前不可用。
fn controller(
    state: &AppState,
) -> Result<std::sync::Arc<crate::shortcut::ShortcutController>, IpcError> {
    state.runtime.shortcut().ok_or_else(|| {
        IpcError::from(AppError::new(
            ErrorCode::InvalidInput,
            "全局快捷键尚未初始化".to_owned(),
        ))
    })
}

/// 读取全局快捷键的当前绑定与注册状态：被其他程序占用时 `conflict` 为 `true`。
///
/// # Errors
///
/// 应用尚未启动完成时返回 `INVALID_INPUT`。
#[tauri::command]
#[specta::specta]
pub async fn get_shortcut_status(
    state: State<'_, AppState>,
) -> Result<ShortcutStatusDto, IpcError> {
    Ok(ShortcutStatusDto::from(controller(&state)?.status()))
}

/// 修改 Quick Create 的全局快捷键并保存。
///
/// 新的注册失败时原来的绑定保持不变。
///
/// # Errors
///
/// 不是合法的快捷键返回 `SHORTCUT_INVALID`；被其他程序占用返回 `SHORTCUT_CONFLICT`；
/// 平台不支持返回 `INVALID_INPUT`；保存失败时返回存储错误（快捷键本次运行仍然有效）。
#[tauri::command]
#[specta::specta]
pub async fn set_quick_create_shortcut(
    state: State<'_, AppState>,
    accelerator: String,
) -> Result<ShortcutStatusDto, IpcError> {
    let status = controller(&state)?.rebind(&accelerator).await?;
    Ok(ShortcutStatusDto::from(status))
}
