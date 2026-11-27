//! Capture：外部输入的统一表示（实施计划 2.1、产品文档 §7、架构文档 §16）。
//!
//! 拖拽、粘贴、快捷键、手动输入——无论从哪里进来，到 Use Case 的都是同一种
//! [`CaptureRequest`]。其中两个概念刻意分开（架构文档 §16）：
//!
//! * [`CaptureInput`]：**内容是什么**（文本、URL、文件、多个文件、图片）；
//! * [`CaptureOrigin`]：**怎么进来的**（拖放、粘贴、快捷键……）。
//!
//! 默认规则与 Workflow 只看 `CaptureInput` 决定"创建成什么"，`CaptureOrigin` 只用于日志与
//! 统计，二者不能互相替代。本模块只有数据结构；URL 解析、文件探测等规范化在 `starat-capture`。

use serde::{Deserialize, Serialize};
use url::Url;

/// 一个被捕获的文件（或文件夹）的**引用**：StarAt 只记住它在哪里，不复制内容。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileRef {
    /// 用户磁盘上的原始路径，原样保存（含中文、空格）。
    pub path: String,
    /// 展示用文件名（含扩展名），取自路径的最后一段。
    pub name: String,
    /// 小写的扩展名（不含点）；没有扩展名时为 `None`。
    pub extension: Option<String>,
    /// 文件大小（字节）；文件夹或读取失败时为 `None`。
    pub size_bytes: Option<u64>,
    /// MIME 类型；无法判断时为 `None`。
    pub mime: Option<String>,
    /// 是否是文件夹。
    pub is_dir: bool,
}

/// 图片的编码格式。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ImageFormat {
    /// PNG。
    Png,
    /// JPEG。
    Jpeg,
    /// GIF。
    Gif,
    /// WebP。
    Webp,
    /// BMP。
    Bmp,
}

impl ImageFormat {
    /// 对应的 MIME 类型。
    #[must_use]
    pub fn mime(self) -> &'static str {
        match self {
            Self::Png => "image/png",
            Self::Jpeg => "image/jpeg",
            Self::Gif => "image/gif",
            Self::Webp => "image/webp",
            Self::Bmp => "image/bmp",
        }
    }

    /// 保存为文件时使用的扩展名（不含点）。
    #[must_use]
    pub fn extension(self) -> &'static str {
        match self {
            Self::Png => "png",
            Self::Jpeg => "jpg",
            Self::Gif => "gif",
            Self::Webp => "webp",
            Self::Bmp => "bmp",
        }
    }
}

/// 没有原始路径的图片（如粘贴的截图）：保存二进制内容。
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImageData {
    /// 图片的编码字节。
    pub bytes: Vec<u8>,
    /// 编码格式。
    pub format: ImageFormat,
}

impl std::fmt::Debug for ImageData {
    /// 只打印格式与大小：图片内容既大又可能是隐私，不应出现在日志里。
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ImageData")
            .field("format", &self.format)
            .field("len", &self.bytes.len())
            .finish()
    }
}

/// 捕获到的**内容**。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CaptureInput {
    /// 一段文本（已去除首尾空白，非空）。
    Text {
        /// 文本内容。
        text: String,
    },
    /// 一个网址（已规范化的绝对 URL）。
    Url {
        /// 规范化后的 URL。
        url: String,
    },
    /// 单个文件或文件夹。
    File {
        /// 文件引用。
        file: FileRef,
    },
    /// 多个文件（至少两个，已按路径去重）。
    Files {
        /// 文件引用，保持用户给出的顺序。
        files: Vec<FileRef>,
    },
    /// 一张没有原始路径的图片。
    Image {
        /// 图片内容。
        image: ImageData,
    },
}

/// 内容**怎么进来**的。仅用于日志与统计，不参与"创建成什么"的决定。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CaptureOrigin {
    /// 在主窗口里手动输入。
    Manual,
    /// 拖放到悬浮窗。
    Drop,
    /// 用户在悬浮窗里粘贴。
    Paste,
    /// 悬浮窗 / 托盘的快速添加。
    QuickAdd,
    /// 全局快捷键。
    Shortcut,
}

/// 一次捕获请求：内容 + 来路 + 可选的来源应用。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CaptureRequest {
    /// 捕获到的内容。
    pub input: CaptureInput,
    /// 内容怎么进来的。
    pub origin: CaptureOrigin,
    /// 来源应用，如 `"Chrome"`；识别不了（Phase 10 才有原生识别）时为 `None`。
    pub source_application: Option<String>,
}

impl CaptureRequest {
    /// 创建一个没有来源应用的请求。
    #[must_use]
    pub fn new(input: CaptureInput, origin: CaptureOrigin) -> Self {
        Self {
            input,
            origin,
            source_application: None,
        }
    }
}

/// 默认标题的最大字符数（按字符而不是字节截断，中文不会被切坏）。
pub const MAX_DEFAULT_TITLE_CHARS: usize = 80;

/// 图片没有可识别名称时的默认标题。
const IMAGE_TITLE: &str = "图片";

/// 按字符数截断，超长时以 `…` 结尾（总长度不超过 `max`）。
fn truncate_chars(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_owned();
    }
    let kept: String = text.chars().take(max.saturating_sub(1)).collect();
    format!("{}…", kept.trim_end())
}

/// URL 的默认标题：去掉 `www.` 的主机 + 路径（不含查询与 fragment，末尾的 `/` 去掉）。
fn url_title(raw: &str) -> String {
    let Ok(url) = Url::parse(raw) else {
        return raw.to_owned();
    };
    let host = url.host_str().unwrap_or_default();
    let host = host.strip_prefix("www.").unwrap_or(host);
    let path = url.path().trim_end_matches('/');
    format!("{host}{path}")
}

/// 由输入生成默认标题（产品文档 §6.1「先创建，再整理」：标题不用用户操心）。
///
/// * URL → `主机 + 路径`（`https://www.example.com/docs/a?x=1` → `example.com/docs/a`）；
/// * 文件 → 文件名；多个文件 → `首个文件名 等 N 个文件`；
/// * 文本 → 第一行非空内容，超过 [`MAX_DEFAULT_TITLE_CHARS`] 个字符时截断并加 `…`；
/// * 图片 → `图片`。
#[must_use]
pub fn default_title(input: &CaptureInput) -> String {
    let title = match input {
        CaptureInput::Url { url } => url_title(url),
        CaptureInput::File { file } => file.name.clone(),
        CaptureInput::Files { files } => match files.first() {
            Some(first) => format!("{} 等 {} 个文件", first.name, files.len()),
            None => IMAGE_TITLE.to_owned(),
        },
        CaptureInput::Text { text } => text
            .lines()
            .map(str::trim)
            .find(|line| !line.is_empty())
            .unwrap_or_default()
            .to_owned(),
        CaptureInput::Image { .. } => IMAGE_TITLE.to_owned(),
    };
    truncate_chars(&title, MAX_DEFAULT_TITLE_CHARS)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn capture_input_round_trips_through_json_with_a_kind_tag() {
        let inputs = [
            CaptureInput::Text {
                text: "买牛奶".into(),
            },
            CaptureInput::Url {
                url: "https://example.com/a".into(),
            },
            CaptureInput::File {
                file: FileRef {
                    path: r"C:\文档\报告 final.pdf".into(),
                    name: "报告 final.pdf".into(),
                    extension: Some("pdf".into()),
                    size_bytes: Some(10),
                    mime: Some("application/pdf".into()),
                    is_dir: false,
                },
            },
            CaptureInput::Image {
                image: ImageData {
                    bytes: vec![1, 2, 3],
                    format: ImageFormat::Png,
                },
            },
        ];
        for input in inputs {
            let json = serde_json::to_string(&input).unwrap();
            assert_eq!(serde_json::from_str::<CaptureInput>(&json).unwrap(), input);
        }
        let json = serde_json::to_value(CaptureInput::Url { url: "u".into() }).unwrap();
        assert_eq!(json["kind"], "url");
    }

    #[test]
    fn request_round_trips_and_origin_is_separate_from_input() {
        let request = CaptureRequest::new(
            CaptureInput::Text { text: "x".into() },
            CaptureOrigin::Paste,
        );
        let json = serde_json::to_string(&request).unwrap();
        assert_eq!(
            serde_json::from_str::<CaptureRequest>(&json).unwrap(),
            request
        );
        assert_eq!(serde_json::to_value(request.origin).unwrap(), "paste");
    }

    #[test]
    fn image_debug_output_never_contains_the_pixels() {
        let image = ImageData {
            bytes: vec![0xAB; 1000],
            format: ImageFormat::Jpeg,
        };
        let text = format!("{image:?}");
        assert!(text.contains("len: 1000"));
        assert!(!text.contains("171"));
    }

    #[test]
    fn image_formats_know_their_mime_and_extension() {
        assert_eq!(ImageFormat::Jpeg.mime(), "image/jpeg");
        assert_eq!(ImageFormat::Jpeg.extension(), "jpg");
        assert_eq!(ImageFormat::Webp.mime(), "image/webp");
    }
}
