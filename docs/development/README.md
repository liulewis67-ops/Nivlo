# 开发指南（Development）

本文档说明如何在本机搭建环境、运行、测试，以及新增 Migration / IPC Command 的步骤。规范性要求见 [前端开发规范](Nivlo_Frontend_Development_Guide.md) 与 [后端开发规范](Nivlo_Backend_Development_Guide.md)，执行计划见 [实施计划](../architecture/Nivlo_Implementation_Plan.md)。

桌面界面与交互的后续优化见 [UI/UX 实施指南](ui-ux-implementation-guide.md)，评估依据与验收方法见 [UI/UX 评估计划](ui-ux-evaluation-plan.md)。

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
| `npm run check:ui` | 依次跑完上面四项前端检查（格式 → 类型 → Lint → 测试） |
| `cargo fmt --all --check` | Rust 格式检查 |
| `cargo clippy --workspace --all-targets -- -D warnings` | Rust Lint |
| `cargo test --workspace` | Rust 测试 |
| `RUSTDOCFLAGS="-D warnings" cargo doc --workspace --no-deps` | 文档注释检查 |
| `npm run check:rust` | 依次跑 Rust 格式、Clippy、测试，以及时钟用法、依赖方向、文档链接三个脚本（`-j 2`：内存紧的机器并行太多会因页面文件不足失败） |
| `npm run check` | 前端 + Rust 全部检查，提交前跑一次 |
| `node scripts/check-deps/check-deps.mjs` | 依赖方向检查 |

提交前请在本地跑完上表中的检查，CI 执行同样的命令。

### 本地数据目录

应用数据（数据库、日志、附件）默认位于系统应用数据目录（Windows：`%APPDATA%Nivlo`）。
开发与测试时可通过环境变量 `NIVLO_DATA_DIR` 指向一个临时目录，避免污染真实数据：

```bash
NIVLO_DATA_DIR=/tmp/nivlo-dev pnpm tauri dev
```

日志位于数据目录的 `logs/`，可用环境变量 `NIVLO_LOG`（语法同 `RUST_LOG`）覆盖过滤级别。

## 4. 新增 Migration

1. 在 `migrations/` 下新增 `NNNN_描述.sql`（编号递增）。
2. **不要修改**已合入的 Migration；任何 Schema 变更都通过新文件完成。
3. 运行 `node scripts/sqlx-prepare.mjs` 更新 `.sqlx/` 离线查询元数据并提交（需要 `sqlx-cli`：`cargo install sqlx-cli --version "~0.8" --no-default-features --features sqlite,rustls --locked`）；`--check` 参数用于校验。
4. 为新 Schema 添加 Storage 集成测试。

## 5. 新增 IPC Command

1. 在 `nivlo-application` 实现 Use Case，并补充 Application 测试。
2. 在 `src-tauri/src/commands/` 添加薄层 Command（参数解析 → 调用 Use Case → 错误映射 → 返回 DTO），并在 `src/lib.rs` 的 `bindings_builder` 中登记。
3. 把命令名加入 `src-tauri/build.rs` 的 `COMMANDS`（生成 `allow-<command>` 权限），再写入对应窗口的 Capability 文件（`capabilities/main.json` 或 `floating.json`），遵循最小权限。
4. 运行 `pnpm gen:bindings` 重新生成并提交 TS Binding（`apps/desktop/ui/src/bindings/index.ts`，CI 会检查是否最新）。
5. 前端通过生成的 Binding 调用，不直接使用 `invoke`。

## 6. 文档约定

- 架构决策记录在 [`docs/adr/`](../adr/)，模板见 `0000-template.md`。
- 每个子阶段完成后更新实施计划中的状态与完成记录。
- 注释使用简体中文，标识符使用英文（后端规范 §15、前端规范 §15）。
