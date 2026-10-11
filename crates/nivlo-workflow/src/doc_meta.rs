//! 从文件内容里提取标题（实施计划 6.6）：Markdown 的首个标题、PDF 的 `/Title`、Word(.docx) 的 `dc:title`。
//!
//! 全部是对已读入内存的字节做纯计算，没有 IO；读取与大小上限由 `FileInspector` Port 负责。
//! 提取不到就返回 `None`，调用方用文件名兜底——标题只是锦上添花，绝不能让捕获失败。

#![allow(clippy::expect_used, clippy::missing_panics_doc)]

use std::io::Read;
use std::sync::OnceLock;

use regex::Regex;

use crate::html_meta::decode_entities;

/// 标题最长保留多少字符。
const MAX_TITLE_CHARS: usize = 200;

/// 文件的种类（由扩展名决定）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DocKind {
    /// Markdown。
    Markdown,
    /// PDF。
    Pdf,
    /// Word（.docx）。
    Docx,
    /// 其他：不提取标题。
    Other,
}

impl DocKind {
    /// 由小写扩展名判断。
    #[must_use]
    pub fn from_extension(extension: &str) -> Self {
        match extension.to_ascii_lowercase().as_str() {
            "md" | "markdown" => Self::Markdown,
            "pdf" => Self::Pdf,
            "docx" => Self::Docx,
            _ => Self::Other,
        }
    }

    /// 稳定的名字（写进模板变量 `vars.<into>_kind`）。
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Markdown => "markdown",
            Self::Pdf => "pdf",
            Self::Docx => "docx",
            Self::Other => "other",
        }
    }
}

/// 按种类提取标题。
#[must_use]
pub fn title_of(kind: DocKind, bytes: &[u8]) -> Option<String> {
    let raw = match kind {
        DocKind::Markdown => markdown_title(&String::from_utf8_lossy(bytes)),
        DocKind::Pdf => pdf_title(bytes),
        DocKind::Docx => docx_title(bytes),
        DocKind::Other => None,
    }?;
    clean(&raw)
}

/// 压缩空白、去掉控制字符、限制长度；结果为空返回 `None`。
fn clean(raw: &str) -> Option<String> {
    let text: String = raw
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let text: String = text.chars().take(MAX_TITLE_CHARS).collect();
    (!text.is_empty()).then_some(text)
}

/// Markdown：YAML front matter 里的 `title:` 优先，其次第一个 ATX 标题（`# 标题`），
/// 其次 setext 标题（下一行是 `===`）。代码块里的 `#` 不算。
#[must_use]
pub fn markdown_title(text: &str) -> Option<String> {
    let text = text.trim_start_matches('\u{feff}');
    let mut lines = text.lines().peekable();
    // front matter
    if lines.peek().is_some_and(|l| l.trim() == "---") {
        lines.next();
        for line in lines.by_ref() {
            if line.trim() == "---" || line.trim() == "..." {
                break;
            }
            if let Some(value) = line.strip_prefix("title:") {
                let value = value.trim().trim_matches(['"', '\'']);
                if !value.is_empty() {
                    return Some(value.to_owned());
                }
            }
        }
    }
    let mut in_code = false;
    let mut previous: Option<&str> = None;
    for line in lines {
        let trimmed = line.trim();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_code = !in_code;
            previous = None;
            continue;
        }
        if in_code {
            continue;
        }
        if let Some(rest) = trimmed.strip_prefix('#') {
            let level_rest = rest.trim_start_matches('#');
            // `#` 后面必须是空格（`#tag` 不是标题）；最多 6 级。
            if rest.len() - level_rest.len() < 6 && level_rest.starts_with(' ') {
                let title = level_rest.trim().trim_end_matches('#').trim();
                if !title.is_empty() {
                    return Some(title.to_owned());
                }
            }
        }
        if !trimmed.is_empty()
            && trimmed.chars().all(|c| c == '=')
            && let Some(prev) = previous
            && !prev.trim().is_empty()
        {
            return Some(prev.trim().to_owned());
        }
        previous = Some(line);
    }
    None
}

/// PDF：在文件里找 Info 字典的 `/Title`，支持字面字符串 `(…)`（含转义与 UTF-16BE BOM）和十六进制 `<…>`。
/// 对象流 / 加密文档里的标题读不到，返回 `None`。
#[must_use]
pub fn pdf_title(bytes: &[u8]) -> Option<String> {
    let mut search_from = 0;
    while let Some(offset) = find(bytes, b"/Title", search_from) {
        let mut at = offset + b"/Title".len();
        // 避免匹配到 /TitleXxx 之类的其他键。
        if bytes.get(at).is_some_and(|b| b.is_ascii_alphanumeric()) {
            search_from = at;
            continue;
        }
        while bytes.get(at).is_some_and(u8::is_ascii_whitespace) {
            at += 1;
        }
        let parsed = match bytes.get(at) {
            Some(b'(') => parse_literal(bytes, at + 1),
            Some(b'<') if bytes.get(at + 1) != Some(&b'<') => parse_hex(bytes, at + 1),
            _ => None,
        };
        if let Some(title) = parsed.and_then(|raw| decode_pdf_text(&raw))
            && !title.trim().is_empty()
        {
            return Some(title);
        }
        search_from = at;
    }
    None
}

/// 在 `haystack[from..]` 里找子串。
fn find(haystack: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    haystack
        .get(from..)?
        .windows(needle.len())
        .position(|w| w == needle)
        .map(|p| p + from)
}

/// 解析 PDF 字面字符串（括号可嵌套，支持 `\` 转义与八进制）。
fn parse_literal(bytes: &[u8], start: usize) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    let mut depth = 1_u32;
    let mut i = start;
    while let Some(&b) = bytes.get(i) {
        match b {
            b'\\' => {
                i += 1;
                match bytes.get(i).copied()? {
                    b'n' => out.push(b'\n'),
                    b'r' => out.push(b'\r'),
                    b't' => out.push(b'\t'),
                    b'b' => out.push(8),
                    b'f' => out.push(12),
                    d @ b'0'..=b'7' => {
                        let mut value = u32::from(d - b'0');
                        for _ in 0..2 {
                            match bytes.get(i + 1) {
                                Some(n @ b'0'..=b'7') => {
                                    value = value * 8 + u32::from(n - b'0');
                                    i += 1;
                                }
                                _ => break,
                            }
                        }
                        out.push(u8::try_from(value & 0xff).unwrap_or(0));
                    }
                    b'\r' | b'\n' => {}
                    other => out.push(other),
                }
            }
            b'(' => {
                depth += 1;
                out.push(b);
            }
            b')' => {
                depth -= 1;
                if depth == 0 {
                    return Some(out);
                }
                out.push(b);
            }
            _ => out.push(b),
        }
        i += 1;
        if out.len() > 4096 {
            return None;
        }
    }
    None
}

/// 解析 PDF 十六进制字符串 `<FEFF4F60…>`。
fn parse_hex(bytes: &[u8], start: usize) -> Option<Vec<u8>> {
    let end = find(bytes, b">", start)?;
    let digits: Vec<u8> = bytes[start..end]
        .iter()
        .copied()
        .filter(u8::is_ascii_hexdigit)
        .collect();
    let mut out = Vec::with_capacity(digits.len() / 2 + 1);
    for pair in digits.chunks(2) {
        let hi = (pair[0] as char).to_digit(16)?;
        let lo = pair
            .get(1)
            .map_or(0, |&b| (b as char).to_digit(16).unwrap_or(0));
        out.push(u8::try_from(hi * 16 + lo).ok()?);
    }
    Some(out)
}

/// PDF 文本字符串：UTF-16BE（BOM `FEFF`）、UTF-8（BOM `EFBBBF`），否则按 Latin-1 近似（PDFDocEncoding）。
fn decode_pdf_text(raw: &[u8]) -> Option<String> {
    if let Some(rest) = raw.strip_prefix(&[0xFE, 0xFF]) {
        let units: Vec<u16> = rest
            .chunks_exact(2)
            .map(|p| u16::from_be_bytes([p[0], p[1]]))
            .collect();
        return String::from_utf16(&units).ok();
    }
    if let Some(rest) = raw.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
        return String::from_utf8(rest.to_vec()).ok();
    }
    Some(raw.iter().map(|&b| char::from(b)).collect())
}

/// Word(.docx)：zip 里的 `docProps/core.xml` 的 `<dc:title>`。
#[must_use]
pub fn docx_title(bytes: &[u8]) -> Option<String> {
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).ok()?;
    let mut entry = archive.by_name("docProps/core.xml").ok()?;
    // core.xml 很小；限制读取量，避免恶意压缩包。
    let mut xml = String::new();
    entry
        .by_ref()
        .take(256 * 1024)
        .read_to_string(&mut xml)
        .ok()?;
    static TITLE: OnceLock<Regex> = OnceLock::new();
    #[allow(clippy::expect_used)]
    let re = TITLE.get_or_init(|| {
        Regex::new(r"(?s)<dc:title[^>]*>(.*?)</dc:title>").expect("title 正则是常量")
    });
    re.captures(&xml).map(|c| decode_entities(&c[1]))
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use std::io::Write;

    use super::*;

    #[test]
    fn markdown_prefers_front_matter_then_the_first_heading() {
        assert_eq!(
            markdown_title("---\ntitle: \"周会纪要\"\ntags: [a]\n---\n# 别的标题\n").as_deref(),
            Some("周会纪要")
        );
        assert_eq!(
            markdown_title("\n\n# 需求说明 ##\n正文").as_deref(),
            Some("需求说明")
        );
        assert_eq!(
            markdown_title("前言\n## 二级也算\n").as_deref(),
            Some("二级也算")
        );
        assert_eq!(
            markdown_title("设计草稿\n=====\n正文").as_deref(),
            Some("设计草稿")
        );
        assert_eq!(
            markdown_title("\u{feff}# 带 BOM").as_deref(),
            Some("带 BOM")
        );
    }

    #[test]
    fn markdown_ignores_hashtags_and_code_blocks() {
        assert_eq!(markdown_title("#tag 不是标题\n没有标题"), None);
        assert_eq!(markdown_title("```\n# 代码里的注释\n```\n"), None);
        assert_eq!(
            markdown_title("```sh\n# 注释\n```\n# 真标题").as_deref(),
            Some("真标题")
        );
        assert_eq!(markdown_title("####### 七级不是标题"), None);
    }

    #[test]
    fn pdf_titles_support_literal_hex_utf16_and_escapes() {
        assert_eq!(
            pdf_title(b"1 0 obj << /Title (Quarterly \\(Q3\\) Report) /Author (x) >> endobj")
                .as_deref(),
            Some("Quarterly (Q3) Report")
        );
        // UTF-16BE：“你好”。
        assert_eq!(
            pdf_title(b"<< /Title <FEFF4F60597D> >>").as_deref(),
            Some("你好")
        );
        let mut literal = b"<< /Title (".to_vec();
        literal.extend_from_slice(&[0xFE, 0xFF, 0x4F, 0x60, 0x59, 0x7D]);
        literal.extend_from_slice(b") >>");
        assert_eq!(pdf_title(&literal).as_deref(), Some("你好"));
        assert_eq!(
            pdf_title(b"<< /Title (a\\101\\n) >>").as_deref(),
            Some(
                "aA
"
            )
        );
        // 其他键与空标题不算。
        assert_eq!(pdf_title(b"<< /TitleFont (x) /Title () >>"), None);
        assert_eq!(pdf_title(b"not a pdf"), None);
    }

    #[test]
    fn docx_title_comes_from_core_properties() {
        let mut buffer = Vec::new();
        {
            let mut writer = zip::ZipWriter::new(std::io::Cursor::new(&mut buffer));
            let options = zip::write::SimpleFileOptions::default();
            writer.start_file("docProps/core.xml", options).unwrap();
            writer
                .write_all(
                    "<cp:coreProperties><dc:title>需求 &amp; 设计</dc:title></cp:coreProperties>"
                        .as_bytes(),
                )
                .unwrap();
            writer.finish().unwrap();
        }
        assert_eq!(docx_title(&buffer).as_deref(), Some("需求 & 设计"));
        assert_eq!(docx_title(b"not a zip"), None);
    }

    #[test]
    fn titles_are_cleaned_and_bounded() {
        assert_eq!(
            title_of(DocKind::Markdown, b"# a\t b\n").as_deref(),
            Some("a b")
        );
        let long = format!("# {}", "长".repeat(500));
        assert_eq!(
            title_of(DocKind::Markdown, long.as_bytes())
                .unwrap()
                .chars()
                .count(),
            MAX_TITLE_CHARS
        );
        assert_eq!(title_of(DocKind::Other, b"# x"), None);
        assert_eq!(DocKind::from_extension("MD"), DocKind::Markdown);
        assert_eq!(DocKind::from_extension("pdf"), DocKind::Pdf);
        assert_eq!(DocKind::from_extension("exe"), DocKind::Other);
    }
}
