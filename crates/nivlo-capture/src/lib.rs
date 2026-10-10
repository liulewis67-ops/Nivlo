//! `nivlo-capture`：将拖拽 / 粘贴 / 快捷键等外部输入规范化为标准 `CaptureInput`。
//!
//! 入口给的是原始材料——一段文本、一组路径、一块图片字节；这里把它们变成领域里的
//! [`CaptureInput`]（实施计划 2.1）：
//!
//! * 文本：去除首尾空白；**只有整段文本恰好是一个 `http(s)` 网址**时才识别为 URL，
//!   句子里夹着网址、多行文本、多个网址都仍然是文本——宁可当成文本，也不要把用户的话吞掉；
//! * 文件：保存路径引用与元数据（名称、扩展名、大小、MIME），**不读取、不复制内容**；
//!   没有扩展名时用文件头的魔数探测 MIME；
//! * 图片：按魔数识别格式，识别不了的字节被拒绝；
//! * 默认标题：由 [`default_title`] 给出（URL 取主机 + 路径，文件取文件名，长文本取首行并截断）。
//!
//! 全部是纯函数加少量只读的文件探测，不依赖 Tauri、数据库或网络。
//!
//! 禁止依赖：`tauri`、其他 Adapter 的内部实现（参见后端规范 §3.1）。

use std::collections::HashSet;
use std::fs::File;
use std::io::Read;
use std::path::Path;

use nivlo_domain::capture::{CaptureInput, FileRef, ImageData, ImageFormat};
pub use nivlo_domain::capture::{MAX_DEFAULT_TITLE_CHARS, default_title};
use thiserror::Error;
use url::Url;

/// 探测 MIME 时最多读取的文件头字节数。
const SNIFF_BYTES: usize = 512;

/// 规范化失败。
#[derive(Debug, Error, PartialEq, Eq)]
pub enum CaptureError {
    /// 不是一个 `http` / `https` 网址。
    #[error("不是有效的网址：{0}")]
    InvalidUrl(String),
    /// 字节不是已支持的图片格式。
    #[error("无法识别的图片格式")]
    UnsupportedImage,
}

/// 把一段文本规范化为输入；去除首尾空白后为空时返回 `None`（没有可捕获的内容）。
///
/// 整段恰好是一个网址时返回 [`CaptureInput::Url`]，否则是 [`CaptureInput::Text`]。
#[must_use]
pub fn normalize_text(raw: &str) -> Option<CaptureInput> {
    let text = raw.trim();
    if text.is_empty() {
        return None;
    }
    match normalize_url(text) {
        Ok(url) => Some(CaptureInput::Url { url }),
        Err(_) => Some(CaptureInput::Text {
            text: text.to_owned(),
        }),
    }
}

/// 规范化一个网址：只接受带主机的 `http` / `https`。
///
/// 主机名转小写、去掉默认端口、解析 `.` / `..`、非 ASCII 路径做百分号编码；
/// 查询参数与 `#fragment` 原样保留（不擅自删除可能有意义的部分）。
///
/// # Errors
///
/// 含空白、不是绝对 URL、协议不是 `http(s)` 或没有主机时返回 [`CaptureError::InvalidUrl`]。
pub fn normalize_url(raw: &str) -> Result<String, CaptureError> {
    let text = raw.trim();
    let invalid = || CaptureError::InvalidUrl(text.to_owned());
    if text.is_empty() || text.chars().any(char::is_whitespace) {
        return Err(invalid());
    }
    let url = Url::parse(text).map_err(|_| invalid())?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err(invalid());
    }
    Ok(url.to_string())
}

/// 取路径的最后一段作为名称；同时识别 `\` 与 `/`，所以 Windows 路径在任何平台上都能解析，
/// 末尾的分隔符会被忽略（`C:\a\b\` → `b`）。
fn file_name_of(path: &str) -> String {
    path.split(['\\', '/'])
        .rfind(|segment| !segment.is_empty())
        .unwrap_or(path)
        .to_owned()
}

/// 小写的扩展名；隐藏文件（`.gitignore`）和以点结尾的名称没有扩展名。
fn extension_of(name: &str) -> Option<String> {
    let (stem, ext) = name.rsplit_once('.')?;
    if stem.is_empty() || ext.is_empty() {
        return None;
    }
    Some(ext.to_lowercase())
}

/// 读取文件头用于魔数探测；读取失败时返回空（探测不到就是不知道，不是错误）。
fn read_head(path: &Path) -> Vec<u8> {
    let mut buffer = vec![0_u8; SNIFF_BYTES];
    let Ok(mut file) = File::open(path) else {
        return Vec::new();
    };
    let read = file.read(&mut buffer).unwrap_or(0);
    buffer.truncate(read);
    buffer
}

/// 为一个路径构造文件引用并探测元数据。
///
/// 只读取元数据与最多 512 字节的文件头；路径不存在 / 无权限时仍返回引用（名称与扩展名
/// 来自路径本身），大小与 MIME 为 `None`——被引用的文件随时可能被移动，不能因此丢掉捕获。
#[must_use]
pub fn file_ref(path: &Path) -> FileRef {
    let path_text = path.to_string_lossy().into_owned();
    let name = file_name_of(&path_text);
    let metadata = std::fs::metadata(path).ok();
    let is_dir = metadata.as_ref().is_some_and(std::fs::Metadata::is_dir);
    let extension = if is_dir { None } else { extension_of(&name) };
    let mime = if is_dir {
        None
    } else {
        extension
            .as_deref()
            .and_then(|ext| mime_guess::from_ext(ext).first_raw())
            .map(str::to_owned)
            .or_else(|| sniff_mime(&read_head(path)).map(str::to_owned))
    };
    FileRef {
        path: path_text,
        name,
        extension,
        size_bytes: metadata.filter(|m| m.is_file()).map(|m| m.len()),
        mime,
        is_dir,
    }
}

/// 被引用的文件现在还在不在原处。
///
/// 文件只保存引用（实施计划 2.2），用户随时可能移动或删除它；展示时用这个函数检查，
/// 缺失就显示「文件不存在」状态，而不是报错。读不到元数据（含无权限）一律视为不存在。
#[must_use]
pub fn reference_exists(path: &str) -> bool {
    std::fs::metadata(path).is_ok()
}

/// 把拖入 / 粘贴的一组路径规范化为输入：按路径去重并保持顺序；
/// 一个文件是 [`CaptureInput::File`]，多个是 [`CaptureInput::Files`]，没有路径返回 `None`。
#[must_use]
pub fn normalize_files<P: AsRef<Path>>(paths: &[P]) -> Option<CaptureInput> {
    let mut seen = HashSet::new();
    let mut files: Vec<FileRef> = paths
        .iter()
        .map(|path| path.as_ref())
        .filter(|path| seen.insert(path.to_string_lossy().into_owned()))
        .map(file_ref)
        .collect();
    match files.len() {
        0 => None,
        1 => files.pop().map(|file| CaptureInput::File { file }),
        _ => Some(CaptureInput::Files { files }),
    }
}

/// 按魔数识别图片格式。
#[must_use]
pub fn sniff_image(bytes: &[u8]) -> Option<ImageFormat> {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        Some(ImageFormat::Png)
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some(ImageFormat::Jpeg)
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some(ImageFormat::Gif)
    } else if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some(ImageFormat::Webp)
    } else if bytes.starts_with(b"BM") && bytes.len() >= 14 {
        Some(ImageFormat::Bmp)
    } else {
        None
    }
}

/// 按文件头魔数探测 MIME；认不出时返回 `None`。覆盖常见的无扩展名文件。
#[must_use]
pub fn sniff_mime(head: &[u8]) -> Option<&'static str> {
    if let Some(format) = sniff_image(head) {
        return Some(format.mime());
    }
    if head.starts_with(b"%PDF-") {
        Some("application/pdf")
    } else if head.starts_with(b"PK\x03\x04") {
        // docx / xlsx / jar 等都是 zip 容器，扩展名缺失时只能说"是 zip"。
        Some("application/zip")
    } else if head.starts_with(&[0x1F, 0x8B]) {
        Some("application/gzip")
    } else if head.starts_with(b"7z\xBC\xAF\x27\x1C") {
        Some("application/x-7z-compressed")
    } else if head.starts_with(b"{\\rtf") {
        Some("application/rtf")
    } else if is_probably_text(head) {
        Some("text/plain")
    } else {
        None
    }
}

/// 文件头像不像文本：非空、没有 NUL 字节，并且是合法 UTF-8（允许末尾被截断的半个字符）。
fn is_probably_text(head: &[u8]) -> bool {
    if head.is_empty() || head.contains(&0) {
        return false;
    }
    match std::str::from_utf8(head) {
        Ok(_) => true,
        // 读取上限可能把一个多字节字符切成两半，只要错误出现在末尾就仍算文本。
        Err(error) => error.error_len().is_none(),
    }
}

/// 把图片字节规范化为输入，格式按魔数识别。
///
/// # Errors
///
/// 不是 PNG / JPEG / GIF / WebP / BMP 时返回 [`CaptureError::UnsupportedImage`]。
pub fn image_input(bytes: Vec<u8>) -> Result<CaptureInput, CaptureError> {
    let format = sniff_image(&bytes).ok_or(CaptureError::UnsupportedImage)?;
    Ok(CaptureInput::Image {
        image: ImageData { bytes, format },
    })
}

#[cfg(test)]
mod tests;
