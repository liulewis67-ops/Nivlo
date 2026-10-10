//! 系统托盘（实施计划 1.9）。
//!
//! 托盘是应用常驻的"安全出口"：悬浮窗被隐藏、主窗口被关闭后，用户仍然可以从托盘
//! 打开 Nivlo、快速添加、重新显示悬浮窗或退出。菜单项的行为由纯函数 [`action_for`]
//! 决定，因此可以脱离系统托盘做单元测试。

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Wry};
use tauri_specta::Event;

use crate::events::QuickAddRequestedEvent;
use crate::windows::{self, FLOATING_WINDOW_LABEL};

/// 托盘图标的 ID。
const TRAY_ID: &str = "nivlo-tray";

/// 菜单文案。
// TODO(P7.5): 与前端一起接入 i18n 后改为按语言选择（实施计划 D-06）。
mod labels {
    /// 托盘悬停提示。
    pub const TOOLTIP: &str = "拾序 Nivlo";
    /// 打开主窗口。
    pub const OPEN: &str = "打开拾序";
    /// 快速添加。
    pub const QUICK_ADD: &str = "快速添加待办";
    /// 显示 / 隐藏悬浮窗。
    pub const TOGGLE_FLOATING: &str = "显示 / 隐藏悬浮窗";
    /// 暂停通知（Phase 4 前置灰）。
    pub const PAUSE_NOTIFICATIONS: &str = "暂停通知";
    /// 设置。
    pub const SETTINGS: &str = "设置";
    /// 退出。
    pub const QUIT: &str = "退出";
}

/// 菜单项 ID。
mod ids {
    /// 打开主窗口。
    pub const OPEN: &str = "open";
    /// 快速添加。
    pub const QUICK_ADD: &str = "quick_add";
    /// 显示 / 隐藏悬浮窗。
    pub const TOGGLE_FLOATING: &str = "toggle_floating";
    /// 暂停通知。
    pub const PAUSE_NOTIFICATIONS: &str = "pause_notifications";
    /// 设置。
    pub const SETTINGS: &str = "settings";
    /// 退出。
    pub const QUIT: &str = "quit";
}

/// 托盘菜单触发的动作。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrayAction {
    /// 打开（必要时创建）并聚焦主窗口。
    OpenMain,
    /// 显示悬浮窗并进入快速创建。
    QuickAdd,
    /// 切换悬浮窗的显示 / 隐藏。
    ToggleFloating,
    /// 退出应用（走有序退出流程）。
    Quit,
}

/// 菜单项 ID → 动作。未知 ID 与置灰的项（暂停通知）没有动作。
///
/// 「设置」目前打开主窗口；设置页本身在 3.5 加入。
#[must_use]
pub fn action_for(id: &str) -> Option<TrayAction> {
    match id {
        ids::OPEN | ids::SETTINGS => Some(TrayAction::OpenMain),
        ids::QUICK_ADD => Some(TrayAction::QuickAdd),
        ids::TOGGLE_FLOATING => Some(TrayAction::ToggleFloating),
        ids::QUIT => Some(TrayAction::Quit),
        _ => None,
    }
}

/// 创建托盘图标与菜单。左键单击打开主窗口，右键弹出菜单。
///
/// # Errors
///
/// 菜单或托盘图标创建失败时返回 Tauri 错误；调用方应记录并继续运行（托盘不是必需功能）。
pub fn setup(app: &AppHandle<Wry>) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, ids::OPEN, labels::OPEN, true, None::<&str>)?;
    let quick_add = MenuItem::with_id(app, ids::QUICK_ADD, labels::QUICK_ADD, true, None::<&str>)?;
    let toggle = MenuItem::with_id(
        app,
        ids::TOGGLE_FLOATING,
        labels::TOGGLE_FLOATING,
        true,
        None::<&str>,
    )?;
    // 通知在 Phase 4 才有，先置灰占位，菜单结构从一开始就是最终形态。
    let pause = MenuItem::with_id(
        app,
        ids::PAUSE_NOTIFICATIONS,
        labels::PAUSE_NOTIFICATIONS,
        false,
        None::<&str>,
    )?;
    let settings = MenuItem::with_id(app, ids::SETTINGS, labels::SETTINGS, true, None::<&str>)?;
    let quit = MenuItem::with_id(app, ids::QUIT, labels::QUIT, true, None::<&str>)?;
    let separator_top = PredefinedMenuItem::separator(app)?;
    let separator_bottom = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(
        app,
        &[
            &open,
            &quick_add,
            &toggle,
            &pause,
            &separator_top,
            &settings,
            &separator_bottom,
            &quit,
        ],
    )?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip(labels::TOOLTIP)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            if let Some(action) = action_for(event.id().as_ref()) {
                perform(app, action);
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                perform(tray.app_handle(), TrayAction::OpenMain);
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

/// 执行一个托盘动作；失败只记录日志，不让托盘点击导致崩溃。
fn perform(app: &AppHandle<Wry>, action: TrayAction) {
    match action {
        TrayAction::OpenMain => {
            if let Err(error) = windows::show_main_window(app) {
                tracing::warn!(event = "tray_open_main_failed", %error, "托盘打开主窗口失败");
            }
        }
        TrayAction::QuickAdd => {
            // 悬浮窗被隐藏时先显示出来，再让它进入快速创建。
            set_floating_visible(app, true);
            let event = QuickAddRequestedEvent {};
            if let Err(error) = event.emit_to(app, FLOATING_WINDOW_LABEL) {
                tracing::warn!(event = "tray_quick_add_failed", %error, "托盘快速添加失败");
            }
        }
        TrayAction::ToggleFloating => {
            let visible = app
                .get_webview_window(FLOATING_WINDOW_LABEL)
                .and_then(|window| window.is_visible().ok())
                .unwrap_or(true);
            set_floating_visible(app, !visible);
        }
        TrayAction::Quit => {
            // 与主窗口的 quit_app 同一条路径：由 RunEvent::ExitRequested 触发有序退出。
            app.exit(0);
        }
    }
}

/// 显示或隐藏悬浮窗。显示时不抢焦点（窗口本身是不可聚焦的）。
fn set_floating_visible(app: &AppHandle<Wry>, visible: bool) {
    let Some(window) = app.get_webview_window(FLOATING_WINDOW_LABEL) else {
        return;
    };
    let result = if visible {
        window.show()
    } else {
        window.hide()
    };
    if let Err(error) = result {
        tracing::warn!(event = "tray_toggle_floating_failed", %error, visible, "切换悬浮窗显示失败");
    }
}

#[cfg(test)]
mod tests {
    use super::{TrayAction, action_for};

    #[test]
    fn menu_ids_map_to_actions() {
        assert_eq!(action_for("open"), Some(TrayAction::OpenMain));
        assert_eq!(action_for("settings"), Some(TrayAction::OpenMain));
        assert_eq!(action_for("quick_add"), Some(TrayAction::QuickAdd));
        assert_eq!(
            action_for("toggle_floating"),
            Some(TrayAction::ToggleFloating)
        );
        assert_eq!(action_for("quit"), Some(TrayAction::Quit));
    }

    #[test]
    fn disabled_and_unknown_items_have_no_action() {
        assert_eq!(action_for("pause_notifications"), None);
        assert_eq!(action_for("nope"), None);
    }
}
