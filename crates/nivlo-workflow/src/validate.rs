//! Workflow 定义的深度校验：JSON Schema、结构、正则、模板（实施计划 5.1）。
//!
//! 保存、导入、复制自定义 Workflow 时都过这一道。错误都带**位置**（JSON 路径或 Step 序号），
//! 用户能直接看出是哪一处写错了。

use std::sync::OnceLock;

use nivlo_domain::workflow::{Matcher, Op, Step, Workflow, WorkflowError};
use serde_json::Value;

use crate::pattern::RegexCache;
use crate::template::Template;

/// 内嵌的 JSON Schema。
const SCHEMA: &str = include_str!("../../../workflows/schema/workflow.schema.json");

/// 一处校验问题。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Issue {
    /// 位置：JSON 路径（`/steps/0/title`）或 `steps[0]`。
    pub path: String,
    /// 说明。
    pub message: String,
}

impl std::fmt::Display for Issue {
    /// 输出 `位置：说明`。
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.path.is_empty() {
            f.write_str(&self.message)
        } else {
            write!(f, "{}：{}", self.path, self.message)
        }
    }
}

/// 编译好的 Schema 校验器（只编译一次）。
fn validator() -> &'static jsonschema::Validator {
    static VALIDATOR: OnceLock<jsonschema::Validator> = OnceLock::new();
    VALIDATOR.get_or_init(|| {
        let schema: Value = serde_json::from_str(SCHEMA)
            .unwrap_or_else(|e| unreachable_schema(&format!("Schema 不是合法 JSON：{e}")));
        jsonschema::validator_for(&schema)
            .unwrap_or_else(|e| unreachable_schema(&format!("Schema 无法编译：{e}")))
    })
}

/// 内嵌 Schema 在编译期就固定了；它坏了是程序错误，测试会在第一时间发现。
#[allow(clippy::panic)]
fn unreachable_schema(message: &str) -> ! {
    panic!("{message}")
}

/// 用 JSON Schema 校验一份定义（还没有解析成 [`Workflow`]）。
///
/// # Errors
///
/// 返回全部问题，每个都带 JSON 路径。
pub fn check_schema(definition: &Value) -> Result<(), Vec<Issue>> {
    let issues: Vec<Issue> = validator()
        .iter_errors(definition)
        .map(|error| Issue {
            path: error.instance_path.to_string(),
            message: error.to_string(),
        })
        .collect();
    if issues.is_empty() {
        Ok(())
    } else {
        Err(issues)
    }
}

/// 检查模板：语法正确。返回引用的变量。
fn check_template(path: &str, source: &str, issues: &mut Vec<Issue>) {
    if let Err(error) = Template::parse(source) {
        issues.push(Issue {
            path: path.to_owned(),
            message: error.to_string(),
        });
    }
}

/// 检查正则：能编译、没超限。
fn check_pattern(path: &str, pattern: &str, regexes: &RegexCache, issues: &mut Vec<Issue>) {
    if let Err(error) = regexes.get(pattern) {
        issues.push(Issue {
            path: path.to_owned(),
            message: error.to_string(),
        });
    }
}

/// 递归检查匹配器里的正则。
fn check_matcher(path: &str, matcher: &Matcher, regexes: &RegexCache, issues: &mut Vec<Issue>) {
    match matcher {
        Matcher::All { all } => {
            for (i, m) in all.iter().enumerate() {
                check_matcher(&format!("{path}/all/{i}"), m, regexes, issues);
            }
        }
        Matcher::Any { any } => {
            for (i, m) in any.iter().enumerate() {
                check_matcher(&format!("{path}/any/{i}"), m, regexes, issues);
            }
        }
        Matcher::Not { not } => check_matcher(&format!("{path}/not"), not, regexes, issues),
        Matcher::Leaf(condition) => {
            if condition.op == Op::Regex
                && let Some(pattern) = &condition.value
            {
                check_pattern(&format!("{path}/value"), pattern, regexes, issues);
            }
        }
    }
}

/// 深度校验一个已解析的 Workflow：领域规则 + 正则 + 模板语法。
///
/// # Errors
///
/// 返回全部问题（不是遇到第一个就停）。
pub fn check_workflow(workflow: &Workflow, regexes: &RegexCache) -> Result<(), Vec<Issue>> {
    let mut issues = Vec::new();
    if let Err(error) = workflow.validate() {
        issues.push(Issue {
            path: String::new(),
            message: error.to_string(),
        });
    }
    check_matcher("/matcher", &workflow.matcher, regexes, &mut issues);
    for (index, step) in workflow.steps.iter().enumerate() {
        let at = |field: &str| format!("/steps/{index}/{field}");
        match step {
            Step::Extract { pattern, from, .. } | Step::Regex { pattern, from, .. } => {
                check_pattern(&at("pattern"), pattern, regexes, &mut issues);
                check_template(&at("from"), from, &mut issues);
            }
            Step::JsonPath { from, .. } => check_template(&at("from"), from, &mut issues),
            Step::Transform { set } => {
                for (name, source) in set {
                    check_template(&at(&format!("set/{name}")), source, &mut issues);
                }
            }
            Step::Condition { value, .. } => {
                if let Some(source) = value {
                    check_template(&at("value"), source, &mut issues);
                }
            }
            Step::CreateItem {
                title,
                content,
                tags,
                scheduled,
                ..
            } => {
                check_template(&at("title"), title, &mut issues);
                if let Some(source) = content {
                    check_template(&at("content"), source, &mut issues);
                }
                for (i, tag) in tags.iter().enumerate() {
                    check_template(&at(&format!("tags/{i}")), tag, &mut issues);
                }
                if let Some(source) = scheduled {
                    check_template(&at("scheduled"), source, &mut issues);
                }
            }
            Step::Http { url, .. } => check_template(&at("url"), url, &mut issues),
            Step::AddTag { tag } => check_template(&at("tag"), tag, &mut issues),
        }
    }
    if issues.is_empty() {
        Ok(())
    } else {
        Err(issues)
    }
}

/// 解析并校验一份 JSON 定义：先过 Schema（带路径的错误），再解析、再深度校验。
///
/// # Errors
///
/// 返回全部问题。
pub fn parse_definition(json: &str, regexes: &RegexCache) -> Result<Workflow, Vec<Issue>> {
    let value: Value = serde_json::from_str(json).map_err(|e| {
        vec![Issue {
            path: String::new(),
            message: format!("不是合法的 JSON：{e}"),
        }]
    })?;
    check_schema(&value)?;
    let workflow: Workflow = serde_json::from_value(value).map_err(|e| {
        vec![Issue {
            path: String::new(),
            message: e.to_string(),
        }]
    })?;
    check_workflow(&workflow, regexes)?;
    Ok(workflow)
}

/// 把领域校验错误包成 [`Issue`]（给只做结构校验的调用方）。
#[must_use]
pub fn issue_from(error: &WorkflowError) -> Issue {
    Issue {
        path: String::new(),
        message: error.to_string(),
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests;
