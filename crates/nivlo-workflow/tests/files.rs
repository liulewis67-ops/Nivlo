//! 文件类 Workflow（实施计划 6.6）：每种 fixture 文件生成预期的 Item 类型、标题与 Source。

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, missing_docs)]

use std::collections::HashMap;
use std::io::Write;
use std::path::Path;
use std::sync::Arc;

use async_trait::async_trait;
use chrono::NaiveDate;
use nivlo_application::ports::inspect::{FileInspector, FileSample, InspectError};
use nivlo_application::workflow::{RunMode, WorkflowEngine, WorkflowRunResult};
use nivlo_capture::{file_ref, normalize_files};
use nivlo_domain::capture::CaptureInput;
use nivlo_domain::item::ItemType;
use nivlo_workflow::{WorkflowEngineAdapter, builtin::builtin_workflows};

/// 预设的检查结果（按文件名）。
type Samples = HashMap<String, Result<FileSample, InspectError>>;

/// 按文件名返回预设内容的假检查器。
struct FakeFiles(Samples);

#[async_trait]
impl FileInspector for FakeFiles {
    async fn sample(&self, path: &str) -> Result<FileSample, InspectError> {
        let name = Path::new(path)
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        self.0
            .get(&name)
            .cloned()
            .unwrap_or(Err(InspectError::Missing))
    }
}

fn content(bytes: &[u8]) -> Result<FileSample, InspectError> {
    Ok(FileSample {
        size: bytes.len() as u64,
        content: Some(bytes.to_vec()),
    })
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
    let engine = WorkflowEngineAdapter::with_ports(None, Some(Arc::new(FakeFiles(samples))));
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

fn one(name: &str, sample: Result<FileSample, InspectError>) -> Samples {
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
async fn oversized_missing_or_unreadable_files_are_saved_as_references_with_the_file_name() {
    for sample in [
        Ok(FileSample {
            size: 500 * 1024 * 1024,
            content: None,
        }),
        Err(InspectError::Missing),
        Err(InspectError::Io("denied".into())),
    ] {
        let result = run(r"D:\a\big.md", one("big.md", sample)).await;
        let items = result.result.unwrap();
        assert_eq!(items[0].title, "big.md");
        assert!(items[0].attach);
    }
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

    let engine = WorkflowEngineAdapter::with_ports(None, Some(Arc::new(FakeFiles(HashMap::new()))));
    let input = normalize_files(&[r"D:\a\1.md", r"D:\a\2.md"]).unwrap();
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
