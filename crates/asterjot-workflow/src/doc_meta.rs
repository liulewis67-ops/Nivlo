//! 从文件内容里提取标题（实施计划 6.6）：Markdown 的首个标题、PDF 的 `/Title` 或 XMP `dc:title`、
//! Office / OpenDocument / EPUB 的 `dc:title`、网页的 `<title>`、纯文本的第一行。
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

mod pdf;
pub mod zip_index;

/// 文件的种类（由扩展名决定）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DocKind {
    /// Markdown。
    Markdown,
    /// PDF。
    Pdf,
    /// Word（.docx）。
    Docx,
    /// PowerPoint（.pptx）。
    Pptx,
    /// Excel（.xlsx）。
    Xlsx,
    /// OpenDocument（.odt / .ods / .odp）。
    OpenDocument,
    /// EPUB 电子书。
    Epub,
    /// 网页文件（.html / .htm）。
    Html,
    /// 纯文本（.txt）：标题是第一行非空文字。
    Text,
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
            "pptx" => Self::Pptx,
            "xlsx" => Self::Xlsx,
            "odt" | "ods" | "odp" => Self::OpenDocument,
            "epub" => Self::Epub,
            "html" | "htm" => Self::Html,
            "txt" => Self::Text,
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
            Self::Pptx => "pptx",
            Self::Xlsx => "xlsx",
            Self::OpenDocument => "opendocument",
            Self::Epub => "epub",
            Self::Html => "html",
            Self::Text => "text",
            Self::Other => "other",
        }
    }

    /// 为了取标题，这种文件要读哪些部分。
    #[must_use]
    pub fn read_plan(self) -> ReadPlan {
        match self {
            Self::Markdown | Self::Text | Self::Html => ReadPlan::Head(HEAD_BYTES),
            Self::Pdf => ReadPlan::Pdf,
            Self::Docx | Self::Pptx | Self::Xlsx | Self::OpenDocument | Self::Epub => {
                ReadPlan::ZipEntry
            }
            Self::Other => ReadPlan::Nothing,
        }
    }

    /// zip 容器里存着标题的那个条目（[`ReadPlan::ZipEntry`] 用）。
    #[must_use]
    pub fn is_title_entry(self, name: &str) -> bool {
        match self {
            Self::Docx | Self::Pptx | Self::Xlsx => name == "docProps/core.xml",
            Self::OpenDocument => name == "meta.xml",
            Self::Epub => std::path::Path::new(name)
                .extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("opf")),
            _ => false,
        }
    }
}

/// 文本类文件只读开头这么多（front matter、首个标题、`<head>` 都在里面）。
pub const HEAD_BYTES: u64 = 256 * 1024;
/// 不超过这么大的 PDF 整个读入（对象流、书签都能看全）。
pub const PDF_WHOLE_BYTES: u64 = 8 * 1024 * 1024;
/// 更大的 PDF 只读开头和末尾各这么多：trailer 与 Info 字典在末尾，线性化文件的在开头。
pub const PDF_EDGE_BYTES: u64 = 1024 * 1024;

/// 读取方式（见 [`DocKind::read_plan`]）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReadPlan {
    /// 不读：认不出标题的种类。
    Nothing,
    /// 只读开头若干字节，交给 [`title_of`]。
    Head(u64),
    /// PDF：小文件整个读，大文件读头尾（拼在一起交给 [`title_of`]）。
    Pdf,
    /// zip 容器：经 [`zip_index`] 只读目录和那一个条目，交给 [`title_from_entry`]。
    ZipEntry,
}

/// 从 zip 条目（Office `core.xml`、OpenDocument `meta.xml`、EPUB `.opf`）里取 `dc:title`。
#[must_use]
pub fn title_from_entry(xml: &[u8]) -> Option<String> {
    clean(&dc_title(&String::from_utf8_lossy(xml))?)
}

/// 按种类提取标题。
#[must_use]
pub fn title_of(kind: DocKind, bytes: &[u8]) -> Option<String> {
    let raw = match kind {
        // GBK / UTF-16 的 Markdown 也要读得出标题；认不出编码时退回有损的 UTF-8。
        DocKind::Markdown => markdown_title(
            &asterjot_common::text::decode_text_file(bytes)
                .unwrap_or_else(|| String::from_utf8_lossy(bytes)),
        ),
        DocKind::Pdf => pdf_title(bytes),
        DocKind::Docx | DocKind::Pptx | DocKind::Xlsx | DocKind::OpenDocument | DocKind::Epub => {
            zip_dc_title(bytes, |name| kind.is_title_entry(name))
        }
        DocKind::Html => {
            // 按 `<meta charset>` 解码（GBK 网页也常见），再取 `<title>` / `og:title`。
            let html = asterjot_application::ports::http::decode_text(bytes, None);
            Some(crate::html_meta::extract(&html, None).title)
        }
        DocKind::Text => text_title(bytes),
        DocKind::Other => None,
    }?;
    clean(&raw)
}

/// 纯文本的标题：第一行非空文字（编码按 [`asterjot_common::text`] 识别；不像文本就没有标题）。
#[must_use]
pub fn text_title(bytes: &[u8]) -> Option<String> {
    let text = asterjot_common::text::decode_text_file(bytes)?;
    text.lines()
        .map(|line| line.trim_start_matches('\u{feff}').trim())
        .find(|line| !line.is_empty())
        .map(str::to_owned)
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

/// PDF 的标题，按可信程度依次尝试：
///
/// 1. trailer 里 `/Info N G R` 指向的那个对象的 `/Title`（对象可能在压缩的对象流里）；
/// 2. XMP 元数据里的 `dc:title`（元数据流可能是压缩的）；
/// 3. 文件里（以及解压后的对象流里）第一个 `/Title`——可能是书签的标题，所以放在最后。
///
/// 字符串支持字面 `(…)`（含转义与 UTF-16BE BOM）和十六进制 `<…>`。加密文档读不到，返回 `None`。
#[must_use]
pub fn pdf_title(bytes: &[u8]) -> Option<String> {
    let streams = pdf::inflated_streams(bytes);
    let info = pdf::info_reference(bytes)
        .or_else(|| streams.iter().find_map(|s| pdf::info_reference(&s.data)));
    if let Some((number, generation)) = info {
        let object = pdf::object_body(bytes, number, generation)
            .map(<[u8]>::to_vec)
            .or_else(|| streams.iter().find_map(|s| s.object(number)));
        if let Some(title) = object.and_then(|body| first_title(&body)) {
            return Some(title);
        }
    }
    std::iter::once(bytes)
        .chain(streams.iter().map(|s| s.data.as_slice()))
        .find_map(xmp_title)
        .or_else(|| first_title(bytes))
        .or_else(|| {
            streams
                .iter()
                .filter(|s| s.is_object_stream)
                .find_map(|s| first_title(&s.data))
        })
}

/// XMP 元数据里的 `<dc:title>…<rdf:li …>标题</rdf:li>`。
fn xmp_title(bytes: &[u8]) -> Option<String> {
    let at = find(bytes, b"<dc:title", 0)?;
    let window = &bytes[at..bytes.len().min(at + 8 * 1024)];
    let text = String::from_utf8_lossy(window);
    static LI: OnceLock<Regex> = OnceLock::new();
    let re = LI.get_or_init(|| {
        Regex::new(r"(?s)<dc:title[^>]*>.*?<rdf:li[^>]*>(.*?)</rdf:li>").expect("XMP 正则是常量")
    });
    let title = decode_entities(re.captures(&text)?.get(1)?.as_str());
    (!title.trim().is_empty()).then_some(title)
}

/// 在一段 PDF 字节里找第一个有内容的 `/Title` 字符串。
fn first_title(bytes: &[u8]) -> Option<String> {
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

/// Office Open XML（.docx / .pptx / .xlsx）：zip 里的 `docProps/core.xml` 的 `<dc:title>`。
#[must_use]
pub fn docx_title(bytes: &[u8]) -> Option<String> {
    zip_dc_title(bytes, |name| name == "docProps/core.xml")
}

/// zip 容器里第一个名字满足 `wanted` 的条目中的 `<dc:title>`（Office、OpenDocument、EPUB 都这样存标题）。
fn zip_dc_title(bytes: &[u8], wanted: impl Fn(&str) -> bool) -> Option<String> {
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).ok()?;
    let name = archive.file_names().find(|name| wanted(name))?.to_owned();
    let mut entry = archive.by_name(&name).ok()?;
    // 元数据文件很小；限制读取量，避免恶意压缩包。
    let mut xml = Vec::new();
    entry
        .by_ref()
        .take(zip_index::MAX_ENTRY_BYTES)
        .read_to_end(&mut xml)
        .ok()?;
    dc_title(&String::from_utf8_lossy(&xml))
}

/// XML 里的第一个 `<dc:title>`（实体已解码）。
fn dc_title(xml: &str) -> Option<String> {
    static TITLE: OnceLock<Regex> = OnceLock::new();
    #[allow(clippy::expect_used)]
    let re = TITLE.get_or_init(|| {
        Regex::new(r"(?s)<dc:title[^>]*>(.*?)</dc:title>").expect("title 正则是常量")
    });
    re.captures(xml).map(|c| decode_entities(&c[1]))
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

    /// 一个只有一个条目的 zip。
    fn zip_with(name: &str, body: &str) -> Vec<u8> {
        let mut buffer = Vec::new();
        {
            let mut writer = zip::ZipWriter::new(std::io::Cursor::new(&mut buffer));
            writer
                .start_file(name, zip::write::SimpleFileOptions::default())
                .unwrap();
            writer.write_all(body.as_bytes()).unwrap();
            writer.finish().unwrap();
        }
        buffer
    }

    /// zlib 压缩。
    fn deflate(bytes: &[u8]) -> Vec<u8> {
        let mut encoder =
            flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(bytes).unwrap();
        encoder.finish().unwrap()
    }

    /// 一个压缩流对象。
    fn stream_object(header: &str, data: &[u8]) -> Vec<u8> {
        let compressed = deflate(data);
        let mut out = format!(
            "{header} /Filter /FlateDecode /Length {} >>\nstream\n",
            compressed.len()
        )
        .into_bytes();
        out.extend_from_slice(&compressed);
        out.extend_from_slice(b"\nendstream\nendobj\n");
        out
    }

    #[test]
    fn pdf_info_dictionary_beats_bookmark_titles() {
        let pdf = b"%PDF-1.4\n3 0 obj << /Title (Chapter 1) /Parent 2 0 R >> endobj\n\
            15 0 obj << /Title (Real Title) /Author (x) >> endobj\n\
            trailer << /Root 1 0 R /Info 15 0 R >>";
        assert_eq!(pdf_title(pdf).as_deref(), Some("Real Title"));
    }

    #[test]
    fn pdf_info_dictionary_inside_a_compressed_object_stream() {
        let objects = "<< /Title (Bookmark) >> << /Title <FEFF6253537065875B57> >>";
        let second = objects.find("<< /Title <").unwrap();
        let header = format!("4 0 5 {second} ");
        let mut data = header.clone().into_bytes();
        data.extend_from_slice(objects.as_bytes());
        let mut pdf = b"%PDF-1.5\n".to_vec();
        pdf.extend(stream_object(
            &format!("7 0 obj << /Type /ObjStm /N 2 /First {}", header.len()),
            &data,
        ));
        pdf.extend_from_slice(b"9 0 obj << /Type /XRef /Info 5 0 R /Root 1 0 R >>\nendobj\n");
        // 「打印文字」的 UTF-16BE。
        assert_eq!(pdf_title(&pdf).as_deref(), Some("打印文字"));
    }

    #[test]
    fn pdf_titles_fall_back_to_xmp_metadata() {
        let xmp = r#"<x:xmpmeta><rdf:RDF><rdf:Description><dc:title><rdf:Alt>
            <rdf:li xml:lang="x-default">季度 &amp; 年度报告</rdf:li></rdf:Alt></dc:title>
            </rdf:Description></rdf:RDF></x:xmpmeta>"#;
        let mut plain = b"%PDF-1.6\n2 0 obj << /Type /Metadata /Subtype /XML >>\nstream\n".to_vec();
        plain.extend_from_slice(xmp.as_bytes());
        plain.extend_from_slice(b"\nendstream\nendobj\n");
        assert_eq!(pdf_title(&plain).as_deref(), Some("季度 & 年度报告"));

        let mut packed = b"%PDF-1.6\n".to_vec();
        packed.extend(stream_object(
            "2 0 obj << /Type /Metadata /Subtype /XML",
            xmp.as_bytes(),
        ));
        assert_eq!(pdf_title(&packed).as_deref(), Some("季度 & 年度报告"));
    }

    #[test]
    fn broken_compressed_streams_do_not_break_title_extraction() {
        let pdf = b"%PDF-1.5\n7 0 obj << /Type /ObjStm /N 1 /First 4 /Filter /FlateDecode >>\n\
            stream\nnot zlib at all\nendstream\nendobj\n1 0 obj << /Title (Plain) >> endobj";
        assert_eq!(pdf_title(pdf).as_deref(), Some("Plain"));
    }

    #[test]
    fn gbk_and_utf16_markdown_titles_are_readable() {
        // 「# 你好」的 GBK 字节。
        let gbk = [b'#', b' ', 0xC4, 0xE3, 0xBA, 0xC3, b'\n'];
        assert_eq!(title_of(DocKind::Markdown, &gbk).as_deref(), Some("你好"));
        let mut utf16 = b"\xFF\xFE".to_vec();
        utf16.extend("# 周报\n".encode_utf16().flat_map(u16::to_le_bytes));
        assert_eq!(title_of(DocKind::Markdown, &utf16).as_deref(), Some("周报"));
    }

    #[test]
    fn more_document_types_have_titles() {
        let core = "<cp:coreProperties><dc:title>季度汇报</dc:title></cp:coreProperties>";
        for kind in ["pptx", "xlsx"] {
            assert_eq!(
                title_of(
                    DocKind::from_extension(kind),
                    &zip_with("docProps/core.xml", core)
                )
                .as_deref(),
                Some("季度汇报"),
                "{kind}"
            );
        }
        let meta = "<office:document-meta><office:meta><dc:title>开放文档</dc:title></office:meta></office:document-meta>";
        assert_eq!(
            title_of(DocKind::from_extension("odt"), &zip_with("meta.xml", meta)).as_deref(),
            Some("开放文档")
        );
        let opf = "<package><metadata><dc:title>电子书</dc:title></metadata></package>";
        assert_eq!(
            title_of(DocKind::Epub, &zip_with("OEBPS/content.opf", opf)).as_deref(),
            Some("电子书")
        );
        // GBK 网页文件，按 meta 声明解码。
        let mut html = b"<html><head><meta charset=\"gbk\"><title>".to_vec();
        html.extend_from_slice(&[0xC4, 0xE3, 0xBA, 0xC3]);
        html.extend_from_slice(b"</title></head></html>");
        assert_eq!(
            title_of(DocKind::from_extension("HTM"), &html).as_deref(),
            Some("你好")
        );
        assert_eq!(
            title_of(DocKind::Text, "\n\n  购物清单  \n牛奶".as_bytes()).as_deref(),
            Some("购物清单")
        );
        assert_eq!(title_of(DocKind::Text, b"\x00\x01binary"), None);
    }
}
