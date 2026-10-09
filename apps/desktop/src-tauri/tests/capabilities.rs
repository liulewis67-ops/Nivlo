//! Capability 边界测试：悬浮窗只能拥有白名单内的命令，主窗口专属命令不得泄漏给它
//! （架构文档 §13，实施计划 D-12）。

#![allow(
    missing_docs,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::missing_docs_in_private_items
)]

use serde_json::Value;

/// 悬浮窗允许使用的全部命令（架构文档 §13 + D-12）。新命令只有在对应功能落地时才加入 Capability，
/// 这里是**上限**：任何不在其中的命令都不得出现在 `floating.json`。
const FLOATING_ALLOWED: &[&str] = &[
    "get_today",
    "quick_create",
    "complete_item",
    "reorder_today",
    "capture",
    "open_main",
    "reschedule_item",
    "undo",
    "get_inbox_count",
    // 悬浮窗的窗口行为命令（位置、拖动、展开 / 收起、焦点）。
    "start_floating_drag",
    "expand_floating",
    "collapse_floating",
    "set_floating_focusable",
];

/// 解析一个 Capability 文件。
fn parse(text: &str) -> Value {
    serde_json::from_str(text).unwrap()
}

/// 取出 Capability 中以 `allow-` 开头的应用命令权限，并还原为 snake_case 命令名。
fn allowed_commands(capability: &Value) -> Vec<String> {
    capability["permissions"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|p| p.as_str())
        .filter_map(|p| p.strip_prefix("allow-"))
        .map(|name| name.replace('-', "_"))
        .collect()
}

/// 取出 Capability 作用的窗口 label。
fn windows(capability: &Value) -> Vec<String> {
    capability["windows"]
        .as_array()
        .unwrap()
        .iter()
        .map(|w| w.as_str().unwrap().to_owned())
        .collect()
}

#[test]
fn floating_capability_only_targets_the_floating_window() {
    let floating = parse(include_str!("../capabilities/floating.json"));
    assert_eq!(windows(&floating), ["floating"]);
}

#[test]
fn main_capability_only_targets_the_main_window() {
    let main = parse(include_str!("../capabilities/main.json"));
    assert_eq!(windows(&main), ["main"]);
}

#[test]
fn floating_only_has_whitelisted_commands() {
    let floating = parse(include_str!("../capabilities/floating.json"));
    for command in allowed_commands(&floating) {
        assert!(
            FLOATING_ALLOWED.contains(&command.as_str()),
            "悬浮窗不应拥有命令 {command}（不在 D-12 白名单中）"
        );
    }
}

#[test]
fn main_only_commands_are_not_exposed_to_floating() {
    let floating = allowed_commands(&parse(include_str!("../capabilities/floating.json")));
    for command in ["create_item", "get_item", "list_items", "quit_app"] {
        assert!(
            !floating.iter().any(|c| c == command),
            "{command} 不得出现在悬浮窗权限中"
        );
    }
}

#[test]
fn no_window_gets_blanket_permissions() {
    for text in [
        include_str!("../capabilities/floating.json"),
        include_str!("../capabilities/main.json"),
    ] {
        let capability = parse(text);
        for permission in capability["permissions"].as_array().unwrap() {
            let name = permission.as_str().unwrap();
            // 不允许通配或"全部命令"类权限，也不允许 shell / fs 等能力型插件（ADR-010）。
            assert!(!name.contains('*'), "{name}");
            assert!(
                !name.starts_with("shell:") && !name.starts_with("fs:"),
                "{name}"
            );
            assert!(name != "core:default", "{name} 过宽，请按需列出具体权限");
        }
    }
}

#[test]
fn every_command_in_build_rs_is_granted_to_some_window() {
    // build.rs 里登记的命令如果没有任何窗口使用，说明它是死代码或漏配了权限。
    let main = allowed_commands(&parse(include_str!("../capabilities/main.json")));
    let floating = allowed_commands(&parse(include_str!("../capabilities/floating.json")));
    let build_rs = include_str!("../build.rs");
    for command in [
        "create_item",
        "get_item",
        "list_items",
        "open_main",
        "quit_app",
        "start_floating_drag",
    ] {
        assert!(
            build_rs.contains(&format!("\"{command}\"")),
            "build.rs 缺少 {command}"
        );
        assert!(
            main.iter().chain(floating.iter()).any(|c| c == command),
            "命令 {command} 没有授予任何窗口"
        );
    }
}
