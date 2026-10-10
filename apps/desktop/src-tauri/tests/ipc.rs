//! IPC 集成测试：通过 Tauri 的 mock 运行时调用真实的 Command，验证
//! "UI → IPC → Application → Domain → SQLite" 整条链路与重启后的持久性（里程碑 M0）。

#![allow(
    missing_docs,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::missing_docs_in_private_items
)]

use nivlo_common::paths::AppPaths;
use nivlo_desktop_lib::app::AppState;
use nivlo_desktop_lib::lifecycle::startup::{build_app_state, open_database};
use nivlo_desktop_lib::windows::MAIN_WINDOW_LABEL;
use serde_json::{Value, json};
use tauri::ipc::{CallbackFn, InvokeBody};
use tauri::test::{
    INVOKE_KEY, MockRuntime, get_ipc_response, mock_builder, mock_context, noop_assets,
};
use tauri::webview::InvokeRequest;
use tauri::{App, WebviewWindow, WebviewWindowBuilder};

/// 在给定数据目录上启动一个带真实 SQLite 的 mock 应用。
async fn app_on(paths: &AppPaths) -> App<MockRuntime> {
    let database = open_database(paths).await.unwrap();
    let state: AppState = build_app_state(database, paths.attachments_dir(), None);
    mock_builder()
        .invoke_handler(nivlo_desktop_lib::bindings_builder!(MockRuntime).invoke_handler())
        .manage(state)
        .build(mock_context(noop_assets()))
        .unwrap()
}

/// 创建主窗口的 webview，用于发起 IPC 调用。
fn main_webview(app: &App<MockRuntime>) -> WebviewWindow<MockRuntime> {
    WebviewWindowBuilder::new(app, MAIN_WINDOW_LABEL, Default::default())
        .build()
        .unwrap()
}

/// 调用一个 Command，返回成功值或错误值（均为 JSON）。
fn invoke(webview: &WebviewWindow<MockRuntime>, cmd: &str, body: Value) -> Result<Value, Value> {
    get_ipc_response(
        webview,
        InvokeRequest {
            cmd: cmd.into(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: "http://tauri.localhost".parse().unwrap(),
            body: InvokeBody::Json(body),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.to_string(),
        },
    )
    .map(|response| response.deserialize::<Value>().unwrap())
}

/// 一个 Todo 的创建请求。
fn todo_request(title: &str) -> Value {
    json!({ "request": {
        "itemType": "todo", "title": title, "content": null, "contentFormat": null,
        "priority": "high", "scheduled": { "date": "2026-10-12", "time": null },
        "due": null, "reminderAt": null, "projectId": null
    }})
}

#[tokio::test(flavor = "multi_thread")]
async fn created_item_survives_a_restart() {
    let dir = tempfile::tempdir().unwrap();
    let paths = AppPaths::from_root(dir.path().join("Nivlo"));
    paths.ensure_dirs().unwrap();

    // 第一次"运行"：创建 Item。
    let app = app_on(&paths).await;
    let webview = main_webview(&app);
    let created = invoke(&webview, "create_item", todo_request("  修复登录超时 ")).unwrap();
    assert_eq!(created["title"], "修复登录超时");
    assert_eq!(created["itemType"], "todo");
    assert_eq!(created["priority"], "high");
    assert_eq!(created["scheduled"]["date"], "2026-10-12");
    let id = created["id"].as_str().unwrap().to_owned();

    let listed = invoke(
        &webview,
        "list_items",
        json!({ "request": { "itemType": null, "includeArchived": false, "limit": null } }),
    )
    .unwrap();
    assert_eq!(listed.as_array().unwrap().len(), 1);

    // 有序退出（关闭数据库），模拟应用关闭。
    let state = tauri::Manager::state::<AppState>(&app);
    state.runtime.shutdown().await;
    drop(webview);
    drop(app);

    // 第二次"运行"：同一份数据目录，数据仍然可读。
    let app = app_on(&paths).await;
    let webview = main_webview(&app);
    let loaded = invoke(&webview, "get_item", json!({ "id": id })).unwrap();
    assert_eq!(loaded["title"], "修复登录超时");
    assert_eq!(loaded["id"], created["id"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn errors_are_returned_as_code_message_action() {
    let dir = tempfile::tempdir().unwrap();
    let paths = AppPaths::from_root(dir.path().join("Nivlo"));
    paths.ensure_dirs().unwrap();
    let app = app_on(&paths).await;
    let webview = main_webview(&app);

    let empty_title = invoke(&webview, "create_item", todo_request("   ")).unwrap_err();
    assert_eq!(empty_title["code"], "ITEM_TITLE_EMPTY");
    assert!(empty_title["action"].is_null());

    let missing = invoke(
        &webview,
        "get_item",
        json!({ "id": "0190a000-0000-7000-8000-000000000001" }),
    )
    .unwrap_err();
    assert_eq!(missing["code"], "ITEM_NOT_FOUND");

    let malformed = invoke(&webview, "get_item", json!({ "id": "not-a-uuid" })).unwrap_err();
    assert_eq!(malformed["code"], "INVALID_INPUT");

    let bad_date = invoke(
        &webview,
        "create_item",
        json!({ "request": {
            "itemType": "todo", "title": "x", "content": null, "contentFormat": null, "priority": null,
            "scheduled": { "date": "yesterday", "time": null }, "due": null, "reminderAt": null, "projectId": null
        }}),
    )
    .unwrap_err();
    assert_eq!(bad_date["code"], "INVALID_INPUT");
}

#[tokio::test(flavor = "multi_thread")]
async fn domain_rules_are_enforced_through_ipc() {
    let dir = tempfile::tempdir().unwrap();
    let paths = AppPaths::from_root(dir.path().join("Nivlo"));
    paths.ensure_dirs().unwrap();
    let app = app_on(&paths).await;
    let webview = main_webview(&app);

    // Note 不能拥有优先级。
    let rejected = invoke(
        &webview,
        "create_item",
        json!({ "request": {
            "itemType": "note", "title": "想法", "content": null, "contentFormat": null, "priority": "high",
            "scheduled": null, "due": null, "reminderAt": null, "projectId": null
        }}),
    )
    .unwrap_err();
    assert_eq!(rejected["code"], "ITEM_FIELD_NOT_APPLICABLE");
}

#[tokio::test(flavor = "multi_thread")]
async fn get_today_returns_todos_scheduled_today_with_the_remaining_count() {
    let dir = tempfile::tempdir().unwrap();
    let paths = AppPaths::from_root(dir.path().join("Nivlo"));
    paths.ensure_dirs().unwrap();
    let app = app_on(&paths).await;
    let webview = main_webview(&app);

    // 先读出"今天"是哪天（由应用自己的时钟决定），再用它创建数据。
    let empty = invoke(&webview, "get_today", json!({})).unwrap();
    assert_eq!(empty["remainingCount"], 0);
    let today = empty["date"].as_str().unwrap().to_owned();

    let make = |title: &str, scheduled: Option<&str>| {
        json!({ "request": {
            "itemType": "todo", "title": title, "content": null, "contentFormat": null,
            "priority": null, "due": null, "reminderAt": null, "projectId": null,
            "scheduled": scheduled.map(|date| json!({ "date": date, "time": null })),
        }})
    };
    invoke(&webview, "create_item", make("今天的待办", Some(&today))).unwrap();
    invoke(&webview, "create_item", make("没有日期的待办", None)).unwrap();
    invoke(
        &webview,
        "create_item",
        make("很久以前的待办", Some("2000-01-01")),
    )
    .unwrap();

    let view = invoke(&webview, "get_today", json!({})).unwrap();

    assert_eq!(view["remainingCount"], 2);
    let titles: Vec<&str> = view["todos"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["title"].as_str().unwrap())
        .collect();
    assert_eq!(titles, ["很久以前的待办", "今天的待办"]);
    assert_eq!(view["todos"][0]["isOverdue"], true);
    assert_eq!(view["todos"][1]["isOverdue"], false);
    // DTO 不携带正文。
    assert!(view["todos"][0].get("content").is_none());
}

#[tokio::test(flavor = "multi_thread")]
async fn quick_create_adds_a_todo_to_today_and_rejects_blank_titles() {
    let dir = tempfile::tempdir().unwrap();
    let paths = AppPaths::from_root(dir.path().join("Nivlo"));
    paths.ensure_dirs().unwrap();
    let app = app_on(&paths).await;
    let webview = main_webview(&app);

    let created = invoke(
        &webview,
        "quick_create",
        json!({ "request": { "itemType": "todo", "title": "  写周报 " } }),
    )
    .unwrap();
    assert_eq!(created["title"], "写周报");
    // 默认计划日期是后端决定的"今天"，与 get_today 的日期一致。
    let today = invoke(&webview, "get_today", json!({})).unwrap();
    assert_eq!(created["scheduled"]["date"], today["date"]);
    assert_eq!(today["remainingCount"], 1);

    // Note 没有日期，不进入 Today。
    let note = invoke(
        &webview,
        "quick_create",
        json!({ "request": { "itemType": "note", "title": "想法" } }),
    )
    .unwrap();
    assert!(note["scheduled"].is_null());
    assert_eq!(
        invoke(&webview, "get_today", json!({})).unwrap()["remainingCount"],
        1
    );

    let blank = invoke(
        &webview,
        "quick_create",
        json!({ "request": { "itemType": "todo", "title": "  " } }),
    )
    .unwrap_err();
    assert_eq!(blank["code"], "ITEM_TITLE_EMPTY");
}

#[tokio::test(flavor = "multi_thread")]
async fn floating_input_commands_report_an_unavailable_window_before_startup_completes() {
    let dir = tempfile::tempdir().unwrap();
    let paths = AppPaths::from_root(dir.path().join("Nivlo"));
    paths.ensure_dirs().unwrap();
    let app = app_on(&paths).await;
    let webview = main_webview(&app);

    // 测试里没有创建悬浮窗控制器，应得到明确的错误而不是 panic。
    let begin = invoke(&webview, "begin_floating_input", json!({})).unwrap_err();
    assert_eq!(begin["code"], "WINDOW_UNAVAILABLE");
    let end = invoke(&webview, "end_floating_input", json!({})).unwrap_err();
    assert_eq!(end["code"], "WINDOW_UNAVAILABLE");
}

#[tokio::test(flavor = "multi_thread")]
async fn complete_and_reopen_move_a_todo_through_today_and_keep_its_position() {
    let dir = tempfile::tempdir().unwrap();
    let paths = AppPaths::from_root(dir.path().join("Nivlo"));
    paths.ensure_dirs().unwrap();
    let app = app_on(&paths).await;
    let webview = main_webview(&app);
    let quick = |title: &str| json!({ "request": { "itemType": "todo", "title": title } });

    let first = invoke(&webview, "quick_create", quick("第一项")).unwrap();
    invoke(&webview, "quick_create", quick("第二项")).unwrap();
    let id = first["id"].as_str().unwrap();

    let done = invoke(&webview, "complete_item", json!({ "id": id })).unwrap();
    assert_eq!(done["status"], "done");
    let today = invoke(&webview, "get_today", json!({})).unwrap();
    assert_eq!(today["remainingCount"], 1);
    assert_eq!(today["completed"][0]["title"], "第一项");

    // 重复完成被领域规则拒绝。
    let again = invoke(&webview, "complete_item", json!({ "id": id })).unwrap_err();
    assert_eq!(again["code"], "ITEM_ALREADY_COMPLETED");

    // 撤销：回到 Today，且仍排在第二项之前。
    invoke(&webview, "reopen_item", json!({ "id": id })).unwrap();
    let today = invoke(&webview, "get_today", json!({})).unwrap();
    assert_eq!(today["remainingCount"], 2);
    assert_eq!(today["todos"][0]["title"], "第一项");
    assert_eq!(today["todos"][1]["title"], "第二项");
    assert!(today["completed"].as_array().unwrap().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn reorder_today_persists_the_order_and_never_drops_unknown_todos() {
    let dir = tempfile::tempdir().unwrap();
    let paths = AppPaths::from_root(dir.path().join("Nivlo"));
    paths.ensure_dirs().unwrap();
    let quick = |title: &str| json!({ "request": { "itemType": "todo", "title": title } });
    let ids = {
        let app = app_on(&paths).await;
        let webview = main_webview(&app);
        let mut ids = Vec::new();
        for title in ["甲", "乙", "丙"] {
            let item = invoke(&webview, "quick_create", quick(title)).unwrap();
            ids.push(item["id"].as_str().unwrap().to_owned());
        }
        // 界面只知道 丙、甲：乙 是排序期间新建的，必须追加在末尾而不是丢失。
        invoke(
            &webview,
            "reorder_today",
            json!({ "orderedIds": [ids[2], ids[0]] }),
        )
        .unwrap();
        let today = invoke(&webview, "get_today", json!({})).unwrap();
        let titles: Vec<&str> = today["todos"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["title"].as_str().unwrap())
            .collect();
        assert_eq!(titles, ["丙", "甲", "乙"]);

        let bad = invoke(
            &webview,
            "reorder_today",
            json!({ "orderedIds": ["不是ID"] }),
        )
        .unwrap_err();
        assert_eq!(bad["code"], "INVALID_INPUT");
        ids
    };
    // 重新打开同一个数据目录，顺序保持。
    let app = app_on(&paths).await;
    let webview = main_webview(&app);
    let today = invoke(&webview, "get_today", json!({})).unwrap();
    assert_eq!(today["todos"][0]["id"], ids[2]);
    assert_eq!(today["todos"][2]["id"], ids[1]);
}

#[tokio::test(flavor = "multi_thread")]
async fn reschedule_removes_a_todo_from_today_and_exact_restores_it() {
    let dir = tempfile::tempdir().unwrap();
    let paths = AppPaths::from_root(dir.path().join("Nivlo"));
    paths.ensure_dirs().unwrap();
    let app = app_on(&paths).await;
    let webview = main_webview(&app);
    let quick = |title: &str| json!({ "request": { "itemType": "todo", "title": title } });
    let first = invoke(&webview, "quick_create", quick("第一项")).unwrap();
    invoke(&webview, "quick_create", quick("第二项")).unwrap();
    let id = first["id"].as_str().unwrap();
    let original = first["scheduled"].clone();

    let moved = invoke(
        &webview,
        "reschedule_item",
        json!({ "id": id, "target": { "kind": "tomorrow" } }),
    )
    .unwrap();
    assert_ne!(moved["scheduled"]["date"], original["date"]);
    let today = invoke(&webview, "get_today", json!({})).unwrap();
    assert_eq!(today["remainingCount"], 1);
    assert_eq!(today["todos"][0]["title"], "第二项");

    // 撤销：精确恢复原来的计划。
    invoke(
        &webview,
        "reschedule_item",
        json!({ "id": id, "target": { "kind": "exact", "scheduled": original } }),
    )
    .unwrap();
    assert_eq!(
        invoke(&webview, "get_today", json!({})).unwrap()["remainingCount"],
        2
    );

    let bad = invoke(
        &webview,
        "reschedule_item",
        json!({ "id": id, "target": { "kind": "exact", "scheduled": { "date": "nope", "time": null } } }),
    )
    .unwrap_err();
    assert_eq!(bad["code"], "INVALID_INPUT");
}

/// 一个文本捕获请求。
fn capture_text(text: &str) -> Value {
    json!({ "request": {
        "input": { "kind": "text", "text": text }, "origin": "quickAdd", "sourceApplication": null
    }})
}

#[tokio::test(flavor = "multi_thread")]
async fn capture_is_fast_lands_in_the_inbox_and_undo_restores_the_database() {
    let dir = tempfile::tempdir().unwrap();
    let paths = AppPaths::from_root(dir.path().join("Nivlo"));
    paths.ensure_dirs().unwrap();
    let app = app_on(&paths).await;
    let webview = main_webview(&app);
    let list = || {
        invoke(
            &webview,
            "list_items",
            json!({ "request": { "itemType": null, "includeArchived": false, "limit": null } }),
        )
        .unwrap()
    };
    let before = list().as_array().unwrap().len();

    // 文本 → Todo，进入 Inbox；测量从调用到返回的耗时（验收：< 100ms）。
    let started = std::time::Instant::now();
    let text = invoke(&webview, "capture", capture_text("  整理周报\n第二行  ")).unwrap();
    let elapsed = started.elapsed();
    eprintln!("capture latency: {elapsed:?}");
    assert!(elapsed.as_millis() < 100, "capture took {elapsed:?}");
    assert_eq!(text["items"][0]["itemType"], "todo");
    assert_eq!(text["items"][0]["title"], "整理周报");
    assert_eq!(text["items"][0]["inInbox"], true);

    // 网址 → Note。
    let url = invoke(
        &webview,
        "capture",
        capture_text("https://www.example.com/docs/a"),
    )
    .unwrap();
    assert_eq!(url["items"][0]["itemType"], "note");
    assert_eq!(url["items"][0]["title"], "example.com/docs/a");
    assert_eq!(list().as_array().unwrap().len(), before + 2);

    // 撤销：数据库回到捕获前（只撤销这两次）。
    for result in [&text, &url] {
        invoke(
            &webview,
            "undo_capture",
            json!({ "itemIds": result["undoIds"] }),
        )
        .unwrap();
    }
    assert_eq!(list().as_array().unwrap().len(), before);

    // 没有内容 → INVALID_INPUT。
    let empty = invoke(&webview, "capture", capture_text("   ")).unwrap_err();
    assert_eq!(empty["code"], "INVALID_INPUT");
}

#[tokio::test(flavor = "multi_thread")]
async fn inbox_lists_captures_with_sources_organizes_in_batch_and_undoes() {
    let dir = tempfile::tempdir().unwrap();
    let paths = AppPaths::from_root(dir.path().join("Nivlo"));
    paths.ensure_dirs().unwrap();
    let app = app_on(&paths).await;
    let webview = main_webview(&app);

    let note = invoke(&webview, "capture", capture_text("https://example.com/a")).unwrap();
    let todo = invoke(&webview, "capture", capture_text("整理周报")).unwrap();
    let file = dir.path().join("报告 final.txt");
    std::fs::write(&file, "hello").unwrap();
    let files = invoke(
        &webview,
        "capture",
        json!({ "request": {
            "input": { "kind": "files", "paths": [file.to_string_lossy()] },
            "origin": "drop", "sourceApplication": null
        }}),
    )
    .unwrap();

    let inbox = invoke(&webview, "list_inbox", json!({})).unwrap();
    let entries = inbox.as_array().unwrap();
    assert_eq!(entries.len(), 3);
    // 最新的在前；每条都带来源。
    assert_eq!(entries[0]["item"]["id"], files["items"][0]["id"]);
    assert_eq!(entries[2]["sources"][0]["sourceType"], "web");
    assert_eq!(entries[1]["sources"][0]["sourceType"], "text");
    assert_eq!(entries[0]["attachments"][0]["kind"], "reference");
    assert_eq!(entries[0]["attachments"][0]["exists"], true);
    assert_eq!(invoke(&webview, "get_inbox_count", json!({})).unwrap(), 3);

    // 被引用的文件被移走后：显示「不存在」，不报错，也不影响列表。
    std::fs::remove_file(&file).unwrap();
    let inbox = invoke(&webview, "list_inbox", json!({})).unwrap();
    assert_eq!(inbox[0]["attachments"][0]["exists"], false);

    // 批量：两条安排到今天 → 离开 Inbox。
    let ids = json!([note["items"][0]["id"], todo["items"][0]["id"]]);
    let organized = invoke(
        &webview,
        "organize_items",
        json!({ "itemIds": ids, "action": { "kind": "schedule", "target": { "kind": "today" } } }),
    )
    .unwrap();
    assert_eq!(organized["items"].as_array().unwrap().len(), 2);
    assert_eq!(organized["items"][0]["inInbox"], false);
    assert_eq!(invoke(&webview, "get_inbox_count", json!({})).unwrap(), 1);

    // 撤销：回到整理之前。
    invoke(
        &webview,
        "restore_items",
        json!({ "previous": organized["previous"] }),
    )
    .unwrap();
    assert_eq!(invoke(&webview, "get_inbox_count", json!({})).unwrap(), 3);

    // 错误：Item 不存在、日期格式不对。
    let missing = invoke(
        &webview,
        "organize_items",
        json!({ "itemIds": ["0190a000-0000-7000-8000-000000000001"], "action": { "kind": "archive" } }),
    )
    .unwrap_err();
    assert_eq!(missing["code"], "ITEM_NOT_FOUND");
    let bad = invoke(
        &webview,
        "organize_items",
        json!({ "itemIds": ids, "action": { "kind": "schedule", "target": { "kind": "date", "date": "明天" } } }),
    )
    .unwrap_err();
    assert_eq!(bad["code"], "INVALID_INPUT");
}

#[tokio::test(flavor = "multi_thread")]
async fn main_view_handoff_validates_the_view_and_is_taken_only_once() {
    let dir = tempfile::tempdir().unwrap();
    let paths = AppPaths::from_root(dir.path().join("Nivlo"));
    paths.ensure_dirs().unwrap();
    let app = app_on(&paths).await;
    let webview = main_webview(&app);

    // 没有请求时什么都没有。
    assert!(
        invoke(&webview, "take_pending_main_view", json!({}))
            .unwrap()
            .is_null()
    );

    // 不认识的视图被拒绝，并且不会留下待处理的请求。
    let rejected = invoke(&webview, "open_main_at", json!({ "view": "settings" })).unwrap_err();
    assert_eq!(rejected["code"], "INVALID_INPUT");
    assert!(
        invoke(&webview, "take_pending_main_view", json!({}))
            .unwrap()
            .is_null()
    );

    // 悬浮窗的请求记在状态里，主窗口取走一次之后就清除。
    let state = tauri::Manager::state::<AppState>(&app);
    state.runtime.set_pending_main_view("inbox".to_owned());
    assert_eq!(
        invoke(&webview, "take_pending_main_view", json!({})).unwrap(),
        "inbox"
    );
    assert!(
        invoke(&webview, "take_pending_main_view", json!({}))
            .unwrap()
            .is_null()
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn update_item_patches_only_what_is_sent_enforces_domain_rules_and_persists() {
    let dir = tempfile::tempdir().unwrap();
    let paths = AppPaths::from_root(dir.path().join("Nivlo"));
    paths.ensure_dirs().unwrap();
    let app = app_on(&paths).await;
    let webview = main_webview(&app);
    let created = invoke(&webview, "create_item", todo_request("写周报")).unwrap();
    let id = created["id"].clone();

    // 只改标题与内容：其他字段（优先级、计划日期）保持。
    let updated = invoke(
        &webview,
        "update_item",
        json!({ "id": id, "request": {
            "title": "  写周报（终稿） ",
            "content": { "kind": "set", "value": "## 要点\n- 登录超时" },
            "contentFormat": "markdown"
        }}),
    )
    .unwrap();
    assert_eq!(updated["title"], "写周报（终稿）");
    assert_eq!(updated["content"], "## 要点\n- 登录超时");
    assert_eq!(updated["contentFormat"], "markdown");
    assert_eq!(updated["priority"], "high");
    assert_eq!(updated["scheduled"]["date"], "2026-10-12");

    // 清除计划日期；设置截止日期与优先级。
    let updated = invoke(
        &webview,
        "update_item",
        json!({ "id": id, "request": {
            "scheduled": { "kind": "clear" },
            "due": { "kind": "set", "value": { "date": "2026-10-20", "time": "18:00" } },
            "priority": "low"
        }}),
    )
    .unwrap();
    assert!(updated["scheduled"].is_null());
    assert_eq!(updated["due"]["date"], "2026-10-20");
    assert_eq!(updated["due"]["time"], "18:00:00");
    assert_eq!(updated["priority"], "low");

    // 领域规则：空标题被拒绝；改成笔记后截止日期与优先级被清理；给笔记设置截止日期被拒绝。
    let empty = invoke(
        &webview,
        "update_item",
        json!({ "id": id, "request": { "title": "   " } }),
    )
    .unwrap_err();
    assert_eq!(empty["code"], "ITEM_TITLE_EMPTY");
    let note = invoke(
        &webview,
        "update_item",
        json!({ "id": id, "request": { "itemType": "note" } }),
    )
    .unwrap();
    assert_eq!(note["itemType"], "note");
    assert!(note["due"].is_null());
    assert_eq!(note["priority"], "none");
    let rejected = invoke(
        &webview,
        "update_item",
        json!({ "id": id, "request": { "due": { "kind": "set", "value": { "date": "2026-10-20", "time": null } } } }),
    )
    .unwrap_err();
    assert_eq!(rejected["code"], "ITEM_FIELD_NOT_APPLICABLE");
    let bad_date = invoke(
        &webview,
        "update_item",
        json!({ "id": id, "request": { "scheduled": { "kind": "set", "value": { "date": "明天", "time": null } } } }),
    )
    .unwrap_err();
    assert_eq!(bad_date["code"], "INVALID_INPUT");

    // 被拒绝的修改没有留下任何痕迹；重启后修改仍在。
    let state = tauri::Manager::state::<AppState>(&app);
    state.runtime.shutdown().await;
    drop(webview);
    drop(app);
    let app = app_on(&paths).await;
    let webview = main_webview(&app);
    let detail = invoke(&webview, "get_item_detail", json!({ "id": id })).unwrap();
    assert_eq!(detail["item"]["title"], "写周报（终稿）");
    assert_eq!(detail["item"]["itemType"], "note");
    assert_eq!(detail["item"]["content"], "## 要点\n- 登录超时");
    assert!(detail["sources"].as_array().unwrap().is_empty());

    let missing = invoke(
        &webview,
        "update_item",
        json!({ "id": "0190a000-0000-7000-8000-000000000001", "request": { "title": "x" } }),
    )
    .unwrap_err();
    assert_eq!(missing["code"], "ITEM_NOT_FOUND");
}

#[tokio::test(flavor = "multi_thread")]
async fn open_item_source_reports_missing_files_and_items_without_a_source() {
    let dir = tempfile::tempdir().unwrap();
    let paths = AppPaths::from_root(dir.path().join("Nivlo"));
    paths.ensure_dirs().unwrap();
    let app = app_on(&paths).await;
    let webview = main_webview(&app);

    // 手动创建的 Item 没有来源。
    let manual = invoke(&webview, "create_item", todo_request("没有来源")).unwrap();
    let error = invoke(&webview, "open_item_source", json!({ "id": manual["id"] })).unwrap_err();
    assert_eq!(error["code"], "SOURCE_OPEN_FAILED");

    // 引用的文件被移走：明确的「文件不存在」，而不是笼统的失败。
    let file = dir.path().join("报告.txt");
    std::fs::write(&file, "x").unwrap();
    let captured = invoke(
        &webview,
        "capture",
        json!({ "request": {
            "input": { "kind": "files", "paths": [file.to_string_lossy()] },
            "origin": "paste", "sourceApplication": null
        }}),
    )
    .unwrap();
    std::fs::remove_file(&file).unwrap();
    let error = invoke(
        &webview,
        "open_item_source",
        json!({ "id": captured["items"][0]["id"] }),
    )
    .unwrap_err();
    assert_eq!(error["code"], "SOURCE_FILE_MISSING");
}
