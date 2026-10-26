//! 全局快捷键控制器（实施计划 2.6）：读取 / 保存用户的绑定、向系统注册、处理冲突。
//!
//! 每个 [`ShortcutAction`] 一个控制器、一个独立的平台注册：
//!
//! * Quick Create：默认 `Ctrl+Shift+Space`（产品文档 §6.2），保存在设置 `shortcut.quick_create`；
//! * 全局搜索：默认 `Ctrl+Alt+Space`，保存在设置 `shortcut.search`。
//!
//! 启动时注册失败（被其他程序占用）**不是致命错误**：应用继续运行，状态里记下冲突，
//! 界面据此提示用户并引导重新绑定；重新绑定时新的注册失败会保持旧的不变。

use std::sync::{Arc, Mutex, PoisonError};

use nivlo_application::error::{AppError, ErrorCode};
use nivlo_application::settings::SettingsService;
use nivlo_platform::error::PlatformError;
use nivlo_platform::shortcut::{Accelerator, ShortcutCallback, ShortcutPort};

/// 当前平台的快捷键注册：Windows 用 `RegisterHotKey`，其他平台暂不支持（返回 `Unsupported`）。
#[must_use]
pub fn platform_port() -> Arc<dyn ShortcutPort> {
    #[cfg(target_os = "windows")]
    {
        Arc::new(nivlo_platform_windows::shortcut::WindowsShortcut::new())
    }
    #[cfg(not(target_os = "windows"))]
    {
        Arc::new(UnsupportedShortcut)
    }
}

/// 不支持全局快捷键的平台。
#[cfg(not(target_os = "windows"))]
struct UnsupportedShortcut;

#[cfg(not(target_os = "windows"))]
impl ShortcutPort for UnsupportedShortcut {
    /// 总是返回 `Unsupported`。
    fn register(&self, _: Accelerator, _: ShortcutCallback) -> Result<(), PlatformError> {
        Err(PlatformError::Unsupported("全局快捷键".to_owned()))
    }

    /// 空操作。
    fn unregister(&self) {}
}

/// 保存 Quick Create 快捷键的设置键。
pub const SHORTCUT_SETTING_KEY: &str = "shortcut.quick_create";

/// 保存全局搜索快捷键的设置键。
pub const SEARCH_SHORTCUT_SETTING_KEY: &str = "shortcut.search";

/// 可以绑定全局快捷键的动作。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ShortcutAction {
    /// 在悬浮窗里快速创建。
    QuickCreate,
    /// 打开全局搜索框。
    Search,
}

impl ShortcutAction {
    /// 全部动作。
    pub const ALL: [Self; 2] = [Self::QuickCreate, Self::Search];

    /// 保存绑定的设置键。
    #[must_use]
    pub const fn setting_key(self) -> &'static str {
        match self {
            Self::QuickCreate => SHORTCUT_SETTING_KEY,
            Self::Search => SEARCH_SHORTCUT_SETTING_KEY,
        }
    }

    /// 没有保存绑定时使用的默认值。
    #[must_use]
    pub const fn default_accelerator(self) -> Accelerator {
        match self {
            Self::QuickCreate => Accelerator::QUICK_CREATE_DEFAULT,
            Self::Search => Accelerator::SEARCH_DEFAULT,
        }
    }
}

/// 快捷键当前的状态。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShortcutStatus {
    /// 用户的绑定（规范文本，如 `Ctrl+Shift+Space`）。
    pub accelerator: String,
    /// 当前是否已经成功注册到系统。
    pub registered: bool,
    /// 没注册成功的原因是被其他程序占用。
    pub conflict: bool,
}

/// 快捷键控制器（一个动作一个）。
pub struct ShortcutController {
    /// 控制的动作，决定设置键与默认值。
    action: ShortcutAction,
    /// 平台注册。
    port: Arc<dyn ShortcutPort>,
    /// 设置读写。
    settings: SettingsService,
    /// 按下时的动作。
    on_pressed: ShortcutCallback,
    /// 当前状态。
    status: Mutex<ShortcutStatus>,
}

impl ShortcutController {
    /// 创建控制器；尚未注册，调用 [`ShortcutController::start`] 开始。
    pub fn new(
        action: ShortcutAction,
        port: Arc<dyn ShortcutPort>,
        settings: SettingsService,
        on_pressed: ShortcutCallback,
    ) -> Self {
        Self {
            action,
            port,
            settings,
            on_pressed,
            status: Mutex::new(ShortcutStatus {
                accelerator: action.default_accelerator().to_string(),
                registered: false,
                conflict: false,
            }),
        }
    }

    /// 控制的动作。
    pub fn action(&self) -> ShortcutAction {
        self.action
    }

    /// 当前状态。
    pub fn status(&self) -> ShortcutStatus {
        self.status
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    /// 读取用户保存的绑定（缺失或无法解析时用默认值）并注册。
    ///
    /// 注册失败只记录日志并把状态标为未注册，不返回错误。
    pub async fn start(&self) {
        let saved = match self.settings.get(self.action.setting_key()).await {
            Ok(value) => value,
            Err(error) => {
                tracing::warn!(event = "shortcut_setting_read_failed", %error, "读取快捷键设置失败，使用默认值");
                None
            }
        };
        let accelerator = saved
            .as_deref()
            .and_then(|text| text.parse::<Accelerator>().ok())
            .unwrap_or(self.action.default_accelerator());
        match self.port.register(accelerator, self.on_pressed.clone()) {
            Ok(()) => {
                tracing::info!(event = "shortcut_registered", action = ?self.action, accelerator = %accelerator, "全局快捷键已注册");
                self.set_status(accelerator, true, false);
            }
            Err(error) => {
                let conflict = matches!(error, PlatformError::Conflict(_));
                tracing::warn!(event = "shortcut_register_failed", action = ?self.action, accelerator = %accelerator, %error, "全局快捷键注册失败");
                self.set_status(accelerator, false, conflict);
            }
        }
    }

    /// 改成新的绑定并保存。
    ///
    /// 新的注册失败时保持原来的绑定不变，也不保存。
    ///
    /// # Errors
    ///
    /// * `SHORTCUT_INVALID` - 文本不是合法的快捷键（没有修饰键、不认识的按键…）。
    /// * `SHORTCUT_CONFLICT` - 已被其他程序占用。
    /// * `INVALID_INPUT` - 当前平台不支持全局快捷键，或系统调用失败。
    /// * 存储错误：注册成功但保存设置失败时，快捷键本次运行仍然有效。
    pub async fn rebind(&self, text: &str) -> Result<ShortcutStatus, AppError> {
        let accelerator = parse_accelerator(text)?;
        self.port
            .register(accelerator, self.on_pressed.clone())
            .map_err(|error| match error {
                PlatformError::Conflict(name) => AppError::new(
                    ErrorCode::ShortcutConflict,
                    format!("快捷键 {name} 已被其他程序占用"),
                ),
                other => AppError::new(ErrorCode::InvalidInput, other.to_string()),
            })?;
        self.set_status(accelerator, true, false);
        self.settings
            .set(self.action.setting_key(), &accelerator.to_string())
            .await?;
        Ok(self.status())
    }

    /// 取消注册（退出时调用）。
    pub fn stop(&self) {
        self.port.unregister();
    }

    /// 更新状态。
    fn set_status(&self, accelerator: Accelerator, registered: bool, conflict: bool) {
        *self.status.lock().unwrap_or_else(PoisonError::into_inner) = ShortcutStatus {
            accelerator: accelerator.to_string(),
            registered,
            conflict,
        };
    }
}

/// 解析用户输入的快捷键文本。
///
/// # Errors
///
/// 不是合法的快捷键时返回 `SHORTCUT_INVALID`。
pub fn parse_accelerator(text: &str) -> Result<Accelerator, AppError> {
    text.parse().map_err(|error| {
        AppError::new(
            ErrorCode::ShortcutInvalid,
            format!("无效的快捷键「{text}」：{error}"),
        )
    })
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use std::collections::HashSet;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use chrono::{TimeZone, Utc};
    use nivlo_application::testing::FakeUnitOfWork;
    use nivlo_common::clock::FakeClock;

    use super::*;

    /// 记录注册的假端口；`taken` 里的组合会报告冲突。
    #[derive(Default)]
    struct FakePort {
        taken: Mutex<HashSet<String>>,
        current: Mutex<Option<String>>,
    }

    impl FakePort {
        fn take(&self, name: &str) {
            self.taken.lock().unwrap().insert(name.to_owned());
        }
        fn current(&self) -> Option<String> {
            self.current.lock().unwrap().clone()
        }
    }

    impl ShortcutPort for FakePort {
        fn register(
            &self,
            accelerator: Accelerator,
            _: ShortcutCallback,
        ) -> Result<(), PlatformError> {
            let name = accelerator.to_string();
            if self.taken.lock().unwrap().contains(&name) {
                return Err(PlatformError::Conflict(name));
            }
            *self.current.lock().unwrap() = Some(name);
            Ok(())
        }
        fn unregister(&self) {
            *self.current.lock().unwrap() = None;
        }
    }

    fn controller(port: &Arc<FakePort>) -> (ShortcutController, FakeUnitOfWork, Arc<AtomicUsize>) {
        let uow = FakeUnitOfWork::new();
        let clock = FakeClock::at_utc(Utc.with_ymd_and_hms(2026, 10, 10, 8, 0, 0).unwrap());
        let settings = SettingsService::new(Arc::new(uow.clone()), Arc::new(clock));
        let presses = Arc::new(AtomicUsize::new(0));
        let counter = presses.clone();
        let controller = ShortcutController::new(
            ShortcutAction::QuickCreate,
            port.clone(),
            settings,
            Arc::new(move || {
                counter.fetch_add(1, Ordering::SeqCst);
            }),
        );
        (controller, uow, presses)
    }

    #[tokio::test]
    async fn starts_with_the_default_when_nothing_is_saved() {
        let port = Arc::new(FakePort::default());
        let (controller, _, _) = controller(&port);
        controller.start().await;
        assert_eq!(port.current().as_deref(), Some("Ctrl+Shift+Space"));
        assert_eq!(
            controller.status(),
            ShortcutStatus {
                accelerator: "Ctrl+Shift+Space".to_owned(),
                registered: true,
                conflict: false
            }
        );
    }

    #[tokio::test]
    async fn a_conflict_at_startup_is_not_fatal_and_is_reported_in_the_status() {
        let port = Arc::new(FakePort::default());
        port.take("Ctrl+Shift+Space");
        let (controller, _, _) = controller(&port);
        controller.start().await;
        let status = controller.status();
        assert!(!status.registered && status.conflict);
        assert_eq!(port.current(), None);
    }

    #[tokio::test]
    async fn an_unparsable_saved_value_falls_back_to_the_default() {
        let port = Arc::new(FakePort::default());
        let (controller, uow, _) = controller(&port);
        controller
            .settings
            .set(SHORTCUT_SETTING_KEY, "not a shortcut")
            .await
            .unwrap();
        let _ = uow;
        controller.start().await;
        assert_eq!(port.current().as_deref(), Some("Ctrl+Shift+Space"));
    }

    #[tokio::test]
    async fn rebinding_registers_saves_and_survives_a_restart() {
        let port = Arc::new(FakePort::default());
        let (controller, uow, _) = controller(&port);
        controller.start().await;

        let status = controller.rebind("alt + ctrl + q").await.unwrap();
        assert_eq!(status.accelerator, "Ctrl+Alt+Q");
        assert!(status.registered);
        assert_eq!(port.current().as_deref(), Some("Ctrl+Alt+Q"));
        assert_eq!(
            uow.committed_setting(SHORTCUT_SETTING_KEY).as_deref(),
            Some("Ctrl+Alt+Q")
        );

        // 「重启」：新的控制器读取保存的绑定。
        let port2 = Arc::new(FakePort::default());
        let settings = SettingsService::new(
            Arc::new(uow.clone()),
            Arc::new(FakeClock::at_utc(
                Utc.with_ymd_and_hms(2026, 10, 10, 9, 0, 0).unwrap(),
            )),
        );
        let second = ShortcutController::new(
            ShortcutAction::QuickCreate,
            port2.clone(),
            settings,
            Arc::new(|| {}),
        );
        second.start().await;
        assert_eq!(port2.current().as_deref(), Some("Ctrl+Alt+Q"));
    }

    #[tokio::test]
    async fn a_conflicting_rebind_is_reported_and_keeps_the_old_binding() {
        let port = Arc::new(FakePort::default());
        let (controller, uow, _) = controller(&port);
        controller.start().await;
        port.take("Ctrl+Alt+Q");

        let error = controller.rebind("Ctrl+Alt+Q").await.unwrap_err();
        assert_eq!(error.code, ErrorCode::ShortcutConflict);
        assert_eq!(controller.status().accelerator, "Ctrl+Shift+Space");
        assert_eq!(port.current().as_deref(), Some("Ctrl+Shift+Space"));
        assert_eq!(
            uow.committed_setting(SHORTCUT_SETTING_KEY),
            None,
            "不保存失败的绑定"
        );
    }

    #[tokio::test]
    async fn an_invalid_rebind_is_rejected_with_a_specific_code() {
        let port = Arc::new(FakePort::default());
        let (controller, _, _) = controller(&port);
        controller.start().await;
        for text in ["", "Space", "Ctrl+Shift", "Ctrl+Banana"] {
            let error = controller.rebind(text).await.unwrap_err();
            assert_eq!(error.code, ErrorCode::ShortcutInvalid, "{text}");
        }
        assert_eq!(port.current().as_deref(), Some("Ctrl+Shift+Space"));
    }

    #[tokio::test]
    async fn fixing_a_startup_conflict_by_rebinding_clears_the_conflict() {
        let port = Arc::new(FakePort::default());
        port.take("Ctrl+Shift+Space");
        let (controller, _, _) = controller(&port);
        controller.start().await;
        assert!(controller.status().conflict);

        let status = controller.rebind("Ctrl+Alt+Space").await.unwrap();
        assert!(status.registered && !status.conflict);
    }

    #[tokio::test]
    async fn the_search_action_has_its_own_default_and_setting() {
        let port = Arc::new(FakePort::default());
        let uow = FakeUnitOfWork::new();
        let clock = FakeClock::at_utc(Utc.with_ymd_and_hms(2026, 10, 10, 8, 0, 0).unwrap());
        let settings = SettingsService::new(Arc::new(uow.clone()), Arc::new(clock));
        let controller = ShortcutController::new(
            ShortcutAction::Search,
            port.clone(),
            settings,
            Arc::new(|| {}),
        );
        controller.start().await;
        assert_eq!(port.current().as_deref(), Some("Ctrl+Alt+Space"));

        controller.rebind("Ctrl+Alt+F").await.unwrap();
        assert_eq!(
            uow.committed_setting(SEARCH_SHORTCUT_SETTING_KEY)
                .as_deref(),
            Some("Ctrl+Alt+F")
        );
        assert_eq!(uow.committed_setting(SHORTCUT_SETTING_KEY), None);
    }
}
