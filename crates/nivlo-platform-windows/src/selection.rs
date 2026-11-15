//! 读取用户主动触发时前台控件公开的 UI Automation 文字选区。

#![allow(unsafe_code)]

use std::sync::Mutex;

use windows::Win32::System::Com::{
    CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx, CoUninitialize,
};
use windows::Win32::UI::Accessibility::{
    CUIAutomation, IUIAutomation, IUIAutomationTextPattern, UIA_TextPatternId,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GUITHREADINFO, GetForegroundWindow, GetGUIThreadInfo, GetWindowThreadProcessId,
};

/// 触发时的前台窗口和具有键盘焦点的控件句柄。
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct SelectionFocus {
    /// 前台窗口。
    window: isize,
    /// 控件或合成界面的宿主窗口。
    focused: isize,
}

/// 获取触发时的前台焦点，供后台读取前核对。
#[must_use]
pub fn foreground_focus() -> SelectionFocus {
    let mut info = GUITHREADINFO {
        cbSize: u32::try_from(std::mem::size_of::<GUITHREADINFO>()).unwrap_or(0),
        ..Default::default()
    };
    // SAFETY: 结构体已填充 cbSize，Win32 只写入该结构。窗口句柄用于查询和比较。
    unsafe {
        let window = GetForegroundWindow();
        let thread = GetWindowThreadProcessId(window, None);
        let _ = GetGUIThreadInfo(thread, &mut info);
        SelectionFocus {
            window: window.0 as isize,
            focused: info.hwndFocus.0 as isize,
        }
    }
}

/// 在后台线程读取前台控件的选区。忙碌、窗口变化、密码字段以及不支持的控件返回空。
#[must_use]
pub fn read_selection(focus: SelectionFocus) -> Option<String> {
    // 远端 provider 可能阻塞；同一时间只让一个调用进入 COM。
    static READING: Mutex<()> = Mutex::new(());
    let _reading = READING.try_lock().ok()?;
    if focus.window == 0 || foreground_focus() != focus {
        return None;
    }
    // SAFETY: 初始化当前工作线程的 COM apartment。成功后由 Scope 配对反初始化。
    unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }
        .ok()
        .ok()?;
    let _com = ComScope;
    // SAFETY: COM 已初始化。查询仅读取此时的焦点和文本选区。
    let text = unsafe {
        let automation: IUIAutomation =
            CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER).ok()?;
        let element = automation.GetFocusedElement().ok()?;
        if element.CurrentIsPassword().ok()?.as_bool() {
            return None;
        }
        let pattern = element
            .GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId)
            .ok()?;
        let ranges = pattern.GetSelection().ok()?;
        let count = ranges.Length().ok()?;
        let mut parts = Vec::new();
        for index in 0..count {
            let range = ranges.GetElement(index).ok()?;
            let part = range.GetText(-1).ok()?.to_string();
            if !part.trim().is_empty() {
                parts.push(part);
            }
        }
        parts.join("\n")
    };
    (foreground_focus() == focus && !text.is_empty()).then_some(text)
}

/// 当前线程的 COM 初始化守卫。
struct ComScope;

impl Drop for ComScope {
    fn drop(&mut self) {
        // SAFETY: 构造守卫前已成功初始化当前线程的 COM apartment。
        unsafe { CoUninitialize() };
    }
}
