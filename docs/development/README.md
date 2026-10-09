# 开发指南（Development）

本文档说明如何在本机搭建环境、运行、测试，以及新增 Migration / IPC Command 的步骤。规范性要求见 [前端开发规范](Nivlo_Frontend_Development_Guide.md) 与 [后端开发规范](Nivlo_Backend_Development_Guide.md)，执行计划见 [实施计划](../architecture/Nivlo_Implementation_Plan.md)。

## 1. 环境要求

| 项 | 要求 |
|---|---|
| Rust | `rust-toolchain.toml` 固定的 stable 版本（含 rustfmt、clippy），`rustup` 会自动安装 |
| Windows 构建依赖 | Visual Studio Build Tools（MSVC + Windows SDK） |
| WebView | Microsoft Edge WebView2 Runtime（Windows 11 自带） |
| Node.js | 22 及以上（规范目标为 24 LTS，见实施计划 0.1 完成记录） |
| pnpm | 10 及以上；**只允许使用 pnpm**，`npm install` 会被拒绝 |

## 2. 首次启动

```bash
git clone <repo-url> nivlo
```

```bash
cd nivlo
```

```bash
corepack enable
```

```bash
pnpm install
```

```bash
pnpm tauri dev
```

首次 `pnpm tauri dev` 会编译全部 Rust 依赖，耗时数分钟；之后为增量编译。

## 3. 常用命令（均在仓库根目录执行）

| 命令 | 作用 |
|---|---|
| `pnpm tauri dev` | 启动桌面应用（Vite + Rust） |
| `pnpm dev:ui` | 仅启动 Vite（纯 UI 调试） |
| `pnpm lint` / `pnpm typecheck` / `pnpm test` / `pnpm format:check` | 前端质量门禁 |
| `cargo fmt --all --check` | Rust 格式检查 |
| `cargo clippy --workspace --all-targets -- -D warnings` | Rust Lint |
| `cargo test --workspace` | Rust 测试 |
| `RUSTDOCFLAGS="-D warnings" cargo doc --workspace --no-deps` | 文档注释检查 |
| `node scripts/check-deps/check-deps.mjs` | 依赖方向检查 |

提交前请在本地跑完上表中的检查，CI 执行同样的命令。

## 4. 新增 Migration

1. 在 `migrations/` 下新增 `NNNN_描述.sql`（编号递增）。
2. **不要修改**已合入的 Migration；任何 Schema 变更都通过新文件完成。
3. 运行 `cargo sqlx prepare --workspace` 更新离线查询元数据并提交（P0.6 起）。
4. 为新 Schema 添加 Storage 集成测试。

## 5. 新增 IPC Command

1. 在 `nivlo-application` 实现 Use Case，并补充 Application 测试。
2. 在 `src-tauri/src/commands/` 添加薄层 Command（参数解析 → 调用 Use Case → 错误映射 → 返回 DTO）。
3. 将 Command 写入对应窗口的 Capability 文件（`capabilities/main.json` 或 `floating.json`），遵循最小权限。
4. 运行 `pnpm gen:bindings` 重新生成并提交 TS Binding（P0.8 起）。
5. 前端通过生成的 Binding 调用，不直接使用 `invoke`。

## 6. 文档约定

- 架构决策记录在 [`docs/adr/`](../adr/)，模板见 `0000-template.md`。
- 每个子阶段完成后更新实施计划中的状态与完成记录。
- 注释使用简体中文，标识符使用英文（后端规范 §15、前端规范 §15）。
