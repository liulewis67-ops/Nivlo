//! Windows 的剪贴板读取：文本（`CF_UNICODETEXT`）、文件列表（`CF_HDROP`）、图片
//! （注册格式 `PNG` 优先，否则 `CF_DIB` 补上 BMP 文件头）。
//!
//! 只在 [`ClipboardPort::read`] 被调用时才打开剪贴板——没有监听、没有轮询。
//! 剪贴板可能被其他程序短暂占用，打开失败时按固定的少量次数重试，仍然失败才返回错误。

// 本模块含 Win32 调用（后端规范 §9.4）：每个 `unsafe` 块都有 SAFETY 注释。
#![allow(unsafe_code)]

use std::time::Duration;

use nivlo_platform::clipboard::{ClipboardContent, ClipboardPort};
use nivlo_platform::error::PlatformError;
use windows::Win32::Foundation::{HANDLE, HGLOBAL};
use windows::Win32::System::DataExchange::{
    CloseClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard,
    RegisterClipboardFormatW,
};
use windows::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};
use windows::Win32::System::Ole::{CF_DIB, CF_HDROP, CF_UNICODETEXT};
use windows::Win32::UI::Shell::{DragQueryFileW, HDROP};
use windows::core::w;

/// 打开剪贴板的最多尝试次数（其他程序可能正占用）。
const OPEN_ATTEMPTS: u32 = 5;

/// 两次尝试之间的等待。
const OPEN_RETRY_DELAY: Duration = Duration::from_millis(20);

/// 打开的剪贴板；释放时关闭，保证任何路径都不会把剪贴板一直占着。
struct OpenClipboardGuard;

impl OpenClipboardGuard {
    /// 打开剪贴板，被占用时重试几次。
    fn open() -> Result<Self, PlatformError> {
        let mut last_error = None;
        for attempt in 0..OPEN_ATTEMPTS {
            // SAFETY: `None` 表示与当前任务关联；成功之后由 `Drop` 配对调用 `CloseClipboard`。
            match unsafe { OpenClipboard(None) } {
                Ok(()) => return Ok(Self),
                Err(error) => last_error = Some(error),
            }
            if attempt + 1 < OPEN_ATTEMPTS {
                std::thread::sleep(OPEN_RETRY_DELAY);
            }
        }
        Err(PlatformError::Failed(format!(
            "无法打开剪贴板：{}",
            last_error.map_or_else(String::new, |error| error.to_string())
        )))
    }
}

impl Drop for OpenClipboardGuard {
    /// 关闭剪贴板。
    fn drop(&mut self) {
        // SAFETY: 本守卫只在 `OpenClipboard` 成功之后构造，这里是与之配对的唯一一次关闭。
        let _ = unsafe { CloseClipboard() };
    }
}

/// 剪贴板某个格式的数据句柄；格式不存在时为 `None`。
fn data_handle(format: u32) -> Option<HANDLE> {
    // SAFETY: 只在剪贴板已打开（`OpenClipboardGuard` 存活）时调用；格式不存在时返回错误。
    unsafe { IsClipboardFormatAvailable(format) }.ok()?;
    // SAFETY: 同上。返回的句柄归剪贴板所有，不能释放，也只在剪贴板打开期间有效。
    unsafe { GetClipboardData(format) }.ok()
}

/// 把剪贴板的全局内存复制成字节（调用方持有打开的剪贴板）。
fn copy_global(handle: HANDLE) -> Option<Vec<u8>> {
    let global = HGLOBAL(handle.0);
    // SAFETY: `global` 是剪贴板数据句柄，剪贴板此刻是打开的；`GlobalLock` 成功后指针在
    // `GlobalUnlock` 之前有效，读取长度不超过 `GlobalSize`。
    unsafe {
        let size = GlobalSize(global);
        let pointer = GlobalLock(global);
        if pointer.is_null() {
            return None;
        }
        let bytes = std::slice::from_raw_parts(pointer.cast::<u8>(), size).to_vec();
        let _ = GlobalUnlock(global);
        Some(bytes)
    }
}

/// 读取 `CF_UNICODETEXT`：UTF-16，以 NUL 结尾。
fn read_text() -> Option<String> {
    let bytes = copy_global(data_handle(u32::from(CF_UNICODETEXT.0))?)?;
    let units: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .take_while(|unit| *unit != 0)
        .collect();
    Some(String::from_utf16_lossy(&units))
}

/// 读取 `CF_HDROP`：资源管理器里复制的文件 / 文件夹的完整路径。
fn read_files() -> Vec<String> {
    let Some(handle) = data_handle(u32::from(CF_HDROP.0)) else {
        return Vec::new();
    };
    let drop = HDROP(handle.0);
    // SAFETY: `drop` 是剪贴板里的 HDROP 句柄（剪贴板已打开）；索引 `u32::MAX` 只查询文件个数。
    let count = unsafe { DragQueryFileW(drop, u32::MAX, None) };
    let mut files = Vec::new();
    for index in 0..count {
        // SAFETY: 第一次传 `None` 只查询第 `index` 个路径的字符数（不含结尾 NUL）。
        let length = unsafe { DragQueryFileW(drop, index, None) } as usize;
        if length == 0 {
            continue;
        }
        let mut buffer = vec![0u16; length + 1];
        // SAFETY: `buffer` 有 `length + 1` 个元素，足够容纳路径和结尾的 NUL。
        let written = unsafe { DragQueryFileW(drop, index, Some(&mut buffer)) } as usize;
        files.push(String::from_utf16_lossy(&buffer[..written.min(length)]));
    }
    files
}

/// 给没有文件头的 DIB 补上 14 字节的 BMP 文件头，得到可以直接保存 / 识别的 `.bmp`。
fn dib_to_bmp(dib: &[u8]) -> Option<Vec<u8>> {
    // BITMAPINFOHEADER 的前 4 个字节是头大小；至少要有它才谈得上图片。
    let header_size = u32::from_le_bytes(dib.get(0..4)?.try_into().ok()?);
    if header_size < 12 || dib.len() < header_size as usize {
        return None;
    }
    // 像素数据偏移 = 文件头 14 + 信息头 + 调色板；为简单起见只处理无调色板、
    // 位深 ≥ 24 的常见截图（剪贴板里的截图基本都是 24 / 32 位）。
    let bit_count = u16::from_le_bytes(dib.get(14..16)?.try_into().ok()?);
    let compression = u32::from_le_bytes(dib.get(16..20)?.try_into().ok()?);
    let colors_used = u32::from_le_bytes(dib.get(32..36)?.try_into().ok()?);
    let mask_bytes = if compression == 3 && header_size == 40 {
        12
    } else {
        0
    };
    let palette = if bit_count <= 8 {
        let entries = if colors_used == 0 {
            1u32 << bit_count
        } else {
            colors_used
        };
        entries * 4
    } else {
        0
    };
    let offset = 14 + header_size + mask_bytes + palette;
    let total = u32::try_from(14 + dib.len()).ok()?;
    let mut bmp = Vec::with_capacity(14 + dib.len());
    bmp.extend_from_slice(b"BM");
    bmp.extend_from_slice(&total.to_le_bytes());
    bmp.extend_from_slice(&[0, 0, 0, 0]);
    bmp.extend_from_slice(&offset.to_le_bytes());
    bmp.extend_from_slice(dib);
    Some(bmp)
}

/// 读取图片：优先用程序注册的 `PNG` 格式（浏览器、截图工具提供，无损且带透明），
/// 否则用 `CF_DIB`（系统自动从各种位图格式合成）。
fn read_image() -> Option<Vec<u8>> {
    // SAFETY: 传入的是以 NUL 结尾的静态宽字符串；返回 0 表示注册失败。
    let png_format = unsafe { RegisterClipboardFormatW(w!("PNG")) };
    let png = (png_format != 0)
        .then(|| data_handle(png_format).and_then(copy_global))
        .flatten()
        .filter(|bytes| bytes.starts_with(&[0x89, b'P', b'N', b'G']));
    if png.is_some() {
        return png;
    }
    let dib = copy_global(data_handle(u32::from(CF_DIB.0))?)?;
    dib_to_bmp(&dib)
}

/// Windows 上的 [`ClipboardPort`]。
#[derive(Debug, Default, Clone, Copy)]
pub struct WindowsClipboard;

impl ClipboardPort for WindowsClipboard {
    fn read_text(&self) -> Result<Option<String>, PlatformError> {
        let _clipboard = OpenClipboardGuard::open()?;
        Ok(read_text())
    }

    /// 读取剪贴板：文件 / 图片 / 文本，可以同时存在多种。
    fn read(&self) -> Result<ClipboardContent, PlatformError> {
        let _clipboard = OpenClipboardGuard::open()?;
        Ok(ClipboardContent {
            files: read_files(),
            image: read_image(),
            text: read_text(),
        })
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::dib_to_bmp;

    /// 构造一个 2×2、32 位、无压缩的 DIB（头 40 字节 + 16 字节像素）。
    fn tiny_dib() -> Vec<u8> {
        let mut dib = Vec::new();
        dib.extend_from_slice(&40u32.to_le_bytes()); // biSize
        dib.extend_from_slice(&2i32.to_le_bytes()); // biWidth
        dib.extend_from_slice(&2i32.to_le_bytes()); // biHeight
        dib.extend_from_slice(&1u16.to_le_bytes()); // biPlanes
        dib.extend_from_slice(&32u16.to_le_bytes()); // biBitCount
        dib.extend_from_slice(&0u32.to_le_bytes()); // biCompression = BI_RGB
        dib.extend_from_slice(&16u32.to_le_bytes()); // biSizeImage
        dib.extend_from_slice(&[0u8; 16]); // 水平 / 垂直分辨率、使用的颜色、重要颜色
        dib.extend_from_slice(&[0u8; 16]); // 像素
        dib
    }

    #[test]
    fn a_dib_gets_a_bmp_file_header_pointing_at_the_pixels() {
        let dib = tiny_dib();
        let bmp = dib_to_bmp(&dib).unwrap();
        assert_eq!(&bmp[0..2], b"BM");
        assert_eq!(
            u32::from_le_bytes(bmp[2..6].try_into().unwrap()) as usize,
            bmp.len()
        );
        // 像素从 14（文件头）+ 40（信息头）开始。
        assert_eq!(u32::from_le_bytes(bmp[10..14].try_into().unwrap()), 54);
        assert_eq!(&bmp[14..], dib.as_slice());
    }

    #[test]
    fn truncated_or_bogus_data_is_not_an_image() {
        assert!(dib_to_bmp(&[]).is_none());
        assert!(dib_to_bmp(&[1, 2, 3]).is_none());
        assert!(dib_to_bmp(&[0u8; 8]).is_none());
    }
}
