//! 页面元数据提取（实施计划 6.3）：`<title>`、`og:*`、`twitter:*`、`description`、favicon，JSON-LD 兜底。
//!
//! 不是完整的 HTML 解析器——只扫描 `<head>` 里的 `<title>` / `<meta>` / `<link>` 标签，
//! 对真实世界里写得不规范的页面足够宽容：属性顺序、引号风格、大小写都不限，
//! 解码常见的 HTML 实体，相对地址按基准地址补全。输入只看前 256 KiB。

// 这里的正则都是编译期常量，由单元测试覆盖；写成 `expect` 比层层传递不可能发生的错误更清楚。
#![allow(clippy::expect_used, clippy::missing_panics_doc)]

use std::sync::OnceLock;

use regex::Regex;
use url::Url;

/// 只扫描页面开头这么多字节（元数据都在 `<head>` 里）。
const SCAN_LIMIT: usize = 256 * 1024;

/// 提取到的元数据；没有的字段是空串。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HtmlMetadata {
    /// 标题：`og:title` 优先，其次 `<title>`。
    pub title: String,
    /// 摘要：`og:description` 优先，其次 `description`。
    pub description: String,
    /// 站点名：`og:site_name`。
    pub site: String,
    /// 预览图：`og:image`。
    pub image: String,
    /// 图标：`<link rel="icon">` 等。
    pub icon: String,
}

/// 一个标签的属性（小写名 → 值）。
fn attributes(tag: &str) -> Vec<(String, String)> {
    static ATTR: OnceLock<Regex> = OnceLock::new();
    let re = ATTR.get_or_init(|| {
        Regex::new(r#"([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))"#)
            .expect("属性正则是常量")
    });
    re.captures_iter(tag)
        .map(|caps| {
            let value = caps
                .get(2)
                .or_else(|| caps.get(3))
                .or_else(|| caps.get(4))
                .map_or("", |m| m.as_str());
            (caps[1].to_ascii_lowercase(), decode_entities(value))
        })
        .collect()
}

/// 取某个属性的值。
fn attr<'a>(attrs: &'a [(String, String)], name: &str) -> Option<&'a str> {
    attrs
        .iter()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.as_str())
}

/// 解码常见的 HTML 实体（命名的几个 + 十进制 / 十六进制数字实体）。
#[must_use]
pub fn decode_entities(text: &str) -> String {
    if !text.contains('&') {
        return text.to_owned();
    }
    static ENTITY: OnceLock<Regex> = OnceLock::new();
    let re = ENTITY.get_or_init(|| {
        Regex::new(r"&(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z]{2,8});").expect("实体正则是常量")
    });
    re.replace_all(text, |caps: &regex::Captures<'_>| {
        let body = &caps[1];
        let decoded = if let Some(hex) = body.strip_prefix("#x").or_else(|| body.strip_prefix("#X"))
        {
            u32::from_str_radix(hex, 16).ok().and_then(char::from_u32)
        } else if let Some(dec) = body.strip_prefix('#') {
            dec.parse::<u32>().ok().and_then(char::from_u32)
        } else {
            match body {
                "amp" => Some('&'),
                "lt" => Some('<'),
                "gt" => Some('>'),
                "quot" => Some('"'),
                "apos" => Some('\''),
                "nbsp" => Some(' '),
                "hellip" => Some('…'),
                "mdash" => Some('—'),
                "ndash" => Some('–'),
                "copy" => Some('©'),
                _ => None,
            }
        };
        decoded.map_or_else(|| caps[0].to_owned(), |c| c.to_string())
    })
    .into_owned()
}

/// 压缩空白（换行、连续空格）为单个空格并去除首尾。
fn squash(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// 补全相对地址；没有基准或解析失败时，只保留本来就是绝对的地址。
fn absolute(raw: &str, base: Option<&Url>) -> String {
    let raw = raw.trim();
    if raw.is_empty() {
        return String::new();
    }
    if let Ok(url) = Url::parse(raw) {
        return if matches!(url.scheme(), "http" | "https") {
            url.to_string()
        } else {
            String::new()
        };
    }
    base.and_then(|b| b.join(raw).ok())
        .filter(|u| matches!(u.scheme(), "http" | "https"))
        .map(|u| u.to_string())
        .unwrap_or_default()
}

/// 第一个非空的值。
fn first_non_empty<const N: usize>(values: [String; N]) -> String {
    values
        .into_iter()
        .find(|v| !v.trim().is_empty())
        .unwrap_or_default()
}

/// JSON-LD（`<script type="application/ld+json">`）里的 `(headline 或 name, description)`：
/// 只在页面没有任何 `<title>` / `og:*` / `twitter:*` 时兜底（单页应用常这样）。
fn json_ld(html: &str) -> (String, String) {
    static SCRIPT: OnceLock<Regex> = OnceLock::new();
    let re = SCRIPT.get_or_init(|| {
        Regex::new(
            r#"(?is)<script[^>]*type\s*=\s*["']?application/ld\+json["']?[^>]*>(.*?)</script\s*>"#,
        )
        .expect("ld+json 正则是常量")
    });
    /// 在一个 JSON 值里找第一个带标题的对象（顶层可以是数组或 `@graph`）。
    fn find(value: &serde_json::Value, depth: u8) -> Option<(String, String)> {
        if depth > 4 {
            return None;
        }
        match value {
            serde_json::Value::Array(items) => items.iter().find_map(|v| find(v, depth + 1)),
            serde_json::Value::Object(map) => {
                let text = |key: &str| {
                    map.get(key)
                        .and_then(serde_json::Value::as_str)
                        .map(|s| squash(&decode_entities(s)))
                        .unwrap_or_default()
                };
                let title = first_non_empty([text("headline"), text("name")]);
                if title.is_empty() {
                    map.get("@graph").and_then(|v| find(v, depth + 1))
                } else {
                    Some((title, text("description")))
                }
            }
            _ => None,
        }
    }
    re.captures_iter(html)
        .filter_map(|caps| serde_json::from_str::<serde_json::Value>(caps[1].trim()).ok())
        .find_map(|value| find(&value, 0))
        .unwrap_or_default()
}

/// 从 HTML 里提取元数据。
#[must_use]
pub fn extract(html: &str, base: Option<&str>) -> HtmlMetadata {
    let mut end = html.len().min(SCAN_LIMIT);
    while !html.is_char_boundary(end) {
        end -= 1;
    }
    let html = &html[..end];
    let base = base.and_then(|b| Url::parse(b).ok());

    static TITLE: OnceLock<Regex> = OnceLock::new();
    static TAG: OnceLock<Regex> = OnceLock::new();
    let title_re = TITLE.get_or_init(|| {
        Regex::new(r"(?is)<title[^>]*>(.*?)</title\s*>").expect("title 正则是常量")
    });
    let tag_re =
        TAG.get_or_init(|| Regex::new(r"(?is)<(?:meta|link)\b[^>]*>").expect("tag 正则是常量"));

    let mut meta = HtmlMetadata::default();
    let mut page_title = title_re
        .captures(html)
        .map(|c| squash(&decode_entities(&c[1])))
        .unwrap_or_default();
    let mut og_title = String::new();
    let mut description = String::new();
    let mut og_description = String::new();
    let mut twitter_title = String::new();
    let mut twitter_description = String::new();
    let mut twitter_image = String::new();
    let mut rel_icon = String::new();
    let mut apple_icon = String::new();

    for tag in tag_re.find_iter(html) {
        let attrs = attributes(tag.as_str());
        let is_link = tag.as_str()[..5].eq_ignore_ascii_case("<link");
        if is_link {
            let rel = attr(&attrs, "rel").unwrap_or("").to_ascii_lowercase();
            let href = attr(&attrs, "href").unwrap_or("");
            if rel.split_whitespace().any(|r| r == "icon") && rel_icon.is_empty() {
                rel_icon = absolute(href, base.as_ref());
            } else if rel.contains("apple-touch-icon") && apple_icon.is_empty() {
                apple_icon = absolute(href, base.as_ref());
            }
            continue;
        }
        let key = attr(&attrs, "property")
            .or_else(|| attr(&attrs, "name"))
            .unwrap_or("")
            .to_ascii_lowercase();
        let content = squash(attr(&attrs, "content").unwrap_or(""));
        if content.is_empty() {
            continue;
        }
        match key.as_str() {
            "og:title" if og_title.is_empty() => og_title = content,
            "twitter:title" if twitter_title.is_empty() => twitter_title = content,
            "og:description" if og_description.is_empty() => og_description = content,
            "twitter:description" if twitter_description.is_empty() => {
                twitter_description = content;
            }
            "description" if description.is_empty() => description = content,
            "og:site_name" if meta.site.is_empty() => meta.site = content,
            "og:image" if meta.image.is_empty() => meta.image = absolute(&content, base.as_ref()),
            "twitter:image" if twitter_image.is_empty() => {
                twitter_image = absolute(&content, base.as_ref());
            }
            _ => {}
        }
    }
    let ld = json_ld(html);
    let social_title = first_non_empty([og_title, twitter_title]);
    // 有的站点把 og:title 写成站点名（每一页都一样），这时 `<title>` 更具体。
    let generic = !meta.site.is_empty() && social_title.eq_ignore_ascii_case(meta.site.trim());
    if !social_title.is_empty() && (!generic || page_title.is_empty()) {
        page_title = social_title;
    }
    meta.title = first_non_empty([page_title, ld.0]);
    meta.description = first_non_empty([og_description, twitter_description, description, ld.1]);
    if meta.image.is_empty() {
        meta.image = twitter_image;
    }
    meta.icon = if rel_icon.is_empty() {
        apple_icon
    } else {
        rel_icon
    };
    meta
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn open_graph_beats_the_plain_title_and_description() {
        let html = r#"<html><head>
            <title>  Plain   Title </title>
            <meta name="description" content="plain desc">
            <meta property="og:title" content="OG Title">
            <meta property="og:description" content="OG desc">
            <meta property="og:site_name" content="Example">
            <meta property="og:image" content="/img/cover.png">
            <link rel="shortcut icon" href="/favicon.ico">
        </head></html>"#;
        let meta = extract(html, Some("https://example.com/post/1"));
        assert_eq!(meta.title, "OG Title");
        assert_eq!(meta.description, "OG desc");
        assert_eq!(meta.site, "Example");
        assert_eq!(meta.image, "https://example.com/img/cover.png");
        assert_eq!(meta.icon, "https://example.com/favicon.ico");
    }

    #[test]
    fn falls_back_to_title_and_description_and_squashes_whitespace() {
        let html = "<TITLE>\n  A &amp; B\n   &#20013;&#x6587; </TITLE><META NAME='Description' CONTENT='line1\n line2'>";
        let meta = extract(html, None);
        assert_eq!(meta.title, "A & B 中文");
        assert_eq!(meta.description, "line1 line2");
        assert_eq!(meta.icon, "");
    }

    #[test]
    fn attribute_order_quotes_and_unquoted_values_are_tolerated() {
        let html =
            r#"<meta content=Hello property=og:title><link href='/a.png' rel='icon' sizes=32x32>"#;
        let meta = extract(html, Some("https://x.org/"));
        assert_eq!(meta.title, "Hello");
        assert_eq!(meta.icon, "https://x.org/a.png");
    }

    #[test]
    fn apple_touch_icon_is_only_a_fallback_and_unsafe_schemes_are_dropped() {
        let html = r#"<link rel="apple-touch-icon" href="/apple.png"><link rel="icon" href="javascript:alert(1)">"#;
        let meta = extract(html, Some("https://x.org/"));
        assert_eq!(meta.icon, "https://x.org/apple.png");
    }

    #[test]
    fn missing_everything_gives_empty_fields() {
        assert_eq!(
            extract("<html><body>hi</body></html>", None),
            HtmlMetadata::default()
        );
    }

    #[test]
    fn unknown_entities_are_left_alone() {
        assert_eq!(decode_entities("a &foo; b &amp; c"), "a &foo; b & c");
    }

    #[test]
    fn only_the_beginning_of_a_huge_page_is_scanned() {
        let mut html = String::from("<title>Early</title>");
        html.push_str(&" ".repeat(SCAN_LIMIT));
        html.push_str("<meta property=\"og:title\" content=\"Late\">");
        assert_eq!(extract(&html, None).title, "Early");
    }

    #[test]
    fn twitter_cards_fill_in_when_open_graph_is_missing() {
        let html = r#"<head><title>Plain</title>
            <meta name="twitter:title" content="Card Title">
            <meta name="twitter:description" content="Card desc">
            <meta name="twitter:image" content="/card.png"></head>"#;
        let meta = extract(html, Some("https://example.com/a"));
        assert_eq!(meta.title, "Card Title");
        assert_eq!(meta.description, "Card desc");
        assert_eq!(meta.image, "https://example.com/card.png");
    }

    #[test]
    fn a_generic_og_title_that_is_just_the_site_name_loses_to_the_page_title() {
        let html = r#"<head><title>如何写好周报 - 示例博客</title>
            <meta property="og:title" content="示例博客">
            <meta property="og:site_name" content="示例博客"></head>"#;
        assert_eq!(extract(html, None).title, "如何写好周报 - 示例博客");
        // 没有 <title> 时站点名也比什么都没有强。
        let bare = r#"<meta property="og:title" content="示例博客"><meta property="og:site_name" content="示例博客">"#;
        assert_eq!(extract(bare, None).title, "示例博客");
    }

    #[test]
    fn json_ld_is_the_last_resort() {
        let html = r#"<head><script type="application/ld+json">
            {"@context":"https://schema.org","@graph":[{"@type":"WebSite","url":"x"},
             {"@type":"Article","headline":"单页应用的文章 &amp; 标题","description":"摘要"}]}
            </script></head>"#;
        let meta = extract(html, None);
        assert_eq!(meta.title, "单页应用的文章 & 标题");
        assert_eq!(meta.description, "摘要");
        // 有 <title> 时 JSON-LD 不抢。
        let titled = format!("<title>页面</title>{html}");
        assert_eq!(extract(&titled, None).title, "页面");
        assert_eq!(
            extract(
                r#"<script type="application/ld+json">{broken</script>"#,
                None
            )
            .title,
            ""
        );
    }
}
