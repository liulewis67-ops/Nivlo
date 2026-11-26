//! 生成 TypeScript Binding 到 `apps/desktop/ui/src/bindings/index.ts`。
//!
//! 通过 `pnpm gen:bindings` 调用；CI 会重新生成并检查工作区是否有差异。

use std::path::PathBuf;
use std::process::ExitCode;

use specta_typescript::Typescript;

/// 导出 Binding；失败时打印原因并返回非零退出码。
fn main() -> ExitCode {
    let target = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("ui")
        .join("src")
        .join("bindings")
        .join("index.ts");
    match stardeskbox_desktop_lib::bindings_builder!(tauri::Wry)
        .export(Typescript::default(), &target)
    {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("生成 Binding 失败: {error}");
            ExitCode::FAILURE
        }
    }
}
