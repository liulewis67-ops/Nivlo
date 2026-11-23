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
    // 悬浮窗重载后只读恢复尚未结束的提醒动画，不允许修改提醒配置。
    "get_reminder_attention_ms",
    // 悬浮窗用只读界面偏好同步显示配置。
    "get_ui_pref",
    "quick_create",
    "create_item",
    "undo_created_item",
    "list_projects",
    "complete_item",
    // 完成的撤销（D-12 的 `undo` 在 Item 完成场景的具体命令）。
    "reopen_item",
    "reorder_today",
    "capture",
    // 撤销一次捕获（D-12 的 `undo` 在捕获场景的具体命令）。
    "undo_capture",
    // 用户在悬浮窗上点「粘贴」：只在这个明确的动作里读取剪贴板（架构文档 §17）。
    "capture_from_clipboard",
    "read_clipboard_text",
    "open_main",
    "open_item_in_main",
    // 悬浮窗请求主窗口打开某个视图（如收集箱）。
    "open_main_at",
    "reschedule_item",
    "undo",
    "get_inbox_count",
    // 悬浮窗的窗口行为命令（位置、拖动、展开 / 收起、焦点）。
    "start_floating_drag",
    "expand_floating",
    "collapse_floating",
    "set_floating_focusable",
    "begin_floating_input",
    "end_floating_input",
];

/// 全局搜索框允许使用的全部命令：只读搜索、列出最近的条目（空输入时显示）、项目与标签（结果旁显示）、把结果交给主窗口、
/// 隐藏自己。写入只有两类，都和悬浮窗相同：`quick_create`（找不到就顺手记成待办），以及
/// 完成待办与它的撤销（Ctrl+D，可撤销）。它在任何应用之上弹出，不应拥有编辑、改期、归档或删除的命令。
const SEARCH_ALLOWED: &[&str] = &[
    "search_items",
    "list_items",
    "list_projects",
    "tags_for_items",
    "quick_create",
    // Ctrl+D 完成选中的待办；`reopen_item` 是它的撤销（与悬浮窗相同）。
    "complete_item",
    "reopen_item",
    "open_item_in_main",
    "open_main_at",
    "hide_search",
    // 窗口高度跟随内容（后端限制范围，只作用于搜索窗口自己）。
    "fit_search",
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
fn search_capability_only_targets_the_search_window_and_cannot_edit_or_delete() {
    let search = parse(include_str!("../capabilities/search.json"));
    assert_eq!(windows(&search), ["search"]);
    for command in allowed_commands(&search) {
        assert!(
            SEARCH_ALLOWED.contains(&command.as_str()),
            "搜索框不应拥有命令 {command}"
        );
    }
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
    for command in ["get_item", "list_items", "quit_app"] {
        assert!(
            !floating.iter().any(|c| c == command),
            "{command} 不得出现在悬浮窗权限中"
        );
    }
}

#[test]
fn detail_windows_can_save_and_preview_but_cannot_manage_the_app() {
    let detail = parse(include_str!("../capabilities/detail.json"));
    assert_eq!(windows(&detail), ["detail-*"]);
    let commands = allowed_commands(&detail);
    for required in [
        "get_item_detail",
        "update_item",
        "preview_item_attachment",
        "reveal_item_attachment",
    ] {
        assert!(commands.iter().any(|command| command == required));
    }
    for forbidden in [
        "quit_app",
        "purge_items",
        "reset_all_data",
        "set_shortcut",
        "install_update",
    ] {
        assert!(!commands.iter().any(|command| command == forbidden));
    }
}

#[test]
fn no_window_gets_blanket_permissions() {
    for text in [
        include_str!("../capabilities/floating.json"),
        include_str!("../capabilities/main.json"),
        include_str!("../capabilities/search.json"),
        include_str!("../capabilities/detail.json"),
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
    let search = allowed_commands(&parse(include_str!("../capabilities/search.json")));
    // 直接解析 build.rs 中 `COMMANDS` 常量里的字符串，而不是在测试里再维护一份列表。
    let build_rs = include_str!("../build.rs");
    let start = build_rs.find("const COMMANDS").unwrap();
    let list = &build_rs[start..];
    // 跳过类型标注里的 `&[&str]`，从赋值号之后的数组字面量开始，到 `];` 结束。
    let list = &list[list.find("= &[").unwrap()..list.find("];").unwrap()];
    let commands: Vec<&str> = list.split('"').skip(1).step_by(2).collect();
    assert!(
        commands.len() >= 6,
        "解析 build.rs 的命令列表失败：{commands:?}"
    );
    for command in commands {
        assert!(
            main.iter()
                .chain(floating.iter())
                .chain(search.iter())
                .any(|c| c == command),
            "命令 {command} 没有授予任何窗口"
        );
    }
}
