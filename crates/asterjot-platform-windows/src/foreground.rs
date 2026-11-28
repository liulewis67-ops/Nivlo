//! Windows 的前台窗口记忆 / 还原。
//!
//! 决策逻辑在平台无关的 `asterjot_platform::foreground::ForegroundTracker` 中并已有测试；
//! 这里把它接到 Win32：取前台窗口、判断窗口是否存在、设为前台，以及用 `WinEvent` 钩子
//! **持续跟踪"最近一个其他进程的前台窗口"**。
//!
//! 为什么需要钩子：用户点击悬浮窗的按钮时，WebView 可能在 Rust 来得及读取前台窗口之前就把悬浮窗
//! 自己激活了，此时 `GetForegroundWindow` 已经是自己；钩子由系统在前台窗口切换的那一刻通知，
//! 因此始终知道用户之前在哪个应用里。钩子是事件驱动的（`WINEVENT_OUTOFCONTEXT` +
//! `WINEVENT_SKIPOWNPROCESS`），空闲时没有任何开销。

// 本模块是整个仓库中少数允许 `unsafe` 的地方：Win32 API 没有安全封装（后端规范 §9.4）。
#![allow(unsafe_code)]

use std::ffi::c_void;
use std::sync::atomic::{AtomicIsize, Ordering};

use asterjot_platform::error::PlatformError;
use asterjot_platform::foreground::{ForegroundOs, ForegroundPort, ForegroundTracker};
use windows::Win32::Foundation::HWND;
use windows::Win32::UI::Accessibility::{HWINEVENTHOOK, SetWinEventHook, UnhookWinEvent};
use windows::Win32::UI::WindowsAndMessaging::{
    EVENT_SYSTEM_FOREGROUND, GetForegroundWindow, IsWindow, SetForegroundWindow,
    WINEVENT_OUTOFCONTEXT, WINEVENT_SKIPOWNPROCESS,
};

/// 最近一次成为前台的、属于其他进程的窗口。
///
/// `WinEvent` 回调是没有用户数据参数的 `extern "system"` 函数，只能通过静态变量传出结果；
/// 这是一个纯粹的操作系统回调通道（单个原子整数），不是业务状态。
static LAST_OTHER_FOREGROUND: AtomicIsize = AtomicIsize::new(0);

/// 把 `isize` 句柄还原为 `HWND`。
fn to_hwnd(handle: isize) -> HWND {
    HWND(handle as *mut c_void)
}

/// `WinEvent` 回调：前台窗口切换到了其他进程的窗口。
///
/// # Safety
///
/// 只能由系统作为 `WinEvent` 回调调用；这里不解引用任何参数，只记录窗口句柄。
unsafe extern "system" fn on_foreground_changed(
    _hook: HWINEVENTHOOK,
    _event: u32,
    hwnd: HWND,
    _id_object: i32,
    _id_child: i32,
    _event_thread: u32,
    _event_time: u32,
) {
    LAST_OTHER_FOREGROUND.store(hwnd.0 as isize, Ordering::Relaxed);
}

/// 调用 Win32 的 [`ForegroundOs`] 实现。
#[derive(Debug, Default, Clone, Copy)]
pub struct Win32Foreground;

impl ForegroundOs for Win32Foreground {
    /// 当前前台窗口。
    fn foreground(&self) -> isize {
        // SAFETY: `GetForegroundWindow` 没有前置条件，没有前台窗口时返回空句柄（0）。
        let hwnd = unsafe { GetForegroundWindow() };
        hwnd.0 as isize
    }

    /// 钩子记录的最近一个其他进程的前台窗口；钩子没有安装成功时为 0。
    fn last_other_foreground(&self) -> isize {
        LAST_OTHER_FOREGROUND.load(Ordering::Relaxed)
    }

    /// 句柄是否仍指向存在的窗口。
    fn is_window(&self, handle: isize) -> bool {
        // SAFETY: `IsWindow` 接受任意句柄值并返回它是否有效，不会解引用该句柄。
        unsafe { IsWindow(Some(to_hwnd(handle))) }.as_bool()
    }

    /// 把窗口设为前台。
    fn set_foreground(&self, handle: isize) -> bool {
        // SAFETY: 句柄在调用前已由 `is_window` 校验；即使窗口恰好在两次调用之间销毁，
        // `SetForegroundWindow` 也只是返回 FALSE，不会产生未定义行为。
        unsafe { SetForegroundWindow(to_hwnd(handle)) }.as_bool()
    }
}

/// 已安装的 `WinEvent` 钩子；释放时卸载。
struct ForegroundHook(HWINEVENTHOOK);

// SAFETY: `HWINEVENTHOOK` 只是一个不透明的令牌，本类型除了在释放时把它交还给 `UnhookWinEvent`
// 之外从不使用它，跨线程移动令牌本身没有数据竞争。（`UnhookWinEvent` 在非安装线程上调用可能失败，
// 此时钩子随进程退出而释放，不影响正确性。）
unsafe impl Send for ForegroundHook {}
// SAFETY: 同上；本类型没有任何通过 `&self` 访问令牌的方法。
unsafe impl Sync for ForegroundHook {}

impl Drop for ForegroundHook {
    /// 卸载钩子。
    fn drop(&mut self) {
        // SAFETY: `self.0` 是 `SetWinEventHook` 返回的有效令牌，且只在这里卸载一次。
        let _ = unsafe { UnhookWinEvent(self.0) };
    }
}

/// 安装前台窗口切换钩子；失败时返回 `None`（降级为只用当前前台窗口）。
///
/// 钩子回调通过安装线程的消息循环投递，因此必须在带消息循环的线程（Tauri 主线程）上调用。
fn install_hook() -> Option<ForegroundHook> {
    // SAFETY: 回调函数是有效的 `extern "system"` 函数且在整个进程生命周期内存在；
    // `WINEVENT_OUTOFCONTEXT` 让回调在安装线程上异步执行，不会注入其他进程。
    let hook = unsafe {
        SetWinEventHook(
            EVENT_SYSTEM_FOREGROUND,
            EVENT_SYSTEM_FOREGROUND,
            None,
            Some(on_foreground_changed),
            0,
            0,
            WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS,
        )
    };
    if hook.0.is_null() {
        None
    } else {
        Some(ForegroundHook(hook))
    }
}

/// Windows 上的前台窗口记忆 / 还原：决策逻辑 + 持续跟踪前台切换的系统钩子。
pub struct WindowsForeground {
    /// 记忆 / 还原的决策逻辑。
    tracker: ForegroundTracker<Win32Foreground>,
    /// 保持钩子存活；释放时卸载。
    _hook: Option<ForegroundHook>,
}

impl ForegroundPort for WindowsForeground {
    /// 记住用户当前所在的窗口。
    fn remember(&self) -> Result<(), PlatformError> {
        self.tracker.remember()
    }

    /// 还原之前记住的窗口。
    fn restore(&self) -> Result<(), PlatformError> {
        self.tracker.restore()
    }
}

/// 创建 Windows 的前台窗口记忆 / 还原；`own_hwnd` 是悬浮窗自己的窗口句柄。
///
/// 必须在带消息循环的线程（Tauri 主线程）上调用，因为要在该线程上安装系统钩子。
pub fn new_windows_foreground(own_hwnd: isize) -> WindowsForeground {
    WindowsForeground {
        tracker: ForegroundTracker::new(Win32Foreground, own_hwnd),
        _hook: install_hook(),
    }
}
