//! 规范化规则的单元测试；文本用例来自 `fixtures/capture/text-cases.json`。

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::path::PathBuf;

use nivlo_domain::capture::{CaptureInput, ImageFormat};
use serde::Deserialize;

use super::*;

/// fixtures 里的一条文本用例。
#[derive(Deserialize)]
struct TextCase {
    name: String,
    input: String,
    kind: String,
    value: String,
}

/// 一段最小的 PNG 文件头。
const PNG_HEAD: &[u8] = &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0];

#[test]
fn text_cases_from_the_fixture_are_classified_and_normalized() {
    let cases: Vec<TextCase> =
        serde_json::from_str(include_str!("../../../fixtures/capture/text-cases.json")).unwrap();
    assert!(cases.len() >= 10, "fixture 应当覆盖足够多的情形");
    for case in cases {
        let result = normalize_text(&case.input);
        match (case.kind.as_str(), result) {
            ("none", None) => {}
            ("url", Some(CaptureInput::Url { url })) => {
                assert_eq!(url, case.value, "{}", case.name);
            }
            ("text", Some(CaptureInput::Text { text })) => {
                assert_eq!(text, case.value, "{}", case.name);
            }
            (kind, other) => panic!("{}: 期望 {kind}，得到 {other:?}", case.name),
        }
    }
}

#[test]
fn normalize_url_rejects_non_http_and_malformed_input() {
    for bad in [
        "",
        "ftp://example.com",
        "mailto:a@b.com",
        "http://",
        "not a url",
    ] {
        assert!(matches!(
            normalize_url(bad),
            Err(CaptureError::InvalidUrl(_))
        ));
    }
}

#[test]
fn windows_paths_with_chinese_and_spaces_are_parsed_without_touching_the_disk() {
    let file = file_ref(Path::new(r"C:\Users\张三\我的 文档\季度 报告 final.PDF"));
    assert_eq!(file.name, "季度 报告 final.PDF");
    assert_eq!(file.extension.as_deref(), Some("pdf"));
    assert_eq!(file.mime.as_deref(), Some("application/pdf"));
    assert_eq!(file.path, r"C:\Users\张三\我的 文档\季度 报告 final.PDF");
    // 文件不存在：大小未知，但仍然是一个有效的引用。
    assert_eq!(file.size_bytes, None);
    assert!(!file.is_dir);
}

#[test]
fn trailing_separators_and_unix_separators_are_handled() {
    assert_eq!(file_name_of(r"C:\a\b\"), "b");
    assert_eq!(file_name_of("/home/lewis/notes.md"), "notes.md");
    assert_eq!(file_name_of(r"\\server\share\x.txt"), "x.txt");
    assert_eq!(file_name_of("C:\\"), "C:");
}

#[test]
fn extensions_ignore_hidden_files_and_trailing_dots() {
    assert_eq!(extension_of("a.tar.GZ").as_deref(), Some("gz"));
    assert_eq!(extension_of(".gitignore"), None);
    assert_eq!(extension_of("README"), None);
    assert_eq!(extension_of("weird."), None);
}

#[test]
fn a_real_file_gets_size_and_mime_from_the_disk() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("便签 一.txt");
    std::fs::write(&path, "你好，世界").unwrap();

    let file = file_ref(&path);

    assert_eq!(file.size_bytes, Some("你好，世界".len() as u64));
    assert_eq!(file.mime.as_deref(), Some("text/plain"));
    assert_eq!(file.name, "便签 一.txt");
}

#[test]
fn files_without_an_extension_are_sniffed_by_magic_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let png = dir.path().join("screenshot");
    std::fs::write(&png, PNG_HEAD).unwrap();
    let pdf = dir.path().join("contract");
    std::fs::write(&pdf, b"%PDF-1.7\n...").unwrap();
    let text = dir.path().join("LICENSE");
    std::fs::write(&text, "MIT License\n\nCopyright").unwrap();
    let binary = dir.path().join("blob");
    std::fs::write(&binary, [0_u8, 159, 146, 150, 0, 1]).unwrap();

    assert_eq!(file_ref(&png).mime.as_deref(), Some("image/png"));
    assert_eq!(file_ref(&pdf).mime.as_deref(), Some("application/pdf"));
    assert_eq!(file_ref(&text).mime.as_deref(), Some("text/plain"));
    assert_eq!(file_ref(&binary).mime, None);
    assert_eq!(file_ref(&png).extension, None);
}

#[test]
fn a_utf8_character_cut_at_the_sniff_limit_still_counts_as_text() {
    // 在 512 字节处把一个三字节汉字切成两半。
    let mut head = "a".repeat(SNIFF_BYTES - 1).into_bytes();
    head.extend_from_slice(&"汉".as_bytes()[..1]);
    assert_eq!(sniff_mime(&head), Some("text/plain"));
}

#[test]
fn directories_are_marked_and_have_no_size_or_mime() {
    let dir = tempfile::tempdir().unwrap();
    let folder = dir.path().join("资料 文件夹.v2");
    std::fs::create_dir(&folder).unwrap();

    let file = file_ref(&folder);

    assert!(file.is_dir);
    assert_eq!(file.size_bytes, None);
    assert_eq!(file.mime, None);
    assert_eq!(file.extension, None);
}

#[test]
fn one_path_is_a_file_many_are_files_and_duplicates_collapse() {
    let a = PathBuf::from(r"C:\a\1.txt");
    let b = PathBuf::from(r"C:\a\2.txt");

    assert!(matches!(
        normalize_files(&[&a]),
        Some(CaptureInput::File { .. })
    ));
    assert!(matches!(
        normalize_files(&[&a, &a]),
        Some(CaptureInput::File { .. })
    ));
    let Some(CaptureInput::Files { files }) = normalize_files(&[&a, &b, &a]) else {
        panic!("应当是多个文件");
    };
    assert_eq!(
        files.iter().map(|f| f.name.as_str()).collect::<Vec<_>>(),
        ["1.txt", "2.txt"]
    );
    assert_eq!(normalize_files::<PathBuf>(&[]), None);
}

#[test]
fn images_are_recognized_by_magic_bytes_and_unknown_bytes_are_rejected() {
    let cases: [(&[u8], ImageFormat); 5] = [
        (PNG_HEAD, ImageFormat::Png),
        (&[0xFF, 0xD8, 0xFF, 0xE0, 0, 0], ImageFormat::Jpeg),
        (b"GIF89a....", ImageFormat::Gif),
        (b"RIFF\x00\x00\x00\x00WEBPVP8 ", ImageFormat::Webp),
        (
            b"BM\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00",
            ImageFormat::Bmp,
        ),
    ];
    for (bytes, expected) in cases {
        let Ok(CaptureInput::Image { image }) = image_input(bytes.to_vec()) else {
            panic!("{expected:?} 应当被识别");
        };
        assert_eq!(image.format, expected);
        assert_eq!(image.bytes, bytes);
    }
    assert_eq!(
        image_input(b"not an image".to_vec()),
        Err(CaptureError::UnsupportedImage)
    );
    assert_eq!(image_input(Vec::new()), Err(CaptureError::UnsupportedImage));
}

#[test]
fn default_titles_follow_the_rules() {
    let url = normalize_text("https://www.example.com/docs/page/?utm=1#top").unwrap();
    assert_eq!(default_title(&url), "example.com/docs/page");
    let root = normalize_text("https://example.com").unwrap();
    assert_eq!(default_title(&root), "example.com");

    let file = CaptureInput::File {
        file: file_ref(Path::new(r"D:\资料\设计稿 v2.fig")),
    };
    assert_eq!(default_title(&file), "设计稿 v2.fig");
    let files =
        normalize_files(&[r"D:\a\第一份.pdf", r"D:\a\second.pdf", r"D:\a\third.pdf"]).unwrap();
    assert_eq!(default_title(&files), "第一份.pdf 等 3 个文件");

    let text = normalize_text("\n\n  第一行内容  \n第二行").unwrap();
    assert_eq!(default_title(&text), "第一行内容");

    let image = image_input(PNG_HEAD.to_vec()).unwrap();
    assert_eq!(default_title(&image), "图片");
}

#[test]
fn long_text_titles_are_truncated_on_character_boundaries() {
    let long = "很长的待办标题".repeat(40);
    let title = default_title(&normalize_text(&long).unwrap());

    assert_eq!(title.chars().count(), MAX_DEFAULT_TITLE_CHARS);
    assert!(title.ends_with('…'));

    let exact = "x".repeat(MAX_DEFAULT_TITLE_CHARS);
    assert_eq!(default_title(&normalize_text(&exact).unwrap()), exact);

    // 带 emoji 与组合字符时也不能在字符中间切断（否则 String 构造会 panic）。
    let emoji = "🙂".repeat(200);
    let title = default_title(&normalize_text(&emoji).unwrap());
    assert_eq!(title.chars().count(), MAX_DEFAULT_TITLE_CHARS);
}

#[test]
fn a_very_long_url_title_is_truncated_too() {
    let url = format!("https://example.com/{}", "segment/".repeat(50));
    let title = default_title(&normalize_text(&url).unwrap());
    assert!(title.chars().count() <= MAX_DEFAULT_TITLE_CHARS);
    assert!(title.ends_with('…'));
}
