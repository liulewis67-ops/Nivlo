//! 来源应用识别的 Win32 路径测试（实施计划 10.4）：用当前测试进程验证「进程号 → 可执行文件名」。

#![cfg(target_os = "windows")]
#![allow(clippy::unwrap_used, clippy::expect_used, missing_docs)]

use nivlo_platform::source_app::SourceApplicationPort;
use nivlo_platform_windows::source_app::{WindowsSourceApplication, process_image_stem};

#[test]
fn the_image_name_of_this_process_is_found() {
    let expected = std::env::current_exe()
        .unwrap()
        .file_stem()
        .unwrap()
        .to_string_lossy()
        .into_owned();
    assert_eq!(process_image_stem(std::process::id()).unwrap(), expected);
}

#[test]
fn a_nonexistent_process_has_no_image_name() {
    // 进程号 0 是系统空闲进程，没有可查询的可执行文件。
    assert_eq!(process_image_stem(0), None);
    assert_eq!(process_image_stem(u32::MAX), None);
}

#[test]
fn reading_the_source_application_never_panics_and_never_returns_blank() {
    // 前台可能是任何应用（也可能没有前台窗口）：只要有结果，就不是空串。
    if let Some(name) = WindowsSourceApplication.source_application() {
        assert!(!name.trim().is_empty());
    }
}
