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
use nivlo_desktop_lib::{bindings_builder, windows::MAIN_WINDOW_LABEL};
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
    let state: AppState = build_app_state(database, None);
    mock_builder()
        .invoke_handler(bindings_builder::<MockRuntime>().invoke_handler())
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
