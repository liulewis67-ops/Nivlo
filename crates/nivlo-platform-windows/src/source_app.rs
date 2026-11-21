//! Windows 的来源应用识别（实施计划 10.4）。
//!
//! 取「用户之前所在的窗口」（前台钩子记录的最近一个其他进程的前台窗口；没有钩子时退回当前前台窗口）
//! → 窗口所属进程 → 进程的可执行文件名 → 显示名。读取只发生在捕获的那一刻。

// 本模块含 Win32 调用（后端规范 §9.4）：每个 `unsafe` 块都有 SAFETY 注释。
#![allow(unsafe_code)]

use std::path::Path;

use nivlo_platform::foreground::ForegroundOs;
use nivlo_platform::source_app::{SourceApplicationPort, friendly_app_name};
use windows::Win32::Foundation::{CloseHandle, HWND};
use windows::Win32::System::Threading::{
    GetCurrentProcessId, OpenProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
    QueryFullProcessImageNameW,
};
use windows::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId;
use windows::core::PWSTR;

use crate::foreground::Win32Foreground;

/// 进程的可执行文件名（不含扩展名）；进程已退出或没有权限查询时为 `None`。
#[must_use]
pub fn process_image_stem(pid: u32) -> Option<String> {
    // SAFETY: `OpenProcess` 只需要一个进程号；成功时返回的句柄由本函数负责关闭。
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }.ok()?;
    let mut buffer = [0_u16; 1024];
    let mut length = u32::try_from(buffer.len()).unwrap_or(1024);
    // SAFETY: `buffer` 有 `length` 个可写的 u16；函数返回时把实际长度写回 `length`。
    let queried = unsafe {
        QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_WIN32,
            PWSTR(buffer.as_mut_ptr()),
            &raw mut length,
        )
    };
    // SAFETY: `handle` 来自上面成功的 `OpenProcess`，这里是唯一一次关闭。
    let _ = unsafe { CloseHandle(handle) };
    queried.ok()?;
    let path = String::from_utf16_lossy(&buffer[..usize::try_from(length).ok()?]);
    Path::new(&path)
        .file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
}

/// 窗口所属进程的进程号。
pub(crate) fn window_process_id(hwnd: isize) -> Option<u32> {
    let mut pid = 0_u32;
    // SAFETY: `GetWindowThreadProcessId` 接受任意窗口句柄值，窗口不存在时返回 0 且不写 `pid`；
    // `pid` 是有效的输出指针。
    let thread = unsafe {
        GetWindowThreadProcessId(HWND(hwnd as *mut std::ffi::c_void), Some(&raw mut pid))
    };
    (thread != 0 && pid != 0).then_some(pid)
}

/// 基于前台窗口钩子的来源应用识别。
#[derive(Debug, Default, Clone, Copy)]
pub struct WindowsSourceApplication;

impl SourceApplicationPort for WindowsSourceApplication {
    /// 用户之前所在应用的显示名；就是 Nivlo 自己（或识别不到）时为 `None`。
    fn source_application(&self) -> Option<String> {
        let os = Win32Foreground;
        let hwnd = match os.last_other_foreground() {
            0 => os.foreground(),
            handle => handle,
        };
        if hwnd == 0 {
            return None;
        }
        let pid = window_process_id(hwnd)?;
        // SAFETY: `GetCurrentProcessId` 没有前置条件。
        if pid == unsafe { GetCurrentProcessId() } {
            return None;
        }
        process_image_stem(pid).map(|stem| friendly_app_name(&stem))
    }
}
