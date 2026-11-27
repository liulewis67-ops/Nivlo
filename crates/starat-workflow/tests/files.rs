//! 文件类 Workflow（实施计划 6.6）：每种 fixture 文件生成预期的 Item 类型、标题与 Source。

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, missing_docs)]

use std::collections::HashMap;
use std::io::Write;
use std::path::Path;
use std::sync::Arc;

use async_trait::async_trait;
use chrono::NaiveDate;
use starat_application::ports::inspect::{FileInspector, InspectError};
use starat_application::workflow::{RunMode, WorkflowEngine, WorkflowRunResult};
use starat_capture::{file_ref, normalize_files};
use starat_domain::capture::CaptureInput;
use starat_domain::item::ItemType;
use starat_workflow::{WorkflowEngineAdapter, builtin::builtin_workflows};

/// 预设的文件内容（按文件名）。
type Samples = HashMap<String, Result<Vec<u8>, InspectError>>;

/// 按文件名返回预设内容的假检查器；记下每次读取的 `(文件名, 偏移, 长度)`。
struct FakeFiles(Samples, std::sync::Mutex<Vec<(String, u64, u64)>>);

impl FakeFiles {
    fn new(samples: Samples) -> Self {
        Self(samples, std::sync::Mutex::new(Vec::new()))
    }

    fn get(&self, path: &str) -> Result<&Vec<u8>, InspectError> {
        let name = Path::new(path)
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        match self.0.get(&name) {
            Some(Ok(bytes)) => Ok(bytes),
            Some(Err(error)) => Err(error.clone()),
            None => Err(InspectError::Missing),
        }
    }
}

#[async_trait]
impl FileInspector for FakeFiles {
    async fn stat(&self, path: &str) -> Result<u64, InspectError> {
        self.get(path).map(|bytes| bytes.len() as u64)
    }

    async fn read_at(&self, path: &str, offset: u64, len: u64) -> Result<Vec<u8>, InspectError> {
        let bytes = self.get(path)?;
        let name = Path::new(path)
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        self.1.lock().unwrap().push((name, offset, len));
        let start = (offset as usize).min(bytes.len());
        let end = start
            .saturating_add(len.min(64 * 1024 * 1024) as usize)
            .min(bytes.len());
        Ok(bytes[start..end].to_vec())
    }
}

fn content(bytes: &[u8]) -> Result<Vec<u8>, InspectError> {
    Ok(bytes.to_vec())
}

fn docx(title: &str) -> Vec<u8> {
    let mut buffer = Vec::new();
    {
        let mut writer = zip::ZipWriter::new(std::io::Cursor::new(&mut buffer));
        writer
            .start_file(
                "docProps/core.xml",
                zip::write::SimpleFileOptions::default(),
            )
            .unwrap();
        writer
            .write_all(
                format!("<cp:coreProperties><dc:title>{title}</dc:title></cp:coreProperties>")
                    .as_bytes(),
            )
            .unwrap();
        writer.finish().unwrap();
    }
    buffer
}

fn today() -> NaiveDate {
    NaiveDate::from_ymd_opt(2026, 10, 11).unwrap()
}

async fn run(path: &str, samples: Samples) -> WorkflowRunResult {
    let engine = WorkflowEngineAdapter::with_ports(None, Some(Arc::new(FakeFiles::new(samples))));
    let input = CaptureInput::File {
        file: file_ref(Path::new(path)),
    };
    engine
        .resolve_and_run(
            &builtin_workflows(),
            &input,
            None,
            today(),
            RunMode::Instant,
        )
        .await
        .unwrap()
}

fn one(name: &str, sample: Result<Vec<u8>, InspectError>) -> Samples {
    HashMap::from([(name.to_owned(), sample)])
}

#[tokio::test]
async fn markdown_uses_its_first_heading_as_the_title() {
    let result = run(
        r"D:\笔记\设计.md",
        one("设计.md", content("# 登录流程设计\n正文".as_bytes())),
    )
    .await;
    assert_eq!(result.workflow_id.as_str(), "builtin.file-document");
    let items = result.result.unwrap();
    assert_eq!(items[0].item_type, ItemType::Note);
    assert_eq!(items[0].title, "登录流程设计");
    assert!(items[0].attach, "文件引用照常保存");
}

#[tokio::test]
async fn pdf_and_word_titles_come_from_document_properties() {
    let pdf = run(
        r"D:\资料\report.pdf",
        one(
            "report.pdf",
            content(b"%PDF-1.4 << /Title (Annual Report) >>"),
        ),
    )
    .await;
    assert_eq!(pdf.result.unwrap()[0].title, "Annual Report");

    let word = run(
        r"D:\资料\spec.docx",
        one("spec.docx", content(&docx("接口规格"))),
    )
    .await;
    assert_eq!(word.result.unwrap()[0].title, "接口规格");
}

#[tokio::test]
async fn documents_without_a_readable_title_fall_back_to_the_file_name() {
    for (path, name, bytes) in [
        (r"D:\a\notes.md", "notes.md", &b"no heading"[..]),
        (r"D:\a\scan.pdf", "scan.pdf", &b"%PDF-1.4 binary only"[..]),
        (r"D:\a\broken.docx", "broken.docx", &b"not a zip"[..]),
    ] {
        let result = run(path, one(name, content(bytes))).await;
        assert_eq!(result.result.unwrap()[0].title, name);
    }
}

#[tokio::test]
async fn missing_unreadable_or_cloud_only_files_are_saved_as_references_with_the_file_name() {
    for sample in [
        Err(InspectError::Missing),
        Err(InspectError::Io("denied".into())),
        Err(InspectError::CloudOnly),
    ] {
        let result = run(r"D:\a\big.md", one("big.md", sample)).await;
        let items = result.result.unwrap();
        assert_eq!(items[0].title, "big.md");
        assert!(items[0].attach);
    }
}

/// 用给定的假文件跑一次单文件捕获，返回标题与读取记录。
async fn run_reading(path: &str, name: &str, bytes: Vec<u8>) -> (String, Vec<(String, u64, u64)>) {
    let files = Arc::new(FakeFiles::new(HashMap::from([(
        name.to_owned(),
        Ok(bytes),
    )])));
    let engine = WorkflowEngineAdapter::with_ports(None, Some(files.clone()));
    let input = CaptureInput::File {
        file: file_ref(Path::new(path)),
    };
    let result = engine
        .resolve_and_run(
            &builtin_workflows(),
            &input,
            None,
            today(),
            RunMode::Instant,
        )
        .await
        .unwrap();
    let title = result.result.unwrap()[0].title.clone();
    let reads = files.1.lock().unwrap().clone();
    (title, reads)
}

#[tokio::test]
async fn big_files_get_their_title_while_only_a_small_part_is_read() {
    // 40 MB 的 Markdown：以前超过 32 MB 就不读，现在只读开头。
    let mut markdown = "# 大文件的标题\n".as_bytes().to_vec();
    markdown.resize(40 * 1024 * 1024, b'x');
    let (title, reads) = run_reading(r"D:\a\big.md", "big.md", markdown).await;
    assert_eq!(title, "大文件的标题");
    let read: u64 = reads.iter().map(|(_, _, len)| len).sum();
    assert!(read <= 256 * 1024, "只读了开头：{read}");

    // 一个塞了 30 MB 媒体的演示文稿：只读 zip 目录和 core.xml。
    let mut pptx = Vec::new();
    {
        let mut writer = zip::ZipWriter::new(std::io::Cursor::new(&mut pptx));
        let stored = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        writer.start_file("ppt/media/video.mp4", stored).unwrap();
        writer.write_all(&vec![0_u8; 30 * 1024 * 1024]).unwrap();
        writer
            .start_file(
                "docProps/core.xml",
                zip::write::SimpleFileOptions::default(),
            )
            .unwrap();
        writer
            .write_all(
                "<cp:coreProperties><dc:title>年度规划</dc:title></cp:coreProperties>".as_bytes(),
            )
            .unwrap();
        writer.finish().unwrap();
    }
    let (title, reads) = run_reading(r"D:\a\plan.pptx", "plan.pptx", pptx).await;
    assert_eq!(title, "年度规划");
    let read: u64 = reads.iter().map(|(_, _, len)| len).sum();
    assert!(read < 512 * 1024, "只读了目录和元数据：{read}");

    // 12 MB 的 PDF：只读头尾，标题在末尾的 Info 字典里。
    let mut pdf = b"%PDF-1.4\n".to_vec();
    pdf.resize(12 * 1024 * 1024, b' ');
    pdf.extend_from_slice(b"\n9 0 obj << /Title (Tail Title) >> endobj\ntrailer << /Info 9 0 R >>");
    let (title, reads) = run_reading(r"D:\a\scan.pdf", "scan.pdf", pdf).await;
    assert_eq!(title, "Tail Title");
    let read: u64 = reads.iter().map(|(_, _, len)| len).sum();
    assert!(read <= 2 * 1024 * 1024, "只读了头尾：{read}");
}

#[tokio::test]
async fn requirement_files_become_todos() {
    for name in ["REQ-123 登录.docx", "PRD-7.pdf", "req-9.md"] {
        let result = run(&format!(r"D:\a\{name}"), HashMap::new()).await;
        assert_eq!(
            result.workflow_id.as_str(),
            "builtin.file-requirements",
            "{name}"
        );
        let items = result.result.unwrap();
        assert_eq!(items[0].item_type, ItemType::Todo);
        assert_eq!(items[0].title, format!("处理 {name}"));
    }
}

#[tokio::test]
async fn meeting_notes_get_a_tag_and_their_heading() {
    let result = run(
        r"D:\a\meeting-2026-10-11.md",
        one(
            "meeting-2026-10-11.md",
            content("# 周会\n- 事项".as_bytes()),
        ),
    )
    .await;
    assert_eq!(result.workflow_id.as_str(), "builtin.file-meeting");
    let items = result.result.unwrap();
    assert_eq!(items[0].title, "周会");
    assert_eq!(items[0].tags, vec!["meeting".to_owned()]);
}

#[tokio::test]
async fn other_files_and_multi_file_drops_keep_the_generic_behaviour() {
    let result = run(r"D:\a\photo.png", HashMap::new()).await;
    assert_eq!(result.workflow_id.as_str(), "builtin.generic-file");
    assert_eq!(result.result.unwrap()[0].title, "photo.png");

    let engine =
        WorkflowEngineAdapter::with_ports(None, Some(Arc::new(FakeFiles::new(HashMap::new()))));
    let input = normalize_files(&[r"D:\a\1.png", r"D:\a\2.zip"]).unwrap();
    let result = engine
        .resolve_and_run(
            &builtin_workflows(),
            &input,
            None,
            today(),
            RunMode::Instant,
        )
        .await
        .unwrap();
    assert_eq!(result.workflow_id.as_str(), "builtin.generic-file");
    assert_eq!(result.result.unwrap().len(), 2);
}

#[tokio::test]
async fn each_document_in_a_multi_file_drop_gets_its_own_title() {
    let samples = HashMap::from([
        ("1.md".to_owned(), content("# 第一篇\n正文".as_bytes())),
        (
            "2.pdf".to_owned(),
            content(b"%PDF-1.4 << /Title (Second) >>"),
        ),
        ("3.md".to_owned(), content(b"no heading")),
    ]);
    let engine = WorkflowEngineAdapter::with_ports(None, Some(Arc::new(FakeFiles::new(samples))));
    // 混进一个不是文档的文件：它不被读取，按文件名建笔记。
    let input =
        normalize_files(&[r"D:\a\1.md", r"D:\a\2.pdf", r"D:\a\3.md", r"D:\a\photo.png"]).unwrap();
    let result = engine
        .resolve_and_run(
            &builtin_workflows(),
            &input,
            None,
            today(),
            RunMode::Instant,
        )
        .await
        .unwrap();
    assert_eq!(result.workflow_id.as_str(), "builtin.file-document");
    let items = result.result.unwrap();
    let titles: Vec<_> = items.iter().map(|i| i.title.as_str()).collect();
    assert_eq!(titles, ["第一篇", "Second", "3.md", "photo.png"]);
    let indexes: Vec<_> = items.iter().map(|i| i.file_index).collect();
    assert_eq!(indexes, [Some(0), Some(1), Some(2), Some(3)]);
    assert!(items.iter().all(|i| i.attach));
}
