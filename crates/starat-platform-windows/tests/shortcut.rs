//! 全局快捷键的集成测试：真正向系统注册 `RegisterHotKey`。
//!
//! 冲突检测不需要交互式桌面，普通测试即可；「真的按下组合键」需要交互式桌面会话，
//! 标为 `ignored`，用 `cargo test -p starat-platform-windows -- --ignored` 手动运行。

#![cfg(target_os = "windows")]
#![allow(
    missing_docs,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::missing_docs_in_private_items,
    unsafe_code
)]

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use starat_platform::error::PlatformError;
use starat_platform::shortcut::{Accelerator, ShortcutPort};
use starat_platform_windows::shortcut::WindowsShortcut;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    INPUT, INPUT_0, INPUT_KEYBOARD, KEYBD_EVENT_FLAGS, KEYBDINPUT, KEYEVENTF_KEYUP, SendInput,
    VIRTUAL_KEY,
};

/// 热键是系统级的资源：同一个组合同一时刻只能被一个测试持有，所以这些测试必须串行。
static SERIAL: Mutex<()> = Mutex::new(());

/// 串行执行的守卫。
fn serial() -> MutexGuard<'static, ()> {
    SERIAL.lock().unwrap_or_else(PoisonError::into_inner)
}

/// 一个不太可能被其他程序占用的组合：`Ctrl+Alt+Shift+F13`。
fn rare() -> Accelerator {
    "Ctrl+Alt+Shift+F13".parse().unwrap()
}

/// 什么都不做的回调。
fn noop() -> Arc<dyn Fn() + Send + Sync> {
    Arc::new(|| {})
}

#[test]
fn a_second_registration_of_the_same_combination_is_reported_as_a_conflict() {
    let _guard = serial();
    let first = WindowsShortcut::new();
    first.register(rare(), noop()).unwrap();

    let second = WindowsShortcut::new();
    let error = second.register(rare(), noop()).unwrap_err();
    assert!(
        matches!(&error, PlatformError::Conflict(name) if name == "Ctrl+Alt+Shift+F13"),
        "{error:?}"
    );

    // 第一个释放之后，同一个组合又可以被注册。
    first.unregister();
    second.register(rare(), noop()).unwrap();
}

#[test]
fn a_failed_replacement_keeps_the_previous_shortcut_registered() {
    let _guard = serial();
    let blocker = WindowsShortcut::new();
    let taken: Accelerator = "Ctrl+Alt+Shift+F14".parse().unwrap();
    blocker.register(taken, noop()).unwrap();

    let shortcut = WindowsShortcut::new();
    shortcut.register(rare(), noop()).unwrap();
    // 想换成被占用的组合：失败，并且原来的仍然有效（别人再注册原来的组合会冲突）。
    assert!(matches!(
        shortcut.register(taken, noop()),
        Err(PlatformError::Conflict(_))
    ));
    let probe = WindowsShortcut::new();
    assert!(matches!(
        probe.register(rare(), noop()),
        Err(PlatformError::Conflict(_))
    ));
}

#[test]
fn unregister_frees_the_combination_and_is_idempotent() {
    let _guard = serial();
    let shortcut = WindowsShortcut::new();
    shortcut.unregister();
    shortcut.register(rare(), noop()).unwrap();
    shortcut.unregister();
    shortcut.unregister();
    WindowsShortcut::new().register(rare(), noop()).unwrap();
}

/// 构造一个键盘事件。
fn key(vk: u16, up: bool) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VIRTUAL_KEY(vk),
                wScan: 0,
                dwFlags: if up {
                    KEYEVENTF_KEYUP
                } else {
                    KEYBD_EVENT_FLAGS(0)
                },
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

#[test]
#[ignore = "需要交互式桌面会话：向系统注入真实的按键"]
fn pressing_the_combination_invokes_the_callback_once() {
    let _guard = serial();
    let presses = Arc::new(AtomicUsize::new(0));
    let counter = presses.clone();
    let shortcut = WindowsShortcut::new();
    shortcut
        .register(
            rare(),
            Arc::new(move || {
                counter.fetch_add(1, Ordering::SeqCst);
            }),
        )
        .unwrap();

    // Ctrl、Alt、Shift 按下 → F13 按下并抬起 → 修饰键抬起。
    const CTRL: u16 = 0x11;
    const ALT: u16 = 0x12;
    const SHIFT: u16 = 0x10;
    const F13: u16 = 0x7C;
    let inputs = [
        key(CTRL, false),
        key(ALT, false),
        key(SHIFT, false),
        key(F13, false),
        key(F13, true),
        key(SHIFT, true),
        key(ALT, true),
        key(CTRL, true),
    ];
    // SAFETY: `inputs` 是有效的 `INPUT` 数组，大小参数与元素类型一致。
    let sent = unsafe { SendInput(&inputs, size_of::<INPUT>() as i32) };
    assert_eq!(sent as usize, inputs.len());

    let deadline = Instant::now() + Duration::from_secs(3);
    while presses.load(Ordering::SeqCst) == 0 && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(presses.load(Ordering::SeqCst), 1);
}
