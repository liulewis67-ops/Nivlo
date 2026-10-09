//! Tauri 构建脚本：生成上下文，并为每个 App Command 生成 `allow-<command>` 权限，
//! 这样 Capability 文件才能按窗口只授予所需命令（架构文档 §13）。

/// 全部 App Command 名称；新增 Command 必须同步加入此处与对应窗口的 Capability。
const COMMANDS: &[&str] = &[
    "create_item",
    "get_item",
    "list_items",
    "get_today",
    "open_main",
    "quit_app",
    "start_floating_drag",
    "expand_floating",
    "collapse_floating",
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
