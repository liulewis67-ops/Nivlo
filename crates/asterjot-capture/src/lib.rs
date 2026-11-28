//! `asterjot-capture`：将拖拽 / 粘贴 / 快捷键等外部输入规范化为标准 `CaptureInput`。
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

mod inspector;

pub use inspector::{FsFileInspector, is_cloud_only};

use std::collections::HashSet;
use std::fs::File;
use std::io::Read;
use std::path::Path;

use asterjot_domain::capture::{CaptureInput, FileRef, ImageData, ImageFormat};
pub use asterjot_domain::capture::{MAX_DEFAULT_TITLE_CHARS, default_title};
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

/// 取路径的最后一段作为名称；同时识别 `` 与 `/`，所以 Windows 路径在任何平台上都能解析，
/// 末尾的分隔符会被忽略（`C:\a\b` → `b`）。
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
/// 只读取元数据与最多 512 字节的文件头（云端占位文件连文件头也不读）；路径不存在 / 无权限时仍返回引用（名称与扩展名
/// 来自路径本身），大小与 MIME 为 `None`——被引用的文件随时可能被移动，不能因此丢掉捕获。
#[must_use]
pub fn file_ref(path: &Path) -> FileRef {
    let path_text = path.to_string_lossy().into_owned();
    let name = file_name_of(&path_text);
    let metadata = std::fs::metadata(path).ok();
    let is_dir = metadata.as_ref().is_some_and(std::fs::Metadata::is_dir);
    let extension = if is_dir { None } else { extension_of(&name) };
    // 只在云端的占位文件（OneDrive 等）不读文件头：一读就会触发整份下载。
    let cloud_only = metadata.as_ref().is_some_and(is_cloud_only);
    let mime = if is_dir {
        None
    } else {
        extension
            .as_deref()
            .and_then(|ext| mime_guess::from_ext(ext).first_raw())
            .map(str::to_owned)
            .or_else(|| {
                (!cloud_only)
                    .then(|| sniff_mime(&read_head(path)))
                    .flatten()
                    .map(str::to_owned)
            })
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

/// 把剪贴板里的内容规范化为输入（实施计划 2.5）。
///
/// 优先级：**文件 → 文本 → 图片**。同时有文本和图片时用文本：从 Excel / 网页复制一段内容时，
/// 剪贴板里往往既有文字也有渲染出来的图片，用户想粘贴的是文字；截图只有图片，会落到最后一档。
/// 图片字节不是支持的格式时跳过它（而不是报错），剪贴板里什么可用的都没有时返回 `None`。
#[must_use]
pub fn normalize_clipboard(
    files: &[String],
    text: Option<&str>,
    image: Option<Vec<u8>>,
) -> Option<CaptureInput> {
    normalize_files(files)
        .or_else(|| text.and_then(normalize_text))
        .or_else(|| image.and_then(|bytes| image_input(bytes).ok()))
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
///
/// 只在文件没有（认识的）扩展名时才用到——有扩展名时按扩展名判断。
#[must_use]
pub fn sniff_mime(head: &[u8]) -> Option<&'static str> {
    if let Some(format) = sniff_image(head) {
        return Some(format.mime());
    }
    if head.starts_with(b"%PDF-") {
        Some("application/pdf")
    } else if head.starts_with(b"PK\x03\x04") {
        Some(zip_container_mime(head))
    } else if head.starts_with(&[0x1F, 0x8B]) {
        Some("application/gzip")
    } else if head.starts_with(b"7z\xBC\xAF\x27\x1C") {
        Some("application/x-7z-compressed")
    } else if head.starts_with(b"Rar!\x1A\x07") {
        Some("application/vnd.rar")
    } else if head.starts_with(&[0xFD, b'7', b'z', b'X', b'Z', 0x00]) {
        Some("application/x-xz")
    } else if head.starts_with(b"{\\rtf") {
        Some("application/rtf")
    } else if head.starts_with(&[0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]) {
        // 旧版 Office（.doc / .xls / .ppt）与 Outlook .msg 都是这种复合文档。
        Some("application/x-ole-storage")
    } else if head.starts_with(b"SQLite format 3\0") {
        Some("application/vnd.sqlite3")
    } else if let Some(mime) = media_mime(head) {
        Some(mime)
    } else if head.starts_with(b"MZ") && head.contains(&0) {
        Some("application/vnd.microsoft.portable-executable")
    } else if let Some(text) = asterjot_common::text::decode_text_file(head) {
        Some(markup_mime(&text).unwrap_or("text/plain"))
    } else {
        None
    }
}

/// zip 容器到底是什么：Office Open XML 看条目路径，OpenDocument / EPUB 看第一个条目 `mimetype` 的内容。
///
/// 文件头只有 512 字节，看不到的就只能说"是 zip"。
fn zip_container_mime(head: &[u8]) -> &'static str {
    let contains = |needle: &[u8]| head.windows(needle.len()).any(|w| w == needle);
    // 第一个条目：文件名长度在偏移 26，文件名从偏移 30 开始，`mimetype` 不压缩，内容紧跟其后。
    if head.get(30..38) == Some(b"mimetype") {
        let extra = head
            .get(28..30)
            .map_or(0, |b| usize::from(u16::from_le_bytes([b[0], b[1]])));
        let body = head.get(38 + extra..).unwrap_or_default();
        for (prefix, mime) in [
            (&b"application/epub+zip"[..], "application/epub+zip"),
            (
                b"application/vnd.oasis.opendocument.text",
                "application/vnd.oasis.opendocument.text",
            ),
            (
                b"application/vnd.oasis.opendocument.spreadsheet",
                "application/vnd.oasis.opendocument.spreadsheet",
            ),
            (
                b"application/vnd.oasis.opendocument.presentation",
                "application/vnd.oasis.opendocument.presentation",
            ),
        ] {
            if body.starts_with(prefix) {
                return mime;
            }
        }
    }
    if contains(b"word/") {
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    } else if contains(b"xl/") {
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    } else if contains(b"ppt/") {
        "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    } else if contains(b"META-INF/MANIFEST.MF") {
        "application/java-archive"
    } else {
        "application/zip"
    }
}

/// 音视频与 [`sniff_image`] 不支持保存、但值得认出来的图片格式。
fn media_mime(head: &[u8]) -> Option<&'static str> {
    // ISO 基础媒体文件（MP4 / MOV / HEIC / AVIF）：偏移 4 是 `ftyp`，后面是品牌。
    if head.get(4..8) == Some(b"ftyp") {
        return Some(match head.get(8..12)? {
            b"heic" | b"heix" | b"heim" | b"heis" | b"mif1" | b"msf1" => "image/heic",
            b"avif" | b"avis" => "image/avif",
            b"qt  " => "video/quicktime",
            b"M4A " | b"M4B " => "audio/mp4",
            _ => "video/mp4",
        });
    }
    if head.len() >= 12 && &head[0..4] == b"RIFF" {
        match &head[8..12] {
            b"WAVE" => return Some("audio/wav"),
            b"AVI " => return Some("video/x-msvideo"),
            _ => {}
        }
    }
    if head.starts_with(b"ID3")
        || (head.len() >= 2 && head[0] == 0xFF && matches!(head[1], 0xFB | 0xF3 | 0xF2))
    {
        Some("audio/mpeg")
    } else if head.starts_with(b"OggS") {
        Some("audio/ogg")
    } else if head.starts_with(b"fLaC") {
        Some("audio/flac")
    } else if head.starts_with(&[0x1A, 0x45, 0xDF, 0xA3]) {
        let webm = head.windows(4).any(|w| w == b"webm");
        Some(if webm {
            "video/webm"
        } else {
            "video/x-matroska"
        })
    } else if head.starts_with(b"II*\0") || head.starts_with(b"MM\0*") {
        Some("image/tiff")
    } else if head.starts_with(&[0x00, 0x00, 0x01, 0x00]) {
        Some("image/x-icon")
    } else {
        None
    }
}

/// 看起来是文本时，再看看是不是 SVG / HTML / XML。
fn markup_mime(text: &str) -> Option<&'static str> {
    let start = text.trim_start_matches('\u{feff}').trim_start();
    let lower: String = start
        .chars()
        .take(512)
        .collect::<String>()
        .to_ascii_lowercase();
    if lower.starts_with("<svg") || (lower.starts_with("<?xml") && lower.contains("<svg")) {
        Some("image/svg+xml")
    } else if lower.starts_with("<!doctype html") || lower.starts_with("<html") {
        Some("text/html")
    } else if lower.starts_with("<?xml") {
        Some("application/xml")
    } else {
        None
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
