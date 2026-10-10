//! Windows 的全局快捷键：`RegisterHotKey` + 专用的消息线程。
//!
//! `RegisterHotKey`（不绑定窗口）把 `WM_HOTKEY` 投递到**调用它的线程**的消息队列，
//! 所以每个注册由一个专用线程负责：线程里注册、跑消息循环、收到 `WM_HOTKEY` 就调用回调。
//! 这样不依赖 Tauri 主线程的消息循环，也不需要窗口句柄。
//!
//! 替换快捷键时**先在新线程里注册新的**，成功之后才停掉旧的；新的注册失败（冲突）就保持旧的不变，
//! 用户输入了一个被占用的快捷键时 Quick Create 不会因此失效。
//!
//! 空闲时线程阻塞在 `GetMessageW` 上，没有任何轮询开销。

// 本模块含 Win32 调用（后端规范 §9.4）：每个 `unsafe` 块都有 SAFETY 注释。
#![allow(unsafe_code)]

use std::sync::mpsc;
use std::sync::{Mutex, PoisonError};
use std::thread::JoinHandle;

use nivlo_platform::error::PlatformError;
use nivlo_platform::shortcut::{Accelerator, Key, ShortcutCallback, ShortcutPort};
use windows::Win32::Foundation::{ERROR_HOTKEY_ALREADY_REGISTERED, LPARAM, WPARAM};
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    HOT_KEY_MODIFIERS, MOD_ALT, MOD_CONTROL, MOD_NOREPEAT, MOD_SHIFT, MOD_WIN, RegisterHotKey,
    UnregisterHotKey,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetMessageW, MSG, PM_NOREMOVE, PeekMessageW, PostThreadMessageW, WM_HOTKEY, WM_QUIT, WM_USER,
};

/// 线程内注册热键用的 ID（每个线程只注册一个，固定即可）。
const HOTKEY_ID: i32 = 1;

/// 主键对应的虚拟键码（字母与数字就是它们的 ASCII 码）。
fn virtual_key(key: Key) -> u32 {
    match key {
        Key::Letter(c) => u32::from(c),
        Key::Digit(d) => u32::from(b'0') + u32::from(d),
        Key::Function(n) => 0x70 + u32::from(n) - 1,
        Key::Space => 0x20,
        Key::Enter => 0x0D,
        Key::Tab => 0x09,
        Key::Left => 0x25,
        Key::Up => 0x26,
        Key::Right => 0x27,
        Key::Down => 0x28,
    }
}

/// 修饰键位掩码；`MOD_NOREPEAT` 让按住不放时只触发一次。
fn modifiers(accelerator: Accelerator) -> HOT_KEY_MODIFIERS {
    let mut mask = MOD_NOREPEAT;
    for (on, flag) in [
        (accelerator.ctrl, MOD_CONTROL),
        (accelerator.alt, MOD_ALT),
        (accelerator.shift, MOD_SHIFT),
        (accelerator.meta, MOD_WIN),
    ] {
        if on {
            mask |= flag;
        }
    }
    mask
}

/// 一个正在运行的消息线程。
struct Worker {
    /// 这个线程注册的快捷键。
    accelerator: Accelerator,
    /// 线程的系统 ID，用来给它投递退出消息。
    thread_id: u32,
    /// 线程句柄，停止时等待它结束。
    join: JoinHandle<()>,
}

impl Worker {
    /// 停止线程：投递 `WM_QUIT` 让消息循环结束（线程退出前会取消热键），并等待它结束。
    fn stop(self) {
        // SAFETY: `PostThreadMessageW` 只是向指定线程的队列投递消息；线程已经结束时返回错误，
        // 此时 `join` 立刻返回，不会有未定义行为。
        let _ = unsafe { PostThreadMessageW(self.thread_id, WM_QUIT, WPARAM(0), LPARAM(0)) };
        let _ = self.join.join();
    }
}

/// 启动一个消息线程并在其中注册热键；注册结果通过通道同步返回。
fn spawn_worker(
    accelerator: Accelerator,
    on_pressed: ShortcutCallback,
) -> Result<Worker, PlatformError> {
    let (ready_tx, ready_rx) = mpsc::channel::<Result<u32, PlatformError>>();
    let join = std::thread::Builder::new()
        .name("nivlo-global-shortcut".to_owned())
        .spawn(move || run_message_loop(accelerator, &on_pressed, &ready_tx))
        .map_err(|error| PlatformError::Failed(format!("无法创建快捷键线程：{error}")))?;
    match ready_rx.recv() {
        Ok(Ok(thread_id)) => Ok(Worker {
            accelerator,
            thread_id,
            join,
        }),
        Ok(Err(error)) => {
            let _ = join.join();
            Err(error)
        }
        Err(_) => Err(PlatformError::Failed("快捷键线程意外退出".to_owned())),
    }
}

/// 消息线程的主体：注册热键、报告结果、处理 `WM_HOTKEY` 直到收到 `WM_QUIT`。
fn run_message_loop(
    accelerator: Accelerator,
    on_pressed: &ShortcutCallback,
    ready: &mpsc::Sender<Result<u32, PlatformError>>,
) {
    let mut message = MSG::default();
    // SAFETY: 先「偷看」一次消息，强制系统为本线程创建消息队列，这样在注册成功之后、
    // 进入 `GetMessageW` 之前投递来的 `WM_QUIT` 也不会丢失。`PM_NOREMOVE` 不会取走任何消息。
    let _ = unsafe { PeekMessageW(&mut message, None, WM_USER, WM_USER, PM_NOREMOVE) };

    // SAFETY: 不绑定窗口（`None`）的热键属于当前线程；参数都是有效的位掩码与虚拟键码。
    let registered = unsafe {
        RegisterHotKey(
            None,
            HOTKEY_ID,
            modifiers(accelerator),
            virtual_key(accelerator.key),
        )
    };
    if let Err(error) = registered {
        let reason = if error.code() == ERROR_HOTKEY_ALREADY_REGISTERED.to_hresult() {
            PlatformError::Conflict(accelerator.to_string())
        } else {
            PlatformError::Failed(format!("RegisterHotKey 失败：{error}"))
        };
        let _ = ready.send(Err(reason));
        return;
    }
    // SAFETY: `GetCurrentThreadId` 没有前置条件。
    let thread_id = unsafe { GetCurrentThreadId() };
    if ready.send(Ok(thread_id)).is_err() {
        // 调用方已经放弃等待：直接取消热键退出。
        // SAFETY: 取消的正是上面在本线程注册的热键。
        let _ = unsafe { UnregisterHotKey(None, HOTKEY_ID) };
        return;
    }

    // SAFETY: `message` 是有效的可写 `MSG`；返回 0（`WM_QUIT`）或 -1（错误）时结束循环。
    while unsafe { GetMessageW(&mut message, None, 0, 0) }.0 > 0 {
        if message.message == WM_HOTKEY {
            on_pressed();
        }
    }
    // SAFETY: 取消本线程注册的热键；失败（已经被系统取消）不影响退出。
    let _ = unsafe { UnregisterHotKey(None, HOTKEY_ID) };
}

/// Windows 上的 [`ShortcutPort`]。
#[derive(Default)]
pub struct WindowsShortcut {
    /// 当前注册的消息线程。
    worker: Mutex<Option<Worker>>,
}

impl WindowsShortcut {
    /// 创建（尚未注册任何快捷键）。
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }
}

impl ShortcutPort for WindowsShortcut {
    /// 注册（替换）全局快捷键：新的先注册成功，才停掉旧的；失败时旧的保持不变。
    fn register(
        &self,
        accelerator: Accelerator,
        on_pressed: ShortcutCallback,
    ) -> Result<(), PlatformError> {
        let mut current = self.worker.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(existing) = current.take_if(|worker| worker.accelerator == accelerator) {
            // 组合没变（只是换回调）：同一个组合不能同时注册两次，所以先停旧的。
            existing.stop();
            *current = Some(spawn_worker(accelerator, on_pressed)?);
            return Ok(());
        }
        // 组合不同：先注册新的；冲突时返回错误，旧的完全不受影响。
        let worker = spawn_worker(accelerator, on_pressed)?;
        if let Some(old) = current.replace(worker) {
            old.stop();
        }
        Ok(())
    }

    /// 取消当前注册的快捷键。
    fn unregister(&self) {
        let worker = self
            .worker
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        if let Some(worker) = worker {
            worker.stop();
        }
    }
}

impl Drop for WindowsShortcut {
    /// 释放时取消快捷键，线程随之结束。
    fn drop(&mut self) {
        self.unregister();
    }
}
