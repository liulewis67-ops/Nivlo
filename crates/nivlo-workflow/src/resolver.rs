//! Resolver：从一组 Workflow 里为一次输入选出要执行的那一个（架构文档 §21）。
//!
//! 规则（确定性——同一份输入永远得到同一个结果）：
//! 1. 跳过未启用的；
//! 2. 只保留 Matcher 匹配的；
//! 3. 按 `priority` 从大到小；
//! 4. 相同时按 Specificity 从大到小（更具体的优先）；
//! 5. 仍相同时按 ID 字典序（稳定）。

use std::cmp::Reverse;

use nivlo_domain::workflow::Workflow;

use crate::facts::InputFacts;
use crate::matcher::{matches, specificity};
use crate::pattern::RegexCache;

/// 选出要执行的 Workflow；没有匹配的返回 `None`。
#[must_use]
pub fn resolve<'a>(
    workflows: &'a [Workflow],
    facts: &InputFacts<'_>,
    regexes: &RegexCache,
) -> Option<&'a Workflow> {
    workflows
        .iter()
        .filter(|workflow| workflow.enabled && matches(&workflow.matcher, facts, regexes))
        .min_by_key(|workflow| {
            (
                Reverse(workflow.priority),
                Reverse(specificity(&workflow.matcher)),
                workflow.id.clone(),
            )
        })
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use std::time::Instant;

    use nivlo_domain::capture::CaptureInput;

    use super::*;

    /// 构造一个 Workflow。
    fn workflow(id: &str, priority: i32, enabled: bool, matcher: &str) -> Workflow {
        serde_json::from_str(&format!(
            r#"{{
                "schemaVersion": 1, "id": "{id}", "name": "{id}", "priority": {priority},
                "enabled": {enabled}, "matcher": {matcher},
                "steps": [ {{ "type": "createItem", "itemType": "note", "title": "t" }} ]
            }}"#
        ))
        .unwrap()
    }

    const URL_ANY: &str = r#"{"field":"input.type","op":"equals","value":"url"}"#;
    const GITHUB: &str = r#"{"all":[
        {"field":"input.type","op":"equals","value":"url"},
        {"field":"url.host","op":"equals","value":"github.com"}]}"#;

    /// 对一个 URL 解析，返回选中的 ID。
    fn pick(workflows: &[Workflow], url: &str) -> Option<String> {
        let input = CaptureInput::Url { url: url.into() };
        resolve(
            workflows,
            &InputFacts {
                input: &input,
                source_application: None,
            },
            &RegexCache::new(),
        )
        .map(|w| w.id.to_string())
    }

    #[test]
    fn the_more_specific_workflow_wins_at_equal_priority() {
        let workflows = [
            workflow("generic", 0, true, URL_ANY),
            workflow("github", 0, true, GITHUB),
        ];
        assert_eq!(
            pick(&workflows, "https://github.com/a/b").as_deref(),
            Some("github")
        );
        assert_eq!(
            pick(&workflows, "https://example.com").as_deref(),
            Some("generic")
        );
    }

    #[test]
    fn explicit_priority_beats_specificity() {
        let workflows = [
            workflow("generic", 10, true, URL_ANY),
            workflow("github", 0, true, GITHUB),
        ];
        assert_eq!(
            pick(&workflows, "https://github.com/a/b").as_deref(),
            Some("generic")
        );
    }

    #[test]
    fn disabled_workflows_are_skipped_and_nothing_matching_gives_none() {
        let workflows = [
            workflow("github", 0, false, GITHUB),
            workflow("generic", 0, true, URL_ANY),
        ];
        assert_eq!(
            pick(&workflows, "https://github.com/a/b").as_deref(),
            Some("generic")
        );
        let only_github = [workflow("github", 0, true, GITHUB)];
        assert_eq!(pick(&only_github, "https://example.com"), None);
        assert_eq!(pick(&[], "https://example.com"), None);
    }

    #[test]
    fn ties_break_by_id_and_the_result_does_not_depend_on_list_order() {
        let a = workflow("b-flow", 0, true, URL_ANY);
        let b = workflow("a-flow", 0, true, URL_ANY);
        let forward = [a.clone(), b.clone()];
        let backward = [b, a];
        assert_eq!(pick(&forward, "https://x.com").as_deref(), Some("a-flow"));
        assert_eq!(pick(&backward, "https://x.com").as_deref(), Some("a-flow"));
        for _ in 0..20 {
            assert_eq!(pick(&forward, "https://x.com").as_deref(), Some("a-flow"));
        }
    }

    #[test]
    fn one_hundred_workflows_resolve_quickly() {
        let mut workflows: Vec<Workflow> = (0..99)
            .map(|n| {
                workflow(
                    &format!("w{n:03}"),
                    0,
                    true,
                    &format!(r#"{{"field":"url.host","op":"glob","value":"*.site{n}.com"}}"#),
                )
            })
            .collect();
        workflows.push(workflow("generic", 0, true, URL_ANY));
        let input = CaptureInput::Url {
            url: "https://a.site42.com/x".into(),
        };
        let facts = InputFacts {
            input: &input,
            source_application: None,
        };
        let cache = RegexCache::new();
        let started = Instant::now();
        let mut hit = None;
        for _ in 0..100 {
            hit = resolve(&workflows, &facts, &cache).map(|w| w.id.to_string());
        }
        let per_call = started.elapsed() / 100;
        assert_eq!(hit.as_deref(), Some("w042"));
        // 目标 < 1ms（实施计划 5.2）；debug 构建留出余量。
        assert!(per_call.as_millis() < 5, "一次匹配耗时 {per_call:?}");
    }
}
