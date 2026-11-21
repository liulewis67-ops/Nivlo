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
    /// 从选区或剪贴板预填新增配置。
    ContextCreate,
}

impl ShortcutAction {
    /// 全部动作。
    pub const ALL: [Self; 3] = [Self::QuickCreate, Self::Search, Self::ContextCreate];

    /// 保存绑定的设置键。
    #[must_use]
    pub const fn setting_key(self) -> &'static str {
        match self {
            Self::QuickCreate => SHORTCUT_SETTING_KEY,
            Self::Search => SEARCH_SHORTCUT_SETTING_KEY,
            Self::ContextCreate => "shortcut.context_create",
        }
    }

    /// 默认组合被占用时可以换用的候选（按推荐顺序）。都带两个以上修饰键，避免和应用自己的快捷键撞车。
    pub const fn suggestion_candidates(self) -> &'static [&'static str] {
        match self {
            Self::QuickCreate => &[
                "Ctrl+Alt+N",
                "Alt+Shift+N",
                "Ctrl+Alt+Shift+N",
                "Ctrl+Shift+Q",
            ],
            Self::Search => &["Ctrl+Alt+K", "Alt+Shift+Space", "Alt+Shift+K"],
            Self::ContextCreate => &["Ctrl+Alt+Shift+N", "Alt+Shift+N", "Ctrl+Shift+Q"],
        }
    }

    /// 没有保存绑定时使用的默认值。
    #[must_use]
    pub const fn default_accelerator(self) -> Accelerator {
        match self {
            Self::QuickCreate => Accelerator::QUICK_CREATE_DEFAULT,
            Self::Search => Accelerator::SEARCH_DEFAULT,
            Self::ContextCreate => Accelerator::CONTEXT_CREATE_DEFAULT,
        }
    }
}

/// 设置里表示「停用」的值：不注册任何快捷键。
pub const DISABLED_SETTING_VALUE: &str = "off";

/// 快捷键当前的状态。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShortcutStatus {
    /// 用户的绑定（规范文本，如 `Ctrl+Shift+Space`）。
    pub accelerator: String,
    /// 当前是否已经成功注册到系统。
    pub registered: bool,
    /// 没注册成功的原因是被其他程序占用。
    pub conflict: bool,
    /// 用户主动停用了；`accelerator` 是重新启用时会用的组合。
    pub disabled: bool,
    /// 在用户当前的键盘布局里这个组合会输入字符（AltGr），注册它会让用户打不出那个字符。
    pub types_character: bool,
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
                disabled: false,
                types_character: false,
            }),
        }
    }

    /// 控制的动作。
    pub fn action(&self) -> ShortcutAction {
        self.action
    }

    /// 几个现在可用的组合（最多 `limit` 个），供冲突时一键换用。
    ///
    /// 从这个动作的候选里挑：跳过 `taken`（Nivlo 各动作当前的绑定）、在当前键盘布局里会输入字符的
    /// （AltGr），以及现在注册不了的。平台无法判断是否可用时返回空列表。
    pub fn suggestions(&self, taken: &[String], limit: usize) -> Vec<String> {
        self.action
            .suggestion_candidates()
            .iter()
            .filter_map(|text| parse_accelerator(text).ok())
            .filter(|accelerator| !taken.contains(&accelerator.to_string()))
            .filter(|accelerator| !self.port.types_character(*accelerator))
            .filter(|accelerator| self.port.is_available(*accelerator) == Some(true))
            .take(limit)
            .map(|accelerator| accelerator.to_string())
            .collect()
    }

    /// 当前状态。
    pub fn status(&self) -> ShortcutStatus {
        self.status
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    /// 读取用户保存的绑定（缺失或无法解析时用默认值）并注册；保存的是「停用」时不注册。
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
        if saved.as_deref() == Some(DISABLED_SETTING_VALUE) {
            tracing::info!(event = "shortcut_disabled", action = ?self.action, "全局快捷键已被用户停用");
            self.set_disabled(self.action.default_accelerator());
            return;
        }
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

    /// 停用：取消注册并保存，重启后也不再注册；重新绑定（[`ShortcutController::rebind`]）即重新启用。
    ///
    /// # Errors
    ///
    /// 存储错误：本次运行已经停用，但重启后会恢复原来的绑定。
    pub async fn disable(&self) -> Result<ShortcutStatus, AppError> {
        self.port.unregister();
        let current = self.status().accelerator;
        let accelerator = current
            .parse::<Accelerator>()
            .unwrap_or(self.action.default_accelerator());
        self.set_disabled(accelerator);
        self.settings
            .set(self.action.setting_key(), DISABLED_SETTING_VALUE)
            .await?;
        Ok(self.status())
    }

    /// 取消注册（退出时调用）。
    pub fn stop(&self) {
        self.port.unregister();
    }

    /// 更新状态。
    fn set_status(&self, accelerator: Accelerator, registered: bool, conflict: bool) {
        let types_character = registered && self.port.types_character(accelerator);
        if types_character {
            tracing::warn!(event = "shortcut_types_character", action = ?self.action, accelerator = %accelerator, "当前键盘布局里这个快捷键会输入字符（AltGr）");
        }
        *self.status.lock().unwrap_or_else(PoisonError::into_inner) = ShortcutStatus {
            accelerator: accelerator.to_string(),
            registered,
            conflict,
            disabled: false,
            types_character,
        };
    }

    /// 标记为停用；`accelerator` 是重新启用时用的组合。
    fn set_disabled(&self, accelerator: Accelerator) {
        *self.status.lock().unwrap_or_else(PoisonError::into_inner) = ShortcutStatus {
            accelerator: accelerator.to_string(),
            registered: false,
            conflict: false,
            disabled: true,
            types_character: false,
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
        typing: Mutex<HashSet<String>>,
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
        fn types_character(&self, accelerator: Accelerator) -> bool {
            self.typing
                .lock()
                .unwrap()
                .contains(&accelerator.to_string())
        }
        fn is_available(&self, accelerator: Accelerator) -> Option<bool> {
            Some(
                !self
                    .taken
                    .lock()
                    .unwrap()
                    .contains(&accelerator.to_string()),
            )
        }
    }

    fn controller(port: &Arc<FakePort>) -> (ShortcutController, FakeUnitOfWork, Arc<AtomicUsize>) {
        controller_on(port, &FakeUnitOfWork::new())
    }

    /// 在已有的（共享的）设置数据上创建 Quick Create 的控制器，模拟重启。
    fn controller_on(
        port: &Arc<FakePort>,
        uow: &FakeUnitOfWork,
    ) -> (ShortcutController, FakeUnitOfWork, Arc<AtomicUsize>) {
        let uow = uow.clone();
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
                conflict: false,
                disabled: false,
                types_character: false
            }
        );
    }

    #[tokio::test]
    async fn a_binding_that_types_a_character_on_the_current_layout_is_flagged() {
        let port = Arc::new(FakePort::default());
        port.typing.lock().unwrap().insert("Ctrl+Alt+Q".to_owned());
        let (controller, _, _) = controller(&port);
        controller.start().await;
        assert!(!controller.status().types_character);

        // 仍然注册（用户可能就是想要它），但状态里带上提示。
        let status = controller.rebind("Ctrl+Alt+Q").await.unwrap();
        assert!(status.registered && status.types_character);
        let status = controller.rebind("Ctrl+Alt+W").await.unwrap();
        assert!(!status.types_character);
    }

    #[tokio::test]
    async fn disabling_unregisters_persists_and_survives_a_restart() {
        let port = Arc::new(FakePort::default());
        let (controller, uow, _) = controller(&port);
        controller.start().await;
        controller.rebind("Ctrl+Alt+Q").await.unwrap();

        let status = controller.disable().await.unwrap();
        assert!(status.disabled && !status.registered);
        // 记住原来的组合，重新启用时用它。
        assert_eq!(status.accelerator, "Ctrl+Alt+Q");
        assert_eq!(port.current(), None);
        assert_eq!(
            uow.committed_setting(SHORTCUT_SETTING_KEY).as_deref(),
            Some(DISABLED_SETTING_VALUE)
        );

        // 「重启」：不注册，状态是停用。
        let port2 = Arc::new(FakePort::default());
        let (second, _, _) = controller_on(&port2, &uow);
        second.start().await;
        assert_eq!(port2.current(), None);
        assert!(second.status().disabled);

        // 重新绑定即重新启用。
        let status = second.rebind("Ctrl+Shift+Space").await.unwrap();
        assert!(status.registered && !status.disabled);
        assert_eq!(port2.current().as_deref(), Some("Ctrl+Shift+Space"));
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
    async fn suggestions_skip_taken_bindings_altgr_combinations_and_ones_already_in_use() {
        let port = Arc::new(FakePort::default());
        let (controller, _, _) = controller(&port);
        // 第一个候选被别的程序占用，第二个在当前布局里会打出字符，第三个是 Nivlo 另一个动作正在用的。
        port.take("Ctrl+Alt+N");
        port.typing.lock().unwrap().insert("Alt+Shift+N".to_owned());
        let taken = ["Ctrl+Alt+Shift+N".to_owned()];

        assert_eq!(controller.suggestions(&taken, 3), ["Ctrl+Shift+Q"]);
        assert!(controller.suggestions(&taken, 0).is_empty());
    }

    #[tokio::test]
    async fn no_suggestions_when_the_platform_cannot_tell_what_is_free() {
        /// 注册总是成功、但说不出组合是否可用的平台（`is_available` 用缺省实现）。
        struct UnknownAvailability;
        impl ShortcutPort for UnknownAvailability {
            fn register(&self, _: Accelerator, _: ShortcutCallback) -> Result<(), PlatformError> {
                Ok(())
            }
            fn unregister(&self) {}
        }

        let settings = SettingsService::new(
            Arc::new(FakeUnitOfWork::new()),
            Arc::new(FakeClock::at_utc(
                Utc.with_ymd_and_hms(2026, 10, 10, 8, 0, 0).unwrap(),
            )),
        );
        let controller = ShortcutController::new(
            ShortcutAction::Search,
            Arc::new(UnknownAvailability),
            settings,
            Arc::new(|| {}),
        );
        assert!(controller.suggestions(&[], 3).is_empty());
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
