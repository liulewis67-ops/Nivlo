//! 电源 / 时钟事件监听的测试（实施计划 10.5）：向隐藏窗口发送系统会发的消息，
//! 确认回调收到对应的事件；无关的电源消息被忽略；释放后线程干净退出。

#![cfg(target_os = "windows")]
#![allow(clippy::unwrap_used, clippy::expect_used, missing_docs, unsafe_code)]

use std::ffi::c_void;
use std::sync::{Arc, Mutex};

use stardeskbox_platform_windows::power::{PowerEvent, PowerEventListener};
use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
use windows::Win32::UI::WindowsAndMessaging::{
    PBT_APMRESUMEAUTOMATIC, PBT_APMRESUMESUSPEND, PBT_APMSUSPEND, SendMessageW, WM_DISPLAYCHANGE,
    WM_POWERBROADCAST, WM_TIMECHANGE,
};

/// 同步发送消息：`SendMessageW` 跨线程发送时会等窗口过程处理完才返回。
fn send(hwnd: isize, message: u32, wparam: usize) {
    // SAFETY: 句柄属于仍存活的监听窗口；消息与参数都是系统自己会发的普通值。
    unsafe {
        SendMessageW(
            HWND(hwnd as *mut c_void),
            message,
            Some(WPARAM(wparam)),
            Some(LPARAM(0)),
        );
    }
}

#[test]
fn resume_and_time_change_messages_reach_the_callback_and_other_power_messages_do_not() {
    let events = Arc::new(Mutex::new(Vec::new()));
    let sink = events.clone();
    let listener =
        PowerEventListener::start(Arc::new(move |event| sink.lock().unwrap().push(event))).unwrap();
    let hwnd = listener.window_handle();
    assert_ne!(hwnd, 0);

    send(hwnd, WM_POWERBROADCAST, PBT_APMRESUMEAUTOMATIC as usize);
    send(hwnd, WM_POWERBROADCAST, PBT_APMRESUMESUSPEND as usize);
    send(hwnd, WM_TIMECHANGE, 0);
    send(hwnd, WM_DISPLAYCHANGE, 32);
    // 进入睡眠的通知不是「恢复」，不应该触发。
    send(hwnd, WM_POWERBROADCAST, PBT_APMSUSPEND as usize);

    assert_eq!(
        events.lock().unwrap().as_slice(),
        [
            PowerEvent::Resumed,
            PowerEvent::Resumed,
            PowerEvent::TimeChanged,
            PowerEvent::DisplayChanged
        ]
    );
    // 释放时线程退出（Drop 会 join；挂住就会让测试超时）。
    drop(listener);
}

#[test]
fn several_listeners_can_start_and_stop_independently() {
    for _ in 0..3 {
        let listener = PowerEventListener::start(Arc::new(|_| {})).unwrap();
        drop(listener);
    }
}
