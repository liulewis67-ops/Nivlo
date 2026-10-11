//! 定义校验与内置 / 示例定义的测试。

use serde_json::json;

use super::{check_schema, parse_definition};
use crate::builtin::builtin_workflows;
use crate::pattern::RegexCache;

/// 仓库里的示例定义（文件名 → JSON）。
const EXAMPLES: &[(&str, &str)] = &[
    (
        "github-pr",
        include_str!("../../../../workflows/examples/github-pr.workflow.json"),
    ),
    (
        "reading-list",
        include_str!("../../../../workflows/examples/reading-list.workflow.json"),
    ),
    (
        "requirements-docs",
        include_str!("../../../../workflows/examples/requirements-docs.workflow.json"),
    ),
];

#[test]
fn every_example_and_builtin_definition_passes_schema_and_deep_validation() {
    let regexes = RegexCache::new();
    for (name, json) in EXAMPLES {
        let result = parse_definition(json, &regexes);
        assert!(result.is_ok(), "示例 {name}：{result:?}");
    }
    let builtins = builtin_workflows();
    assert_eq!(builtins.len(), 6, "内置 Workflow 都应该能解析");
    for workflow in &builtins {
        let json = serde_json::to_string(workflow).unwrap_or_default();
        assert!(
            parse_definition(&json, &regexes).is_ok(),
            "内置 {}",
            workflow.id
        );
        assert!(workflow.enabled);
    }
}

/// 返回校验出的问题路径。
fn paths(definition: &serde_json::Value) -> Vec<String> {
    check_schema(definition)
        .unwrap_err()
        .into_iter()
        .map(|issue| issue.path)
        .collect()
}

/// 一份最小的合法定义。
fn valid() -> serde_json::Value {
    json!({
        "schemaVersion": 1, "id": "user.x", "name": "x",
        "matcher": { "field": "input.type", "op": "equals", "value": "url" },
        "steps": [ { "type": "createItem", "itemType": "note", "title": "t" } ]
    })
}

#[test]
fn the_schema_accepts_a_minimal_definition() {
    assert!(check_schema(&valid()).is_ok());
}

#[test]
fn schema_errors_carry_json_paths() {
    let mut bad_step = valid();
    bad_step["steps"][0]["itemType"] = json!("project");
    assert!(
        paths(&bad_step).iter().any(|p| p.starts_with("/steps/0")),
        "{:?}",
        paths(&bad_step)
    );

    let mut bad_matcher = valid();
    bad_matcher["matcher"] = json!({ "field": "nonsense", "op": "equals", "value": "x" });
    assert!(
        paths(&bad_matcher)
            .iter()
            .any(|p| p.starts_with("/matcher"))
    );

    let mut bad_id = valid();
    bad_id["id"] = json!("Has Space");
    assert!(paths(&bad_id).contains(&"/id".to_owned()));

    let mut no_steps = valid();
    no_steps["steps"] = json!([]);
    assert!(paths(&no_steps).contains(&"/steps".to_owned()));

    let mut extra = valid();
    extra["surprise"] = json!(1);
    assert!(check_schema(&extra).is_err());

    let mut future = valid();
    future["schemaVersion"] = json!(2);
    assert!(paths(&future).contains(&"/schemaVersion".to_owned()));
}

#[test]
fn deep_validation_reports_regex_and_template_problems_with_locations() {
    let regexes = RegexCache::new();
    let mut definition = valid();
    definition["matcher"] = json!({ "field": "text", "op": "regex", "value": "(" });
    definition["steps"] = json!([
        { "type": "extract", "from": "text", "pattern": "[", "into": "a" },
        { "type": "createItem", "itemType": "note", "title": "{{ oops", "tags": ["{{ a | nofilter }}"] }
    ]);
    let issues = parse_definition(&definition.to_string(), &regexes).unwrap_err();
    let at: Vec<&str> = issues.iter().map(|i| i.path.as_str()).collect();
    assert!(at.contains(&"/matcher/value"), "{at:?}");
    assert!(at.contains(&"/steps/0/pattern"), "{at:?}");
    assert!(at.contains(&"/steps/1/title"), "{at:?}");
    assert!(at.contains(&"/steps/1/tags/0"), "{at:?}");
    assert!(issues[0].to_string().contains('：'), "问题的文字形式带位置");
}

#[test]
fn not_json_and_domain_rule_violations_are_reported() {
    let regexes = RegexCache::new();
    let issues = parse_definition("{ 不是 json", &regexes).unwrap_err();
    assert!(issues[0].message.contains("JSON"));
    let mut no_create = valid();
    no_create["steps"] = json!([ { "type": "addTag", "tag": "x" } ]);
    let issues = parse_definition(&no_create.to_string(), &regexes).unwrap_err();
    assert!(issues.iter().any(|i| i.message.contains("createItem")));
    let mut bad_var = valid();
    bad_var["steps"] = json!([
        { "type": "transform", "set": { "1bad": "x" } },
        { "type": "createItem", "itemType": "note", "title": "t" }
    ]);
    assert!(parse_definition(&bad_var.to_string(), &regexes).is_err());
}
