//! 最小模板语法（实施计划 D-11）：`{{ path.to.var }}`，可接少量过滤器，**不是**完整的模板引擎。
//!
//! ```text
//! {{ url.host }}                          变量
//! {{ vars.issue | upper }}                过滤器
//! {{ vars.title | default("无标题") | truncate(40) }}
//! \{{ 不是变量 }}                         反斜杠转义，输出 {{ 不是变量 }}
//! ```
//!
//! 过滤器：`trim`、`lower`、`upper`、`default("x")`（变量缺失或为空时用 x）、`truncate(n)`
//! （超过 n 个字符截断并加 `…`）、`replace("a", "b")`。没有循环、条件、表达式、函数调用——
//! 这些需要的话应该用 Step（Condition / Transform）或将来的 Script。
//!
//! 变量缺失是**错误**（而不是悄悄渲染成空串），除非用了 `default`：Workflow 里的拼写错误要尽早暴露。

/// 模板解析或渲染失败。
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum TemplateError {
    /// 变量不存在（又没有 `default`）。
    #[error("变量 {0} 不存在")]
    Missing(String),
    /// 不认识的过滤器。
    #[error("不认识的过滤器：{0}")]
    UnknownFilter(String),
    /// 过滤器的参数不对。
    #[error("过滤器 {0} 的参数不对")]
    BadArgument(String),
    /// 语法错误（`{{` 没有闭合、变量名不合法……）。
    #[error("模板语法错误：{0}")]
    Syntax(String),
}

/// 一个过滤器。
#[derive(Debug, Clone, PartialEq, Eq)]
enum Filter {
    /// 去除首尾空白。
    Trim,
    /// 转小写。
    Lower,
    /// 转大写。
    Upper,
    /// 缺失或为空时用这个值。
    Default(String),
    /// 超过 n 个字符截断。
    Truncate(usize),
    /// 把 a 替换成 b。
    Replace(String, String),
}

/// `{{ … }}` 里的表达式。
#[derive(Debug, Clone, PartialEq, Eq)]
struct Expr {
    /// 变量路径。
    path: String,
    /// 依次应用的过滤器。
    filters: Vec<Filter>,
}

/// 模板的一段：字面文字或表达式。
#[derive(Debug, Clone, PartialEq, Eq)]
enum Part {
    /// 原样输出。
    Literal(String),
    /// 渲染时求值。
    Expr(Expr),
}

/// 解析好的模板。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Template {
    /// 各段。
    parts: Vec<Part>,
}

/// 变量路径是否合法：字母 / 数字 / 下划线 / 点 / 连字符，以字母或下划线开头。
fn valid_path(path: &str) -> bool {
    let mut chars = path.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
}

/// 在不在引号里地按 `separator` 切分。
fn split_outside_quotes(text: &str, separator: char) -> Vec<String> {
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    for c in text.chars() {
        match quote {
            Some(q) => {
                current.push(c);
                if c == q {
                    quote = None;
                }
            }
            None if c == '"' || c == '\'' => {
                quote = Some(c);
                current.push(c);
            }
            None if c == separator => parts.push(std::mem::take(&mut current)),
            None => current.push(c),
        }
    }
    parts.push(current);
    parts
}

/// 解析过滤器参数：带引号的字符串或非负整数。
fn parse_arg(raw: &str) -> Option<String> {
    let raw = raw.trim();
    for quote in ['"', '\''] {
        if let Some(inner) = raw
            .strip_prefix(quote)
            .and_then(|rest| rest.strip_suffix(quote))
        {
            return Some(inner.to_owned());
        }
    }
    raw.parse::<usize>().ok().map(|n| n.to_string())
}

/// 解析一个过滤器（`name` 或 `name(args)`）。
fn parse_filter(raw: &str) -> Result<Filter, TemplateError> {
    let raw = raw.trim();
    let (name, args) = match raw.split_once('(') {
        Some((name, rest)) => {
            let inner = rest
                .strip_suffix(')')
                .ok_or_else(|| TemplateError::Syntax(format!("过滤器 {raw} 缺少右括号")))?;
            let args: Option<Vec<String>> = split_outside_quotes(inner, ',')
                .iter()
                .filter(|a| !a.trim().is_empty())
                .map(|a| parse_arg(a))
                .collect();
            (
                name.trim(),
                args.ok_or_else(|| TemplateError::BadArgument(name.trim().to_owned()))?,
            )
        }
        None => (raw, Vec::new()),
    };
    match (name, args.as_slice()) {
        ("trim", []) => Ok(Filter::Trim),
        ("lower", []) => Ok(Filter::Lower),
        ("upper", []) => Ok(Filter::Upper),
        ("default", [value]) => Ok(Filter::Default(value.clone())),
        ("truncate", [n]) => n
            .parse()
            .map(Filter::Truncate)
            .map_err(|_| TemplateError::BadArgument("truncate".to_owned())),
        ("replace", [from, to]) if !from.is_empty() => {
            Ok(Filter::Replace(from.clone(), to.clone()))
        }
        ("trim" | "lower" | "upper" | "default" | "truncate" | "replace", _) => {
            Err(TemplateError::BadArgument(name.to_owned()))
        }
        _ => Err(TemplateError::UnknownFilter(name.to_owned())),
    }
}

impl Template {
    /// 解析模板。
    ///
    /// # Errors
    ///
    /// `{{` 没有闭合、变量名不合法、过滤器不认识或参数不对。
    pub fn parse(source: &str) -> Result<Self, TemplateError> {
        let mut parts = Vec::new();
        let mut literal = String::new();
        let mut rest = source;
        while !rest.is_empty() {
            if let Some(after) = rest.strip_prefix("\\{{") {
                literal.push_str("{{");
                rest = after;
            } else if let Some(after) = rest.strip_prefix("{{") {
                let end = after
                    .find("}}")
                    .ok_or_else(|| TemplateError::Syntax("{{ 没有对应的 }}".to_owned()))?;
                if !literal.is_empty() {
                    parts.push(Part::Literal(std::mem::take(&mut literal)));
                }
                parts.push(Part::Expr(Self::parse_expr(&after[..end])?));
                rest = &after[end + 2..];
            } else if let Some(c) = rest.chars().next() {
                literal.push(c);
                rest = &rest[c.len_utf8()..];
            }
        }
        if !literal.is_empty() {
            parts.push(Part::Literal(literal));
        }
        Ok(Self { parts })
    }

    /// 解析 `{{ … }}` 里面的内容。
    fn parse_expr(inner: &str) -> Result<Expr, TemplateError> {
        let segments = split_outside_quotes(inner, '|');
        let path = segments.first().map_or("", |s| s.trim());
        if !valid_path(path) {
            return Err(TemplateError::Syntax(format!("变量名不合法：「{path}」")));
        }
        let filters = segments[1..]
            .iter()
            .map(|segment| parse_filter(segment))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Expr {
            path: path.to_owned(),
            filters,
        })
    }

    /// 模板里引用的变量路径（去重前，按出现顺序）。
    pub fn variables(&self) -> Vec<&str> {
        self.parts
            .iter()
            .filter_map(|part| match part {
                Part::Expr(expr) => Some(expr.path.as_str()),
                Part::Literal(_) => None,
            })
            .collect()
    }

    /// 渲染。`lookup` 按路径取变量值。
    ///
    /// # Errors
    ///
    /// 变量缺失（又没有 `default`）。
    pub fn render(&self, lookup: &dyn Fn(&str) -> Option<String>) -> Result<String, TemplateError> {
        let mut out = String::new();
        for part in &self.parts {
            match part {
                Part::Literal(text) => out.push_str(text),
                Part::Expr(expr) => out.push_str(&expr.evaluate(lookup)?),
            }
        }
        Ok(out)
    }
}

impl Expr {
    /// 求值：取变量，依次应用过滤器。
    fn evaluate(&self, lookup: &dyn Fn(&str) -> Option<String>) -> Result<String, TemplateError> {
        let mut value = lookup(&self.path);
        for filter in &self.filters {
            value = match filter {
                Filter::Default(fallback) => Some(match value {
                    Some(v) if !v.is_empty() => v,
                    _ => fallback.clone(),
                }),
                other => {
                    let current = value.ok_or_else(|| TemplateError::Missing(self.path.clone()))?;
                    Some(match other {
                        Filter::Trim => current.trim().to_owned(),
                        Filter::Lower => current.to_lowercase(),
                        Filter::Upper => current.to_uppercase(),
                        Filter::Truncate(n) => truncate(&current, *n),
                        Filter::Replace(from, to) => current.replace(from.as_str(), to),
                        Filter::Default(_) => current,
                    })
                }
            };
        }
        value.ok_or_else(|| TemplateError::Missing(self.path.clone()))
    }
}

/// 超过 `max` 个字符时截断并加 `…`（总长不超过 `max`）。
fn truncate(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_owned();
    }
    let keep = max.saturating_sub(1);
    let mut cut: String = text.chars().take(keep).collect();
    cut.push('…');
    cut
}

/// 解析并渲染的便捷函数。
///
/// # Errors
///
/// 解析或渲染失败。
pub fn render(
    source: &str,
    lookup: &dyn Fn(&str) -> Option<String>,
) -> Result<String, TemplateError> {
    Template::parse(source)?.render(lookup)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use std::collections::HashMap;

    use super::*;

    /// 用一张表做变量查找。
    fn render_with(source: &str, vars: &[(&str, &str)]) -> Result<String, TemplateError> {
        let map: HashMap<String, String> = vars
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect();
        render(source, &|path| map.get(path).cloned())
    }

    #[test]
    fn variables_are_interpolated_with_whitespace_tolerance() {
        let vars = [("url.host", "github.com"), ("vars.n", "42")];
        assert_eq!(
            render_with("读：{{url.host}} / {{ vars.n }}", &vars).unwrap(),
            "读：github.com / 42"
        );
        assert_eq!(render_with("没有变量", &vars).unwrap(), "没有变量");
        assert_eq!(render_with("", &vars).unwrap(), "");
    }

    #[test]
    fn filters_apply_in_order() {
        let vars = [("a", "  Hello World  "), ("empty", "")];
        assert_eq!(
            render_with("{{ a | trim | upper }}", &vars).unwrap(),
            "HELLO WORLD"
        );
        assert_eq!(
            render_with("{{ a | trim | lower }}", &vars).unwrap(),
            "hello world"
        );
        assert_eq!(
            render_with("{{ a | trim | replace(\"World\", \"Rust\") }}", &vars).unwrap(),
            "Hello Rust"
        );
        assert_eq!(
            render_with("{{ a | trim | truncate(5) }}", &vars).unwrap(),
            "Hell…"
        );
        assert_eq!(
            render_with("{{ a | trim | truncate(50) }}", &vars).unwrap(),
            "Hello World"
        );
        assert_eq!(
            render_with("{{ 中文 }}", &[]).unwrap_err(),
            TemplateError::Syntax("变量名不合法：「中文」".into())
        );
        let _ = vars;
    }

    #[test]
    fn missing_variables_are_errors_unless_defaulted() {
        assert_eq!(
            render_with("{{ nope }}", &[]).unwrap_err(),
            TemplateError::Missing("nope".into())
        );
        assert_eq!(
            render_with("{{ nope | upper }}", &[]).unwrap_err(),
            TemplateError::Missing("nope".into())
        );
        assert_eq!(
            render_with("{{ nope | default(\"无\") }}", &[]).unwrap(),
            "无"
        );
        // 空串也走默认值；有值时不受影响。
        assert_eq!(
            render_with("{{ e | default('x') }}", &[("e", "")]).unwrap(),
            "x"
        );
        assert_eq!(
            render_with("{{ e | default('x') }}", &[("e", "y")]).unwrap(),
            "y"
        );
        // default 之后可以继续过滤。
        assert_eq!(
            render_with("{{ nope | default(\"abc\") | upper }}", &[]).unwrap(),
            "ABC"
        );
    }

    #[test]
    fn escaping_and_quoted_delimiters() {
        assert_eq!(
            render_with("\\{{ 不是变量 }} {{ a }}", &[("a", "1")]).unwrap(),
            "{{ 不是变量 }} 1"
        );
        // 引号里的 | 与 , 不是分隔符。
        assert_eq!(
            render_with("{{ nope | default(\"a|b,c\") }}", &[]).unwrap(),
            "a|b,c"
        );
        assert_eq!(
            render_with("{{ a | replace(\",\", \";\") }}", &[("a", "x,y")]).unwrap(),
            "x;y"
        );
    }

    #[test]
    fn syntax_errors_are_reported_at_parse_time() {
        for bad in [
            "{{ a",
            "{{ }}",
            "{{ a b }}",
            "{{ a | }}",
            "{{ a | nosuchfilter }}",
            "{{ a | truncate }}",
            "{{ a | truncate(x) }}",
            "{{ a | default }}",
            "{{ a | replace(\"\", \"x\") }}",
            "{{ a | upper(1) }}",
            "{{ a | trim(\"x\" }}",
        ] {
            assert!(Template::parse(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn variables_lists_every_reference() {
        let template = Template::parse("{{ a }} 和 {{ b.c | upper }} 以及 \\{{ x }}").unwrap();
        assert_eq!(template.variables(), ["a", "b.c"]);
    }

    #[test]
    fn rendering_handles_non_ascii_literals_and_values() {
        assert_eq!(
            render_with("【{{ t }}】✅", &[("t", "修复登录超时")]).unwrap(),
            "【修复登录超时】✅"
        );
        assert_eq!(
            render_with("{{ t | truncate(3) }}", &[("t", "修复登录超时")]).unwrap(),
            "修复…"
        );
    }
}
