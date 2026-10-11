//! 系统托盘（实施计划 1.9）。
//!
//! 托盘是应用常驻的"安全出口"：悬浮窗被隐藏、主窗口被关闭后，用户仍然可以从托盘
//! 打开 Nivlo、快速添加、重新显示悬浮窗或退出。菜单项的行为由纯函数 [`action_for`]
//! 决定，因此可以脱离系统托盘做单元测试。

use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Wry};
use tauri_specta::Event;

use crate::app::AppState;
use crate::events::QuickAddRequestedEvent;
use crate::native_i18n::Lang;
use crate::scheduling::PauseMenuItem;
use crate::windows::{self, FLOATING_WINDOW_LABEL};

/// 托盘图标的 ID。
const TRAY_ID: &str = "nivlo-tray";

/// 一种语言下的全部菜单文案。
struct Labels {
    /// 托盘悬停提示。
    tooltip: &'static str,
    /// 打开主窗口。
    open: &'static str,
    /// 快速添加。
    quick_add: &'static str,
    /// 显示 / 隐藏悬浮窗。
    toggle_floating: &'static str,
    /// 暂停通知（勾选 = 已暂停）。
    pause_notifications: &'static str,
    /// 设置。
    settings: &'static str,
    /// 退出。
    quit: &'static str,
}

/// 按语言选择菜单文案。
fn labels(lang: Lang) -> Labels {
    match lang {
        Lang::ZhCn => Labels {
            tooltip: "拾序 Nivlo",
            open: "打开拾序",
            quick_add: "快速添加待办",
            toggle_floating: "显示 / 隐藏悬浮窗",
            pause_notifications: "暂停通知",
            settings: "设置",
            quit: "退出",
        },
        Lang::En => Labels {
            tooltip: "Nivlo",
            open: "Open Nivlo",
            quick_add: "Quick add to-do",
            toggle_floating: "Show / hide floating window",
            pause_notifications: "Pause notifications",
            settings: "Settings",
            quit: "Quit",
        },
    }
}

/// 托盘菜单项的句柄，切换语言时用来更新文案。
pub struct TrayMenuItems {
    /// 托盘图标。
    tray: tauri::tray::TrayIcon<Wry>,
    /// 打开主窗口。
    open: MenuItem<Wry>,
    /// 快速添加。
    quick_add: MenuItem<Wry>,
    /// 显示 / 隐藏悬浮窗。
    toggle: MenuItem<Wry>,
    /// 暂停通知。
    pause: CheckMenuItem<Wry>,
    /// 设置。
    settings: MenuItem<Wry>,
    /// 退出。
    quit: MenuItem<Wry>,
}

/// 把托盘菜单与悬停提示切换到 `lang`；托盘不存在（创建失败）时什么都不做。
pub fn apply_language<R: tauri::Runtime>(app: &AppHandle<R>, lang: Lang) {
    let Some(items) = app.try_state::<TrayMenuItems>() else {
        return;
    };
    let text = labels(lang);
    let results = [
        items.open.set_text(text.open),
        items.quick_add.set_text(text.quick_add),
        items.toggle.set_text(text.toggle_floating),
        items.pause.set_text(text.pause_notifications),
        items.settings.set_text(text.settings),
        items.quit.set_text(text.quit),
        items.tray.set_tooltip(Some(text.tooltip)),
    ];
    for error in results.into_iter().filter_map(Result::err) {
        tracing::warn!(event = "tray_language_failed", %error, "切换托盘语言失败");
    }
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
    /// 暂停 / 恢复系统通知。
    TogglePause,
    /// 退出应用（走有序退出流程）。
    Quit,
}

/// 菜单项 ID → 动作。未知 ID 没有动作。
///
/// 「设置」打开主窗口（设置页在主窗口侧栏里）。
#[must_use]
pub fn action_for(id: &str) -> Option<TrayAction> {
    match id {
        ids::OPEN | ids::SETTINGS => Some(TrayAction::OpenMain),
        ids::QUICK_ADD => Some(TrayAction::QuickAdd),
        ids::TOGGLE_FLOATING => Some(TrayAction::ToggleFloating),
        ids::PAUSE_NOTIFICATIONS => Some(TrayAction::TogglePause),
        ids::QUIT => Some(TrayAction::Quit),
        _ => None,
    }
}

/// 创建托盘图标与菜单。左键单击打开主窗口，右键弹出菜单。
///
/// # Errors
///
/// 菜单或托盘图标创建失败时返回 Tauri 错误；调用方应记录并继续运行（托盘不是必需功能）。
pub fn setup(app: &AppHandle<Wry>, lang: Lang) -> tauri::Result<()> {
    let text = labels(lang);
    let open = MenuItem::with_id(app, ids::OPEN, text.open, true, None::<&str>)?;
    let quick_add = MenuItem::with_id(app, ids::QUICK_ADD, text.quick_add, true, None::<&str>)?;
    let toggle = MenuItem::with_id(
        app,
        ids::TOGGLE_FLOATING,
        text.toggle_floating,
        true,
        None::<&str>,
    )?;
    // 勾选 = 通知已暂停；初始状态取自 Scheduler（启动时已读取上次保存的设置）。
    let paused = app
        .try_state::<AppState>()
        .is_some_and(|state| state.runtime.scheduler_control().is_paused());
    let pause = CheckMenuItem::with_id(
        app,
        ids::PAUSE_NOTIFICATIONS,
        text.pause_notifications,
        true,
        paused,
        None::<&str>,
    )?;
    app.manage(PauseMenuItem(pause.clone()));
    let settings = MenuItem::with_id(app, ids::SETTINGS, text.settings, true, None::<&str>)?;
    let quit = MenuItem::with_id(app, ids::QUIT, text.quit, true, None::<&str>)?;
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
        .tooltip(text.tooltip)
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
    let tray = builder.build(app)?;
    app.manage(TrayMenuItems {
        tray,
        open,
        quick_add,
        toggle,
        pause,
        settings,
        quit,
    });
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
        TrayAction::QuickAdd => request_quick_add(app),
        TrayAction::ToggleFloating => {
            let visible = app
                .get_webview_window(FLOATING_WINDOW_LABEL)
                .and_then(|window| window.is_visible().ok())
                .unwrap_or(true);
            set_floating_visible(app, !visible);
        }
        TrayAction::TogglePause => {
            // 勾选框已经被系统切换过：新的勾选状态就是用户想要的状态。
            let paused = app
                .try_state::<PauseMenuItem>()
                .and_then(|item| item.0.is_checked().ok())
                .unwrap_or(false);
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let state = app.state::<AppState>();
                if let Err(error) = crate::scheduling::set_paused(&app, &state, paused).await {
                    tracing::warn!(event = "pause_notifications_failed", %error, "切换暂停通知失败");
                    // 保存失败：把勾选状态还原成实际状态。
                    if let Some(item) = app.try_state::<PauseMenuItem>() {
                        let _ = item
                            .0
                            .set_checked(state.runtime.scheduler_control().is_paused());
                    }
                }
            });
        }
        TrayAction::Quit => {
            // 与主窗口的 quit_app 同一条路径：由 RunEvent::ExitRequested 触发有序退出。
            app.exit(0);
        }
    }
}

/// 请求悬浮窗进入快速创建：被隐藏时先显示出来，再通知它展开并聚焦输入。
///
/// 托盘「快速添加」与全局快捷键共用这一条路径。
pub fn request_quick_add(app: &AppHandle<Wry>) {
    set_floating_visible(app, true);
    let event = QuickAddRequestedEvent {};
    if let Err(error) = event.emit_to(app, FLOATING_WINDOW_LABEL) {
        tracing::warn!(event = "quick_add_request_failed", %error, "请求快速添加失败");
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
        assert_eq!(
            action_for("pause_notifications"),
            Some(TrayAction::TogglePause)
        );
        assert_eq!(action_for("nope"), None);
    }
}
