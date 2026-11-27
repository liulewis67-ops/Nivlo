//! Windows 的系统电源 / 时钟事件（实施计划 10.5）：休眠恢复（`WM_POWERBROADCAST`）与系统时间被改动
//! （`WM_TIMECHANGE`）。
//!
//! 另外监听显示器配置变化（`WM_DISPLAYCHANGE`，实施计划 10.3）。
//!
//! 在一个专用线程里创建一个**隐藏的顶层窗口**并跑消息循环：这两类消息是广播给顶层窗口的，
//! 消息专用窗口（`HWND_MESSAGE`）收不到。窗口从不显示、不进任务栏。事件回调只负责「通知」
//! （例如唤醒 Scheduler 去 Reconcile），回调里不做重活。空闲时线程阻塞在 `GetMessageW`，没有任何轮询。

// 本模块含 Win32 调用（后端规范 §9.4）：每个 `unsafe` 块都有 SAFETY 注释。
#![allow(unsafe_code)]

use std::ffi::c_void;
use std::sync::Arc;
use std::sync::mpsc::channel;
use std::thread::JoinHandle;

use starat_platform::error::PlatformError;
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::{
    CREATESTRUCTW, CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GWLP_USERDATA,
    GetMessageW, GetWindowLongPtrW, MSG, PBT_APMRESUMEAUTOMATIC, PBT_APMRESUMESUSPEND,
    PostMessageW, PostQuitMessage, RegisterClassW, SetWindowLongPtrW, TranslateMessage,
    WINDOW_EX_STYLE, WINDOW_STYLE, WM_CLOSE, WM_DESTROY, WM_DISPLAYCHANGE, WM_NCCREATE,
    WM_NCDESTROY, WM_POWERBROADCAST, WM_TIMECHANGE, WNDCLASSW, WS_EX_TOOLWINDOW, WS_OVERLAPPED,
};
use windows::core::w;

/// 系统事件。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PowerEvent {
    /// 从休眠 / 睡眠中恢复。
    Resumed,
    /// 系统时间被用户或时间同步改动。
    TimeChanged,
    /// 显示器配置变化（拔掉 / 接上显示器、分辨率或缩放比例改变，`WM_DISPLAYCHANGE`）。
    DisplayChanged,
}

/// 事件回调（在监听线程上调用，必须很快返回）。
type Callback = Arc<dyn Fn(PowerEvent) + Send + Sync>;

/// 窗口类名。
const CLASS_NAME: windows::core::PCWSTR = w!("StarAtPowerEvents");

/// 窗口过程：把电源 / 时钟消息翻译成 [`PowerEvent`] 交给回调。
///
/// # Safety
///
/// 只能由系统作为窗口过程调用。`GWLP_USERDATA` 里存的是 `WM_NCCREATE` 时放入的
/// `Box<Callback>` 的裸指针，在 `WM_NCDESTROY`（该窗口收到的最后一条消息）时释放。
unsafe extern "system" fn window_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match message {
        WM_NCCREATE => {
            // SAFETY: `WM_NCCREATE` 的 `lparam` 指向有效的 `CREATESTRUCTW`，其 `lpCreateParams`
            // 是 `create_window` 传入的 `Box<Callback>` 裸指针。
            let create = unsafe { &*(lparam.0 as *const CREATESTRUCTW) };
            // SAFETY: 窗口刚创建，把回调指针存进它自己的用户数据槽。
            unsafe { SetWindowLongPtrW(hwnd, GWLP_USERDATA, create.lpCreateParams as isize) };
        }
        WM_POWERBROADCAST | WM_TIMECHANGE | WM_DISPLAYCHANGE => {
            // SAFETY: 用户数据槽里要么是 0（尚未设置 / 已清除），要么是上面存入的有效 `Box<Callback>` 指针。
            let pointer = unsafe { GetWindowLongPtrW(hwnd, GWLP_USERDATA) } as *const Callback;
            if !pointer.is_null() {
                let event = match message {
                    WM_TIMECHANGE => Some(PowerEvent::TimeChanged),
                    WM_DISPLAYCHANGE => Some(PowerEvent::DisplayChanged),
                    _ if wparam.0 == PBT_APMRESUMEAUTOMATIC as usize
                        || wparam.0 == PBT_APMRESUMESUSPEND as usize =>
                    {
                        Some(PowerEvent::Resumed)
                    }
                    _ => None,
                };
                if let Some(event) = event {
                    // SAFETY: 指针有效（见上），回调在窗口存活期间一直存在。
                    (unsafe { &*pointer })(event);
                }
            }
        }
        WM_CLOSE => {
            // SAFETY: `hwnd` 是本过程正在处理的窗口。
            let _ = unsafe { DestroyWindow(hwnd) };
            return LRESULT(0);
        }
        WM_DESTROY => {
            // SAFETY: 结束本线程的消息循环。
            unsafe { PostQuitMessage(0) };
        }
        WM_NCDESTROY => {
            // SAFETY: 取出并清空用户数据槽；这是窗口的最后一条消息，之后不会再有回调使用该指针。
            let pointer = unsafe { SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0) } as *mut Callback;
            if !pointer.is_null() {
                // SAFETY: 指针来自 `Box::into_raw`，且只在这里释放一次。
                drop(unsafe { Box::from_raw(pointer) });
            }
        }
        _ => {}
    }
    // SAFETY: 对未处理的消息交给系统默认处理，参数原样转交。
    unsafe { DefWindowProcW(hwnd, message, wparam, lparam) }
}

/// 在当前线程创建隐藏窗口；`callback` 的所有权交给窗口（`WM_NCDESTROY` 时释放）。
fn create_window(callback: Callback) -> Result<HWND, PlatformError> {
    // SAFETY: 取当前模块句柄，没有前置条件。
    let instance = unsafe { GetModuleHandleW(None) }
        .map_err(|e| PlatformError::Failed(format!("无法获取模块句柄：{e}")))?;
    let class = WNDCLASSW {
        lpfnWndProc: Some(window_proc),
        hInstance: instance.into(),
        lpszClassName: CLASS_NAME,
        ..Default::default()
    };
    // SAFETY: `class` 的字符串是 `'static` 的，窗口过程是有效的函数指针。重复注册同名类会返回 0，
    // 此时窗口类已存在，直接继续创建窗口即可。
    let _ = unsafe { RegisterClassW(&class) };
    let boxed = Box::into_raw(Box::new(callback));
    // SAFETY: 窗口类已注册；`boxed` 作为创建参数传入，`WM_NCCREATE` 里转存，所有权随窗口转移。
    let created = unsafe {
        CreateWindowExW(
            WINDOW_EX_STYLE(WS_EX_TOOLWINDOW.0),
            CLASS_NAME,
            w!("StarAt power events"),
            WINDOW_STYLE(WS_OVERLAPPED.0),
            0,
            0,
            0,
            0,
            None,
            None,
            Some(instance.into()),
            Some(boxed.cast::<c_void>()),
        )
    };
    match created {
        Ok(hwnd) => Ok(hwnd),
        Err(error) => {
            // SAFETY: 窗口没有创建成功，`WM_NCCREATE` 可能没有接管指针；这里收回所有权避免泄漏。
            // （创建失败时系统不会再调用窗口过程释放它。）
            drop(unsafe { Box::from_raw(boxed) });
            Err(PlatformError::Failed(format!("无法创建事件窗口：{error}")))
        }
    }
}

/// 监听系统的休眠恢复与时间变化；释放（`Drop`）时关闭窗口并等待线程结束。
pub struct PowerEventListener {
    /// 监听线程。
    thread: Option<JoinHandle<()>>,
    /// 隐藏窗口的句柄（测试用它发送模拟消息）。
    hwnd: isize,
}

impl PowerEventListener {
    /// 启动监听线程并等待窗口创建完成。
    ///
    /// # Errors
    ///
    /// 窗口创建失败或线程无法启动时返回 [`PlatformError::Failed`]。
    pub fn start(callback: Arc<dyn Fn(PowerEvent) + Send + Sync>) -> Result<Self, PlatformError> {
        let (ready_tx, ready_rx) = channel::<Result<isize, PlatformError>>();
        let thread = std::thread::Builder::new()
            .name("starat-power-events".to_owned())
            .spawn(move || {
                let hwnd = match create_window(callback) {
                    Ok(hwnd) => hwnd,
                    Err(error) => {
                        let _ = ready_tx.send(Err(error));
                        return;
                    }
                };
                let _ = ready_tx.send(Ok(hwnd.0 as isize));
                let mut message = MSG::default();
                // SAFETY: 标准消息循环；`GetMessageW` 在 `WM_QUIT`（窗口销毁时发出）时返回 0 / -1。
                while unsafe { GetMessageW(&raw mut message, None, 0, 0) }.0 > 0 {
                    // SAFETY: `message` 是刚由 `GetMessageW` 填充的有效消息。
                    unsafe {
                        let _ = TranslateMessage(&raw const message);
                        DispatchMessageW(&raw const message);
                    }
                }
            })
            .map_err(|e| PlatformError::Failed(format!("无法启动事件线程：{e}")))?;
        match ready_rx.recv() {
            Ok(Ok(hwnd)) => Ok(Self {
                thread: Some(thread),
                hwnd,
            }),
            Ok(Err(error)) => {
                let _ = thread.join();
                Err(error)
            }
            Err(_) => Err(PlatformError::Failed("事件线程意外退出".to_owned())),
        }
    }

    /// 隐藏窗口的句柄（只给测试发送模拟消息用）。
    #[must_use]
    pub fn window_handle(&self) -> isize {
        self.hwnd
    }
}

impl Drop for PowerEventListener {
    /// 关闭窗口并等待线程退出，释放回调。
    fn drop(&mut self) {
        // SAFETY: 给自己的窗口投递 `WM_CLOSE`；窗口已不存在时调用失败，忽略即可。
        let _ = unsafe {
            PostMessageW(
                Some(HWND(self.hwnd as *mut c_void)),
                WM_CLOSE,
                WPARAM(0),
                LPARAM(0),
            )
        };
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}
