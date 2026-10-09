# Nivlo · 拾序 技术架构设计

> Status: Draft v1  
> Target: Nivlo Desktop MVP → V1/V2 可持续演进  
> Primary Platform: Windows  
> Cross-platform Target: Windows / macOS / Linux  
> Architecture Principle: **Tauri 是宿主，不是核心；能力与实现分离；核心业务不依赖 UI 框架与具体平台。**

---

# 1. 文档目标

本文档用于定义 Nivlo · 拾序的桌面端总体技术架构，并作为后续仓库初始化、模块划分、Code Agent 开发、技术评审、跨平台适配、Workflow Runtime 演进、性能与安全治理的主要技术依据。

本文档重点解决：

1. Tauri 2、React 与 Rust 的职责边界。
2. Nivlo Core 如何保持独立。
3. 悬浮窗与主窗口如何组织。
4. Capture 如何统一手动输入、拖拽、粘贴等来源。
5. Workflow Engine 如何设计。
6. JavaScript 脚本如何安全执行。
7. SQLite 如何作为 Local-First 数据源。
8. Scheduler 如何保证提醒可靠性。
9. 如何隔离 Windows / macOS / Linux 平台差异。
10. 如何为未来 Workflow Marketplace、AI、插件系统留出扩展空间。

---

# 2. 技术目标

Nivlo 是一个长期常驻的桌面应用，因此技术目标与普通“大窗口应用”不同。

## 2.1 轻量常驻

理想状态：

```text
系统启动
   ↓
Nivlo 启动
   ↓
悬浮窗常驻
   ↓
大部分时间处于 Idle
```

要求：

- Idle CPU 接近 0。
- 不做无意义轮询。
- 不让主窗口长期保持高成本渲染。
- Hover 展开不触发重型数据库查询。
- 网络任务全部异步。
- Workflow 运行不得阻塞 UI。

## 2.2 快速响应

关键体验：

```text
Hover Floating
→ 立即展示 Today

Quick Add
→ Enter 即完成

Drop
→ 快速进入 Capture Pipeline
```

## 2.3 Local First

核心数据默认保存在本机：

- Todo
- Note
- Tip
- Workflow
- Source
- Project
- Tag
- Schedule
- Workflow Run

云同步不是 MVP 前置条件。

## 2.4 可编程但受控

Workflow 可以：

- 匹配输入
- 解析内容
- 发 HTTP 请求
- 执行 JS
- 创建 Item
- 调用 Integration

但必须受 Capability、Permission、Timeout、Memory Limit、Domain Allowlist 约束。

## 2.5 跨平台但不强求实现完全统一

架构从第一天支持：

```text
Windows
macOS
Linux
```

但 MVP 实现优先级：

```text
Windows
↓
macOS
↓
Linux
```

Core 与 Platform API 从第一天解耦。

---

# 3. 最终技术选型

## 3.1 Desktop Host

**Tauri 2**

职责：

- 应用生命周期
- WebView Host
- Window
- Tray
- Global Shortcut
- Autostart
- Updater
- Single Instance
- Command / Event Bridge
- Capability / Permission Boundary

不承担：

- 核心业务模型
- Workflow 规则
- SQL 业务逻辑
- Jira 领域逻辑
- Scheduler 领域逻辑

## 3.2 Frontend

```text
React
TypeScript
Vite
```

推荐附加：

```text
Tailwind CSS
Zustand
TanStack Query
dnd-kit
date-fns
CodeMirror 6
```

后期可选：

```text
TipTap / ProseMirror
React Flow
```

但 MVP 不建议直接引入复杂 Block Editor 或 Workflow DAG UI。

## 3.3 Backend / Core

```text
Rust
Tokio
Serde
thiserror
tracing
reqwest
```

核心业务全部由 Rust 负责。

## 3.4 Storage

```text
SQLite
SQLx
SQLite FTS5
```

原则：

```text
SQLite
=
Domain State Source of Truth
```

React State 不能替代数据库。

## 3.5 Script Runtime

```text
QuickJS
rquickjs
```

用途：

```text
Workflow Script Step
```

不是：

```text
整个 Workflow Engine
```

## 3.6 Platform Native

Windows：

```text
windows-rs
Win32 / COM
```

macOS：

```text
AppKit Adapter
```

Linux：

```text
Tauri / GTK / X11 / Wayland Adapter
```

只在 Tauri 默认能力无法满足需求时使用平台 API。

---

# 4. 总体架构

```text
                         Nivlo · 拾序

┌──────────────────────────────────────────────────────────────┐
│                         UI Layer                             │
│                                                              │
│ React + TypeScript                                           │
│                                                              │
│ Floating / Today / Calendar / Inbox / Note / Workflow        │
└─────────────────────────────┬────────────────────────────────┘
                              │
                       Typed Tauri IPC
                              │
┌─────────────────────────────▼────────────────────────────────┐
│                   Desktop Host Layer                         │
│                                                              │
│ Tauri Window / Lifecycle / Tray / Events / Capability        │
└─────────────────────────────┬────────────────────────────────┘
                              │
┌─────────────────────────────▼────────────────────────────────┐
│                    Application Layer                         │
│                                                              │
│ Use Cases / Services / Transaction Boundary / Event Dispatch │
└─────────────────────────────┬────────────────────────────────┘
                              │
┌─────────────────────────────▼────────────────────────────────┐
│                       Domain Layer                           │
│                                                              │
│ Item / Capture / Workflow / Schedule / Source / Project      │
└──────────┬────────────┬─────────────┬──────────────┬─────────┘
           │            │             │              │
           ▼            ▼             ▼              ▼
       Storage        Script      Integration      Platform
           │            │             │              │
        SQLite       QuickJS       Jira/GitHub       │
                                                      │
                                    ┌─────────────────┼──────────────┐
                                    ▼                 ▼              ▼
                                 Windows            macOS          Linux
```

依赖方向必须始终：

```text
UI
↓
Desktop Host
↓
Application
↓
Domain

Adapters
→ 实现 Domain/Application 定义的 Port
```

禁止反向依赖：

```text
Domain → Tauri
Domain → SQLite
Domain → WebView
```

---

# 5. 架构风格

采用：

> **轻量 Hexagonal Architecture / Ports & Adapters**

不是为了追求复杂 Clean Architecture，而是解决 Nivlo 最核心的问题：同一个能力需要存在多种实现。

例如：

```text
CredentialStore

Windows → Credential Manager
macOS   → Keychain
Linux   → Secret Service
```

Core 只看到抽象接口，不知道操作系统。

---

# 6. Repository / Workspace 结构

推荐：

```text
nivlo/
│
├── Cargo.toml
├── Cargo.lock
├── package.json
├── pnpm-workspace.yaml
├── rust-toolchain.toml
│
├── apps/
│   └── desktop/
│       │
│       ├── src-tauri/
│       │   ├── Cargo.toml
│       │   ├── build.rs
│       │   ├── tauri.conf.json
│       │   │
│       │   ├── capabilities/
│       │   │   ├── main.json
│       │   │   └── floating.json
│       │   │
│       │   └── src/
│       │       ├── main.rs
│       │       ├── app.rs
│       │       ├── commands/
│       │       ├── events/
│       │       ├── windows/
│       │       └── lifecycle/
│       │
│       └── ui/
│           ├── package.json
│           ├── vite.config.ts
│           └── src/
│               ├── app/
│               ├── features/
│               ├── components/
│               ├── bindings/
│               ├── stores/
│               ├── hooks/
│               ├── lib/
│               └── styles/
│
├── crates/
│   ├── nivlo-domain/
│   ├── nivlo-application/
│   ├── nivlo-storage/
│   ├── nivlo-capture/
│   ├── nivlo-workflow/
│   ├── nivlo-script/
│   ├── nivlo-scheduler/
│   ├── nivlo-integrations/
│   ├── nivlo-platform/
│   ├── nivlo-platform-windows/
│   ├── nivlo-platform-macos/
│   ├── nivlo-platform-linux/
│   └── nivlo-common/
│
├── migrations/
├── workflows/
│   └── builtin/
├── fixtures/
│   ├── jira/
│   ├── github/
│   └── workflow/
├── scripts/
└── docs/
    ├── architecture/
    ├── adr/
    └── development/
```

---

# 7. Crate 职责

## 7.1 `nivlo-domain`

纯领域模型。

包含：

```text
Item / Todo / Note / Tip
Source / Attachment
Project / Tag
Schedule / Reminder
Workflow / WorkflowStep / WorkflowRun
CaptureInput
Domain Event
Value Object
Domain Error
```

禁止依赖：

```text
Tauri
SQLx
Reqwest
Windows API
WebView
React
```

## 7.2 `nivlo-application`

应用层 Use Case：

```text
CreateItem
UpdateItem
CompleteItem
ScheduleItem
ReorderToday
Capture
ExecuteWorkflow
CreateWorkflow
EnableWorkflow
DisableWorkflow
SearchItems
ConfigureIntegration
```

负责业务编排、Repository 协调、Transaction Boundary、Domain Event 发送、权限调用入口。

## 7.3 `nivlo-storage`

负责：

```text
SQLite
SQLx
Migration
Repository Implementation
FTS
Transaction
```

## 7.4 `nivlo-capture`

负责：

```text
CaptureInput Normalization
Source Detection
Mime Detection
URL Parsing
File Metadata
Drop Decode
Paste Normalize
```

核心职责：将各种外部输入统一成标准 `CaptureInput`。

## 7.5 `nivlo-workflow`

负责：

```text
Matcher
Workflow Resolver
Workflow Runtime
Workflow Step Executor
Execution Context
Run Logging
Permission Request
Error Propagation
```

## 7.6 `nivlo-script`

负责：

```text
QuickJS Runtime
Script Context Bridge
Script Limits
Script Permission Bridge
JS ↔ Rust Conversion
```

未来可切换为 Out-of-process Script Worker，而不影响 Workflow Engine。

## 7.7 `nivlo-scheduler`

负责：

```text
Reminder
Tip Trigger
Due Trigger
Daily Rollover
Resume Reconciliation
```

## 7.8 `nivlo-integrations`

结构：

```text
jira/
github/
web/
```

负责外部系统协议、Authentication、REST API、DTO 与 Mapping。

## 7.9 `nivlo-platform`

只定义跨平台 Port：

```rust
trait WindowPort;
trait DropPort;
trait ClipboardPort;
trait CredentialPort;
trait NotificationPort;
trait ShortcutPort;
trait AutostartPort;
trait OpenPort;
```

不要定义一个拥有几十个方法的 God Trait。

---

# 8. Domain Model

## 8.1 Item

统一模型：

```rust
pub enum ItemType {
    Todo,
    Note,
    Tip,
}
```

建议：

```rust
pub struct Item {
    pub id: ItemId,
    pub item_type: ItemType,
    pub title: String,
    pub content: Option<String>,
    pub content_format: ContentFormat,
    pub status: ItemStatus,
    pub priority: Priority,
    pub scheduled: Option<DatePoint>, // 本地日期 + 可选本地时间（实施计划 D-03）
    pub due: Option<DatePoint>,
    pub reminder_at: Option<DateTime<Utc>>, // 唯一的绝对时间点
    pub project_id: Option<ProjectId>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub completed_at: Option<DateTime<Utc>>,
    pub archived_at: Option<DateTime<Utc>>,
}
```

语义：

```text
Todo = 我要做
Note = 我要记住
Tip  = 某个时间我要知道
```

Tip 不强行具有 done / undone 语义。

---

# 9. Capture Input Model

所有入口最终统一成：

```rust
pub enum CaptureInput {
    Text(TextCapture),
    Url(UrlCapture),
    File(FileCapture),
    Files(Vec<FileCapture>),
    Image(ImageCapture),
}
```

入口：

```text
Manual
Drop
Paste
Quick Add
Browser
Integration
```

最终：

```text
Input Source
   ↓
Normalizer
   ↓
CaptureInput
   ↓
Workflow Matcher
```

建议明确 `CaptureSource != CaptureInput`。例如来源是 `DragFromChrome`，输入类型是 `Url`。

---

# 10. Window Architecture

MVP 只创建两个长期窗口：

```text
floating
main
```

避免大量 Browser/WebView Window。

## 10.1 Floating Window

状态：

```text
Collapsed
Expanded
QuickCreate
DragHover
```

状态机：

```text
                Mouse Enter
Collapsed ─────────────────────→ Expanded
    ▲                               │
    │                               │
    └────── Leave Delay ────────────┘

Expanded ─── Quick Add ───→ QuickCreate

Collapsed/Expanded
       │
       └── Drag Enter ───→ DragHover
```

优先采用：

```text
一个窗口 + 动态 resize
```

而不是悬浮球窗口 + Today Popup + Quick Add Popup。

## 10.2 UI 与 Window Behavior 分离

React：

```text
Todo
Tip
Animation
Quick Create
Reorder
```

Rust/Tauri：

```text
Position
Size
Always-on-top
Focusable
Monitor
Snap
Native Drag
```

## 10.3 Window Port

```rust
pub trait FloatingWindowPort {
    fn collapse(&self) -> Result<()>;
    fn expand(&self, bounds: FloatingBounds) -> Result<()>;
    fn set_focusable(&self, enabled: bool) -> Result<()>;
    fn set_always_on_top(&self, enabled: bool) -> Result<()>;
    fn move_to(&self, position: ScreenPosition) -> Result<()>;
    fn current_monitor(&self) -> Result<MonitorInfo>;
}
```

优先使用 Tauri 实现；只有 `No Activate`、特殊 HitTest、特殊 Window Level、高级 Drag Target 等能力不足时才进入平台 Adapter。

---

# 11. Multi-monitor 与 DPI

悬浮窗口必须从第一阶段考虑：

```text
多个显示器
不同 DPI
不同 Scaling
显示器热插拔
```

保存位置时不要只保存绝对像素。建议保存：

```text
monitor_id
edge
offset_ratio / logical_position
```

例如：

```json
{
  "monitor": "DISPLAY2",
  "edge": "right",
  "offset": 0.42
}
```

Monitor 消失时回退到 Primary Monitor。

---

# 12. Hover 性能

Hover 本身禁止发生：

```text
SQLite Query
Network
Workflow
Heavy IPC
```

正确方式：

```text
Rust state changed
   ↓
item_updated event
   ↓
Floating UI 更新 Today Cache
```

然后 Hover 只做 React/CSS 展开。

目标：

> Hover 视觉响应不依赖数据库。

---

# 13. Tauri Capability Boundary

Capability 按窗口分。

`floating` 只允许：

```text
get_today
quick_create
complete_item
reorder_today
capture
open_main
reschedule_item
undo
get_inbox_count
```

其中 `reschedule_item`、`undo`、`get_inbox_count` 来自实施计划 D-12：产品文档 §22 要求在悬浮面板内直接推迟、撤销，并显示 Inbox 数量。

禁止：

```text
credential write
workflow install
raw file access
integration config
updater install
```

`main` 才拥有更高权限。

原则：前端窗口只拥有其功能真正需要的 IPC 能力。

---

# 14. IPC 设计

IPC 不是 Repository API。

禁止：

```text
execute_sql
read_database
http_request
read_file(path)
```

应该提供 Use Case API：

```text
get_today
create_item
update_item
complete_item
reorder_today
capture_input
get_calendar
search_items
list_workflows
execute_workflow
```

Command：UI → Rust。  
Event：Rust → UI。

Rust DTO 是单一来源，建议使用 typed binding generator，例如 Specta / tauri-specta；如果未来工具维护状态发生变化，可替换生成器，但架构不依赖具体工具。

---

# 15. UI State 与 Domain State

UI 本地状态：

```text
hover
selectedDate
modal
dragState
calendarView
searchPanel
```

使用 Zustand。

Domain Query：

```text
Today
Calendar
Workflow
Search
```

可使用 TanStack Query 做查询缓存和 optimistic update，但 Source of Truth 始终是 SQLite。

例如 Todo Complete：

```text
Click Complete
↓
UI 立即变更
↓
invoke complete_item
↓
成功 → 保留
失败 → rollback + toast
```

---

# 16. Drag & Drop 架构

拖拽分两层：

```text
WebView Standard Drop
+
Native Platform Drop
```

MVP 优先使用 Tauri/WebView 支持 File / Text / URL，但从第一天定义：

```rust
pub trait DropPort {
    async fn decode(
        &self,
        data: RawDropData,
    ) -> Result<Vec<CaptureInput>>;
}
```

Windows 后续需要支持：

```text
IDataObject
IDropTarget
CF_HDROP
CF_UNICODETEXT
CFSTR_INETURL
```

用于处理 Explorer、Browser、Office、特殊 Win32 程序。

当标准 WebView Drop 无法完整获取数据时，由 Native Drop Adapter 补齐。

---

# 17. Clipboard

Clipboard 不做全局持续监听作为 MVP 默认行为。

第一阶段只在 Quick Capture Paste、用户明确 Paste 时读取。

未来如果支持 Clipboard Watch，必须显式 opt-in。

---

# 18. Workflow Architecture

Workflow 是 Nivlo 的核心资产。

```text
CaptureInput
     │
     ▼
Workflow Resolver
     │
     ▼
Matcher
     │
     ▼
Execution Plan
     │
     ▼
Workflow Engine
     │
     ▼
Execution Context
     │
     ▼
Step Executors
     │
     ▼
Workflow Output
```

## 18.1 Workflow V1

第一版不做 DAG。

```rust
pub struct Workflow {
    pub id: WorkflowId,
    pub name: String,
    pub description: Option<String>,
    pub enabled: bool,
    pub matcher: WorkflowMatcher,
    pub steps: Vec<WorkflowStep>,
    pub permissions: WorkflowPermissions,
    pub source: WorkflowSource,
    pub version: String,
}
```

V1 使用 Linear Pipeline：

```text
Step 1
↓
Step 2
↓
Step 3
```

典型 Jira：

```text
Match URL
↓
Extract Jira Key
↓
Fetch Jira
↓
Transform
↓
Create Todo
```

DAG 会立即引入 Branch、Merge、Parallel、Loop、Retry Graph、Graph Validation、Visual Node Editor、Execution Graph State，不适合作为 MVP 前置能力。

---

# 19. Workflow Step

建议：

```rust
pub enum WorkflowStep {
    Extract(ExtractStep),
    Http(HttpStep),
    Regex(RegexStep),
    JsonPath(JsonPathStep),
    Transform(TransformStep),
    Condition(ConditionStep),
    Script(ScriptStep),
    Integration(IntegrationStep),
    CreateItem(CreateItemStep),
    Notification(NotificationStep),
}
```

未来增加 AI / OCR / File Parser / Webhook。

Step 使用 Executor Registry：

```rust
#[async_trait]
pub trait WorkflowStepExecutor: Send + Sync {
    async fn execute(
        &self,
        ctx: &mut WorkflowContext,
        step: &WorkflowStep,
    ) -> Result<StepResult, WorkflowError>;
}
```

不要把所有 Step 写进一个巨大 match。

---

# 20. Workflow Context

```rust
pub struct WorkflowContext {
    pub run_id: WorkflowRunId,
    pub input: CaptureInput,
    pub origin: CaptureOrigin,
    pub vars: serde_json::Value,
    pub metadata: Metadata,
    pub outputs: Vec<StepOutput>,
    pub permissions: EffectivePermissions,
}
```

每个 Step 从 Context 读取数据，再将结果写回 Context。

---

# 21. Workflow Resolver 与 Matcher

多个 Workflow 可能匹配同一个输入，例如 Generic Web、Official Jira、Company Jira。

优先级建议：

```text
Specificity
+
Explicit Priority
```

例如：

```text
Company Jira   priority 100
Official Jira  priority 80
Generic Web    priority 0
```

Matcher 支持：

```text
input.type
url.scheme
url.host
url.path
url.query
file.name
file.extension
file.mime
file.path
text.contains
text.regex
source.application
```

Matcher 初期使用声明式结构，不要求用户写 JS 才能匹配。

---

# 22. Built-in Workflow

MVP 内置：

```text
Generic Web Page
Jira Issue
GitHub Issue
GitHub PR
PDF
Word
Markdown
Image
Generic File
```

用户可以 Duplicate → Customize，不允许直接修改内置 Workflow 本体。

Workflow Source 区分：

```text
Builtin
User
Imported
Marketplace
```

---

# 23. JavaScript Runtime

JS 仅作为 Script Step，不承担 Workflow scheduling、Permission system、Repository、Integration lifecycle。

推荐模型：

```text
Workflow Engine
      │
      ▼
Script Executor
      │
      ▼
Script Worker
      │
      ▼
QuickJS Runtime / Context
```

禁止 UI Thread → eval()。

---

# 24. Script Resource Limits

通过 QuickJS/rquickjs 的 Runtime 限制能力实现：

```text
Memory Limit
Stack Limit
Interrupt Handler
Timeout
```

初期建议：

```text
Default timeout: 3s
Maximum user-configurable timeout: 10s
Default memory: 32MB
Maximum: 64MB
```

具体数值后续通过 benchmark 调整。

定义：

```rust
pub struct ScriptPolicy {
    pub timeout: Duration,
    pub memory_limit: usize,
    pub max_stack_size: usize,
}
```

---

# 25. Script Capability API

脚本不能直接获得：

```text
Filesystem
Shell
Environment
Process
Raw Network
OS Credential
```

只暴露：

```js
ctx.input
ctx.vars
ctx.metadata
ctx.http
ctx.file
ctx.clipboard
ctx.item
ctx.utils
```

所有 Capability 调用：

```text
JS
↓
Rust Bridge
↓
Permission Manager
↓
Port
↓
Adapter
```

---

# 26. Workflow Permission

例如：

```json
{
  "network": {
    "allow": ["company.atlassian.net"]
  },
  "fileRead": {
    "allow": []
  },
  "fileWrite": false,
  "clipboard": false,
  "notification": false
}
```

Script Step 只能使用 Workflow Effective Permission 的子集。

重要：QuickJS Context 并不等于 OS Security Sandbox。

MVP 假设脚本主要由用户自己编写或官方提供。未来开放 Workflow Marketplace 后，建议升级为独立 `nivlo-script-worker` 进程，通过 IPC 与 Nivlo Core 通信。

---

# 27. Workflow Run 与调试

每次执行持久化轻量 Run：

```text
workflow_runs
```

字段：

```text
id
workflow_id
status
started_at
finished_at
input_summary
output_summary
error_code
error_message
```

Debug 模式记录 Step：

```text
✓ Matcher      1ms
✓ Extract      2ms
✓ HTTP         231ms
✓ Script       4ms
✓ CreateItem   5ms
```

Workflow Editor 后期可以提供 Run Inspector。

---

# 28. Workflow Error Policy

Step Error 分类：

```text
Retryable
Fatal
PermissionDenied
UserActionRequired
Timeout
InvalidInput
```

例如 Jira 401：

```text
UserActionRequired
```

UI 显示：

```text
Jira authentication required
[Connect Jira]
```

而不是暴露底层 HTTP 堆栈。

---

# 29. Storage Architecture

SQLite 建议启用：

```text
WAL
foreign_keys = ON
busy_timeout
```

连接池：

```text
2 ~ 4
```

Nivlo 是单用户桌面 App，不需要 Web Server 级连接池。

目录逻辑：

```text
Nivlo/
├── database/
│   └── nivlo.db
├── config/
├── logs/
├── cache/
├── workflows/
└── attachments/
```

---

# 30. Database Migration

所有 Schema 变化通过 SQL Migration：

```text
0001_initial.sql
0002_item_source.sql
0003_workflow.sql
...
```

启动顺序：

```text
Open DB
↓
Run Migration
↓
Initialize Repository
↓
Start Scheduler
↓
Create UI
```

如果 migration 失败，不启动业务 Runtime，并进入恢复/诊断流程。

---

# 31. Core Schema

MVP 推荐：

```text
items
projects
tags
item_tags
item_sources
attachments
daily_item_order
workflows
workflow_steps
workflow_runs
workflow_run_steps
reminders
settings
```

## 31.1 Item

```text
id
type
title
content
content_format
status
priority
scheduled_date
scheduled_time
due_date
due_time
reminder_at
project_id
created_at
updated_at
completed_at
archived_at
```

## 31.2 Source

```text
item_sources

id
item_id
source_type
source_app
source_url
source_path
original_title
metadata_json
captured_at
```

Integration-specific 信息优先存 `metadata_json`，避免一开始把 Jira/GitHub 专属字段污染通用 Schema。

## 31.3 Today Order

独立表：

```text
daily_item_order

date
item_id
position
```

原因：

```text
Priority != Today Execution Order
```

---

# 32. Scheduled vs Due

必须区分：

```text
scheduled_date / scheduled_time
```

= 我计划什么时候做。

```text
due_date / due_time
```

= 最晚什么时候完成。

Calendar 默认主要展示 Scheduled，Due 作为 Deadline Overlay。

---

# 33. Search

MVP 使用 SQLite FTS5。

索引：

```text
title
content
source title
source URL
```

搜索入口：

```text
Ctrl + K
```

第一阶段不引入 Elasticsearch、Vector DB。

---

# 34. File Attachment Policy

默认：

```text
Reference First
```

即保存 Original File Path，而不是复制文件到 Nivlo。

只有用户主动选择 Import Copy 时才复制。

---

# 35. Credential Architecture

Secret：

```text
Jira Token
GitHub Token
API Key
OAuth Refresh Token
```

禁止保存到 SQLite 明文、JSON 配置、日志。

定义：

```rust
pub trait CredentialPort {
    async fn get(&self, key: &CredentialKey) -> Result<Option<Secret>>;
    async fn set(&self, key: &CredentialKey, value: Secret) -> Result<()>;
    async fn delete(&self, key: &CredentialKey) -> Result<()>;
}
```

平台：

```text
Windows Credential Manager
macOS Keychain
Linux Secret Service
```

---

# 36. Integration Architecture

例如 Jira：

```text
Workflow Step
      │
      ▼
IntegrationRegistry
      │
      ▼
JiraIntegration
      │
      ▼
HTTP Client
```

Jira 不应该直接存在于 WorkflowEngine。

统一封装 `HttpPort`，负责 Timeout、User Agent、Proxy、TLS、Retry Policy、Workflow Permission Check、Integration Auth Injection。

---

# 37. Scheduler Architecture

```text
SQLite
↓
Schedule Repository
↓
Scheduler
↓
Timer Queue
↓
Notification
```

不能只靠 Timer。

场景：

```text
10:00 提醒
09:50 电脑休眠
11:00 电脑恢复
```

因此 Startup、Resume、Clock Change 都执行 Reconcile Pending Events。

Scheduler 内部维护 Nearest Trigger，不做每秒轮询。

流程：

```text
load next trigger
↓
sleep_until
↓
trigger
↓
load next
```

DB 更新 schedule 时发送 `SchedulerWakeup` 重新计算最近 Trigger。

---

# 38. Event Architecture

Application 内部建议存在 Domain Event Bus：

```text
ItemCreated
ItemUpdated
ItemCompleted
ScheduleChanged
WorkflowFinished
IntegrationChanged
```

内部事件解耦 Repository、Scheduler、Search、UI Events。

不要把所有 Domain Event 都广播给前端。

```text
Domain Event
     │
     ├── Scheduler
     ├── Search
     └── UI Event Mapper
               │
               ▼
          Tauri Event
```

---

# 39. Concurrency Model

基础 Runtime：Tokio。

任务分类：

```text
Short CPU
Async IO
Blocking IO
Script
Platform Thread-bound
```

不要全部 `tokio::spawn`。

复杂文件解析等 blocking 工作使用 `spawn_blocking`；Script 进入独立 Script Worker；COM/AppKit 按平台线程要求调度。

Workflow、HTTP、AI 等耗时任务都应支持 CancellationToken。

---

# 40. Actor-like Runtime Components

Scheduler 适合 Actor-like Task：

```text
Reload
ScheduleChanged
Resume
Shutdown
```

Script Worker 同理：

```text
ScriptRequest
Cancel
Shutdown
```

通过 channel 与外部交互，避免共享复杂可变状态。

未来 Script Worker 切成独立进程时，上层 API 可保持不变。

---

# 41. Application Shutdown

退出流程：

```text
Stop accepting new workflow
↓
Cancel non-critical tasks
↓
Flush critical writes
↓
Persist window state
↓
Stop scheduler
↓
Close database
↓
Exit
```

不要在正常路径直接 `process::exit()`。

---

# 42. Logging

统一使用：

```text
tracing
tracing-subscriber
```

日志默认不得包含：

```text
Token
Cookie
Authorization Header
完整 Clipboard
Note 全文
用户文件全文
```

建议结构化字段：

```text
event
run_id
workflow_id
item_id
duration_ms
error_code
```

---

# 43. Error Model

各层定义自己的 Error：

```text
DomainError
StorageError
CaptureError
WorkflowError
ScriptError
IntegrationError
PlatformError
```

Application 统一为 AppError。

IPC 返回：

```json
{
  "code": "WORKFLOW_SCRIPT_TIMEOUT",
  "message": "Workflow script exceeded the time limit",
  "action": null
}
```

可恢复错误应带 UI Action，例如 `OPEN_INTEGRATION_SETTINGS`。

---

# 44. Security Architecture

安全分层：

```text
Tauri Capability
       ↓
Application Permission
       ↓
Workflow Permission
       ↓
Script Capability
```

原则：Least Privilege。

Integration Credential 只能由 Integration Adapter 获取，不直接暴露给 JS。

Workflow 网络权限按 Host 限制，并在 Marketplace 阶段进一步考虑 Redirect Host、DNS Rebinding、localhost/private IP、file:// 与 custom protocol。

MVP 不提供 Shell Step。

---

# 45. Update / Single Instance / Autostart / Tray

使用 Tauri Updater，发布包签名并使用 HTTPS endpoint。

Single Instance 必须启用：第二次启动只通知已有进程并 Show Main Window，避免重复 Tray、Scheduler、Workflow Runtime、SQLite Writer。

Autostart 首次使用时询问用户，不静默开启。

Tray 建议：

```text
Open Nivlo
Quick Add
Show / Hide Floating Window
Pause Notifications
Settings
Quit
```

---

# 46. Performance Budget

以下作为开发目标而非硬 SLA：

```text
Cold start: < 1s 体感
Idle CPU: 接近 0
Floating Hover: 即时展开
Local Capture: < 100ms 进入处理中状态
Local DB query: 毫秒级
Script: 默认 3s 超时
```

禁止高频 polling、持续 RAF 动画、后台无意义 timer。

Floating Hover 不可依赖数据库和网络。

---

# 47. Frontend 跨平台策略

由于 Tauri 在不同平台使用不同系统 WebView，Design System 必须：

- 避免依赖浏览器默认按钮样式。
- 自定义 form control。
- 减少对原生 scrollbar 外观的依赖。
- 明确字体栈。
- 避免实验性 Web API。
- Windows/macOS/Linux 建立视觉回归测试。
- 使用统一 Design Token 管理 spacing、radius、font、shadow、z-index、animation duration。

---

# 48. Testing Strategy

## Domain Unit Test

重点：

```text
Item State
Todo Complete
Tip Rules
Schedule Rules
Workflow Matcher
Permission
Date Logic
```

## Application Test

使用 Fake Repository 测试完整 Use Case，例如：

```text
Capture → Workflow → Create Item
```

## Storage Integration Test

临时 SQLite：

```text
Migration
Repository CRUD
Transaction
FTS
Order
```

## Workflow Fixture Test

Fixtures：

```text
jira_issue.json
github_issue.json
web_metadata.json
```

## Script Test

覆盖：

```text
Normal Script
Timeout
Memory Limit
Exception
Permission Denied
Invalid Return
```

## Frontend

```text
Vitest
React Testing Library
```

## Desktop E2E

只测试关键路径：

```text
Application Start
Hover Floating
Quick Add
Complete Todo
Drop File
Schedule Item
```

---

# 49. CI / Release

PR：

```text
cargo fmt --check
cargo clippy
cargo test
pnpm lint
pnpm typecheck
pnpm test
```

Build Matrix：

```text
Windows
macOS
Linux
```

早期 MVP 可以 Windows required，macOS/Linux non-blocking，随后逐步提升。

Release：

```text
Git Tag
↓
CI Build
↓
Platform Signing
↓
Artifacts
↓
Updater Manifest
↓
Release
```

---

# 50. Diagnostics

Settings 提供：

```text
Export Diagnostics
```

输出：

```text
App Version
OS
Architecture
WebView Version
DB Schema Version
Workflow Metadata
Recent Sanitized Logs
```

不包括 Token、Note Full Text、Clipboard、User File Content。

---

# 51. Built-in Workflow Packaging

官方 Workflow 作为应用资源：

```text
workflows/builtin/
```

启动时：

```text
read builtin definitions
↓
compare version
↓
sync into DB
```

用户配置与官方定义分离。

每个 Workflow 带：

```text
id
version
schema_version
```

Import 时检查 schema compatibility、permissions、publisher。

---

# 52. Future Plugin / AI Boundary

V1 不做 Plugin System，但长期预留：

```text
Workflow
Integration
Processor
UI Extension
```

当前只需保证 Step Executor Registry、Integration Registry、Platform Port 不写死。

AI 未来作为 `WorkflowStepExecutor` 接入，例如：

```text
PDF
↓
AI Extract Action
↓
Create Todo
```

Core Item 模型不依赖具体 LLM。

---

# 53. Cross-platform 策略

架构：

```text
Cross-platform Core
+
Per-platform Adapter
```

Windows 第一阶段重点：

```text
WebView2
windows-rs
Always-on-top
No-activate
DPI
Multi-monitor
Snap
Native Drop
Credential Manager
Autostart
Notification
```

macOS 后期重点：

```text
NSPanel
Window Level
AppKit Dragging
Keychain
Notification
Login Item
```

Linux 需要考虑：

```text
X11
Wayland
Desktop Environment
WebKitGTK
```

平台 Adapter 应允许 Capability Detection，并支持 Graceful Degradation。

例如高级非激活悬浮窗能力不可用时，退化为普通 Always-on-top Window，而不是整个功能不可用。

---

# 54. Startup Lifecycle

推荐：

```text
Process Start
   ↓
Initialize Logging
   ↓
Resolve App Paths
   ↓
Open SQLite
   ↓
Run Migration
   ↓
Initialize Repositories
   ↓
Load Settings
   ↓
Initialize Credential Adapter
   ↓
Initialize Integration Registry
   ↓
Initialize Workflow Runtime
   ↓
Initialize Scheduler
   ↓
Reconcile Reminders
   ↓
Create Tray
   ↓
Create Floating Window
   ↓
Main Window On Demand
```

---

# 55. Application State

Tauri State 不应该是无结构的大对象。

建议：

```rust
pub struct AppState {
    pub services: ApplicationServices,
    pub runtime: RuntimeHandles,
}
```

`ApplicationServices`：

```text
ItemService
CaptureService
WorkflowService
ScheduleService
```

`RuntimeHandles`：

```text
SchedulerHandle
ScriptWorkerHandle
EventBus
```

避免 `static GLOBAL_HASHMAP`，优先使用 Arc<Service>、Repository、Actor/Channel。

---

# 56. Transaction Boundary

例如：

```text
Capture
→ Create Item
→ Create Source
→ Create Tag
```

必须在一个 Transaction 中完成。

Application 层定义事务边界，不要每个 Repository 自己提交。

---

# 57. Data Backup / Import / Export

Local-first 产品建议后续提供：

```text
Export Backup
```

包含 SQLite snapshot、Workflow、Settings。

Secret 不直接导出。

数据导入导出至少支持：

```text
Markdown
JSON
```

避免用户被锁死在 Nivlo。

---

# 58. Architecture Decision Records

建议建立：

```text
docs/adr/
```

第一批 ADR：

```text
ADR-001 Tauri 2 as Desktop Host
ADR-002 Rust Core Independent from Tauri
ADR-003 SQLite as Local Source of Truth
ADR-004 Workflow V1 Uses Linear Pipeline
ADR-005 QuickJS for Script Step
ADR-006 Platform Features Use Port/Adapter
ADR-007 Windows-first Cross-platform Strategy
ADR-008 Item Unifies Todo Note Tip
ADR-009 React Owns UI Only
ADR-010 No Shell Capability in MVP
```

---

# 59. MVP 实现顺序

## Phase 0 — Foundation

```text
Workspace
Logging
SQLite
Migration
Domain
Application
Typed IPC
```

完成后可以创建/读取 Item。

## Phase 1 — Floating Today

```text
Floating Window
Today Cache
Quick Add
Complete
Reorder
Tray
Single Instance
Autostart
```

这是第一版可以每天使用的 Nivlo。

## Phase 2 — Capture

```text
File Drop
Text
URL
Paste
Source
Inbox
```

形成：

```text
Capture → Item
```

## Phase 3 — Calendar

```text
Todo
Tip
Scheduled
Due
Reminder
Calendar
Drag Schedule
Scheduler
```

形成：

```text
Capture → Schedule → Execute
```

完整闭环。

## Phase 4 — Workflow

```text
Matcher
Linear Pipeline
Executor Registry
Workflow Run
Debug Log
Built-in Workflow
```

## Phase 5 — Script

```text
QuickJS
CodeMirror
Permission
Timeout
Memory Limit
```

## Phase 6 — Integration

```text
Credential Store
Jira
GitHub
```

## Phase 7 — Native Drop / Platform Polish

```text
Windows IDataObject
Advanced Floating Window
DPI
Multi-monitor
Snap
```

## Phase 8 — macOS / Linux

实现对应 Adapter。

---

# 60. MVP 明确不做

```text
Cloud Account
Cloud Sync
Team Workspace
Multi-user
Complex DAG
Workflow Marketplace
Plugin Marketplace
Shell Step
Block-based Note Editor
Gantt
Habit
Pomodoro
Vector Database
AI Agent
Full Jira Two-way Sync
```

---

# 61. 技术风险

## 风险 1：WebView 跨平台差异

策略：Design System、Visual Regression、平台测试、Platform Adapter。

## 风险 2：浏览器 URL Drag 无法统一

策略：Standard Drop + Native Drop Adapter。

## 风险 3：悬浮窗抢焦点

策略：Tauri first → platform native behavior；Window Behavior 与 UI 分离。

## 风险 4：Workflow 过早平台化

策略：V1 Linear Pipeline，禁止一开始做 DAG + Marketplace + Plugin。

## 风险 5：JS 安全

策略：No raw OS API、Capability API、Permission、Memory、Timeout、Future Worker Process。

## 风险 6：长期运行内存增长

策略：Profiler、Window Lifecycle、Script Runtime Reset、Bounded Cache、Bounded Workflow Log。

---

# 62. Coding Rules

Rust：

```text
clippy clean
非测试关键业务路径禁止随意 unwrap()
Error 类型化
公共 API 文档
核心逻辑写测试
```

TypeScript：

```text
strict = true
禁止 any 滥用
IPC 类型自动生成
Feature boundary
```

---

# 63. Dependency Rules

`nivlo-domain` 不能依赖：

```text
tauri
sqlx
reqwest
rquickjs
windows
```

`nivlo-application` 可以依赖 Domain，但不能依赖 Tauri。

`src-tauri` 是 Composition Root，可以依赖具体 Adapter 并完成装配。

例如：

```text
SqliteItemRepository
QuickJsScriptExecutor
WindowsCredentialStore
ReqwestHttpClient
TauriNotificationAdapter
```

组合成 `ApplicationServices`。

---

# 64. Future Replacement Capability

如果未来发现 Floating Window WebView 不够好，可以：

```text
Main Window
→ Tauri + React

Floating
→ GPUI / Slint
```

两者共享：

```text
Nivlo Application/Core
SQLite
Workflow
Scheduler
```

当前架构不锁死 UI 技术。

---

# 65. 最终技术定义

Nivlo 的整体技术定位：

> **一个以 Tauri 2 为桌面宿主、React 为跨平台 UI、Rust 为核心业务运行时、SQLite 为本地数据源、QuickJS 为受控脚本 Runtime，并通过 Ports & Adapters 隔离操作系统差异的 Local-First 桌面应用。**

核心边界：

```text
React
负责：View / Interaction

Tauri
负责：Desktop Host / IPC / Window Lifecycle

Application
负责：Use Case / Orchestration

Domain
负责：Business Model / Rules

Adapters
负责：SQLite / QuickJS / HTTP / OS
```

---

# 66. 最终架构图

```text
                              Nivlo

                    ┌────────────────────┐
                    │ React / TypeScript │
                    │                    │
                    │ Floating           │
                    │ Today              │
                    │ Calendar           │
                    │ Workflow Editor    │
                    └─────────┬──────────┘
                              │
                         Typed IPC
                              │
                    ┌─────────▼──────────┐
                    │      Tauri 2       │
                    │                    │
                    │ Desktop Host       │
                    │ Window / Tray      │
                    │ Capability         │
                    └─────────┬──────────┘
                              │
                    ┌─────────▼──────────┐
                    │ Application Layer  │
                    │                    │
                    │ Use Cases          │
                    │ Services           │
                    │ Event Mapping      │
                    └─────────┬──────────┘
                              │
                    ┌─────────▼──────────┐
                    │    Domain Layer    │
                    │                    │
                    │ Capture            │
                    │ Item               │
                    │ Workflow           │
                    │ Schedule           │
                    │ Source             │
                    └──┬────┬────┬────┬─┘
                       │    │    │    │
             ┌─────────┘    │    │    └───────────┐
             ▼              ▼    ▼                ▼
        ┌─────────┐   ┌────────┐ ┌──────────┐ ┌──────────┐
        │ Storage │   │ Script │ │Integrat. │ │ Platform │
        │         │   │        │ │          │ │          │
        │ SQLite  │   │QuickJS │ │Jira      │ │Windows   │
        │ FTS5    │   │        │ │GitHub    │ │macOS     │
        └─────────┘   └────────┘ └──────────┘ │Linux     │
                                               └──────────┘
```

---

# 67. 当前最终技术栈

```text
Desktop
Tauri 2

Frontend
React
TypeScript
Vite
Tailwind CSS
Zustand
TanStack Query
dnd-kit
CodeMirror 6
date-fns

Core
Rust
Tokio
Serde
thiserror
tracing

Storage
SQLite
SQLx
FTS5

Networking
reqwest

Workflow
Rust Workflow Runtime

Script
QuickJS
rquickjs

Platform
Tauri API
windows-rs
macOS Adapter
Linux Adapter

Credentials
OS Credential Store

IPC
Tauri Command/Event
Typed Binding Generator

Release
Tauri Updater
Platform Signing
```

---

# 68. 关键原则总结

1. **Tauri 是壳，不是 Core。**
2. **React 只负责 UI，不直接承担核心业务。**
3. **SQLite 是本地 Source of Truth。**
4. **所有 Capture Source 最终统一成 CaptureInput。**
5. **Workflow V1 是 Linear Pipeline，不做 DAG。**
6. **JavaScript 只是 Workflow Step。**
7. **JS 不直接拥有 OS 权限。**
8. **平台差异统一进入 Platform Adapter。**
9. **Floating Window 的 UI 与 Window Behavior 分离。**
10. **Windows 优先实现，但 Core 从第一天跨平台。**
11. **高权限能力遵守最小权限原则。**
12. **不要为了未来能力过度设计 MVP。**
13. **长期常驻意味着 Idle Performance 是产品能力。**
14. **所有关键异步任务必须可取消、可恢复、可诊断。**
15. **架构允许未来替换局部 UI Host，而无需重写 Nivlo Core。**

---

# 69. 参考依据

制定本方案时重点核对的当前技术能力：

- Tauri 2 Capability / IPC permission boundary  
  https://v2.tauri.app/reference/acl/capability/

- Tauri 2 Core permissions  
  https://v2.tauri.app/reference/acl/core-permissions/

- Tauri 2 Updater  
  https://v2.tauri.app/plugin/updater/

- rquickjs Runtime  
  https://docs.rs/rquickjs/latest/rquickjs/struct.Runtime.html

- rquickjs AsyncRuntime  
  https://docs.rs/rquickjs/latest/rquickjs/struct.AsyncRuntime.html

---

# 70. 下一阶段

技术架构确定后，下一阶段不应继续扩大功能设计，而应进入：

```text
1. 建立 Cargo Workspace
2. 建立 React/Vite Desktop UI
3. 建立 Domain Model
4. 建立 SQLite Migration
5. 建立 Typed IPC
6. 建立 Floating Window Prototype
7. 实现 Today + Quick Add + Reorder
```

第一技术里程碑定义为：

> **Nivlo 可以开机常驻，鼠标 Hover 悬浮窗立即展示 Today，用户可以在悬浮窗直接创建、排序和完成 Todo，所有数据可靠持久化到 SQLite。**

完成这一阶段以后，再进入 Capture / Workflow。
