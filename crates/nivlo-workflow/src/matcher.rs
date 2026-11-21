//! Matcher 求值与 Specificity（实施计划 5.2、架构文档 §21）。

use nivlo_domain::workflow::{Condition, Matcher, Op};

use crate::facts::InputFacts;
use crate::glob::glob_match;
use crate::pattern::RegexCache;

/// 一个值是否满足运算符与期望值。
fn satisfies(op: Op, actual: &str, expected: &str, regexes: &RegexCache) -> bool {
    let (a, e) = (actual.to_lowercase(), expected.to_lowercase());
    match op {
        Op::Equals => a == e,
        Op::Contains => a.contains(&e),
        Op::StartsWith => a.starts_with(&e),
        Op::EndsWith => a.ends_with(&e),
        Op::Glob => glob_match(expected, actual),
        // 正则不改大小写（用户用 `(?i)` 自己决定）；编译失败视为不匹配，不 panic。
        Op::Regex => regexes
            .get(expected)
            .is_ok_and(|regex| regex.is_match(actual)),
        // 存在性由调用方在「有没有值」层面处理。
        Op::Exists => true,
    }
}

/// 一个叶子条件是否满足：字段的**任一**值满足即可；`exists` 只看有没有值。
fn leaf_matches(condition: &Condition, facts: &InputFacts<'_>, regexes: &RegexCache) -> bool {
    let values = facts.values(&condition.field);
    match condition.op {
        Op::Exists => values.iter().any(|v| !v.is_empty()),
        op => {
            let expected = condition.value.as_deref().unwrap_or_default();
            values.iter().any(|v| satisfies(op, v, expected, regexes))
        }
    }
}

/// 匹配器是否匹配输入。
#[must_use]
pub fn matches(matcher: &Matcher, facts: &InputFacts<'_>, regexes: &RegexCache) -> bool {
    match matcher {
        Matcher::All { all } => all.iter().all(|m| matches(m, facts, regexes)),
        Matcher::Any { any } => any.iter().any(|m| matches(m, facts, regexes)),
        Matcher::Not { not } => !matches(not, facts, regexes),
        Matcher::Leaf(condition) => leaf_matches(condition, facts, regexes),
    }
}

/// 一个叶子条件的「具体程度」分数：越精确越高。
///
/// 只比较「输入种类」的条件几乎人人都有，所以分数最低；精确的主机 / 文件名比包含、正则更具体。
fn leaf_score(condition: &Condition) -> u32 {
    use nivlo_domain::workflow::Field;
    if condition.field == Field::InputType {
        return 10;
    }
    match condition.op {
        Op::Equals => 100,
        Op::StartsWith | Op::EndsWith => 80,
        // 通配里写死的字符越多越具体。
        Op::Glob => {
            let literal = condition
                .value
                .as_deref()
                .map_or(0, |v| v.chars().filter(|c| !matches!(c, '*' | '?')).count());
            40 + u32::try_from(literal.min(40)).unwrap_or(40)
        }
        Op::Contains => 40,
        Op::Regex => 30,
        Op::Exists => 10,
    }
}

/// 匹配器的 Specificity：`all` 各项相加、`any` 取最大、`not` 不加分。
#[must_use]
pub fn specificity(matcher: &Matcher) -> u32 {
    match matcher {
        Matcher::All { all } => all.iter().map(specificity).sum(),
        Matcher::Any { any } => any.iter().map(specificity).max().unwrap_or(0),
        Matcher::Not { .. } => 0,
        Matcher::Leaf(condition) => leaf_score(condition),
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use nivlo_domain::capture::{CaptureInput, FileRef};

    use super::*;

    /// 由 JSON 构造匹配器。
    fn m(json: &str) -> Matcher {
        serde_json::from_str(json).unwrap()
    }

    /// 用 URL 输入判断。
    fn url_matches(matcher: &str, url: &str, app: Option<&str>) -> bool {
        let input = CaptureInput::Url { url: url.into() };
        matches(
            &m(matcher),
            &InputFacts {
                input: &input,
                source_application: app,
            },
            &RegexCache::new(),
        )
    }

    /// 用文本输入判断。
    fn text_matches(matcher: &str, text: &str) -> bool {
        let input = CaptureInput::Text { text: text.into() };
        matches(
            &m(matcher),
            &InputFacts {
                input: &input,
                source_application: None,
            },
            &RegexCache::new(),
        )
    }

    /// 用单个文件输入判断。
    fn file_matches(matcher: &str, name: &str, ext: Option<&str>, mime: Option<&str>) -> bool {
        let input = CaptureInput::File {
            file: FileRef {
                path: format!(r"D:\docs\{name}"),
                name: name.into(),
                extension: ext.map(str::to_owned),
                size_bytes: None,
                mime: mime.map(str::to_owned),
                is_dir: false,
            },
        };
        matches(
            &m(matcher),
            &InputFacts {
                input: &input,
                source_application: None,
            },
            &RegexCache::new(),
        )
    }

    #[test]
    fn every_url_field_and_operator_has_a_case() {
        let u = "https://acme.atlassian.net/browse/REQ-12?draft=1&ref=abc";
        assert!(url_matches(
            r#"{"field":"input.type","op":"equals","value":"URL"}"#,
            u,
            None
        ));
        assert!(url_matches(
            r#"{"field":"url.scheme","op":"equals","value":"https"}"#,
            u,
            None
        ));
        assert!(!url_matches(
            r#"{"field":"url.scheme","op":"equals","value":"http"}"#,
            u,
            None
        ));
        assert!(url_matches(
            r#"{"field":"url.host","op":"glob","value":"*.atlassian.net"}"#,
            u,
            None
        ));
        assert!(url_matches(
            r#"{"field":"url.host","op":"endsWith","value":".NET"}"#,
            u,
            None
        ));
        assert!(url_matches(
            r#"{"field":"url.host","op":"startsWith","value":"acme"}"#,
            u,
            None
        ));
        assert!(url_matches(
            r#"{"field":"url.host","op":"contains","value":"atlassian"}"#,
            u,
            None
        ));
        assert!(url_matches(
            r#"{"field":"url.path","op":"regex","value":"^/browse/[A-Z]+-\\d+$"}"#,
            u,
            None
        ));
        assert!(!url_matches(
            r#"{"field":"url.path","op":"regex","value":"^/wiki"}"#,
            u,
            None
        ));
        assert!(url_matches(
            r#"{"field":"url.query.draft","op":"exists"}"#,
            u,
            None
        ));
        assert!(url_matches(
            r#"{"field":"url.query.ref","op":"equals","value":"ABC"}"#,
            u,
            None
        ));
        assert!(!url_matches(
            r#"{"field":"url.query.nope","op":"exists"}"#,
            u,
            None
        ));
        assert!(url_matches(
            r#"{"field":"source.application","op":"equals","value":"chrome"}"#,
            u,
            Some("Chrome")
        ));
        assert!(!url_matches(
            r#"{"field":"source.application","op":"exists"}"#,
            u,
            None
        ));
    }

    #[test]
    fn text_fields_and_operators() {
        assert!(text_matches(
            r#"{"field":"text","op":"contains","value":"登录"}"#,
            "修复登录超时"
        ));
        assert!(text_matches(
            r#"{"field":"text","op":"startsWith","value":"todo:"}"#,
            "TODO: 买菜"
        ));
        assert!(text_matches(
            r#"{"field":"text","op":"endsWith","value":"？"}"#,
            "今天吃什么？"
        ));
        assert!(text_matches(
            r#"{"field":"text","op":"regex","value":"^\\d{4}-\\d{2}-\\d{2}$"}"#,
            "2026-10-14"
        ));
        assert!(
            !text_matches(r#"{"field":"text","op":"regex","value":"("}"#, "x"),
            "非法正则不匹配也不 panic"
        );
        assert!(!text_matches(
            r#"{"field":"url.host","op":"exists"}"#,
            "没有 URL 字段"
        ));
        assert!(text_matches(r#"{"field":"text","op":"exists"}"#, "x"));
    }

    #[test]
    fn file_fields_and_operators() {
        assert!(file_matches(
            r#"{"field":"file.name","op":"glob","value":"REQ-*.docx"}"#,
            "REQ-7 终稿.docx",
            Some("docx"),
            None
        ));
        assert!(file_matches(
            r#"{"field":"file.extension","op":"equals","value":"PDF"}"#,
            "a.pdf",
            Some("pdf"),
            None
        ));
        assert!(!file_matches(
            r#"{"field":"file.extension","op":"equals","value":"pdf"}"#,
            "README",
            None,
            None
        ));
        assert!(file_matches(
            r#"{"field":"file.mime","op":"startsWith","value":"image/"}"#,
            "a.png",
            Some("png"),
            Some("image/png")
        ));
        assert!(file_matches(
            r#"{"field":"file.path","op":"contains","value":"docs"}"#,
            "a.txt",
            Some("txt"),
            None
        ));
    }

    #[test]
    fn multiple_files_match_when_any_file_satisfies() {
        let input = CaptureInput::Files {
            files: ["a.png", "b.pdf"]
                .iter()
                .map(|name| FileRef {
                    path: (*name).into(),
                    name: (*name).into(),
                    extension: name.rsplit('.').next().map(str::to_owned),
                    size_bytes: None,
                    mime: None,
                    is_dir: false,
                })
                .collect(),
        };
        let facts = InputFacts {
            input: &input,
            source_application: None,
        };
        let cache = RegexCache::new();
        assert!(matches(
            &m(r#"{"field":"file.extension","op":"equals","value":"pdf"}"#),
            &facts,
            &cache
        ));
        assert!(!matches(
            &m(r#"{"field":"file.extension","op":"equals","value":"doc"}"#),
            &facts,
            &cache
        ));
    }

    #[test]
    fn all_any_and_not_compose() {
        let u = "https://github.com/acme/repo/pull/7";
        let all = r#"{"all":[
            {"field":"url.host","op":"equals","value":"github.com"},
            {"field":"url.path","op":"contains","value":"/pull/"}]}"#;
        assert!(url_matches(all, u, None));
        let any = r#"{"any":[
            {"field":"url.host","op":"equals","value":"gitlab.com"},
            {"field":"url.path","op":"contains","value":"/pull/"}]}"#;
        assert!(url_matches(any, u, None));
        let not = r#"{"not":{"field":"url.host","op":"equals","value":"github.com"}}"#;
        assert!(!url_matches(not, u, None));
        let nested = r#"{"all":[
            {"field":"input.type","op":"equals","value":"url"},
            {"not":{"any":[
                {"field":"url.path","op":"startsWith","value":"/wiki"},
                {"field":"url.query.draft","op":"exists"}]}}]}"#;
        assert!(url_matches(nested, u, None));
        assert!(!url_matches(nested, "https://github.com/wiki/x", None));
        // 空的 all 恒真、空的 any 恒假。
        assert!(url_matches(r#"{"all":[]}"#, u, None));
        assert!(!url_matches(r#"{"any":[]}"#, u, None));
    }

    #[test]
    fn specificity_ranks_exact_over_glob_over_contains_over_type_only() {
        let type_only = m(r#"{"field":"input.type","op":"equals","value":"url"}"#);
        let contains = m(r#"{"field":"url.host","op":"contains","value":"github"}"#);
        let glob = m(r#"{"field":"url.host","op":"glob","value":"*.github.com"}"#);
        let exact = m(r#"{"field":"url.host","op":"equals","value":"github.com"}"#);
        assert!(specificity(&type_only) < specificity(&contains));
        assert!(specificity(&contains) < specificity(&glob));
        assert!(specificity(&glob) < specificity(&exact));
        // all 相加、any 取最大、not 不加分。
        let both = m(r#"{"all":[
            {"field":"input.type","op":"equals","value":"url"},
            {"field":"url.host","op":"equals","value":"github.com"}]}"#);
        assert_eq!(
            specificity(&both),
            specificity(&type_only) + specificity(&exact)
        );
        let either = m(r#"{"any":[
            {"field":"url.host","op":"equals","value":"a.com"},
            {"field":"url.host","op":"contains","value":"b"}]}"#);
        assert_eq!(specificity(&either), specificity(&exact));
        assert_eq!(
            specificity(&m(
                r#"{"not":{"field":"url.host","op":"equals","value":"a"}}"#
            )),
            0
        );
        // 通配里写死的字符越多越具体。
        let longer = m(r#"{"field":"url.host","op":"glob","value":"*.eng.github.com"}"#);
        assert!(specificity(&glob) < specificity(&longer));
    }
}
