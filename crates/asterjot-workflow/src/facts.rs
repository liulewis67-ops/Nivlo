//! 输入事实：Matcher 与模板都从这里读取捕获输入的各个部分。
//!
//! 同一份输入有两种读法：
//! * [`InputFacts::values`]——给 Matcher 用：一个字段可能有**多个值**（多文件输入时每个文件一个），
//!   条件「任一值满足」即满足；
//! * [`InputFacts::scope`]——给模板与 Step 用：一张 `名称 → 值` 的扁平表（`url.host`、`file.name`、
//!   `input.title`……），多文件输入的 `file.*` 取第一个文件，逐个文件处理时由 `createItem` 覆盖。

use std::collections::HashMap;

use asterjot_domain::capture::{CaptureInput, FileRef, default_title};
use asterjot_domain::workflow::Field;
use chrono::NaiveDate;
use url::Url;

/// 一次捕获输入连同它的上下文。
#[derive(Debug, Clone, Copy)]
pub struct InputFacts<'a> {
    /// 内容。
    pub input: &'a CaptureInput,
    /// 捕获时的来源应用（前台应用）；未知为 `None`。
    pub source_application: Option<&'a str>,
}

/// 输入种类的名称（`input.type` 的值）。
#[must_use]
pub fn input_kind(input: &CaptureInput) -> &'static str {
    match input {
        CaptureInput::Text { .. } => "text",
        CaptureInput::Url { .. } => "url",
        CaptureInput::File { .. } => "file",
        CaptureInput::Files { .. } => "files",
        CaptureInput::Image { .. } => "image",
    }
}

/// 输入里的全部文件引用（单个文件当作一个）。
#[must_use]
pub fn files_of(input: &CaptureInput) -> Vec<&FileRef> {
    match input {
        CaptureInput::File { file } => vec![file],
        CaptureInput::Files { files } => files.iter().collect(),
        _ => Vec::new(),
    }
}

/// 把一个文件的信息写进变量表（`file.name`、`file.stem`……）。
pub fn put_file(scope: &mut HashMap<String, String>, file: &FileRef) {
    scope.insert("file.name".to_owned(), file.name.clone());
    let stem = file
        .extension
        .as_deref()
        .and_then(|ext| file.name.strip_suffix(&format!(".{ext}")))
        .unwrap_or(&file.name);
    scope.insert("file.stem".to_owned(), stem.to_owned());
    scope.insert("file.path".to_owned(), file.path.clone());
    scope.insert(
        "file.extension".to_owned(),
        file.extension.clone().unwrap_or_default(),
    );
    scope.insert(
        "file.mime".to_owned(),
        file.mime.clone().unwrap_or_default(),
    );
    scope.insert(
        "file.is_dir".to_owned(),
        if file.is_dir { "true" } else { "false" }.to_owned(),
    );
}

impl InputFacts<'_> {
    /// 解析 URL 输入。
    fn url(&self) -> Option<Url> {
        match self.input {
            CaptureInput::Url { url } => Url::parse(url).ok(),
            _ => None,
        }
    }

    /// Matcher 读取某个字段的全部值（没有该字段时为空）。
    #[must_use]
    pub fn values(&self, field: &Field) -> Vec<String> {
        let url = self.url();
        match field {
            Field::InputType => vec![input_kind(self.input).to_owned()],
            Field::UrlScheme => url.map(|u| u.scheme().to_owned()).into_iter().collect(),
            Field::UrlHost => url
                .and_then(|u| u.host_str().map(str::to_owned))
                .into_iter()
                .collect(),
            Field::UrlPath => url.map(|u| u.path().to_owned()).into_iter().collect(),
            Field::UrlQuery(key) => url
                .map(|u| {
                    u.query_pairs()
                        .filter(|(k, _)| k == key)
                        .map(|(_, v)| v.into_owned())
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default(),
            Field::FileName => files_of(self.input)
                .iter()
                .map(|f| f.name.clone())
                .collect(),
            Field::FileExtension => files_of(self.input)
                .iter()
                .filter_map(|f| f.extension.clone())
                .collect(),
            Field::FileMime => files_of(self.input)
                .iter()
                .filter_map(|f| f.mime.clone())
                .collect(),
            Field::FilePath => files_of(self.input)
                .iter()
                .map(|f| f.path.clone())
                .collect(),
            Field::Text => match self.input {
                CaptureInput::Text { text } => vec![text.clone()],
                _ => Vec::new(),
            },
            Field::SourceApplication => self
                .source_application
                .map(str::to_owned)
                .into_iter()
                .collect(),
        }
    }

    /// 模板与 Step 使用的变量表。
    #[must_use]
    pub fn scope(&self, today: NaiveDate) -> HashMap<String, String> {
        let mut scope = HashMap::new();
        scope.insert("input.type".to_owned(), input_kind(self.input).to_owned());
        let title = default_title(self.input);
        scope.insert("input.title".to_owned(), title.clone());
        scope.insert("now.date".to_owned(), today.format("%Y-%m-%d").to_string());
        scope.insert(
            "source.application".to_owned(),
            self.source_application.unwrap_or_default().to_owned(),
        );
        match self.input {
            CaptureInput::Text { text } => {
                scope.insert("input.text".to_owned(), text.clone());
                // 标题已经能完整表达（单行、没被截断）时不重复放进内容。
                let extra = if *text == title { "" } else { text.as_str() };
                scope.insert("input.extra".to_owned(), extra.to_owned());
            }
            CaptureInput::Url { url } => {
                scope.insert("input.url".to_owned(), url.clone());
                if let Ok(parsed) = Url::parse(url) {
                    scope.insert("url.scheme".to_owned(), parsed.scheme().to_owned());
                    scope.insert(
                        "url.host".to_owned(),
                        parsed.host_str().unwrap_or_default().to_owned(),
                    );
                    // 主机加显式端口（`jira.corp:8080`）：自托管服务常用非默认端口，集成要用它拼地址。
                    let authority = match (parsed.host_str(), parsed.port()) {
                        (Some(host), Some(port)) => format!("{host}:{port}"),
                        (Some(host), None) => host.to_owned(),
                        _ => String::new(),
                    };
                    scope.insert("url.authority".to_owned(), authority);
                    scope.insert("url.path".to_owned(), parsed.path().to_owned());
                    for (key, value) in parsed.query_pairs() {
                        scope
                            .entry(format!("url.query.{key}"))
                            .or_insert_with(|| value.into_owned());
                    }
                }
            }
            CaptureInput::File { .. } | CaptureInput::Files { .. } => {
                let files = files_of(self.input);
                scope.insert("input.file_count".to_owned(), files.len().to_string());
                if let Some(first) = files.first() {
                    put_file(&mut scope, first);
                }
            }
            CaptureInput::Image { .. } => {}
        }
        scope
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use asterjot_domain::capture::{FileRef, ImageData, ImageFormat};

    use super::*;

    /// 一个文件引用。
    fn file(path: &str, name: &str, ext: Option<&str>) -> FileRef {
        FileRef {
            path: path.into(),
            name: name.into(),
            extension: ext.map(str::to_owned),
            size_bytes: Some(10),
            mime: ext.map(|e| format!("application/{e}")),
            is_dir: false,
        }
    }

    fn today() -> NaiveDate {
        NaiveDate::from_ymd_opt(2026, 10, 14).unwrap()
    }

    #[test]
    fn url_inputs_expose_their_parts() {
        let input = CaptureInput::Url {
            url: "https://acme.atlassian.net/browse/REQ-12?draft=1&a=x&a=y".into(),
        };
        let facts = InputFacts {
            input: &input,
            source_application: Some("Chrome"),
        };
        assert_eq!(facts.values(&Field::InputType), ["url"]);
        assert_eq!(facts.values(&Field::UrlScheme), ["https"]);
        assert_eq!(facts.values(&Field::UrlHost), ["acme.atlassian.net"]);
        assert_eq!(facts.values(&Field::UrlPath), ["/browse/REQ-12"]);
        assert_eq!(facts.values(&Field::UrlQuery("a".into())), ["x", "y"]);
        assert!(facts.values(&Field::UrlQuery("missing".into())).is_empty());
        assert_eq!(facts.values(&Field::SourceApplication), ["Chrome"]);
        assert!(facts.values(&Field::FileName).is_empty());
        assert!(facts.values(&Field::Text).is_empty());

        let scope = facts.scope(today());
        assert_eq!(scope["url.host"], "acme.atlassian.net");
        assert_eq!(scope["url.query.draft"], "1");
        assert_eq!(scope["url.query.a"], "x", "同名参数取第一个");
        assert_eq!(scope["input.title"], "acme.atlassian.net/browse/REQ-12");
        assert_eq!(scope["now.date"], "2026-10-14");
    }

    #[test]
    fn text_inputs_only_repeat_the_text_in_the_content_when_the_title_is_not_enough() {
        let single = CaptureInput::Text {
            text: "买牛奶".into(),
        };
        let scope = InputFacts {
            input: &single,
            source_application: None,
        }
        .scope(today());
        assert_eq!(scope["input.title"], "买牛奶");
        assert_eq!(scope["input.extra"], "");

        let multi = CaptureInput::Text {
            text: "第一行\n第二行".into(),
        };
        let scope = InputFacts {
            input: &multi,
            source_application: None,
        }
        .scope(today());
        assert_eq!(scope["input.title"], "第一行");
        assert_eq!(scope["input.extra"], "第一行\n第二行");
    }

    #[test]
    fn file_inputs_expose_every_file_and_the_first_in_scope() {
        let input = CaptureInput::Files {
            files: vec![
                file(r"D:\a\报告.pdf", "报告.pdf", Some("pdf")),
                file(r"D:\a\图.png", "图.png", Some("png")),
            ],
        };
        let facts = InputFacts {
            input: &input,
            source_application: None,
        };
        assert_eq!(facts.values(&Field::FileName), ["报告.pdf", "图.png"]);
        assert_eq!(facts.values(&Field::FileExtension), ["pdf", "png"]);
        let scope = facts.scope(today());
        assert_eq!(scope["file.name"], "报告.pdf");
        assert_eq!(scope["file.stem"], "报告");
        assert_eq!(scope["input.file_count"], "2");
        assert_eq!(scope["file.is_dir"], "false");
    }

    #[test]
    fn images_have_no_text_url_or_file_fields() {
        let input = CaptureInput::Image {
            image: ImageData {
                bytes: vec![1],
                format: ImageFormat::Png,
            },
        };
        let facts = InputFacts {
            input: &input,
            source_application: None,
        };
        assert_eq!(facts.values(&Field::InputType), ["image"]);
        assert!(facts.values(&Field::FileName).is_empty());
        assert_eq!(facts.scope(today())["input.title"], "图片");
    }
}
