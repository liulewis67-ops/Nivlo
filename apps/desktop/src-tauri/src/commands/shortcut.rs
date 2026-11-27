//! 全局快捷键相关的 Command（仅主窗口）。

use starat_application::error::{AppError, ErrorCode};
use tauri::{AppHandle, Runtime, State};

use crate::app::AppState;
use crate::dto::{IpcError, ShortcutActionDto, ShortcutStatusDto};
use crate::shortcut::{ShortcutAction, parse_accelerator};

/// 取得某个动作的全局快捷键控制器；启动完成之前不可用。
fn controller(
    state: &AppState,
    action: ShortcutAction,
) -> Result<std::sync::Arc<crate::shortcut::ShortcutController>, IpcError> {
    state.runtime.shortcut(action).ok_or_else(|| {
        IpcError::from(AppError::new(
            ErrorCode::InvalidInput,
            "全局快捷键尚未初始化".to_owned(),
        ))
    })
}

/// 读取一个动作的全局快捷键的当前绑定与注册状态：被其他程序占用时 `conflict` 为 `true`。
///
/// # Errors
///
/// 应用尚未启动完成时返回 `INVALID_INPUT`。
#[tauri::command]
#[specta::specta]
pub async fn get_shortcut_status(
    state: State<'_, AppState>,
    action: ShortcutActionDto,
) -> Result<ShortcutStatusDto, IpcError> {
    let action = ShortcutAction::from(action);
    Ok(ShortcutStatusDto::new(
        controller(&state, action)?.status(),
        action,
    ))
}

/// 一个动作的快捷键被占用时，列出几个现在可用的组合（最多 3 个），界面上一键换用。
///
/// # Errors
///
/// 应用尚未启动完成时返回 `INVALID_INPUT`。
#[tauri::command]
#[specta::specta]
pub async fn suggest_shortcuts(
    state: State<'_, AppState>,
    action: ShortcutActionDto,
) -> Result<Vec<String>, IpcError> {
    let action = ShortcutAction::from(action);
    let taken: Vec<String> = ShortcutAction::ALL
        .into_iter()
        .filter_map(|each| state.runtime.shortcut(each))
        .map(|each| each.status().accelerator)
        .collect();
    Ok(controller(&state, action)?.suggestions(&taken, 3))
}

/// 修改一个动作的全局快捷键并保存。
///
/// 新的注册失败时原来的绑定保持不变。
///
/// # Errors
///
/// 不是合法的快捷键返回 `SHORTCUT_INVALID`；已经绑定给 StarAt 的另一个动作、或被其他程序占用返回
/// `SHORTCUT_CONFLICT`；平台不支持返回 `INVALID_INPUT`；保存失败时返回存储错误（快捷键本次运行仍然有效）。
#[tauri::command]
#[specta::specta]
pub async fn set_shortcut<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    action: ShortcutActionDto,
    accelerator: String,
) -> Result<ShortcutStatusDto, IpcError> {
    let action = ShortcutAction::from(action);
    // 和另一个动作撞车时给出明确的原因，而不是让系统报「被其他程序占用」。
    let wanted = parse_accelerator(&accelerator)?.to_string();
    for other in ShortcutAction::ALL
        .into_iter()
        .filter(|other| *other != action)
    {
        // 停用的动作不占用它的组合。
        if let Some(existing) = state.runtime.shortcut(other)
            && !existing.status().disabled
            && existing.status().accelerator == wanted
        {
            return Err(IpcError::from(AppError::new(
                ErrorCode::ShortcutConflict,
                format!("快捷键 {wanted} 已经用于 StarAt 的另一个动作"),
            )));
        }
    }
    let status = controller(&state, action)?.rebind(&accelerator).await?;
    if action == ShortcutAction::Search {
        crate::tray::refresh_search_shortcut(&app);
    }
    Ok(ShortcutStatusDto::new(status, action))
}

/// 停用一个动作的全局快捷键并保存（重启后也不注册）；再次设置快捷键即重新启用。
///
/// # Errors
///
/// 应用尚未启动完成时返回 `INVALID_INPUT`；保存失败时返回存储错误（本次运行已经停用）。
#[tauri::command]
#[specta::specta]
pub async fn disable_shortcut<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    action: ShortcutActionDto,
) -> Result<ShortcutStatusDto, IpcError> {
    let action = ShortcutAction::from(action);
    let status = controller(&state, action)?.disable().await?;
    if action == ShortcutAction::Search {
        crate::tray::refresh_search_shortcut(&app);
    }
    Ok(ShortcutStatusDto::new(status, action))
}
