//! 设置页相关的 Command（仅主窗口，实施计划 3.5）。
//!
//! 全局快捷键有自己的命令（`get_shortcut_status` / `set_quick_create_shortcut`）；
//! 主题与语言是纯前端的显示偏好，不经过后端。

use nivlo_application::error::{AppError, ErrorCode};
use nivlo_application::settings::keys;
use tauri::{AppHandle, Runtime, State};
use tauri_plugin_autostart::ManagerExt;

use crate::app::AppState;
use crate::dto::{AppSettingsDto, IpcError, LaterRuleDto, WeekStartDto};

/// 系统设置（开机启动项）修改失败时的错误。
fn system_error(what: &str, error: &dyn std::fmt::Display) -> IpcError {
    tracing::warn!(event = "system_setting_failed", what, %error, "修改系统设置失败");
    IpcError::from(AppError::new(
        ErrorCode::SystemSettingFailed,
        format!("{what}失败：{error}"),
    ))
}

/// 读取全部设置：开机自启、悬浮窗置顶、「稍后」的规则。
///
/// 开机自启的状态以系统启动项为准（用户可能在系统设置里改过）；读取失败时按「关闭」显示并记录日志。
///
/// # Errors
///
/// 存储失败时返回 [`IpcError`]。
#[tauri::command]
#[specta::specta]
pub async fn get_app_settings<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
) -> Result<AppSettingsDto, IpcError> {
    let autostart = app.autolaunch().is_enabled().unwrap_or_else(|error| {
        tracing::warn!(event = "autostart_read_failed", %error, "读取开机自启状态失败");
        false
    });
    let always_on_top = state
        .services
        .settings
        .get(keys::FLOATING_ALWAYS_ON_TOP)
        .await?
        .is_none_or(|value| value != "false");
    let later_rule = state.services.settings.later_rule().await?;
    let week_start = state.services.settings.week_start().await?;
    let notifications_paused = state.runtime.scheduler_control().is_paused();
    let onboarding_completed = state
        .services
        .settings
        .get(keys::ONBOARDING_COMPLETED)
        .await?
        .is_some_and(|value| value == "true");
    Ok(AppSettingsDto {
        autostart,
        floating_always_on_top: always_on_top,
        later_rule: later_rule.into(),
        week_start: week_start.into(),
        notifications_paused,
        onboarding_completed,
    })
}

/// 开启或关闭开机自启，返回之后的实际状态。
///
/// # Errors
///
/// 系统拒绝修改启动项时返回 `SYSTEM_SETTING_FAILED`，此时状态不变。
#[tauri::command]
#[specta::specta]
pub async fn set_autostart<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    enabled: bool,
) -> Result<bool, IpcError> {
    let launcher = app.autolaunch();
    let result = if enabled {
        launcher.enable()
    } else {
        launcher.disable()
    };
    result.map_err(|error| system_error("修改开机自启", &error))?;
    // 用户明确做过选择，首次运行的询问就不必再弹了。
    if let Err(error) = state
        .services
        .settings
        .set(keys::AUTOSTART_PROMPTED, "true")
        .await
    {
        tracing::warn!(event = "autostart_prompt_save_failed", %error, "保存自启询问状态失败");
    }
    launcher
        .is_enabled()
        .map_err(|error| system_error("读取开机自启状态", &error))
}

/// 设置悬浮窗是否置顶：先保存，再立即应用到窗口。
///
/// # Errors
///
/// 保存失败返回存储错误（窗口不变）；窗口调用失败返回 `WINDOW_UNAVAILABLE`（设置已保存，下次启动生效）。
#[tauri::command]
#[specta::specta]
pub async fn set_floating_always_on_top(
    state: State<'_, AppState>,
    enabled: bool,
) -> Result<(), IpcError> {
    state
        .services
        .settings
        .set(
            keys::FLOATING_ALWAYS_ON_TOP,
            if enabled { "true" } else { "false" },
        )
        .await?;
    if let Some(floating) = state.runtime.floating() {
        floating.set_always_on_top(enabled).map_err(|error| {
            tracing::warn!(event = "floating_always_on_top_failed", %error, "设置悬浮窗置顶失败");
            IpcError::from(AppError::new(
                ErrorCode::WindowUnavailable,
                error.to_string(),
            ))
        })?;
    }
    Ok(())
}

/// 修改「稍后」的规则（悬浮窗与收集箱的「稍后」按钮都按它算日期）。
///
/// # Errors
///
/// 存储失败时返回 [`IpcError`]，规则不变。
#[tauri::command]
#[specta::specta]
pub async fn set_later_rule(
    state: State<'_, AppState>,
    rule: LaterRuleDto,
) -> Result<(), IpcError> {
    state.services.settings.set_later_rule(rule.into()).await?;
    Ok(())
}

/// 修改日历一周从哪天开始（Calendar 的周视图与月视图随之变化）。
///
/// # Errors
///
/// 存储失败时返回 [`IpcError`]，设置不变。
#[tauri::command]
#[specta::specta]
pub async fn set_week_start(
    state: State<'_, AppState>,
    week_start: WeekStartDto,
) -> Result<(), IpcError> {
    state
        .services
        .settings
        .set_week_start(week_start.into())
        .await?;
    Ok(())
}

/// 暂停或恢复系统通知（与托盘的「暂停通知」同一个开关）。
///
/// 暂停期间到点的提醒不会丢：恢复后作为「错过的提醒」通知（多了就合并成一条汇总）。
///
/// # Errors
///
/// 保存失败时返回存储错误，开关保持原来的状态。
#[tauri::command]
#[specta::specta]
pub async fn set_notifications_paused<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    paused: bool,
) -> Result<(), IpcError> {
    crate::scheduling::set_paused(&app, &state, paused).await?;
    Ok(())
}

/// 记录首次运行引导看过了（`true`）或让它下次重新出现（`false`，设置页的「重新查看引导」）。
///
/// # Errors
///
/// 存储失败时返回 [`IpcError`]。
#[tauri::command]
#[specta::specta]
pub async fn set_onboarding_completed(
    state: State<'_, AppState>,
    completed: bool,
) -> Result<(), IpcError> {
    state
        .services
        .settings
        .set(
            keys::ONBOARDING_COMPLETED,
            if completed { "true" } else { "false" },
        )
        .await?;
    Ok(())
}

/// UI 偏好允许的名字与对应的设置 key；只有这里列出的偏好能经由 IPC 读写（D-14）。
fn ui_pref_key(name: &str) -> Result<&'static str, IpcError> {
    match name {
        "appearance" => Ok(keys::UI_APPEARANCE),
        "skin" => Ok(keys::UI_SKIN),
        "language" => Ok(keys::UI_LANGUAGE),
        "theme" => Ok(keys::UI_THEME),
        "hideCompleted" => Ok(keys::UI_HIDE_COMPLETED),
        _ => Err(IpcError::from(AppError::new(
            ErrorCode::InvalidInput,
            format!("未知的界面偏好：{name}"),
        ))),
    }
}

/// 读取界面偏好（`appearance` / `skin` / `language` / `theme`）的 JSON 文本；没保存过返回 `None`。
///
/// 偏好存于 `settings` 表，因此随备份导出 / 恢复（实施计划 D-14）。
///
/// # Errors
///
/// 名字不认识返回 `INVALID_INPUT`；存储失败返回存储错误。
#[tauri::command]
#[specta::specta]
pub async fn get_ui_pref(
    state: State<'_, AppState>,
    name: String,
) -> Result<Option<String>, IpcError> {
    let key = ui_pref_key(&name)?;
    Ok(state.services.settings.get(key).await?)
}

/// 保存界面偏好的 JSON 文本；`None` 表示恢复默认（删除记录）。
///
/// # Errors
///
/// 名字不认识或内容过大（超过设置值上限）返回 `INVALID_INPUT`；存储失败返回存储错误。
#[tauri::command]
#[specta::specta]
pub async fn set_ui_pref<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    name: String,
    value: Option<String>,
) -> Result<(), IpcError> {
    let key = ui_pref_key(&name)?;
    if let Some(text) = &value {
        validate_ui_pref(&name, text)?;
    }
    match value {
        Some(text) => {
            state.services.settings.set(key, &text).await?;
            // 语言变了：托盘菜单立即换成新语言（原生对话框与通知在下次弹出时读取）。
            if name == "language"
                && let Some(lang) = crate::native_i18n::Lang::parse(&text)
            {
                crate::tray::apply_language(&app, lang);
                state.runtime.scheduler_control().set_locale(lang.into());
            }
            Ok(())
        }
        // 空字符串等同于未设置：读取方会回退到默认值。
        None => Ok(state.services.settings.set(key, "").await?),
    }
}

/// 语言与主题是枚举值，写入前校验，避免后端读到无法识别的文本；外观与皮肤的结构由前端清洗。
fn validate_ui_pref(name: &str, value: &str) -> Result<(), IpcError> {
    let allowed: &[&str] = match name {
        "language" => &["zh-CN", "en"],
        "theme" => &["system", "light", "dark"],
        "hideCompleted" => &["true", "false"],
        _ => return Ok(()),
    };
    if allowed.contains(&value) {
        Ok(())
    } else {
        Err(IpcError::from(AppError::new(
            ErrorCode::InvalidInput,
            format!("界面偏好 {name} 的值不合法：{value}"),
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ui_pref_names_are_whitelisted() {
        assert_eq!(ui_pref_key("language").ok(), Some(keys::UI_LANGUAGE));
        assert_eq!(ui_pref_key("theme").ok(), Some(keys::UI_THEME));
        assert!(ui_pref_key("sql").is_err());
    }

    #[test]
    fn enum_prefs_reject_unknown_values() {
        assert!(validate_ui_pref("language", "en").is_ok());
        assert!(validate_ui_pref("language", "fr").is_err());
        assert!(validate_ui_pref("theme", "dark").is_ok());
        assert!(validate_ui_pref("theme", "neon").is_err());
        assert!(validate_ui_pref("skin", "{}").is_ok());
    }
}
