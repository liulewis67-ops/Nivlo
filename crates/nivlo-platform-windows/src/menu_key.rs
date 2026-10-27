//! 单独按一下 Alt 不让窗口进入「键盘菜单模式」。
//!
//! WebView2 把没处理的 Alt 交给宿主窗口，`DefWindowProc` 把它变成 `WM_SYSCOMMAND(SC_KEYMENU)`，
//! 窗口随即进入系统菜单的模态循环。Nivlo 的窗口没有菜单栏，用户什么也看不到，但之后的按键都被
//! 这个循环吃掉，主窗口与悬浮窗的页面都不再响应，直到再按 Esc 或点一下——看起来就是「卡死了」。
//!
//! 这里给窗口加一个子类过程，只吞掉**键盘**触发、没有附带字符的 `SC_KEYMENU`（`lParam == 0`，即
//! 单独按下并松开 Alt）；`Alt+Space` 打开系统菜单（`lParam` 是空格）与鼠标点系统菜单都照常。

// 本模块是整个仓库中少数允许 `unsafe` 的地方：Win32 API 没有安全封装（后端规范 §9.4）。
#![allow(unsafe_code)]

use std::ffi::c_void;

use nivlo_platform::error::PlatformError;
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};
use windows::Win32::UI::WindowsAndMessaging::{SC_KEYMENU, WM_SYSCOMMAND};

/// 子类过程的 ID（同一个窗口重复安装时会替换而不是叠加）。
const SUBCLASS_ID: usize = 0x4E49_564C; // "NIVL"

/// `WM_SYSCOMMAND` 的 `wParam` 低 4 位由系统内部使用，比较命令前要去掉。
const COMMAND_MASK: usize = 0xFFF0;

/// 这条消息是不是「单独按 Alt 进入菜单模式」。
///
/// # Arguments
///
/// * `message` - 消息。
/// * `wparam` - 消息的 `wParam`。
/// * `lparam` - 消息的 `lParam`。
fn is_bare_alt_menu(message: u32, wparam: usize, lparam: isize) -> bool {
    message == WM_SYSCOMMAND && (wparam & COMMAND_MASK) == SC_KEYMENU as usize && lparam == 0
}

/// 子类过程：吞掉单独按 Alt 产生的 `SC_KEYMENU`，其余交给原来的窗口过程。
///
/// # Safety
///
/// 只能由系统作为通过 `SetWindowSubclass` 安装的子类过程调用。
unsafe extern "system" fn subclass_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _id: usize,
    _data: usize,
) -> LRESULT {
    if is_bare_alt_menu(message, wparam.0, lparam.0) {
        return LRESULT(0);
    }
    // SAFETY: 参数原样来自系统，`DefSubclassProc` 只能在子类过程内调用，这里正是。
    unsafe { DefSubclassProc(hwnd, message, wparam, lparam) }
}

/// 给窗口安装子类过程，让单独按 Alt 不再进入键盘菜单模式。
///
/// 必须在创建该窗口的线程（Tauri 主线程）上调用：`SetWindowSubclass` 不能跨线程安装。
///
/// # Errors
///
/// 安装失败（窗口已销毁或不在当前线程）时返回 [`PlatformError::Failed`]；调用方降级为不处理。
pub fn suppress_bare_alt_menu(hwnd: isize) -> Result<(), PlatformError> {
    // SAFETY: 子类过程是在整个进程生命周期内都有效的 `extern "system"` 函数，不使用引用数据；
    // 句柄无效或线程不对时系统只是返回 FALSE。
    let installed = unsafe {
        SetWindowSubclass(
            HWND(hwnd as *mut c_void),
            Some(subclass_proc),
            SUBCLASS_ID,
            0,
        )
    };
    if installed.as_bool() {
        Ok(())
    } else {
        Err(PlatformError::Failed("SetWindowSubclass 失败".into()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows::Win32::UI::WindowsAndMessaging::{SC_CLOSE, WM_KEYDOWN};

    #[test]
    fn only_the_bare_alt_menu_command_is_swallowed() {
        let keymenu = SC_KEYMENU as usize;
        assert!(is_bare_alt_menu(WM_SYSCOMMAND, keymenu, 0));
        // 低 4 位是系统内部用的，不影响判断。
        assert!(is_bare_alt_menu(WM_SYSCOMMAND, keymenu | 0x3, 0));
        // Alt+Space（lParam 是空格）照常打开系统菜单。
        assert!(!is_bare_alt_menu(
            WM_SYSCOMMAND,
            keymenu,
            i32::from(b' ') as isize
        ));
        assert!(!is_bare_alt_menu(WM_SYSCOMMAND, SC_CLOSE as usize, 0));
        assert!(!is_bare_alt_menu(WM_KEYDOWN, keymenu, 0));
    }
}
