# Nivlo · 拾序 后端开发规范（Backend Development Guide）

> Status: v1.0  
> Last Updated: 2026-10-09  
> 适用范围：`crates/` 下全部 Rust crate、`apps/desktop/src-tauri/`、`migrations/`、`workflows/builtin/`  
> 依据文档：[技术架构](../architecture/Nivlo_Technical_Architecture.md)、[实施计划](../architecture/Nivlo_Implementation_Plan.md)、[前端开发规范](Nivlo_Frontend_Development_Guide.md)  
> 规范中的「必须 / 禁止」为强制要求，CI 与 Code Review 按此执行；「建议」为推荐做法，偏离时需在 PR 中说明理由。

---

# 1. 后端职责边界

后端 = Rust Core（Domain / Application / Adapters）+ Tauri Desktop Host。

| 层 | 位置 | 负责 |
|---|---|---|
| Desktop Host / Composition Root | `apps/desktop/src-tauri` | 应用生命周期、窗口、Tray、插件、IPC Command / Event 注册、依赖装配 |
| Application | `crates/nivlo-application` | Use Case、业务编排、事务边界、Port 定义、Domain Event 分发 |
| Domain | `crates/nivlo-domain` | 业务模型、业务规则、值对象、领域事件、领域错误 |
| Adapters | `nivlo-storage`、`nivlo-capture`、`nivlo-workflow`、`nivlo-script`、`nivlo-scheduler`、`nivlo-integrations`、`nivlo-platform-*` | 实现 Port：SQLite、输入解析、Workflow Runtime、QuickJS、调度、外部系统、操作系统能力 |
| Common | `crates/nivlo-common` | 日志初始化、路径、时钟、ID、`Secret` 等无业务含义的基础设施 |

核心原则（架构文档 §68）：

1. **Tauri 是壳，不是 Core**——业务逻辑不得写在 `src-tauri` 中。
2. **SQLite 是唯一 Source of Truth**。
3. **平台差异只出现在 Platform Adapter 中**。
4. **常驻应用的 Idle 性能是产品能力**——禁止无意义轮询与后台忙等。

---

# 2. 技术栈要求

## 2.1 工具链

| 项 | 要求 | 说明 |
|---|---|---|
| Rust | **stable**，通过 `rust-toolchain.toml` 锁定确切版本（含 `rustfmt`、`clippy` 组件） | 升级工具链需单独 PR |
| Edition | **2024** | 所有 crate 统一 |
| Windows 构建依赖 | Visual Studio Build Tools（MSVC、Windows SDK）、WebView2 Runtime | 见开发文档 |
| SQLx CLI | `sqlx-cli`（仅 `sqlite` feature） | 新建 migration、`cargo sqlx prepare` |
| Tauri CLI | 通过前端 devDependency `@tauri-apps/cli`，使用 `pnpm tauri ...` 调用 | **不**单独 `cargo install tauri-cli`，保证版本一致 |
| 依赖审计 | `cargo-deny` | License、安全公告、重复依赖检查 |
| 测试运行器 | `cargo test`（可选 `cargo-nextest`） | CI 使用 `cargo test --workspace` |

## 2.2 依赖技术栈

> 所有依赖在根 `Cargo.toml` 的 `[workspace.dependencies]` 中统一声明版本，各 crate 使用 `xxx.workspace = true` 引用，**禁止**在子 crate 中单独指定版本。下表为基线主版本，确切版本在实施计划 0.1 锁定于 `Cargo.lock`。

| 分类 | Crate | 基线版本 | 用途 / 约束 |
|---|---|---|---|
| 桌面宿主 | `tauri` | 2.x | 仅 `src-tauri` 可依赖 |
| Tauri 插件 | `tauri-plugin-single-instance`、`-autostart`、`-global-shortcut`、`-notification`、`-updater`、`-clipboard-manager`、`-opener`、`-dialog` | 2.x | 仅 `src-tauri` 与对应 Platform Adapter 可依赖 |
| 异步运行时 | `tokio` | 1.x | 多线程运行时；按需开启 feature |
| 取消 | `tokio-util`（`CancellationToken`） | 0.7.x | Workflow、HTTP、Script 等耗时任务 |
| 序列化 | `serde`、`serde_json` | 1.x | |
| 错误 | `thiserror` | 2.x | 库 crate 的错误类型；**库 crate 禁止使用 `anyhow`** |
| 日志 | `tracing`、`tracing-subscriber`、`tracing-appender` | 0.1.x / 0.3.x / 0.2.x | 禁止 `println!` / `log` crate 直接输出 |
| 数据库 | `sqlx`（features：`sqlite`、`runtime-tokio`、`migrate`、`macros`、`chrono`、`uuid`） | 0.8.x | 仅 `nivlo-storage` 与 `src-tauri`（装配）可依赖 |
| HTTP | `reqwest`（`rustls-tls`，关闭默认 TLS） | 0.12.x | 仅 `nivlo-integrations` 的 HttpPort 适配器可依赖 |
| 脚本 | `rquickjs` | 最新稳定版 | 仅 `nivlo-script` 可依赖 |
| 时间 | `chrono`（+ `chrono-tz` 如需要） | 0.4.x | 统一时间库，禁止混用 `time` crate |
| ID | `uuid`（`v7`、`serde`） | 1.x | 实施计划 D-04 |
| 异步 Trait | `async-trait` | 0.1.x | 需要 `dyn Trait` 的 Port；无需动态分发时优先使用原生 `async fn` in trait |
| 输入解析 | `url`、`regex`、`globset`、`mime_guess`、`infer` | 最新稳定版 | `nivlo-capture`、`nivlo-workflow` |
| IPC 类型生成 | `specta`、`tauri-specta` | 与 Tauri 2 兼容的版本 | DTO 派生 `specta::Type`；工具若停止维护可替换，架构不依赖具体工具 |
| Windows 原生 | `windows` | 最新稳定版 | 仅 `nivlo-platform-windows` 可依赖 |
| 测试 | `tempfile`、`rstest`、`wiremock`、`insta`（可选）、`tokio`（`test-util`） | 最新稳定版 | 仅 `[dev-dependencies]` |

## 2.3 禁止事项

- 库 crate 使用 `anyhow`（应用入口 `main.rs` 的顶层启动函数与测试除外）。
- 使用 `lazy_static` / `static mut` / 全局 `Mutex<HashMap>` 保存业务状态（架构文档 §55）。
- 使用 `openssl`（统一 `rustls`）。
- 引入第二个异步运行时（如 `async-std`）。
- 引入 ORM（Diesel、SeaORM 等）——统一使用 SQLx 手写 SQL。
- 新增运行时依赖未在 PR 中说明用途、维护状态、License、编译时间 / 体积影响。

---

# 3. Workspace 与 Crate 依赖规则

## 3.1 允许的依赖关系

| Crate | 可以依赖 | 禁止依赖 |
|---|---|---|
| `nivlo-common` | 标准库、`tracing*`、`chrono`、`uuid`、`serde` | 任何 `nivlo-*` 业务 crate、`tauri`、`sqlx`、`reqwest`、`rquickjs`、`windows` |
| `nivlo-domain` | `nivlo-common`、`serde`、`chrono`、`uuid`、`thiserror` | `tauri`、`sqlx`、`reqwest`、`rquickjs`、`windows`、`tokio`（运行时相关） |
| `nivlo-application` | `nivlo-domain`、`nivlo-common`、`tokio`（sync / time）、`async-trait`、`thiserror` | `tauri`、`sqlx`、`reqwest`、`rquickjs`、`windows`、任何 Adapter crate |
| `nivlo-platform` | `nivlo-domain`、`nivlo-common` | 任何具体平台库 |
| Adapter crate（storage / capture / workflow / script / scheduler / integrations / platform-*） | `nivlo-application`（实现其 Port）、`nivlo-domain`、`nivlo-common`、各自的技术依赖 | `tauri`（`nivlo-platform-*` 中的 Tauri 适配除外）、其他 Adapter 的内部实现 |
| `src-tauri` | 所有 crate | — |

- 依赖方向由 `scripts/check-deps` 在 CI 中强制检查（实施计划 0.2）。
- Adapter 之间需要协作时，通过 Application 层定义的 Port 进行，而不是直接依赖。例如 `nivlo-workflow` 通过 `HttpPort` 发请求，不直接依赖 `nivlo-integrations`。
- 平台 crate 使用 `#![cfg(target_os = "...")]` 隔离，`src-tauri` 中按 `cfg` 选择装配。

## 3.2 模块组织

- 每个 crate 的 `lib.rs` 只做模块声明与公开导出，不写业务实现。
- 模块按业务概念划分（`item/`、`schedule/`、`workflow/`），而不是按技术类型划分（不要 `models/`、`utils/` 大杂烩）。
- 公开 API 最小化：默认 `pub(crate)`，只有被其他 crate 使用的项才 `pub`。

---

# 4. 分层编码规则

## 4.1 Domain（`nivlo-domain`）

- 纯同步、纯计算：**禁止** IO、异步、获取当前时间（时间由调用方传入或通过 `Clock` 在 Application 层获得）。
- 业务不变量在类型中表达：使用 Newtype（`ItemId`、`Title`）与构造函数校验，不允许构造出非法状态。
- 状态变化通过方法完成并返回领域事件或 `Result`，例如 `item.complete(now) -> Result<ItemCompleted, DomainError>`；Tip 调用 `complete` 返回错误。
- 字段尽量私有，通过方法暴露，避免外部绕过规则直接修改。

## 4.2 Application（`nivlo-application`）

- 每个 Use Case 一个方法（或一个结构体），按服务分组：`ItemService`、`CaptureService`、`WorkflowService`、`ScheduleService`。
- **Port（trait）在本层定义**：`ItemRepository`、`UnitOfWork`、`Clock`、`EventPublisher`、`HttpPort`、`CredentialPort`、`NotificationPort` 等。
- **事务边界由本层决定**（架构文档 §56）：一个 Use Case 内的多次写入在同一个 `UnitOfWork` 中提交；Repository 不自行提交。
- 写入成功并提交后才发布 Domain Event；事务回滚时不得发布。
- 输入 / 输出使用专门的 DTO（`CreateItemInput`、`TodayView`），不把 Domain 实体直接暴露给 IPC。
- Use Case 内不处理具体平台、具体数据库、具体 HTTP 库的细节。

## 4.3 Storage（`nivlo-storage`）

- 使用 SQLx 的编译期校验宏（`query!`、`query_as!`）；动态 SQL 只在确有需要时使用 `QueryBuilder`，并在代码中注释原因。
- Repository 只做数据映射与查询，**禁止**包含业务判断（如「哪些 Item 属于 Today」应由 Application 组装查询条件或由明确命名的查询方法表达，并在 Application 层测试其语义）。
- 数据库行类型（`ItemRow`）与 Domain 类型分离，转换函数集中放置并测试。

## 4.4 其他 Adapter

- 实现 Application 定义的 Port，外部库的错误在 Adapter 内转换为本 crate 的错误类型，不向上泄漏 `reqwest::Error`、`sqlx::Error` 等。
- 可替换性：同一 Port 的不同实现（如 Windows / macOS 凭据库）对上层行为一致；平台能力不足时返回明确的 `Unsupported` 错误或执行降级，而不是 panic（架构文档 §53）。

## 4.5 Desktop Host（`src-tauri`）

- **Command 必须是薄层**：参数解析 → 调用 Application Service → 错误映射 → 返回 DTO。单个 Command 函数体建议不超过 20 行。
- `AppState { services, runtime }` 作为唯一 Tauri State；**禁止**注册零散的多个 State。
- 启动顺序严格遵循架构文档 §54；Migration 失败时不得启动业务 Runtime。
- 关闭流程遵循架构文档 §41；正常路径**禁止** `std::process::exit()`。

---

# 5. IPC Command 与 Event 规范

## 5.1 Command

- 命名：`snake_case`，`动词_名词`，表达 Use Case 而非数据操作：`get_today`、`complete_item`、`reorder_today`、`capture_input`。
- **禁止**通用能力型 Command：`execute_sql`、`read_file(path)`、`http_request`、`eval` 等（架构文档 §14）。
- 所有 Command 为 `async`，不阻塞 WebView 线程。
- 参数与返回值类型派生 `serde::{Serialize, Deserialize}` 与 `specta::Type`，字段使用 `#[serde(rename_all = "camelCase")]` 以符合前端习惯。
- 返回 `Result<T, IpcError>`，`IpcError` 结构统一为 `{ code, message, action }`。
- 新增 Command 必须同时：
  1. 在 `src-tauri/src/commands/` 中按 feature 分文件实现；
  2. 在 Builder 中注册；
  3. 写入对应窗口的 Capability 文件（最小权限：悬浮窗只开放其必需命令）；
  4. 执行 `pnpm gen:bindings` 并提交生成结果。

## 5.2 Event

- 命名：`snake_case`，过去式：`item_created`、`item_updated`、`today_reordered`、`day_changed`。
- Domain Event 不直接广播给前端；由 UI Event Mapper 选择并转换为 UI 需要的事件与载荷（架构文档 §38）。
- 事件载荷保持精简（ID + 必要的变更字段），禁止包含 Note 全文等大字段。
- 只向需要的窗口发送事件（`emit_to`），避免所有窗口都处理所有事件。

---

# 6. 错误处理

## 6.1 错误类型

- 每层定义自己的错误枚举（`thiserror`）：`DomainError`、`StorageError`、`CaptureError`、`WorkflowError`、`ScriptError`、`IntegrationError`、`PlatformError`；Application 统一为 `AppError`（架构文档 §43）。
- `AppError` 携带稳定错误码（`ITEM_NOT_FOUND`、`WORKFLOW_SCRIPT_TIMEOUT` 等），所有错误码登记在 `docs/development/error-codes.md`，前端以错误码为 i18n key。
- 可恢复错误携带 UI Action（如 `OPEN_INTEGRATION_SETTINGS`）。
- Workflow Step 错误按架构文档 §28 分类：Retryable / Fatal / PermissionDenied / UserActionRequired / Timeout / InvalidInput。

## 6.2 规则

- **禁止**在非测试代码中使用 `unwrap()`、`expect()`、`panic!()`、`unreachable!()`、数组越界索引，除非能证明不可能失败——此时必须使用 `expect("原因")` 并在上一行写注释说明为什么不可能失败。
- 使用 `?` 传播错误；跨层转换使用 `From` 实现或 `map_err`，并保留错误来源（`#[source]`）。
- **禁止**静默吞掉错误（`let _ = ...` 丢弃 `Result`）；确需忽略时必须注释原因并记录 `tracing::warn!`。
- 错误信息（`message`）面向开发者，用于日志；面向用户的文案由前端 i18n 提供。
- 错误信息中**禁止**包含 Token、完整文件内容、完整 URL 查询参数中的敏感值。

---

# 7. 异步与并发

- 运行时：Tokio 多线程运行时，由 `src-tauri` 创建并共享。
- 任务分类（架构文档 §39）：

  | 类型 | 处理方式 |
  |---|---|
  | 短 CPU 计算 | 直接在 async 中执行 |
  | 异步 IO（网络、SQLx） | `async` |
  | 阻塞 IO / 重计算（文件解析、大文件哈希） | `tokio::task::spawn_blocking` |
  | 脚本执行 | Script Worker 专用线程（`nivlo-script`） |
  | 平台线程绑定（COM、AppKit） | 平台 Adapter 内按平台要求调度到指定线程 |

- **禁止**在 async 上下文中调用阻塞 API（`std::fs`、`std::thread::sleep`、同步 HTTP）。
- **禁止**跨 `.await` 持有 `std::sync::Mutex` 锁；需要时使用 `tokio::sync::Mutex`，并优先考虑 Actor + Channel。
- 长生命周期组件（Scheduler、Script Worker）采用 Actor 模式：私有状态 + `mpsc` 消息 + Handle（架构文档 §40）。
- 所有 `tokio::spawn` 出的任务必须：可取消（`CancellationToken`）、有归属（Handle 被保存或加入 `JoinSet`）、错误被记录。禁止「发射后不管」的匿名任务。
- **禁止轮询**：等待时间点使用 `sleep_until`，等待状态变化使用 Channel / `Notify`。
- 超时：所有网络请求、Workflow 执行、脚本执行必须设置超时。

---

# 8. 数据库规范

## 8.1 连接与 Pragma

- 连接池大小 2~4；启用 `journal_mode=WAL`、`foreign_keys=ON`、`busy_timeout`（建议 5000ms）、`synchronous=NORMAL`。
- 数据库文件路径来自 `AppPaths`，禁止硬编码。

## 8.2 Migration

- 文件位于根目录 `migrations/`，命名：`NNNN_snake_case_description.sql`（四位递增序号），例如 `0002_item_source.sql`。
- **已合入主分支的 migration 禁止修改**；修正通过新的 migration 完成。
- 每个 migration 文件顶部用 SQL 注释说明：目的、对应实施计划子阶段、是否需要数据迁移。
- 涉及数据迁移的 migration 必须有集成测试：在旧 Schema 中插入数据 → 迁移 → 断言新 Schema 数据正确。

## 8.3 Schema 约定

| 项 | 约定 |
|---|---|
| 表名 | 复数 `snake_case`：`items`、`item_sources` |
| 主键 | `id TEXT PRIMARY KEY`（UUIDv7） |
| 外键 | `<entity>_id`，必须声明 `REFERENCES` 与 `ON DELETE` 行为 |
| 时间戳 | 按实施计划 D-03 / D-04 定稿的格式，全库统一 |
| 布尔 | `INTEGER NOT NULL CHECK (x IN (0, 1))` |
| 枚举 | `TEXT` + `CHECK` 约束 |
| 扩展字段 | Integration 专属数据放 `metadata_json TEXT`，不为单一集成新增列 |
| 索引 | 每个用于过滤 / 排序的高频查询必须有索引，并在 migration 注释中说明服务于哪个查询 |
| FTS | FTS5 + `trigram` tokenizer，Trigger 同步（实施计划 D-09） |

## 8.4 查询

- **禁止**字符串拼接 SQL（防注入）；所有参数使用绑定。
- 列表查询必须有上限（分页或 `LIMIT`）。
- CI 执行 `cargo sqlx prepare --check`，`.sqlx/` 离线查询元数据必须提交。

---

# 9. 日志、隐私与安全

## 9.1 日志

- 统一使用 `tracing`；关键 Use Case 与 Workflow 执行使用 `#[tracing::instrument(skip_all, fields(...))]` 建立 Span。
- 结构化字段：`event`、`run_id`、`workflow_id`、`item_id`、`duration_ms`、`error_code`（架构文档 §42）。
- 级别：`error`（需要关注的失败）、`warn`（可恢复异常 / 降级）、`info`（生命周期与关键业务事件）、`debug`（开发诊断）、`trace`（高频细节，默认关闭）。
- **禁止**在日志中出现：Token、Cookie、Authorization Header、完整剪贴板、Note 全文、用户文件内容、完整 Item 标题（需要时只记录 ID 或截断后的摘要）。`instrument` 必须使用 `skip_all` 再显式列出安全字段。

## 9.2 Secret

- 凭据类数据一律使用 `nivlo_common::Secret<T>` 包装，其 `Debug` / `Display` 输出 `***`，且不实现 `Serialize`。
- 凭据只存放于 OS 凭据库（`CredentialPort`），**禁止**写入 SQLite、配置文件、日志、导出文件（架构文档 §35）。
- 凭据只能被 Integration Adapter 读取，不得通过 IPC 返回前端，不得暴露给脚本。

## 9.3 权限分层

```text
Tauri Capability → Application Permission → Workflow Permission → Script Capability
```

- 每一层都必须执行检查，不能假设上一层已经检查过。
- 网络访问统一经过 `HttpPort`：Host 白名单、重定向后重新检查、默认拒绝 localhost / 私有 IP / `file://`。
- MVP **不提供** Shell 能力（ADR-010）。

## 9.4 unsafe

- 只允许出现在 `nivlo-platform-*` 与 `nivlo-script` 的 FFI 边界；其他 crate 使用 `#![forbid(unsafe_code)]`。
- 每个 `unsafe` 块前**必须**有 `// SAFETY:` 注释说明为什么是安全的；每个 `unsafe fn` 的文档注释**必须**有 `# Safety` 小节说明调用者需要保证的条件。

---

# 10. 平台代码规范

- 平台能力通过 `nivlo-platform` 中的细粒度 Port 暴露（`FloatingWindowPort`、`DropPort`、`ClipboardPort`、`CredentialPort`、`NotificationPort`、`ShortcutPort`、`AutostartPort`、`OpenPort`），**禁止**定义包含大量方法的 God Trait。
- 优先使用 Tauri 提供的能力；只有 Tauri 无法满足（No-Activate、特殊 HitTest、原生 Drop 等）时才进入 `nivlo-platform-windows` 等平台 crate。
- 平台 Adapter 必须提供能力检测，并在能力不足时降级（如高级非激活悬浮窗不可用 → 普通置顶窗口）。
- COM / Win32 调用必须遵守线程模型要求（STA / 消息循环），相关代码必须写行内注释说明线程约束。

---

# 11. 命名约定

| 对象 | 规则 | 示例 |
|---|---|---|
| crate | `nivlo-<领域>` | `nivlo-scheduler` |
| 模块、文件、函数、变量 | `snake_case` | `reorder_today` |
| 类型、trait、枚举变体 | `UpperCamelCase` | `WorkflowStepExecutor` |
| 常量 | `SCREAMING_SNAKE_CASE`，带单位后缀 | `DEFAULT_SCRIPT_TIMEOUT_MS` |
| Port trait | `<能力>Port` 或 `<实体>Repository` | `ClipboardPort`、`ItemRepository` |
| Port 实现 | `<技术><能力>` | `SqliteItemRepository`、`WindowsCredentialStore`、`ReqwestHttpClient` |
| Use Case 输入 / 输出 | `<动作>Input` / `<视图>View` | `CreateItemInput`、`TodayView` |
| 错误 | `<层>Error` | `StorageError` |
| 测试函数 | 描述行为的 `snake_case` | `completing_tip_returns_error` |

时间相关变量必须体现语义：`*_at`（时间点，UTC）、`*_date`（本地日期）、`*_ms` / `Duration`（时长）。

---

# 12. 测试规范

| 类型 | 位置 | 要求 |
|---|---|---|
| Domain 单元测试 | 同文件 `#[cfg(test)] mod tests` | 覆盖所有业务规则与状态转移：Todo 完成、Tip 规则、Schedule 规则、Matcher、Permission、日期逻辑 |
| Application 测试 | `crates/nivlo-application/tests/` | 使用 Fake Repository / FakeClock 测试完整 Use Case，例如 Capture → Workflow → Create Item |
| Storage 集成测试 | `crates/nivlo-storage/tests/` | 使用 `tempfile` 临时数据库：Migration、CRUD、事务回滚、FTS、排序 |
| Workflow Fixture 测试 | `crates/nivlo-workflow/tests/` + `fixtures/` | Jira、GitHub、网页元数据等使用录制数据，不访问真实网络 |
| Script 测试 | `crates/nivlo-script/tests/` | 正常、超时、内存超限、异常、越权、非法返回值 |
| HTTP 测试 | 使用 `wiremock` | 禁止测试访问真实外部服务 |

要求：

- 所有涉及「当前时间」的逻辑通过 `Clock` 注入并使用 `FakeClock` 测试；涉及定时的异步逻辑使用 `tokio::time::pause()`。
- 测试之间相互独立，不依赖执行顺序，不共享数据库文件。
- Domain 与 Workflow Matcher 测试覆盖率目标 ≥ 90%；新增 Use Case 必须有 Application 测试。
- 修复缺陷时先补一个能复现缺陷的测试。

---

# 13. 性能规范

- Idle CPU 接近 0：禁止每秒级轮询、禁止后台无意义 Timer（架构文档 §46）。
- Hover 相关命令不得访问数据库（前端使用事件驱动缓存）。
- 本地 Capture 从命令进入到返回 < 100ms；本地 DB 查询毫秒级。
- 所有有界资源必须有上限：Workflow Run 记录、日志文件、缓存目录、事件 Channel 容量、HTTP 响应体大小、脚本内存。
- 热点查询变更时在 PR 中附 `EXPLAIN QUERY PLAN` 结果。

---

# 14. 代码质量与 Lint

- `cargo fmt`：使用仓库 `rustfmt.toml`。
- `cargo clippy --workspace --all-targets -- -D warnings`：CI 中警告即失败。
- Workspace 级 Lint（根 `Cargo.toml` 的 `[workspace.lints]`，各 crate `lints.workspace = true`）：

  ```toml
  [workspace.lints.rust]
  missing_docs = "warn"
  unsafe_code = "deny"            # 平台 / 脚本 crate 中按需单独放开为 "allow" 并配合 SAFETY 注释

  [workspace.lints.clippy]
  unwrap_used = "warn"
  expect_used = "warn"
  panic = "warn"
  missing_errors_doc = "warn"
  missing_panics_doc = "warn"
  undocumented_unsafe_blocks = "warn"
  missing_docs_in_private_items = "warn"
  todo = "warn"
  dbg_macro = "warn"
  print_stdout = "warn"
  ```

  测试代码中可通过 `#[cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used))]` 放开。
- `cargo deny check`：License 与安全公告。
- **禁止**在 crate 根部整体 `#![allow(...)]` 关闭上述规则；局部 `#[allow]` 必须附注释说明原因。

---

# 15. 注释规范（强制）

注释的目的：让后续开发者（包括 Code Agent）**不读实现就能正确调用一个函数**，并且**读到复杂代码时能理解为什么这样写**。

## 15.1 注释语言

- 注释统一使用**简体中文**；类型名、API 名、专有名词（Today Stack、Capture、Workflow、Port 等）保留英文原文。
- 标识符一律使用英文。

## 15.2 函数注释（必须）

以下每一项**都必须**有 rustdoc（`///`）注释：

- **所有函数与方法，包括私有函数**（由 `clippy::missing_docs_in_private_items` 与 `missing_docs` 检查）。
- 所有结构体、枚举、trait、类型别名、常量、静态项。
- 公共结构体的每个字段、枚举的每个变体。
- 所有 Tauri Command。

豁免：`#[cfg(test)]` 中的测试函数（以描述行为的函数名替代注释）、自动派生的代码、闭包。

函数注释结构：

| 部分 | 要求 |
|---|---|
| 摘要（第一行） | 一句话说明「做什么」，以动词开头 |
| 详细说明 | 复杂函数必须写：行为细节、前置条件、副作用（写数据库、发事件、启动任务、调用网络）、事务语义、性能特征 |
| `# Arguments`（可选） | 参数含义不能从名称和类型直接看出时说明，包括单位与取值范围 |
| `# Returns`（可选） | 返回值有特殊含义时说明（如 `None` 代表什么） |
| `# Errors` | 返回 `Result` 的函数**必须**写，列出每种错误及触发条件 |
| `# Panics` | 可能 panic 的函数**必须**写 |
| `# Safety` | `unsafe fn` **必须**写 |
| `# Examples` | 公共 API（跨 crate 使用）建议提供，并作为 doctest 运行 |
| 文档引用 | 涉及设计决策时引用对应章节：`参见架构文档 §37` |

### 示例：Use Case

```rust
/// 将指定日期的 Today 顺序重排为 `ordered_ids` 给出的顺序。
///
/// Today Order 独立于 priority / created_at / due（产品文档 §5.3），
/// 只影响 Today Stack 的展示与执行顺序。
///
/// 在单个事务中整体替换该日期的 `daily_item_order` 记录；
/// 提交成功后发布 [`DomainEvent::TodayReordered`]。
/// `ordered_ids` 中不属于该日 Today 的 Item 会被忽略，
/// 该日 Today 中存在但未出现在 `ordered_ids` 里的 Item 会追加到末尾，
/// 以避免前端缓存过期时丢失新创建的 Item。
///
/// # Arguments
///
/// * `date` - 用户本地日期。
/// * `ordered_ids` - 前端拖拽后的完整顺序。
///
/// # Errors
///
/// * [`AppError::Storage`] - 数据库读写失败，事务已回滚。
/// * [`AppError::InvalidInput`] - `ordered_ids` 中存在重复 ID。
pub async fn reorder_today(
    &self,
    date: LocalDate,
    ordered_ids: Vec<ItemId>,
) -> Result<(), AppError> {
    // ...
}
```

### 示例：Port

```rust
/// 操作系统凭据库的抽象。
///
/// Windows 使用 Credential Manager，macOS 使用 Keychain，
/// Linux 使用 Secret Service。只允许 Integration Adapter 持有此 Port，
/// 凭据不得通过 IPC 或脚本暴露（架构文档 §35、§44）。
#[async_trait]
pub trait CredentialPort: Send + Sync {
    /// 读取凭据。
    ///
    /// # Returns
    ///
    /// 不存在时返回 `Ok(None)`，而不是错误。
    ///
    /// # Errors
    ///
    /// 凭据库不可用或访问被系统拒绝时返回 [`PlatformError`]。
    async fn get(&self, key: &CredentialKey) -> Result<Option<Secret<String>>, PlatformError>;
    // ...
}
```

### 示例：私有函数

```rust
/// 计算下一个需要唤醒的触发时间点；没有待触发项时返回 `None`。
fn next_trigger_at(pending: &[Trigger], now: DateTime<Utc>) -> Option<DateTime<Utc>> {
    // ...
}
```

## 15.3 模块与 crate 注释

- 每个 crate 的 `lib.rs` 顶部使用 `//!` 说明：crate 职责、主要导出、**禁止依赖的 crate**（摘自本规范 §3.1）。
- 每个包含非平凡逻辑的模块文件顶部使用 `//!` 说明模块职责与关键设计决策。

```rust
//! Scheduler Actor。
//!
//! 维护最近一个触发时间点并 `sleep_until`，不做轮询（架构文档 §37）。
//! 外部通过 [`SchedulerHandle`] 发送 `Reload` / `ScheduleChanged` / `Resume` / `Shutdown`。
//! 启动、系统唤醒、时钟变化时执行 Reconcile，补发错过的提醒。
```

## 15.4 行内注释（复杂逻辑必须）

以下情况**必须**写行内注释（`//`），注释说明**为什么**，而不是复述代码：

1. **事务与一致性**：事务的范围、为什么某些操作必须在同一事务中、事件为什么在提交后发布。
2. **并发与异步**：锁的范围、为什么使用某种 Channel、取消点、`select!` 各分支的优先级、可能的竞态及其处理方式。
3. **调度与时间**：时区换算、休眠 / 时钟回拨的处理、触发去重逻辑。
4. **Workflow 执行**：短路、降级链（API → Page Metadata → URL）、错误分类的依据。
5. **安全检查**：权限判断、Host 白名单、重定向检查、为什么某个能力不暴露给脚本——使用 `// SECURITY:` 前缀。
6. **复杂 SQL**：在 SQL 字符串上方说明查询目的、用到的索引、特殊条件的业务含义。
7. **平台 / FFI 代码**：线程模型、资源释放责任、Win32 / COM 调用的非直观要求；每个 `unsafe` 块前写 `// SAFETY:`。
8. **正则与解析逻辑**：说明匹配目标，并给出匹配与不匹配示例。
9. **魔法数字**：无法提取为命名常量时说明取值依据。
10. **Workaround**：写明问题现象、影响平台 / 版本、Issue 链接、移除条件。
11. **`expect` / 忽略错误**：说明为什么不可能失败或为什么可以忽略。

### 示例

```rust
let mut tx = self.uow.begin().await?;
// Item、Source、Tag 必须在同一事务中写入：任何一步失败都不能留下没有 Source 的
// 半成品 Item（架构文档 §56）。
let item = tx.items().insert(&new_item).await?;
tx.sources().insert(item.id(), &source).await?;
tx.tags().attach(item.id(), &tags).await?;
tx.commit().await?;
// 只有提交成功后才发布事件，避免前端收到一个随后被回滚的 Item。
self.events.publish(DomainEvent::ItemCreated(item.id()));

tokio::select! {
    // biased：优先处理控制消息，保证 Shutdown 不会被一个即将到期的触发拖延。
    biased;
    Some(msg) = self.rx.recv() => self.handle(msg).await,
    _ = sleep_until(next) => self.fire_due(now).await,
}

// SECURITY: 重定向后的 Host 必须重新检查白名单，否则允许的 Host 可以通过 302
// 把请求转发到内网地址（架构文档 §44）。
if !permissions.network_allows(redirect_url.host_str()) { ... }

// SAFETY: `hdrop` 来自本次 Drop 回调中的 STGMEDIUM，在 ReleaseStgMedium 之前一直有效；
// DragQueryFileW 只读取不修改该句柄。
let count = unsafe { DragQueryFileW(hdrop, u32::MAX, None) };
```

## 15.5 特殊标记

| 标记 | 格式 | 要求 |
|---|---|---|
| 待办 | `// TODO(P4.5): 说明` | 必须关联实施计划子阶段编号或 Issue；禁止无归属的 TODO |
| 已知问题 | `// FIXME(P4.5): 说明` | 同上 |
| 兼容处理 | `// WORKAROUND(<平台或组件>): 说明` | 见 15.4 第 10 条 |
| 安全相关 | `// SECURITY: 说明` | 见 15.4 第 5 条 |
| unsafe | `// SAFETY: 说明` | 每个 `unsafe` 块前必须有 |

## 15.6 禁止事项与检查方式

**禁止**：

- 提交被注释掉的代码。
- 与代码不一致的过期注释——修改代码必须同步修改注释，Code Review 中视为缺陷。
- 复述代码的无效注释。
- 在注释或 doctest 中写入真实 Token、真实用户数据。

**检查方式**：

- 自动：`missing_docs`、`clippy::missing_docs_in_private_items`、`clippy::missing_errors_doc`、`clippy::missing_panics_doc`、`clippy::undocumented_unsafe_blocks`（§14）；`cargo doc --workspace --no-deps` 必须无警告（CI 中设置 `RUSTDOCFLAGS="-D warnings"`）。
- 人工：行内注释的必要性与质量由 Code Review 按 §15.4 判定。

---

# 16. Workflow 定义文件规范

- 内置 Workflow 位于 `workflows/builtin/<id>.workflow.json`，必须通过 `workflows/schema/workflow.schema.json` 校验（CI 检查）。
- 每个定义必须包含 `id`、`version`（SemVer）、`schema_version`、`name`、`description`、`permissions`（最小权限）。
- 修改内置 Workflow 行为必须提升 `version`，并在 `fixtures/workflow/` 中补充或更新测试用例。
- JSON 不支持注释：每个内置 Workflow 的设计说明写在其 `description` 字段，复杂的匹配 / 映射逻辑在 `workflows/builtin/README.md` 中逐个说明。

---

# 17. PR 自检清单

- [ ] `cargo fmt --check`、`cargo clippy -- -D warnings`、`cargo test --workspace`、`cargo sqlx prepare --check`、`scripts/check-deps`、`cargo doc`（无警告）全部通过。
- [ ] 所有函数（含私有）、类型、Command 均有符合 §15.2 的文档注释；返回 `Result` 的函数有 `# Errors`。
- [ ] 复杂逻辑有 §15.4 要求的行内注释；每个 `unsafe` 块有 `// SAFETY:`。
- [ ] 没有在 Domain / Application 中引入禁止的依赖；没有业务逻辑写在 `src-tauri`。
- [ ] 非测试代码无 `unwrap()` / 无理由 `expect()`；没有静默丢弃的 `Result`。
- [ ] Schema 变更通过新增 migration 完成，且有对应测试。
- [ ] 新增 Command 已注册、已写入 Capability（最小权限）、已重新生成 TS Binding。
- [ ] 新增错误码已登记到 `error-codes.md`。
- [ ] 日志与错误信息不包含 Secret、全文内容。
- [ ] 新增后台任务可取消、有归属，没有引入轮询。
- [ ] 实施计划中对应子阶段的状态已更新。

---

# 18. 变更记录

| 日期 | 版本 | 说明 |
|---|---|---|
| 2026-10-09 | v1.0 | 初版 |
