//! 数据导出（实施计划 7.4）：把全部 Item 导出成 JSON 或 Markdown，随时可以在任何编辑器里读。
//!
//! * JSON：一个文件，完整、机器可读（含来源、标签、项目、时间戳）；
//! * Markdown：一个文件（按时间顺序的分节）或每个 Item 一个文件（带 YAML front matter）；
//! * 回收站里的 Item 不导出；Workflow 与设置不在这里（它们在备份里）；不含任何 Secret。
//!
//! 纯读取：不改任何数据，也不写磁盘——返回要写的文件，由宿主决定写在哪里。

use std::collections::HashMap;
use std::sync::Arc;

use chrono::{DateTime, Utc};
use nivlo_common::clock::Clock;
use nivlo_domain::item::{DatePoint, Item, ItemType};
use nivlo_domain::source::Source;
use serde_json::{Value, json};

use crate::error::AppError;
use crate::ports::{ItemFilter, UnitOfWork};

/// 导出格式。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExportFormat {
    /// 单个 JSON 文件。
    Json,
    /// 单个 Markdown 文件。
    Markdown,
    /// 每个 Item 一个 Markdown 文件。
    MarkdownFiles,
}

/// 要写出的一个文件。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExportedFile {
    /// 相对路径（`/` 分隔，不含 `..`）。
    pub path: String,
    /// 内容。
    pub bytes: Vec<u8>,
}

/// 导出结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExportBundle {
    /// 要写出的文件。
    pub files: Vec<ExportedFile>,
    /// 导出了多少个 Item。
    pub item_count: usize,
}

/// 一个 Item 连同它的关联信息。
struct Entry {
    /// Item。
    item: Item,
    /// 项目名。
    project: Option<String>,
    /// 标签名。
    tags: Vec<String>,
    /// 来源。
    sources: Vec<Source>,
}

/// 导出的 Use Case。
#[derive(Clone)]
pub struct ExportService {
    /// 事务工厂。
    uow: Arc<dyn UnitOfWork>,
    /// 时钟。
    clock: Arc<dyn Clock>,
}

impl ExportService {
    /// 创建服务。
    pub fn new(uow: Arc<dyn UnitOfWork>, clock: Arc<dyn Clock>) -> Self {
        Self { uow, clock }
    }

    /// 导出全部 Item。
    ///
    /// # Errors
    ///
    /// 存储错误。
    pub async fn export(&self, format: ExportFormat) -> Result<ExportBundle, AppError> {
        let entries = self.collect().await?;
        let exported_at = self.clock.now_utc();
        let item_count = entries.len();
        let files = match format {
            ExportFormat::Json => vec![ExportedFile {
                path: "nivlo-export.json".to_owned(),
                bytes: to_json(&entries, exported_at).into_bytes(),
            }],
            ExportFormat::Markdown => vec![ExportedFile {
                path: "nivlo-export.md".to_owned(),
                bytes: to_markdown(&entries, exported_at).into_bytes(),
            }],
            ExportFormat::MarkdownFiles => entries
                .iter()
                .map(|entry| ExportedFile {
                    path: format!("{}.md", file_stem(&entry.item)),
                    bytes: item_markdown(entry, true).into_bytes(),
                })
                .collect(),
        };
        Ok(ExportBundle { files, item_count })
    }

    /// 读取全部 Item 及其标签 / 来源 / 项目名（一个事务，一致的视图）。
    async fn collect(&self) -> Result<Vec<Entry>, AppError> {
        let mut tx = self.uow.begin_read().await?;
        let filter = ItemFilter {
            include_archived: true,
            ..ItemFilter::default()
        };
        let items = tx.items().list(&filter).await?;
        let projects: HashMap<_, _> = tx
            .projects()
            .list(true)
            .await?
            .into_iter()
            .map(|p| (p.id, p.name.as_str().to_owned()))
            .collect();
        let mut entries = Vec::with_capacity(items.len());
        for item in items {
            let tags = tx
                .tags()
                .for_item(item.id())
                .await?
                .into_iter()
                .map(|t| t.name.as_str().to_owned())
                .collect();
            let sources = tx.sources().list_for_item(item.id()).await?;
            let project = item.project_id().and_then(|id| projects.get(&id).cloned());
            entries.push(Entry {
                item,
                project,
                tags,
                sources,
            });
        }
        // 按创建时间从早到晚，同一时刻按 ID，输出稳定。
        entries.sort_by(|a, b| {
            a.item
                .created_at()
                .cmp(&b.item.created_at())
                .then_with(|| a.item.id().to_string().cmp(&b.item.id().to_string()))
        });
        Ok(entries)
    }
}

/// 日期点 → 文本（`2026-10-11` 或 `2026-10-11 09:30`）。
fn date_text(point: DatePoint) -> String {
    match point.time() {
        Some(time) => format!(
            "{} {}",
            point.date().format("%Y-%m-%d"),
            time.format("%H:%M")
        ),
        None => point.date().format("%Y-%m-%d").to_string(),
    }
}

/// 时间点 → RFC 3339。
fn instant(value: DateTime<Utc>) -> String {
    value.to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

/// 类型的中文名。
fn type_label(item_type: ItemType) -> &'static str {
    match item_type {
        ItemType::Todo => "待办",
        ItemType::Note => "笔记",
        ItemType::Tip => "提示",
    }
}

/// 一个 Item 的 JSON 表示。
fn item_json(entry: &Entry) -> Value {
    let item = &entry.item;
    json!({
        "id": item.id().to_string(),
        "type": item.item_type().as_str(),
        "title": item.title().as_str(),
        "brief": item.brief(),
        "content": item.content(),
        "contentFormat": item.content_format().as_str(),
        "status": item.status().as_str(),
        "priority": item.priority().as_str(),
        "scheduled": item.scheduled().map(date_text),
        "due": item.due().map(date_text),
        "reminderAt": item.reminder_at().map(instant),
        "inInbox": item.in_inbox(),
        "project": entry.project,
        "tags": entry.tags,
        "createdAt": instant(item.created_at()),
        "updatedAt": instant(item.updated_at()),
        "completedAt": item.completed_at().map(instant),
        "archivedAt": item.archived_at().map(instant),
        "sources": entry.sources.iter().map(|s| json!({
            "type": s.source_type.as_str(),
            "app": s.source_app,
            "url": s.source_url,
            "path": s.source_path,
            "originalTitle": s.original_title,
            "capturedAt": instant(s.captured_at),
        })).collect::<Vec<_>>(),
    })
}

/// 整体 JSON。
fn to_json(entries: &[Entry], exported_at: DateTime<Utc>) -> String {
    let document = json!({
        "format": "nivlo-export",
        "version": 1,
        "exportedAt": instant(exported_at),
        "itemCount": entries.len(),
        "items": entries.iter().map(item_json).collect::<Vec<_>>(),
    });
    serde_json::to_string_pretty(&document).unwrap_or_default()
}

/// 来源的一句话描述。
fn source_line(source: &Source) -> String {
    let mut parts = vec![source.source_type.as_str().to_owned()];
    if let Some(app) = &source.source_app {
        parts.push(app.clone());
    }
    if let Some(title) = &source.original_title {
        parts.push(title.clone());
    }
    if let Some(url) = &source.source_url {
        parts.push(url.clone());
    }
    if let Some(path) = &source.source_path {
        parts.push(path.clone());
    }
    parts.join(" · ")
}

/// 元信息行（类型、状态、日期、项目、标签）。
fn meta_line(entry: &Entry) -> String {
    let item = &entry.item;
    let mut parts = vec![type_label(item.item_type()).to_owned()];
    if item.item_type() == ItemType::Todo {
        parts.push(
            if item.is_done() {
                "已完成"
            } else {
                "未完成"
            }
            .to_owned(),
        );
    }
    if let Some(day) = item.scheduled() {
        parts.push(format!("计划 {}", date_text(day)));
    }
    if let Some(day) = item.due() {
        parts.push(format!("截止 {}", date_text(day)));
    }
    if let Some(project) = &entry.project {
        parts.push(format!("项目 {project}"));
    }
    if !entry.tags.is_empty() {
        parts.push(
            entry
                .tags
                .iter()
                .map(|t| format!("#{t}"))
                .collect::<Vec<_>>()
                .join(" "),
        );
    }
    parts.join(" · ")
}

/// 一个 Item 的 Markdown：`front_matter` 为真时带 YAML 头（每个 Item 一个文件时用）。
fn item_markdown(entry: &Entry, front_matter: bool) -> String {
    let item = &entry.item;
    let mut out = String::new();
    if front_matter {
        out.push_str("---\n");
        out.push_str(&format!("id: {}\n", item.id()));
        out.push_str(&format!("type: {}\n", item.item_type().as_str()));
        out.push_str(&format!("status: {}\n", item.status().as_str()));
        out.push_str(&format!("created: {}\n", instant(item.created_at())));
        out.push_str(&format!("updated: {}\n", instant(item.updated_at())));
        if let Some(day) = item.scheduled() {
            out.push_str(&format!("scheduled: {}\n", date_text(day)));
        }
        if let Some(project) = &entry.project {
            out.push_str(&format!("project: {}\n", yaml_string(project)));
        }
        if !entry.tags.is_empty() {
            out.push_str(&format!(
                "tags: [{}]\n",
                entry
                    .tags
                    .iter()
                    .map(|t| yaml_string(t))
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
        out.push_str("---\n\n");
    }
    let marker = match (item.item_type(), item.is_done()) {
        (ItemType::Todo, true) => "[x] ",
        (ItemType::Todo, false) => "[ ] ",
        _ => "",
    };
    out.push_str(&format!(
        "{} {marker}{}\n\n",
        if front_matter { "#" } else { "##" },
        item.title().as_str()
    ));
    out.push_str(&format!("_{}_\n\n", meta_line(entry)));
    if let Some(brief) = item.brief() {
        out.push_str(&format!("> {brief}\n\n"));
    }
    if let Some(content) = item.content() {
        out.push_str(content.trim_end());
        out.push_str("\n\n");
    }
    if !entry.sources.is_empty() {
        out.push_str("来源：\n\n");
        for source in &entry.sources {
            out.push_str(&format!("- {}\n", source_line(source)));
        }
        out.push('\n');
    }
    out
}

/// YAML 字符串（双引号包裹并转义）。
fn yaml_string(text: &str) -> String {
    format!(
        "\"{}\"",
        text.replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('\n', " ")
    )
}

/// 整体 Markdown（单文件）。
fn to_markdown(entries: &[Entry], exported_at: DateTime<Utc>) -> String {
    let mut out = format!(
        "# 拾序导出\n\n导出时间：{} · 共 {} 条\n\n---\n\n",
        instant(exported_at),
        entries.len()
    );
    for entry in entries {
        out.push_str(&item_markdown(entry, false));
        out.push_str("---\n\n");
    }
    out
}

/// 每个 Item 一个文件时的文件名（不含扩展名）：净化后的标题 + ID 前 8 位，保证唯一且在 Windows 上合法。
fn file_stem(item: &Item) -> String {
    let cleaned: String = item
        .title()
        .as_str()
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
                ' '
            } else {
                c
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let cleaned: String = cleaned.chars().take(40).collect();
    let cleaned = cleaned.trim().trim_end_matches('.').to_owned();
    let short: String = item.id().to_string().chars().take(8).collect();
    if cleaned.is_empty() {
        short
    } else {
        format!("{cleaned}-{short}")
    }
}

#[cfg(test)]
mod tests;
