//! Tauri 构建脚本：生成上下文，并为每个 App Command 生成 `allow-<command>` 权限，
//! 这样 Capability 文件才能按窗口只授予所需命令（架构文档 §13）。

/// 全部 App Command 名称；新增 Command 必须同步加入此处与对应窗口的 Capability。
const COMMANDS: &[&str] = &[
    "create_item",
    "get_item",
    "list_items",
    "search_items",
    "mark_item_opened",
    "get_item_detail",
    "update_item",
    "open_item_source",
    "delete_items",
    "undo_created_item",
    "restore_deleted_items",
    "list_trash",
    "purge_items",
    "empty_trash",
    "export_diagnostics",
    "create_backup_file",
    "export_data",
    "restore_backup",
    "reset_all_data",
    "restart_app",
    "list_workflows",
    "set_workflow_enabled",
    "set_workflow_priority",
    "duplicate_workflow",
    "save_workflow",
    "delete_workflow",
    "dry_run_workflow",
    "list_workflow_runs",
    "rerun_workflow",
    "confirm_script_permissions",
    "export_workflow_file",
    "pick_workflow_import",
    "import_workflow",
    "get_app_settings",
    "list_integrations",
    "connect_integration",
    "disconnect_integration",
    "test_integration",
    "check_for_update",
    "install_update",
    "get_ui_pref",
    "set_ui_pref",
    "save_skin_asset",
    "prune_skin_assets",
    "get_skin_storage_usage",
    "export_skin_pack",
    "import_skin_pack",
    "set_autostart",
    "set_floating_always_on_top",
    "set_search_prewarm",
    "set_later_rule",
    "get_calendar",
    "set_week_start",
    "set_onboarding_completed",
    "set_notifications_paused",
    "set_reminder_flash_seconds",
    "set_reminder_count",
    "list_projects",
    "create_project",
    "rename_project",
    "archive_project",
    "unarchive_project",
    "list_tags",
    "tags_for_items",
    "rename_tag",
    "merge_tags",
    "set_item_tags",
    "capture",
    "undo_capture",
    "capture_from_clipboard",
    "read_clipboard_text",
    "list_inbox",
    "get_inbox_count",
    "organize_items",
    "restore_items",
    "quick_create",
    "complete_item",
    "reopen_item",
    "reschedule_item",
    "get_today",
    "reorder_today",
    "open_main",
    "open_main_at",
    "get_shortcut_status",
    "set_shortcut",
    "suggest_shortcuts",
    "disable_shortcut",
    "take_pending_main_view",
    "quit_app",
    "start_floating_drag",
    "open_item_in_main",
    "hide_search",
    "fit_search",
    "expand_floating",
    "collapse_floating",
    "get_reminder_attention_ms",
    "begin_floating_input",
    "end_floating_input",
];

fn main() {
    let mut attributes = tauri_build::Attributes::new()
        .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS));

    let is_msvc_windows = std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc");
    if is_msvc_windows {
        // tauri-build 默认只给"可执行文件目标"嵌入 Windows 清单，而单元测试与 example 也会链接 Tauri，
        // 缺少 Common Controls v6 清单时启动即报 STATUS_ENTRYPOINT_NOT_FOUND。
        // 因此关闭默认清单，改为对所有目标统一嵌入我们自己的清单。
        attributes = attributes
            .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
        let manifest = std::env::current_dir()
            .map(|dir| dir.join("windows-app.manifest"))
            .unwrap_or_default();
        println!("cargo:rerun-if-changed=windows-app.manifest");
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
    }

    if let Err(error) = tauri_build::try_build(attributes) {
        // 构建脚本没有更好的错误出口：打印后以失败状态退出，让 cargo 报告构建失败。
        eprintln!("tauri 构建失败: {error:#}");
        std::process::exit(1);
    }
}
