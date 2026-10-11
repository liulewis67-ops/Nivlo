//! 开机自启（实施计划 1.9）。
//!
//! 默认**关闭**。首次运行时用一个原生对话框问一次，无论回答什么都记录"已询问"，之后不再打扰；
//! 以后的开关放在设置页（3.5）。自启本身由 `tauri-plugin-autostart` 写入系统启动项。

use nivlo_application::settings::{SettingsService, keys};

use crate::native_i18n::Lang;
use tauri::{AppHandle, Wry};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_dialog::{
    DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult,
};

/// 传给自启进程的参数，便于日后区分"用户手动启动"与"开机启动"。
pub const AUTOSTART_ARG: &str = "--autostarted";

/// 设置了这个环境变量就不弹首次运行询问（自动化脚本使用，不会记录「已询问」）。
pub const SKIP_PROMPT_ENV: &str = "NIVLO_SKIP_FIRST_RUN_PROMPTS";

/// 一种语言下的对话框文案。
struct Text {
    /// 标题。
    title: &'static str,
    /// 正文。
    message: &'static str,
    /// 同意按钮。
    enable: &'static str,
    /// 拒绝按钮。
    decline: &'static str,
}

/// 按语言选择对话框文案。
fn text(lang: Lang) -> Text {
    match lang {
        Lang::ZhCn => Text {
            title: "开机时自动启动拾序？",
            message: "拾序常驻在屏幕边缘，开机自动启动后你随时可以把想法和待办收进来。

                      你可以随时在设置里更改这个选项。",
            enable: "开机自动启动",
            decline: "暂不需要",
        },
        Lang::En => Text {
            title: "Start Nivlo when you sign in?",
            message: "Nivlo lives at the edge of your screen. Starting it at sign-in lets you capture ideas and to-dos anytime.

                      You can change this in Settings at any time.",
            enable: "Start at sign-in",
            decline: "Not now",
        },
    }
}

/// 是否需要询问：只有从未询问过才问。设置里是任何值都算"问过了"。
#[must_use]
pub fn should_prompt(prompted: Option<&str>) -> bool {
    prompted.is_none()
}

/// 对话框的返回值是否是「开机自动启动」按钮。
fn is_enable_choice(result: &MessageDialogResult, enable_label: &str) -> bool {
    matches!(result, MessageDialogResult::Custom(label) if label == enable_label)
}

/// 首次运行时询问是否开机自启；已经问过则什么都不做。
///
/// 对话框是非阻塞的：这里读取设置、弹出对话框后立即返回，用户回答后在回调里记录并启用。
/// 所有失败只记录日志——自启是便利功能，不能影响启动。
pub async fn prompt_once(app: AppHandle<Wry>, settings: SettingsService) {
    // 自动化测量（scripts/perf）与端到端测试不能被模态对话框打断。
    if std::env::var_os(SKIP_PROMPT_ENV).is_some() {
        return;
    }
    match settings.get(keys::AUTOSTART_PROMPTED).await {
        Ok(value) if !should_prompt(value.as_deref()) => return,
        Ok(_) => {}
        Err(error) => {
            tracing::warn!(event = "autostart_prompt_read_failed", %error, "读取自启询问状态失败");
            return;
        }
    }
    let handle = app.clone();
    let words = text(crate::native_i18n::current(&settings).await);
    let enable_label = words.enable;
    app.dialog()
        .message(words.message)
        .title(words.title)
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::OkCancelCustom(
            words.enable.to_owned(),
            words.decline.to_owned(),
        ))
        .show_with_result(move |result| {
            // 只有明确点了「开机自动启动」才启用：对话框被系统 / 其他窗口意外关闭时一律视为拒绝。
            let enable = is_enable_choice(&result, enable_label);
            tauri::async_runtime::spawn(async move {
                // 先记录"已询问"，即使启用失败也不再反复弹窗。
                if let Err(error) = settings.set(keys::AUTOSTART_PROMPTED, "true").await {
                    tracing::warn!(event = "autostart_prompt_save_failed", %error, "保存自启询问状态失败");
                }
                if enable {
                    match handle.autolaunch().enable() {
                        Ok(()) => tracing::info!(event = "autostart_enabled", "已开启开机自启"),
                        Err(error) => {
                            tracing::warn!(event = "autostart_enable_failed", %error, "开启开机自启失败");
                        }
                    }
                }
            });
        });
}

#[cfg(test)]
mod tests {
    use tauri_plugin_dialog::MessageDialogResult;

    use super::{Lang, is_enable_choice, should_prompt, text};

    #[test]
    fn prompts_only_when_never_asked() {
        assert!(should_prompt(None));
        assert!(!should_prompt(Some("true")));
        assert!(!should_prompt(Some("anything")));
    }

    #[test]
    fn only_the_enable_button_enables_autostart() {
        assert!(is_enable_choice(
            &MessageDialogResult::Custom(text(Lang::ZhCn).enable.to_owned()),
            text(Lang::ZhCn).enable
        ));
        assert!(!is_enable_choice(
            &MessageDialogResult::Custom(text(Lang::ZhCn).decline.to_owned()),
            text(Lang::ZhCn).enable
        ));
        assert!(!is_enable_choice(
            &MessageDialogResult::Ok,
            text(Lang::ZhCn).enable
        ));
        assert!(!is_enable_choice(
            &MessageDialogResult::Yes,
            text(Lang::ZhCn).enable
        ));
        assert!(!is_enable_choice(
            &MessageDialogResult::Cancel,
            text(Lang::ZhCn).enable
        ));
    }
}
