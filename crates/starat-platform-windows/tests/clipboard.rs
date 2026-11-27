//! 剪贴板读取的集成测试：用 PowerShell 往**真实的系统剪贴板**写入各种格式，再用 `WindowsClipboard` 读回。
//!
//! 这些测试会覆盖用户的剪贴板，并且需要交互式桌面会话，所以默认忽略；
//! 手动运行：`cargo test -p starat-platform-windows --test clipboard -- --ignored`
//! （系统剪贴板只有一个，各测试用 `SERIAL` 锁依次进行，不需要 `--test-threads=1`）。

#![cfg(target_os = "windows")]
#![allow(
    missing_docs,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::missing_docs_in_private_items
)]

use std::process::Command;
use std::sync::{Mutex, MutexGuard, PoisonError};

use starat_platform::clipboard::ClipboardPort;
use starat_platform_windows::clipboard::WindowsClipboard;

/// 系统剪贴板是全局的：同时写入的测试会互相覆盖，所以一次只跑一个。
static SERIAL: Mutex<()> = Mutex::new(());

/// 取得剪贴板测试的锁；前一个测试失败导致锁中毒时照常继续。
fn serial() -> MutexGuard<'static, ()> {
    SERIAL.lock().unwrap_or_else(PoisonError::into_inner)
}

/// 用 PowerShell（STA，剪贴板的位图 API 需要）执行一段脚本。
fn powershell(script: &str) {
    let status = Command::new("powershell")
        .args(["-NoProfile", "-STA", "-Command", script])
        .status()
        .unwrap();
    assert!(status.success(), "PowerShell 失败：{script}");
}

#[test]
#[ignore = "覆盖系统剪贴板，需要交互式桌面会话"]
fn reads_unicode_text() {
    let _serial = serial();
    powershell("Set-Clipboard -Value '整理周报：第 1 行'");
    let content = WindowsClipboard.read().unwrap();
    assert_eq!(content.text.as_deref(), Some("整理周报：第 1 行"));
    assert!(content.files.is_empty());
}

#[test]
#[ignore = "覆盖系统剪贴板，需要交互式桌面会话"]
fn reads_files_copied_in_explorer_with_chinese_and_spaces() {
    let _serial = serial();
    let dir = tempfile::tempdir().unwrap();
    let first = dir.path().join("报告 final.txt");
    let second = dir.path().join("b.txt");
    std::fs::write(&first, "1").unwrap();
    std::fs::write(&second, "2").unwrap();
    powershell(&format!(
        "Set-Clipboard -Path '{}','{}'",
        first.display(),
        second.display()
    ));

    let content = WindowsClipboard.read().unwrap();
    let mut files = content.files.clone();
    files.sort();
    let mut expected = vec![first.display().to_string(), second.display().to_string()];
    expected.sort();
    assert_eq!(files, expected);
}

#[test]
#[ignore = "覆盖系统剪贴板，需要交互式桌面会话"]
fn reads_a_screenshot_style_image_as_bytes_with_a_known_signature() {
    let _serial = serial();
    powershell(
        "Add-Type -AssemblyName System.Windows.Forms,System.Drawing; \
         $b = New-Object System.Drawing.Bitmap 8,6; \
         [System.Windows.Forms.Clipboard]::SetImage($b)",
    );
    let content = WindowsClipboard.read().unwrap();
    let image = content.image.expect("应当读到图片");
    assert!(
        image.starts_with(&[0x89, b'P', b'N', b'G']) || image.starts_with(b"BM"),
        "未知的图片格式：{:?}",
        &image[..8.min(image.len())]
    );
}

#[test]
#[ignore = "覆盖系统剪贴板，需要交互式桌面会话"]
fn an_empty_clipboard_reads_as_empty_not_as_an_error() {
    let _serial = serial();
    powershell("Set-Clipboard -Value $null");
    let content = WindowsClipboard.read().unwrap();
    assert!(content.is_empty(), "{content:?}");
}
