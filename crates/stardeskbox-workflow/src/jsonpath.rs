//! 简化的 JSONPath（`jsonPath` Step 使用）：`$`、`.key`、`['key']`、`[n]`、`[-n]` 的组合。
//!
//! 不支持通配、过滤、递归下降——这些超出「从一段元数据里取一个值」的需要。

use serde_json::Value;

/// 路径里的一步。
#[derive(Debug, Clone, PartialEq, Eq)]
enum Segment {
    /// 取对象的键。
    Key(String),
    /// 取数组的下标（负数从末尾数）。
    Index(i64),
}

/// 路径语法错误。
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("JSONPath 不合法：{0}")]
pub struct PathError(pub String);

/// 解析路径。
fn parse(path: &str) -> Result<Vec<Segment>, PathError> {
    let rest = path
        .strip_prefix('$')
        .ok_or_else(|| PathError("必须以 $ 开头".to_owned()))?;
    let chars: Vec<char> = rest.chars().collect();
    let mut segments = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        match chars[i] {
            '.' => {
                let start = i + 1;
                let mut end = start;
                while end < chars.len() && !matches!(chars[end], '.' | '[') {
                    end += 1;
                }
                if start == end {
                    return Err(PathError("「.」后面缺少键名".to_owned()));
                }
                segments.push(Segment::Key(chars[start..end].iter().collect()));
                i = end;
            }
            '[' => {
                let close = chars[i..]
                    .iter()
                    .position(|&c| c == ']')
                    .map(|offset| i + offset)
                    .ok_or_else(|| PathError("缺少 ]".to_owned()))?;
                let inner: String = chars[i + 1..close].iter().collect();
                let inner = inner.trim();
                let quoted = ['\'', '"']
                    .iter()
                    .find_map(|&q| inner.strip_prefix(q).and_then(|rest| rest.strip_suffix(q)));
                match quoted {
                    Some(key) => segments.push(Segment::Key(key.to_owned())),
                    None => segments.push(Segment::Index(
                        inner
                            .parse()
                            .map_err(|_| PathError(format!("[{inner}] 不是下标或带引号的键")))?,
                    )),
                }
                i = close + 1;
            }
            other => return Err(PathError(format!("意外的字符 {other}"))),
        }
    }
    Ok(segments)
}

/// 从 JSON 文本里按路径取值，转成字符串：字符串原样、数字 / 布尔转文字、对象 / 数组保留为 JSON 文本；
/// 路径不存在或值是 `null` 时为 `Ok(None)`。
///
/// # Errors
///
/// 路径语法不对，或 `json` 不是合法 JSON。
pub fn extract(json: &str, path: &str) -> Result<Option<String>, PathError> {
    let segments = parse(path)?;
    let mut value: Value =
        serde_json::from_str(json).map_err(|e| PathError(format!("输入不是合法 JSON：{e}")))?;
    for segment in segments {
        value = match (segment, value) {
            (Segment::Key(key), Value::Object(mut map)) => match map.remove(&key) {
                Some(next) => next,
                None => return Ok(None),
            },
            (Segment::Index(index), Value::Array(mut items)) => {
                let len = i64::try_from(items.len()).unwrap_or(i64::MAX);
                let at = if index < 0 { len + index } else { index };
                match usize::try_from(at).ok().filter(|&n| n < items.len()) {
                    Some(n) => items.swap_remove(n),
                    None => return Ok(None),
                }
            }
            _ => return Ok(None),
        };
    }
    Ok(match value {
        Value::Null => None,
        Value::String(text) => Some(text),
        other => Some(other.to_string()),
    })
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    const DOC: &str = r#"{"title":"登录超时","meta":{"labels":["bug","p1"],"count":3,"ok":true,"none":null},"a.b":"点"}"#;

    #[test]
    fn keys_indexes_and_quoted_keys() {
        assert_eq!(
            extract(DOC, "$.title").unwrap().as_deref(),
            Some("登录超时")
        );
        assert_eq!(
            extract(DOC, "$.meta.labels[0]").unwrap().as_deref(),
            Some("bug")
        );
        assert_eq!(
            extract(DOC, "$.meta.labels[-1]").unwrap().as_deref(),
            Some("p1")
        );
        assert_eq!(extract(DOC, "$['a.b']").unwrap().as_deref(), Some("点"));
        assert_eq!(
            extract(DOC, "$.meta['count']").unwrap().as_deref(),
            Some("3")
        );
        assert_eq!(extract(DOC, "$.meta.ok").unwrap().as_deref(), Some("true"));
        assert_eq!(
            extract(DOC, "$.meta.labels").unwrap().as_deref(),
            Some(r#"["bug","p1"]"#)
        );
        assert_eq!(
            extract(r#"[{"a":1}]"#, "$[0].a").unwrap().as_deref(),
            Some("1")
        );
    }

    #[test]
    fn missing_paths_and_nulls_are_none() {
        assert_eq!(extract(DOC, "$.nope").unwrap(), None);
        assert_eq!(extract(DOC, "$.meta.none").unwrap(), None);
        assert_eq!(extract(DOC, "$.meta.labels[9]").unwrap(), None);
        assert_eq!(extract(DOC, "$.title.deeper").unwrap(), None);
        assert_eq!(extract(DOC, "$.meta.labels.x").unwrap(), None);
    }

    #[test]
    fn syntax_errors_and_bad_json_are_errors() {
        assert!(extract(DOC, "title").is_err());
        assert!(extract(DOC, "$.").is_err());
        assert!(extract(DOC, "$[0").is_err());
        assert!(extract(DOC, "$[x]").is_err());
        assert!(extract(DOC, "$ title").is_err());
        assert!(extract("不是 json", "$.a").is_err());
    }
}
