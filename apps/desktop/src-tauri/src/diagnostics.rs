//! 诊断包导出（实施计划 7.3，架构文档 §42）。
//!
//! 打包的内容：应用版本、系统、架构、WebView 版本、数据库 Schema 版本、Workflow 元数据
//! （ID / 名称 / 版本 / 是否启用 / 步骤数，**不含定义本体**）、最近的日志（逐行脱敏）。
//!
//! 不包含：Item 标题与内容、剪贴板、用户文件、任何 Token。日志本身按规范就不记录这些，
//! 这里再做一遍**防御性脱敏**——即使将来某处日志误写了敏感值，导出包里也不会出现。

use std::io::Write;
use std::sync::OnceLock;

use regex::Regex;
use serde::Serialize;

/// 每个日志文件最多取末尾多少字节。
pub const LOG_TAIL_BYTES: usize = 512 * 1024;

/// 最多带多少个日志文件（最近的几天）。
pub const MAX_LOG_FILES: usize = 3;

/// 一个 Workflow 的元数据。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowMeta {
    /// ID。
    pub id: String,
    /// 名称。
    pub name: String,
    /// 来源。
    pub source: String,
    /// 版本。
    pub version: u32,
    /// 是否启用。
    pub enabled: bool,
    /// 优先级。
    pub priority: i32,
    /// Step 数。
    pub step_count: usize,
    /// 是否需要网络。
    pub network: bool,
}

/// 诊断包的内容。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Environment {
    /// 应用版本。
    pub app_version: String,
    /// 操作系统。
    pub os: String,
    /// CPU 架构。
    pub arch: String,
    /// WebView 版本；取不到是 `None`。
    pub webview_version: Option<String>,
    /// 数据库 Schema 版本。
    pub schema_version: Option<i64>,
    /// 导出时间（RFC 3339）。
    pub exported_at: String,
    /// Workflow 元数据。
    pub workflows: Vec<WorkflowMeta>,
}

/// 编译好的脱敏规则（只编译一次）。
fn rules() -> &'static [(Regex, &'static str)] {
    static RULES: OnceLock<Vec<(Regex, &'static str)>> = OnceLock::new();
    RULES.get_or_init(|| {
        let table: &[(&str, &str)] = &[
            // 凭据头与令牌。
            (r"(?i)\b(authorization|proxy-authorization|cookie|set-cookie|x-api-key)\s*[:=]\s*[^\r\n]*", "$1: [redacted]"),
            (r"(?i)\bbearer\s+[A-Za-z0-9._~+/=-]+", "Bearer [redacted]"),
            (r"\b(gh[pousr]_[A-Za-z0-9]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16})\b", "[redacted]"),
            // key=value 形式的敏感字段（值到空白 / 逗号 / 引号为止）。
            (r#"(?i)\b(token|access_token|refresh_token|api[_-]?key|apikey|secret|password|passwd|pwd|session|sid)\b(["']?\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;&"']+)"#, "$1$2[redacted]"),
            // 业务内容字段：日志规范不记录它们，万一记了也不导出。
            (r#"(?i)\b(title|content|body|text|clipboard|note|description|summary)\b(["']?\s*[=:]\s*)("(?:[^"\\]|\\.)*"|'[^']*')"#, "$1$2[redacted]"),
            // URL 的查询串与片段。
            (r"(https?://[^\s?#\x22'<>]+)[?#][^\s\x22'<>]*", "$1?[redacted]"),
            // 邮箱。
            (r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}", "[email]"),
            // 用户目录里的用户名。
            (r"(?i)([A-Z]:\\+Users\\+)[^\\/\s\x22']+", "$1<user>"),
            (r"(/(?:Users|home)/)[^/\s\x22']+", "$1<user>"),
        ];
        table
            .iter()
            .filter_map(|(pattern, replacement)| {
                Regex::new(pattern).ok().map(|regex| (regex, *replacement))
            })
            .collect()
    })
}

/// 脱敏一段文本。
#[must_use]
pub fn redact(text: &str) -> String {
    let mut out = text.to_owned();
    for (regex, replacement) in rules() {
        out = regex.replace_all(&out, *replacement).into_owned();
    }
    out
}

/// 取文本末尾不超过 `max` 字节的部分，并对齐到行首与字符边界。
#[must_use]
pub fn tail(text: &str, max: usize) -> &str {
    if text.len() <= max {
        return text;
    }
    let mut start = text.len() - max;
    while !text.is_char_boundary(start) {
        start += 1;
    }
    match text[start..].find('\n') {
        Some(line_end) => &text[start + line_end + 1..],
        None => &text[start..],
    }
}

/// 读取日志目录里最近的几个日志文件（文件名倒序 = 日期倒序）。读不到的文件跳过。
#[must_use]
pub fn collect_logs(dir: &std::path::Path) -> Vec<(String, String)> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut names: Vec<String> = entries
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|name| name.starts_with("nivlo") && name.ends_with(".log"))
        .collect();
    names.sort_unstable_by(|a, b| b.cmp(a));
    names
        .into_iter()
        .take(MAX_LOG_FILES)
        .filter_map(|name| {
            let bytes = std::fs::read(dir.join(&name)).ok()?;
            Some((name, String::from_utf8_lossy(&bytes).into_owned()))
        })
        .collect()
}

/// 诊断包生成失败。
#[derive(Debug, thiserror::Error)]
pub enum DiagnosticsError {
    /// 写 zip 失败。
    #[error("无法生成诊断包：{0}")]
    Zip(String),
}

/// 生成诊断 zip。`logs` 是 (文件名, 原始内容)，会在这里取尾部并脱敏。
///
/// # Errors
///
/// 打包失败时返回 [`DiagnosticsError`]。
pub fn build_zip(
    environment: &Environment,
    logs: &[(String, String)],
) -> Result<Vec<u8>, DiagnosticsError> {
    let zip_error = |e: &dyn std::fmt::Display| DiagnosticsError::Zip(e.to_string());
    let mut buffer = Vec::new();
    {
        let mut writer = zip::ZipWriter::new(std::io::Cursor::new(&mut buffer));
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        let info = serde_json::to_string_pretty(environment).map_err(|e| zip_error(&e))?;
        writer
            .start_file("environment.json", options)
            .map_err(|e| zip_error(&e))?;
        writer
            .write_all(info.as_bytes())
            .map_err(|e| zip_error(&e))?;
        writer
            .start_file("README.txt", options)
            .map_err(|e| zip_error(&e))?;
        writer
            .write_all(
                "拾序诊断包\n\n包含：运行环境、Workflow 元数据（不含定义）、最近日志（已脱敏）。\n不包含：笔记与待办的标题和内容、剪贴板、你的文件、任何令牌。\n".as_bytes(),
            )
            .map_err(|e| zip_error(&e))?;
        for (name, content) in logs.iter().take(MAX_LOG_FILES) {
            let safe_name: String = name
                .chars()
                .map(|c| {
                    if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') {
                        c
                    } else {
                        '_'
                    }
                })
                .collect();
            writer
                .start_file(format!("logs/{safe_name}"), options)
                .map_err(|e| zip_error(&e))?;
            writer
                .write_all(redact(tail(content, LOG_TAIL_BYTES)).as_bytes())
                .map_err(|e| zip_error(&e))?;
        }
        writer.finish().map_err(|e| zip_error(&e))?;
    }
    Ok(buffer)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use std::io::Read;

    use super::*;

    fn environment() -> Environment {
        Environment {
            app_version: "0.1.0".into(),
            os: "windows".into(),
            arch: "x86_64".into(),
            webview_version: Some("141.0".into()),
            schema_version: Some(6),
            exported_at: "2026-10-11T08:00:00Z".into(),
            workflows: vec![WorkflowMeta {
                id: "builtin.generic-url".into(),
                name: "网页链接".into(),
                source: "builtin".into(),
                version: 1,
                enabled: true,
                priority: 0,
                step_count: 1,
                network: false,
            }],
        }
    }

    fn read_all(zip_bytes: &[u8]) -> Vec<(String, String)> {
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(zip_bytes)).unwrap();
        (0..archive.len())
            .map(|i| {
                let mut file = archive.by_index(i).unwrap();
                let mut text = String::new();
                file.read_to_string(&mut text).unwrap();
                (file.name().to_owned(), text)
            })
            .collect()
    }

    #[test]
    fn credentials_urls_emails_and_home_paths_are_scrubbed() {
        let line = r#"2026 INFO request Authorization: Bearer abc.DEF-123
2026 INFO Cookie: sid=zzz
2026 INFO url=https://x.org/p?token=SECRET123&a=1#frag mail=bob@example.com path=C:\Users\alice\Documents\a.md home=/home/carol/x api_key="KEY456" password=hunter2 gh=ghp_abcdefghijklmnopqrstuvwxyz0123456789"#;
        let out = redact(line);
        for secret in [
            "abc.DEF-123",
            "zzz",
            "SECRET123",
            "frag",
            "bob@example.com",
            "alice",
            "carol",
            "KEY456",
            "hunter2",
            "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
        ] {
            assert!(!out.contains(secret), "泄露了 {secret}：{out}");
        }
        assert!(out.contains("https://x.org/p?[redacted]"));
        assert!(out.contains(r"C:\Users\<user>\Documents\a.md"));
    }

    #[test]
    fn business_content_fields_are_never_exported() {
        let out = redact(
            r#"event=capture title="我的秘密计划" content='银行卡 6222' text="clipboard 内容" duration_ms=3"#,
        );
        for secret in ["秘密计划", "6222", "clipboard 内容"] {
            assert!(!out.contains(secret), "{secret}：{out}");
        }
        assert!(out.contains("duration_ms=3"), "普通字段保持：{out}");
    }

    #[test]
    fn tail_keeps_whole_lines_within_the_limit() {
        let text = "第一行很长很长\n第二行\n第三行\n";
        let t = tail(text, 20);
        assert!(t.len() <= 20);
        assert!(t.ends_with("第三行\n"));
        assert!(!t.starts_with('行'), "不能从半个字符开始");
        assert_eq!(tail("short", 100), "short");
    }

    /// 7.3 验收：用含特征字符串的测试数据，断言导出包中不出现。
    #[test]
    fn the_bundle_never_contains_note_text_clipboard_tokens_or_file_contents() {
        let leaky_log = [
            r#"INFO capture_completed items=1 title="NOTE-BODY-FULL-TEXT-9f3a""#,
            "WARN http host=api.github.com Authorization: token ghp_TOKENVALUE0123456789abcdefghij",
            r#"DEBUG clipboard="CLIPBOARD-CONTENT-77b1" url=https://x.org/a?secret=FILE-CONTENT-31cc"#,
            r"INFO opened C:\Users\realname\Desktop\private.docx",
            "INFO fine duration_ms=12",
        ]
        .join("\n");
        let bytes = build_zip(
            &environment(),
            &[("nivlo.2026-10-11.log".into(), leaky_log)],
        )
        .unwrap();
        let files = read_all(&bytes);
        let everything: String = files.iter().map(|(n, t)| format!("{n}\n{t}\n")).collect();
        for feature in [
            "NOTE-BODY-FULL-TEXT-9f3a",
            "TOKENVALUE",
            "CLIPBOARD-CONTENT-77b1",
            "FILE-CONTENT-31cc",
            "realname",
        ] {
            assert!(!everything.contains(feature), "诊断包泄露了 {feature}");
        }
        assert!(everything.contains("duration_ms=12"));
        assert!(everything.contains("builtin.generic-url"));
        let names: Vec<_> = files.iter().map(|(n, _)| n.as_str()).collect();
        assert!(names.contains(&"environment.json"));
        assert!(names.contains(&"logs/nivlo.2026-10-11.log"));
    }

    #[test]
    fn log_names_cannot_escape_the_logs_folder_and_the_count_is_bounded() {
        let logs: Vec<(String, String)> = (0..6)
            .map(|i| (format!("../evil{i}.log"), "x".to_owned()))
            .collect();
        let bytes = build_zip(&environment(), &logs).unwrap();
        let files = read_all(&bytes);
        assert!(
            files
                .iter()
                .all(|(n, _)| n.matches('/').count() <= 1 && !n.starts_with('/'))
        );
        assert_eq!(
            files.iter().filter(|(n, _)| n.starts_with("logs/")).count(),
            MAX_LOG_FILES
        );
        assert!(
            files.iter().all(|(n, _)| n == "environment.json"
                || n == "README.txt"
                || n.starts_with("logs/"))
        );
    }

    #[test]
    fn only_the_newest_log_files_are_collected_and_other_files_are_ignored() {
        let dir = tempfile::tempdir().unwrap();
        for day in ["09", "10", "11", "12"] {
            std::fs::write(dir.path().join(format!("nivlo.2026-10-{day}.log")), day).unwrap();
        }
        std::fs::write(dir.path().join("other.txt"), "x").unwrap();
        let logs = collect_logs(dir.path());
        let names: Vec<_> = logs.iter().map(|(n, _)| n.as_str()).collect();
        assert_eq!(
            names,
            [
                "nivlo.2026-10-12.log",
                "nivlo.2026-10-11.log",
                "nivlo.2026-10-10.log"
            ]
        );
        assert!(collect_logs(&dir.path().join("missing")).is_empty());
    }
}
