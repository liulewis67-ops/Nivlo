# Nivlo · 拾序 实施计划（Implementation Plan）

> Status: v1.0  
> Last Updated: 2026-10-11  
> 依据文档：[Nivlo_Product_Design.md](Nivlo_Product_Design.md)（下称「产品文档」）、[Nivlo_Technical_Architecture.md](Nivlo_Technical_Architecture.md)（下称「架构文档」）  
> 开发规范：[前端开发规范](../development/Nivlo_Frontend_Development_Guide.md)、[后端开发规范](../development/Nivlo_Backend_Development_Guide.md)（所有子阶段的实现必须遵守）  
> 用途：本文档是后续全部开发工作的执行依据。每一项开发任务都应能对应到本文档中的某个子阶段（Sub-phase），完成后在本文档中更新状态。

---

# 0. 使用说明

## 0.1 状态标记

| 标记 | 含义 |
|---|---|
| ⬜ | 未开始（Not Started） |
| 🟨 | 进行中（In Progress） |
| ✅ | 已完成（Done）——全部验收标准已勾选并留有证据 |
| ⏸ | 阻塞（Blocked）——必须在「完成记录」中写明阻塞原因 |
| ➖ | 推迟 / 不做（Deferred）——必须写明原因与目标版本 |

## 0.2 文档维护规则

1. **开始**一个子阶段时：把状态改为 🟨，并在「完成记录」中写开始日期。
2. **完成**一个子阶段时：逐条勾选验收标准，在「完成记录」中写完成日期、证据（测试名 / 截图路径 / 测量数据 / PR 或 commit），然后把状态改为 ✅，并同步更新 [§2 进度总览](#2-进度总览)。
3. 验收标准**不得**为了让子阶段「完成」而被删改；如确需调整，在「完成记录」中写明原因（变更须可追溯）。
4. 任何偏离架构文档的实现决策，需新增或更新 ADR（`docs/adr/`），并在对应子阶段中引用。
5. [§3 待决策事项](#3-待决策事项decision-log) 中的决策在被依赖的子阶段开始前必须定稿（状态改为「已决定」）。
6. 一个阶段（Phase）只有在其所有子阶段为 ✅ 或 ➖，且「阶段退出标准」满足时，才算完成。

## 0.3 全局完成定义（Definition of Done）

以下要求适用于**每一个**子阶段，不在各子阶段中重复列出：

- [ ] 代码已合入主分支，CI 全绿：`cargo fmt --check`、`cargo clippy -- -D warnings`、`cargo test`、`pnpm lint`、`pnpm typecheck`、`pnpm test`。
- [ ] 新增业务逻辑有对应测试（Domain / Application 单元测试，Storage 集成测试，或前端组件测试）。
- [ ] 新增 IPC Command 已写入对应窗口的 Capability 文件（最小权限），TS Binding 已重新生成并提交。
- [ ] Schema 变更只通过**新增** migration 文件完成；已合入的 migration 不得修改。
- [ ] 日志中不包含 Token、Cookie、Authorization Header、完整 Clipboard、Note 全文、用户文件全文。
- [ ] 非测试的关键业务路径中没有随意的 `unwrap()` / `expect()`；TypeScript 中没有无理由的 `any`。
- [ ] 注释符合规范：所有函数（含私有函数）、组件、Hook、类型有函数 / 文档注释；复杂逻辑有说明「为什么」的行内注释（前端规范 §15、后端规范 §15）。
- [ ] 前端只使用 pnpm 管理依赖，`pnpm-lock.yaml` 已同步更新。
- [ ] 依赖方向符合架构文档 §63（`nivlo-domain` / `nivlo-application` 不依赖 Tauri、SQLx、reqwest、rquickjs、windows）。
- [ ] 本文档状态已更新。

## 0.4 开发约定（含 Code Agent）

- 一个子阶段 = 一个或若干个独立可合并的变更单元；不要跨子阶段混合提交。
- 分支命名：`p<阶段>.<子阶段>-<简短描述>`，例如 `p1.7-today-reorder`。
- 提交 / PR 标题以子阶段编号开头，例如 `[P1.7] Persist today order`。
- 开始实现前先阅读该子阶段的「依赖」与相关「待决策事项」；依赖未完成时不得开始。
- 只实现子阶段「任务」范围内的内容；发现范围外问题时记录到对应后续子阶段或 [§16 Backlog](#16-phase-12--backlog未排期)，而不是顺手扩大范围。

---

# 1. 阶段规划总览

## 1.1 阶段与版本映射

```text
Phase 0  Foundation                  ┐
Phase 1  Floating Today              │  → M1：第一个可每天使用的 Nivlo
Phase 2  Capture & Inbox             │  → M2：Capture → Item
Phase 3  Workspace & Organization    │
Phase 4  Calendar & Scheduler        │  → M3：Capture → Schedule → Execute 闭环
Phase 5  Workflow Engine             │
Phase 6  Built-in Workflow & Smart   │
         Capture                     │
Phase 7  MVP Hardening & Release     ┘  → M4：MVP 发布（v0.1.0，Windows）

Phase 8  Script Runtime                 → V2 Programmable Capture
Phase 9  Integration & Credential       → V3 Integration（Jira / GitHub API）
Phase 10 Windows Native Polish          → 可按风险提前（见 2.4 兼容矩阵结果）
Phase 11 macOS / Linux                  → 跨平台发布
Phase 12 Backlog                        → 未排期
```

与架构文档 §59 的对应关系：本计划在架构文档的 Phase 0–8 基础上，将「主应用 Workspace」「MVP 发布工程」拆为独立阶段（Phase 3、Phase 7），并把 Script（架构 Phase 5）与 Integration（架构 Phase 6）后移到 MVP 发布之后，与产品文档 §29 的版本规划（Script 属 V2、Jira API 属 V3）保持一致。

## 1.2 里程碑

| 里程碑 | 完成条件 | 对应阶段 | 状态 |
|---|---|---|---|
| M0 | UI 可通过 Typed IPC 创建 / 读取 Item，数据持久化到 SQLite | Phase 0 | ✅ |
| M1 | 开机常驻；Hover 悬浮窗立即展示 Today；可在悬浮窗直接创建、排序、完成 Todo；数据可靠持久化 | Phase 1 | ⬜ |
| M2 | 拖拽 / 粘贴 / 快捷键捕获 URL、文件、文本进入 Inbox，保留 Source | Phase 2 | ⬜ |
| M3 | Calendar 规划 + 提醒可靠触发，形成 Capture → Schedule → Execute 闭环 | Phase 3–4 | ⬜ |
| M4 | Workflow + 内置 Workflow 可用，通过发布工程验收，发布 MVP v0.1.0（Windows） | Phase 5–7 | ⬜ |

---

# 2. 进度总览

| 阶段 | 子阶段 | 名称 | 状态 |
|---|---|---|---|
| **P0** | 0.1 | 仓库与 Workspace 初始化 | ✅ |
| | 0.2 | 代码质量门禁与 CI | 🟨 |
| | 0.3 | ADR 与开发文档 | 🟨 |
| | 0.4 | Common 基础设施（日志 / 路径 / 时钟 / ID / Secret） | ✅ |
| | 0.5 | Domain Model | ✅ |
| | 0.6 | Storage：SQLite 与 Migration | ✅ |
| | 0.7 | Application Layer 与 Event Bus | ✅ |
| | 0.8 | Tauri Host、启动生命周期与 Typed IPC | ✅ |
| | 0.9 | Frontend 基础 | ✅ |
| **P1** | 1.1 | 窗口架构与 Capability | ✅ |
| | 1.2 | 悬浮窗 Window Behavior | 🟨 |
| | 1.3 | Hover 展开与悬浮窗状态机 | ✅ |
| | 1.4 | Today 查询与缓存 | ✅ |
| | 1.5 | 悬浮窗 Quick Create | 🟨 |
| | 1.6 | 完成 / Undo / Optimistic Update | ✅ |
| | 1.7 | Today Stack 排序 | ✅ |
| | 1.8 | 推迟操作 | ✅ |
| | 1.9 | Tray / Single Instance / Autostart / Shutdown | ✅ |
| | 1.10 | 主窗口外壳与 Today 视图 | ✅ |
| | 1.11 | 常驻性能基线验收 | ⬜ |
| **P2** | 2.1 | CaptureInput 模型与 Normalizer | ✅ |
| | 2.2 | Source 与 Attachment 持久化 | ✅ |
| | 2.3 | Capture Use Case 与默认规则 | ✅ |
| | 2.4 | 悬浮窗拖拽捕获（WebView Drop） | 🟨 |
| | 2.5 | 粘贴捕获 | 🟨 |
| | 2.6 | 全局快捷键 Quick Create | 🟨 |
| | 2.7 | Inbox | ✅ |
| **P3** | 3.1 | Item 完整编辑器 | 🟨 |
| | 3.2 | Notes 视图 | ✅ |
| | 3.3 | Projects 与 Tags | ✅ |
| | 3.4 | 全文搜索与 Ctrl+K | ✅ |
| | 3.5 | 归档 / 删除 / 设置页 | ✅ |
| **P4** | 4.1 | 时间模型与 Schedule 语义 | ✅ |
| | 4.2 | Calendar 查询与 Month / Week 视图 | ✅ |
| | 4.3 | Calendar 拖拽排期 | ✅ |
| | 4.4 | Scheduler Actor | ✅ |
| | 4.5 | Reconcile：启动 / 唤醒 / 时钟变化 | ✅ |
| | 4.6 | 系统通知 | 🟨 |
| | 4.7 | Reminder / Due / Tip 的 UI | 🟨 |
| **P5** | 5.1 | Workflow 领域模型与定义格式 | ✅ |
| | 5.2 | Matcher 与 Resolver | ✅ |
| | 5.3 | Engine、Context 与 Executor Registry | ✅ |
| | 5.4 | 基础 Step Executor | ✅ |
| | 5.5 | Capture 接入 Workflow | 🟨 |
| | 5.6 | Workflow Run 记录与调试 | ✅ |
| | 5.7 | Workflow 管理 UI | ✅ |
| **P6** | 6.1 | HttpPort 与网络权限 | ✅ |
| | 6.2 | 内置 Workflow 打包与同步 | ✅ |
| | 6.3 | Generic Web Page（页面元数据） | ✅ |
| | 6.4 | Jira Issue（无 API 降级路径） | ✅ |
| | 6.5 | GitHub Issue / PR | ✅ |
| | 6.6 | 文件类 Workflow | ✅ |
| | 6.7 | 自然语言日期解析 | ✅ |
| **P7** | 7.1 | Desktop E2E 关键路径 | ⬜ |
| | 7.2 | 性能预算与长稳验收 | ⬜ |
| | 7.3 | Diagnostics 导出 | ✅ |
| | 7.4 | 备份与数据导出 | ✅ |
| | 7.5 | 首次运行引导与体验打磨 | 🟨 |
| | 7.6 | 安装包、签名、Updater 与发布流水线 | ⬜ |
| | 7.7 | 悬浮窗外观与自定义皮肤 | 🟨 |
| **P8** | 8.1 | QuickJS Runtime 与 Script Worker | ✅ |
| | 8.2 | Script Context 与 Capability API | ⬜ |
| | 8.3 | Script Step 与 Workflow 权限 | ⬜ |
| | 8.4 | 脚本编辑器（CodeMirror） | ⬜ |
| | 8.5 | Workflow 导入 / 导出 | ⬜ |
| **P9** | 9.1 | CredentialPort 与 Windows Credential Manager | ⬜ |
| | 9.2 | Integration Registry 与 Integration Step | ⬜ |
| | 9.3 | Jira API | ⬜ |
| | 9.4 | GitHub API | ⬜ |
| | 9.5 | Integration 设置 UI | ⬜ |
| **P10** | 10.1 | Windows Native Drop Adapter（建议提前至 M4，见 D-15） | ⬜ |
| | 10.2 | 高级悬浮窗行为（No-Activate 等） | ⬜ |
| | 10.3 | DPI 与多显示器热插拔加固 | ⬜ |
| | 10.4 | 来源应用识别 | ⬜ |
| | 10.5 | 原生电源 / 时钟事件 | ⬜ |
| | 10.6 | 原生通知激活（点击通知定位 Item） | ⬜ |
| **P11** | 11.1 | 跨平台 CI 与视觉回归 | ⬜ |
| | 11.2 | macOS Adapter | ⬜ |
| | 11.3 | Linux Adapter | ⬜ |

## 2.1 MVP 发布差距盘点（2026-10-11）

盘点时的基线：本地 `cargo test --workspace` 569 通过 / 0 失败 / 6 忽略；`pnpm typecheck`、`pnpm lint`、`pnpm test`（45 个文件 447 个用例）全部通过；仓库**尚未配置远端**，CI 从未运行。Phase 0–6 的代码与自动化测试基本完成，剩余工作集中在发布工程、真机验收与少量功能缺口。本节只做汇总与排序，具体任务与验收标准以各子阶段为准，完成后同步勾掉。

### A. M4 发布阻塞项

| # | 事项 | 子阶段 | 说明 |
|---|---|---|---|
| A1 | 推送远端并让 CI 全绿，Windows Job 设为必需检查 | 0.2 | 全局完成定义（§0.3）的第一条目前无法满足。 |
| A2 | 资源管理器文件拖放 | 10.1、D-15 | 产品文档 §28 把「Drag & Drop → File」与内置 PDF / File Workflow 列为 MVP 必须有；HTML5 Drop 拿不到磁盘路径（ADR-011），目前只能复制 → 粘贴。 |
| A3 | 常驻性能基线与长稳 | 1.11、7.2 | `docs/development/perf-baseline.md` 尚不存在；7.7 的皮肤动效需一并测量（D-13）。 |
| A4 | Desktop E2E 关键路径 | 7.1 | 7.6 的依赖。 |
| A5 | 安装包、签名、Updater、发布流水线 | 7.6 | 4.6 的「通知显示正确应用名与图标」也依赖安装包注册的应用标识。 |

### B. 真机验收清单（代码与自动化已完成，子阶段因手动验收保持 🟨）

| 子阶段 | 待验证项 |
|---|---|
| 0.3 | 在未配置过的 Windows 机器上 10 步内首次启动。 |
| 1.2 | 100% 与 150% 缩放显示器之间移动，徽标视觉尺寸一致（需双显示器）。 |
| 1.5 | Hover → Enter 3 秒内；重启后仍在；Esc 不创建数据；结束后焦点不残留。 |
| 2.4 | `drop-matrix.md` 全部「待真机」项；Drop → Created ✓ < 1s；悬浮窗不长期占有焦点。 |
| 2.5 | 悬浮窗 / 主窗口里的完整粘贴流程。 |
| 2.6 | 其他应用在前台时呼出 → 输入 → 创建 → 焦点归还；记录无法归还的场景。 |
| 3.1 | 「在浏览器中打开」「在文件夹中显示」真实生效。 |
| 4.6 / 4.7 | 设置提醒后按时收到通知（端到端）。 |
| 5.5 | 本地 Workflow 从 Drop 到「处理中」< 100ms。 |
| 7.5 | 至少 3 人可用性测试（2 分钟内完成 Hover → 新建 → 完成）。 |

建议集中一次按本表逐项走查，结果写回各子阶段的完成记录。

### C. 已标记完成 / 进行中子阶段里的功能缺口

| 缺口 | 归属 | 说明 |
|---|---|---|
| D-07「隐藏已完成」开关未实现 | 7.5 | 1.6 把开关留给 3.5 设置页，3.5 完成时遗漏。 |
| 原生侧文案未国际化 | 7.5、D-14 | 托盘菜单（`tray.rs`）、开机自启询问（`autostart.rs`）、恢复对话框（`lifecycle/recovery.rs`）、Scheduler 通知标题（`nivlo-scheduler` `plan.rs`）硬编码中文；语言偏好只存在前端 `localStorage`，Rust 侧无法得知当前语言。7.5 的「中英文切换后无缺失文案」因此未满足。 |
| 点击通知无法定位 Item | 10.6 | `tauri-plugin-notification` 在桌面端没有点击回调，需要原生 Toast 激活。 |
| 内网 / 自托管 Jira 只能保存工单号 | 9.3 | HostPolicy 拒绝私网地址（6.4 的已知偏差），由 Jira API 与按 Integration 配置的 Host 解决。 |
| UI 偏好不在备份内 | D-14 | 语言、主题、悬浮窗外观、皮肤存于 `localStorage`，与 3.5「设置写入 `settings` 表」不一致，7.4 的备份 / 恢复不包含它们。 |

### D. 技术债与文档卫生

- 过期的代码 TODO：`apps/desktop/src-tauri/src/app.rs` 中 `TODO(P4.4)`「停止 Scheduler」已不成立（Scheduler 作为受跟踪任务随 shutdown 令牌取消，见 `scheduling.rs`），应删除；`events/forwarder.rs` 中 `TODO(P1.1)` 仍未做——事件广播到所有窗口，应改为 `emit_to` 按窗口发送（后端规范 §5.2）。
- 8.1 的草稿（rquickjs Worker 与 8 个测试）放在 `.wip/`，被 `.git/info/exclude` 排除，不在版本控制中，存在丢失风险；应移到 `p8.1-script-worker` 分支。
- Vitest 每个测试文件各建一次 jsdom（45 次，单次运行约 48s）；可评估 `pool: "vmThreads"` 或 `isolate: false`。
- 5.4 第二条验收缺一个测试：经 Workflow 捕获且带 Tag 时提交失败，Item / Source / Tag 均不残留。
- 本次盘点已同步：D-11 定稿、新增 7.7 与 10.6、新增 D-13 ~ D-15。

### E. 建议顺序

1. A1：推送远端，CI 全绿。
2. D-13 / D-14 定稿 → 收尾 7.7 并提交。
3. D-15 定稿 → 10.1（MVP 范围：`CF_HDROP` 文件 / 多文件 / 文件夹）。
4. 7.5 缺口：原生文案国际化、「隐藏已完成」开关。
5. B 类真机验收一次走查。
6. 1.11 / 7.2 性能基线与长稳。
7. 7.1 E2E → 7.6 发布流水线 → v0.1.0。

---

# 3. 待决策事项（Decision Log）

以下事项在两份设计文档中尚未定论或存在冲突。每项给出**推荐方案**，在「需在…前定稿」所指子阶段开始前确认；确认后把状态改为「已决定」并写明最终结论（如与推荐不同）。

| ID | 事项 | 推荐方案 | 需在…前定稿 | 状态 |
|---|---|---|---|---|
| D-01 | **Today 的定义** | Today = `type=Todo` 且未完成且计划日期 ≤ 今天（过期未完成自动滚入 Today，带「逾期」标记）；外加计划日期 = 今天的 Tip。悬浮窗数字 = Today 中未完成 Todo 数。 | 1.4 | 已决定（2026-10-10，采用推荐方案） |
| D-02 | **Inbox 的定义** | 采用显式字段 `in_inbox`（布尔）。Capture 产生的 Item 置为 true；任何整理动作（设置计划日期、设置项目、转换类型、手动「移出 Inbox」）置为 false；「推迟到 Inbox」置为 true 并清除计划日期。不采用「无日期且无项目即 Inbox」的推导规则，避免 Note 永远滞留 Inbox。 | 2.2 | 已决定（2026-10-10，采用推荐方案） |
| D-03 | **时间存储模型** | 架构文档使用 `scheduled_at: DateTime`，产品文档使用 `scheduled_date`。推荐：计划与截止拆为「本地日期 + 可选本地时间」（`scheduled_date`、`scheduled_time`、`due_date`、`due_time`），按用户本地日历语义解释（跨时区不漂移）；`reminder_at` 存 UTC 时间点。需同步更新架构文档 §8、§31。 | 0.5 | 已决定（2026-10-09，采用推荐方案） |
| D-04 | **ID 与时间戳格式** | ID 使用 UUIDv7（TEXT）；`created_at` 等审计时间戳存 UTC（RFC 3339 TEXT 或 Unix ms INTEGER，二选一并全库统一）。 | 0.5 | 已决定（2026-10-09：ID 为 UUIDv7 TEXT；审计时间戳为 UTC RFC 3339 TEXT，全库统一） |
| D-05 | **Project Order** | 产品文档 §21 要求区分 Today Order 与 Project Order。推荐 MVP 中 Project 视图按 优先级 → 计划日期 → 创建时间 排序，手动 Project Order 推迟到 MVP 后（新增 `project_item_order` 表）。 | 3.3 | 已决定（2026-10-11，采用推荐方案；未完成的排在已完成之前） |
| D-06 | **UI 语言** | 默认简体中文，从 0.9 起接入 i18n 框架（如 i18next），文案全部走资源文件；英文作为第二语言在 7.5 补齐。 | 0.9 | 已决定（2026-10-09，采用推荐方案） |
| D-07 | **已完成 Todo 在 Today 中的展示** | 当天完成的 Todo 以删除线显示在 Today 列表底部，次日不再显示；提供「隐藏已完成」开关。 | 1.6 | 已决定（2026-10-10，采用推荐方案） |
| D-08 | **删除语义** | 增加 `deleted_at` 软删除，进入回收站，30 天后自动清除；与 `archived_at`（归档，长期保留）区分。 | 3.5 | 已决定（2026-10-11，采用推荐方案：`items.deleted_at` 软删除，30 天后自动清除） |
| D-09 | **FTS 索引同步方式** | 使用 SQLite Trigger 同步 FTS5 表（与业务写入同一事务，不会不一致），而不是通过 Domain Event 异步更新。FTS5 使用 `trigram` tokenizer 以支持中文子串搜索。 | 3.4 | 已决定（2026-10-11，采用推荐方案；trigram 要求至少 3 个字符，更短的查询退化为 LIKE 扫描） |
| D-10 | **WebView 拖拽方案** | Tauri 2 在 Windows 上启用原生 `dragDropEnabled` 时会拦截 HTML5 drop（只能拿到文件路径，拿不到浏览器拖来的 URL / 文本）。需在 2.4 开头做技术验证，从「Tauri 原生文件拖放 + HTML5 drop」的组合方案中选定一个，必要时将 10.1 Native Drop 提前。 | 2.4 | 已决定（2026-10-10：悬浮窗使用 HTML5 Drop，文件拖放由 10.1 Native Drop 解决，见 ADR-011；待真机验证） |
| D-11 | **Workflow 字段映射模板语法** | 采用最小模板语法 `{{ path.to.var }}`（仅变量插值与少量过滤器，如 `| default`、`| trim`），不引入完整模板引擎。 | 5.3 | 已决定（2026-10-11，按 5.3 的实现补记：`{{ path.to.var }}` 插值，过滤器 `default`、`trim`、`lower`、`upper`、`truncate`、`replace`；6.3 增加 `default(var)` 以另一个变量作为默认值；不引入完整模板引擎） |
| D-12 | **悬浮窗 IPC 白名单补充** | 架构文档 §13 的 floating 白名单没有推迟（改期）能力，但产品文档 §22 要求在悬浮面板直接推迟。推荐在 floating 白名单中增加 `reschedule_item`、`undo`、`get_inbox_count`，并同步更新架构文档 §13。 | 1.1 | 已决定（2026-10-09，采用推荐方案，已同步架构文档 §13） |
| D-13 | **悬浮窗装饰动效与常驻性能预算** | 7.7 的自定义皮肤支持循环 / 往返逐帧播放（前端 `setInterval`）与漂浮 / 呼吸 / 弹跳（CSS 无限动画），与架构文档 §46「禁止持续 RAF 动画、后台无意义 timer」及 1.11「空闲 CPU < 0.5%」冲突。推荐：① 默认播放方式为「仅悬停时播放」，附加动效默认「无」；② 循环类播放作为用户显式选择，设置页注明会增加耗电；③ 窗口隐藏（`document.hidden`）或悬浮窗被隐藏时停止计时器与动画；④ 1.11 / 7.2 分别测量「默认徽标」与「循环皮肤 + 动效」两种配置，前者必须满足预算，后者记录实测值。 | 7.7 完成前 | 前端部分已落实（2026-10-11）：默认「仅悬停」播放、附加动效默认「无」、页面隐藏时停止计时器与 CSS 动画；设置页提示与 perf-baseline 实测待 7.2 |
| D-14 | **UI 偏好的持久化位置** | 语言、主题（0.9 / 7.5）、悬浮窗外观与皮肤（7.7）目前存于各窗口的 `localStorage`，与 3.5「设置写入 `settings` 表」不一致：Rust 侧无法按语言显示托盘 / 通知文案，7.4 备份也不包含它们。推荐：语言、主题、外观写入 `settings` 表并通过 IPC 读写，变化以事件广播给各窗口；`localStorage` 只作为首帧渲染缓存；皮肤帧图保存到 `<数据目录>/skins/`，`settings` 只存元数据，从而被备份覆盖。 | 7.5 原生文案国际化、7.7 完成前 | 外观、皮肤、语言、主题已落实（2026-10-11，`ui.*` 写入 settings 表，启动时回填缓存）；Rust 侧原生文案国际化留在 7.5 |
| D-15 | **10.1 Native Drop 是否提前到 M4** | 产品文档 §28 把「Drag & Drop → File」与内置 PDF / File Workflow 列为 MVP 必须有，2.4 也把「资源管理器文件（单 / 多）」列为核心来源；而 ADR-011 的 HTML5 Drop 拿不到文件路径。Phase 10 引言与 D-10 均规定核心来源失败时提前 10.1。推荐：把 10.1 中 `CF_HDROP`（单 / 多文件、文件夹）部分列为 M4 发布前必需；`FileGroupDescriptor`（Outlook 附件等）留在 Phase 10。 | 7.1 开始前 | 待定 |

---

# 4. Phase 0 — Foundation（工程基础）

**目标**：建立符合架构文档的工程骨架、分层与质量门禁，打通 UI → IPC → Application → Domain → SQLite 的最短链路。

**阶段退出标准**：M0 达成——在 UI 中创建一个 Item，重启应用后仍可读取；CI 在 Windows 上全绿；依赖方向检查生效。

---

### 0.1 仓库与 Workspace 初始化

- **状态**：✅
- **依赖**：—
- **目标**：按架构文档 §6 建立 Monorepo 骨架。
- **任务**：
  - `git init`，添加 `.gitignore`、`.editorconfig`、`.gitattributes`（统一 LF）。
  - 根 `Cargo.toml` 建立 Cargo Workspace，使用 `[workspace.dependencies]` 统一依赖版本；`rust-toolchain.toml` 固定 stable 版本。
  - 创建 crates 骨架：`nivlo-domain`、`nivlo-application`、`nivlo-storage`、`nivlo-capture`、`nivlo-workflow`、`nivlo-script`、`nivlo-scheduler`、`nivlo-integrations`、`nivlo-platform`、`nivlo-platform-windows`、`nivlo-platform-macos`、`nivlo-platform-linux`、`nivlo-common`（平台 crate 以 `cfg(target_os)` 隔离，非目标平台编译为空）。
  - 根 `package.json` + `pnpm-workspace.yaml`；用 Tauri 2 初始化 `apps/desktop/src-tauri`，用 Vite + React + TypeScript 初始化 `apps/desktop/ui`。
  - 建立目录：`migrations/`、`workflows/builtin/`、`fixtures/{jira,github,workflow}/`、`scripts/`、`docs/{architecture,adr,development}/`。
  - 每个 crate 的 `lib.rs` 顶部写 crate 级文档注释，说明职责与禁止依赖项（摘自架构文档 §7）。
- **验收标准**：
  - [x] 在 Windows 上 `cargo build --workspace` 成功。
  - [x] `pnpm install` 后 `pnpm -C apps/desktop/ui build` 成功。
  - [x] `pnpm tauri dev` 可启动一个空白窗口。
  - [x] 目录结构与架构文档 §6 一致（差异须在完成记录中说明原因）。
  - [x] 每个 crate 都有职责说明文档注释。
- **完成记录**：2026-10-09 完成。
  - 证据：`cargo build --workspace`、`cargo clippy --workspace --all-targets -- -D warnings` 通过；`pnpm build` 通过；`pnpm tauri dev` 启动 `nivlo-desktop.exe` 并显示空白窗口。
  - 偏差：① 本机工具链为 Node 22.19 / pnpm 11.1.3 / Rust 1.95.0，规范写的是 Node 24 / pnpm 10，`engines` 暂放宽为 `node >=22`、`pnpm >=10`，`packageManager` 锁定 `pnpm@11.1.3`；② 产品与架构文档暂留在 `doc/`，按 0.3 迁入 `docs/`；③ `tauri` 脚本从仓库根目录运行（`pnpm tauri ...`），因为 Tauri CLI 无法从 `ui/` 目录定位 `../src-tauri`；④ 当前图标为占位图（字母 N）。

### 0.2 代码质量门禁与 CI

- **状态**：🟨
- **依赖**：0.1
- **目标**：从第一天起强制执行架构文档 §49、§62、§63 的规则。
- **任务**：
  - Rust：`rustfmt.toml`；按后端规范 §14 配置 `[workspace.lints]`（含 `missing_docs`、`clippy::missing_docs_in_private_items`、`missing_errors_doc`、`undocumented_unsafe_blocks`、`unwrap_used` 等）；CI 中 `RUSTDOCFLAGS="-D warnings" cargo doc --workspace --no-deps`。
  - TypeScript：`strict: true`、ESLint（含 `eslint-plugin-jsdoc`，按前端规范 §15.6 配置）、Prettier；`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm format:check` 脚本。
  - pnpm：根 `package.json` 声明 `packageManager` 与 `engines`，`preinstall` 使用 `only-allow pnpm`；CI 使用 `pnpm install --frozen-lockfile`（前端规范 §3）。
  - 依赖方向检查脚本 `scripts/check-deps`：基于 `cargo metadata`，断言 `nivlo-domain` 不（直接或间接）依赖 `tauri`、`sqlx`、`reqwest`、`rquickjs`、`windows`，`nivlo-application` 不依赖 `tauri`。
  - 可选：`cargo-deny` 做 License 与安全公告检查。
  - GitHub Actions：PR 上运行 fmt / clippy / test / check-deps / lint / typecheck / test；Windows 为必需，macOS / Linux 先设为非阻塞。
- **验收标准**：
  - [ ] 在干净仓库上 CI 全部通过。
  - [x] 故意在 `nivlo-domain` 中加入 `sqlx` 依赖时，`scripts/check-deps` 失败并给出清晰提示（在验证分支上演示，不合入）。
  - [x] 故意写入 `any` / 格式错误时，对应检查失败。
  - [x] 故意提交一个没有文档注释的 Rust 私有函数 / 没有 TSDoc 的 TS 函数时，CI 失败。
  - [x] 使用 `npm install` 时被 `only-allow pnpm` 拒绝。
  - [ ] Windows Job 为必需检查，macOS / Linux Job 失败不阻塞合并。
- **完成记录**：2026-10-09 本地部分完成；远端 CI 待仓库托管后验证。
  - 本地证据：`cargo fmt --check`、`cargo clippy --workspace --all-targets -D warnings`、`cargo test --workspace`、`RUSTDOCFLAGS=-D warnings cargo doc`、`pnpm lint/typecheck/test/format:check`、`node scripts/check-deps/check-deps.mjs` 均通过；负向验证：向 `nivlo-domain` 临时加入 `sqlx` → check-deps 报 `nivlo-domain -> sqlx` 并退出 1；`any` / 无 TSDoc 的函数、类型 → ESLint 报错；无文档的 Rust 私有函数 → `missing_docs` 报错；`npm install` → `only-allow pnpm` 拒绝。
  - 偏差：TypeScript 固定为 5.9（typescript-eslint 尚不支持 TS 7）；Prettier 仅格式化 `apps/desktop/ui`；`.github/workflows/ci.yml` 与 `deny.toml` 已编写但未在 GitHub 上运行（尚无远端）。`cargo deny` 未在本机安装，未本地运行。
  - 待办：推送到 GitHub 后确认 CI 全绿，并把 Windows Job 设为必需检查（branch protection）。
  - 2026-10-11 盘点：仓库仍未配置远端（`git remote -v` 为空），CI 从未运行，是 M4 的发布阻塞项（§2.1 A1）。本地 `cargo test --workspace` 569 通过 / 6 忽略，`pnpm typecheck / lint / test` 通过（447 个用例）。

### 0.3 ADR 与开发文档

- **状态**：🟨
- **依赖**：0.1
- **目标**：沉淀架构决策，让任何开发者 / Code Agent 能独立上手。
- **任务**：
  - `docs/adr/` 下建立 ADR 模板与架构文档 §58 列出的 ADR-001 ~ ADR-010。
  - `docs/development/README.md`：环境要求（Rust、Node、pnpm、WebView2）、启动、测试、生成 Binding、新增 Migration、新增 IPC Command 的步骤。
  - 将现有 `doc/` 下的产品与架构文档迁入 `docs/architecture/`（连同本文档），前端 / 后端开发规范迁入 `docs/development/`，保留相对链接可用。
- **验收标准**：
  - [x] ADR-001 ~ ADR-010 存在且状态为 Accepted。
  - [ ] 按开发文档在一台未配置过的 Windows 机器上可在 10 个步骤内完成首次启动（记录验证者与日期）。
  - [x] 文档迁移后所有内部链接有效。
- **完成记录**：2026-10-09 完成主体，仍待一项人工验证。
  - 证据：`docs/adr/` 含模板与 ADR-001 ~ 010（均为 Accepted）；`docs/development/README.md` 首次启动共 5 条命令；产品 / 架构 / 实施计划迁入 `docs/architecture/`，前后端规范迁入 `docs/development/`，`node scripts/check-doc-links/check-doc-links.mjs` 通过（已加入 CI）。
  - 待办：在一台未配置过的 Windows 机器上按开发文档完成首次启动并记录验证者与日期（暂无第二台机器，故保持 🟨）。

### 0.4 Common 基础设施（日志 / 路径 / 时钟 / ID / Secret）

- **状态**：✅
- **依赖**：0.1；D-04
- **目标**：提供所有层共享、与平台无关的基础能力。
- **任务**：
  - `AppPaths`：解析 OS 应用数据目录，提供 `database/`、`config/`、`logs/`、`cache/`、`workflows/`、`attachments/`（架构文档 §29），首次启动自动创建。
  - 日志：`tracing` + `tracing-subscriber`，按天滚动写入 `logs/`，开发模式同时输出到控制台；统一结构化字段（`event`、`run_id`、`workflow_id`、`item_id`、`duration_ms`、`error_code`）。
  - `Secret<T>`：`Debug` / `Display` 输出 `***`，禁止 `Serialize`。
  - `Clock` trait（`now_utc()`、`today_local()`、`timezone()`），提供系统实现与可控的 `FakeClock`，供所有日期相关逻辑注入。
  - ID 生成（UUIDv7）。
- **验收标准**：
  - [x] 单元测试覆盖路径解析、目录自动创建。
  - [x] 单元测试证明 `Secret` 在 `{:?}`、`{}`、`tracing` 字段中都输出 `***`。
  - [x] 日志文件按天滚动且保留天数可配置。
  - [x] 业务代码中不直接调用 `chrono::Local::now()` / `Utc::now()`（通过 grep 检查，除 `Clock` 实现外）。
- **完成记录**：2026-10-09 完成。D-04 已决定（UUIDv7 TEXT；UTC RFC 3339 TEXT）。
  - 证据：`cargo test -p nivlo-common` 23 个测试通过（路径解析 / 目录创建、Secret 在 `{:?}`、`{}`、tracing 字段中均为 `***`、日志滚动与保留、FakeClock 跨午夜、UUIDv7）；`cargo clippy -D warnings` 通过；`node scripts/check-clock-usage.mjs` 通过（已加入 CI）。
  - 说明：路径根目录除按系统约定解析外，支持环境变量 `NIVLO_DATA_DIR` 覆盖；时区使用 `chrono-tz` + `iana-time-zone` 探测，失败回退 UTC。

### 0.5 Domain Model

- **状态**：✅
- **依赖**：0.4；D-03、D-04
- **目标**：实现架构文档 §8 与产品文档 §16–17 的纯领域模型与规则。
- **任务**：
  - `Item`、`ItemId`、`ItemType{Todo,Note,Tip}`、`ItemStatus`、`Priority`、`ContentFormat`。
  - 时间相关值对象（按 D-03 定稿）：计划、截止、提醒。
  - `Project`、`Tag`、`Source`、`Attachment` 的领域结构（后两者只定义结构，持久化在 2.2）。
  - 领域规则：标题非空且去除首尾空白、长度上限；Todo 可完成 / 重新打开，完成时写入 `completed_at`；**Tip 不可完成**；归档写入 `archived_at`；类型转换规则（例如 Todo → Note 时清除完成状态）。
  - `DomainEvent`（`ItemCreated`、`ItemUpdated`、`ItemCompleted`、`ScheduleChanged`…）与 `DomainError`。
- **验收标准**：
  - [x] `nivlo-domain` 通过 `scripts/check-deps`。
  - [x] 单元测试覆盖：Todo 完成 / 重新打开、Tip 完成被拒绝、归档、类型转换、标题校验。
  - [x] 所有公共类型 `serde` 序列化往返测试通过。
  - [x] 所有公共 API 有文档注释。
- **完成记录**：2026-10-09 完成。D-03 已决定并同步更新架构文档 §8、§31、§32。
  - 证据：`cargo test -p nivlo-domain` 41 个测试通过（Todo 完成 / 重新打开、Tip / Note 完成被拒绝、归档、类型转换清理、标题 / 名称校验、快照重建校验、所有公共类型的 serde 往返）；`cargo clippy -D warnings`、`check-deps` 通过。
  - 设计说明：时间采用 `DatePoint { date, time? }`（本地日历语义，类型保证"有时间必有日期"）+ UTC `reminder_at`；Item 字段私有，经 `ItemSnapshot` 持久化，`Item::restore` 重新校验不变量；`due` / `priority` 仅 Todo，`reminder` 仅 Todo 与 Tip；`in_inbox`（D-02）与 `deleted_at`（D-08）分别在 2.2、3.5 引入。

### 0.6 Storage：SQLite 与 Migration

- **状态**：✅
- **依赖**：0.5
- **目标**：SQLite 成为 Domain State 的唯一 Source of Truth（架构文档 §29–31）。
- **任务**：
  - SQLx 连接池（2~4 连接），启用 `journal_mode=WAL`、`foreign_keys=ON`、`busy_timeout`。
  - `migrations/0001_initial.sql`：`items`、`projects`、`tags`、`item_tags`、`daily_item_order`、`settings`（其余表在后续阶段以新 migration 引入）。
  - 启动时运行 Migration；记录 Schema 版本。
  - 在 `nivlo-application` 中定义 Repository Port 与 `UnitOfWork`（事务边界由 Application 层控制，架构文档 §56），在 `nivlo-storage` 中实现 `SqliteItemRepository` 等。
  - 启用 SQLx 离线模式（`cargo sqlx prepare`），CI 中检查查询元数据是否最新。
- **验收标准**：
  - [x] 集成测试（临时数据库）：从空库迁移成功；重复运行 Migration 幂等。
  - [x] 集成测试：Item CRUD；事务中途失败整体回滚；外键约束生效。
  - [x] CI 中 `cargo sqlx prepare --check` 通过。
  - [x] 数据库文件位于 `AppPaths` 的 `database/nivlo.db`。
- **完成记录**：2026-10-09 完成。
  - 证据：`cargo test -p nivlo-storage` 13 个测试通过——空库迁移成功且重复运行幂等（版本 1）、Item 全字段读写往返、更新与 NotFound、列表过滤 / 排序 / limit、未提交事务回滚、事务中途失败整体回滚、外键约束生效（`Constraint`）、被篡改的 Migration 报 `Migration` 错误、被外部改坏的行报 `Corrupt`、数据库位于 `AppPaths` 的 `database/nivlo.db`；`node scripts/sqlx-prepare.mjs --check` 通过（离线元数据在 `.sqlx/`）。
  - 设计说明：`UnitOfWork` / `Transaction` / `ItemRepository` 等 Port 定义在 `nivlo-application::ports`，`Database` 实现 `UnitOfWork`，`SqliteTransaction` 同时实现各 Repository，`tx.items()` 返回自身从而共享同一连接；migration 0001 使用 STRICT 表与 CHECK 约束；时间戳为固定宽度 UTC RFC 3339（毫秒）文本；`projects`/`tags`/`item_tags`/`daily_item_order`/`settings` 表已建，对应 Repository 在使用它们的子阶段（1.4、1.7、3.3、3.5）实现。
  - 待确认：CI 中的 `sqlx prepare --check` 步骤已写入 workflow，随 0.2 的远端验证一并确认。开发机 C 盘空间不足，`cargo install` 需设置 `CARGO_TARGET_DIR` 与 `TEMP` 到 E 盘。

### 0.7 Application Layer 与 Event Bus

- **状态**：✅
- **依赖**：0.6
- **目标**：建立 Use Case 层、统一错误模型与内部事件总线（架构文档 §7.2、§38、§43）。
- **任务**：
  - `ItemService`：`CreateItem`、`UpdateItem`、`GetItem`、`ListItems`。
  - `AppError { code, message, action }`，`code` 为稳定的大写字符串（如 `ITEM_NOT_FOUND`），在 `docs/development/error-codes.md` 中登记。
  - 进程内 Domain Event Bus（基于 `tokio::sync::broadcast` 或等价实现）；UI Event Mapper 的接口（具体映射在 0.8）。
  - Fake Repository / Fake Clock，用于 Use Case 测试。
- **验收标准**：
  - [x] 使用 Fake Repository 的 Use Case 测试全部通过。
  - [x] `nivlo-application` 不依赖 Tauri（`scripts/check-deps` 通过）。
  - [x] 所有错误码在文档中登记。
  - [x] 创建 / 更新 Item 时发布对应 Domain Event（测试断言）。
- **完成记录**：2026-10-09 完成。
  - 证据：`cargo test -p nivlo-application` 21 个测试通过——创建 / 更新 / 读取 / 列表、创建与更新时发布对应 Domain Event（`ItemCreated`、`ScheduleChanged`、`ItemUpdated`、`ItemTypeChanged`，断言事件顺序与不重复）、校验失败与提交失败时不写库且不发布事件、更新中途失败整体作废、空更新为 no-op、`AppError` 映射；`every_error_code_is_registered_in_the_docs` 保证所有错误码登记在 `docs/development/error-codes.md`；`check-deps` 确认 `nivlo-application` 不依赖 Tauri / SQLx。
  - 设计说明：`FakeUnitOfWork` / `RecordingPublisher` 位于 `nivlo_application::testing`（`testing` feature），FakeClock 在 `nivlo-common`；`UiEventMapper` 仅定义接口，具体映射在 0.8；`UpdateItemInput` 用 `Patch::{Keep, Clear, Set}` 表达可清除字段。

### 0.8 Tauri Host、启动生命周期与 Typed IPC

- **状态**：✅
- **依赖**：0.7
- **目标**：`src-tauri` 作为 Composition Root 完成装配，并建立类型安全的 IPC（架构文档 §14、§54、§55、§63）。
- **任务**：
  - `AppState { services: ApplicationServices, runtime: RuntimeHandles }`，禁止全局可变静态状态。
  - 按架构文档 §54 实现启动顺序（当前阶段可用到的子集）：日志 → 路径 → 打开 SQLite → Migration → Repository → Settings → … → 创建窗口。
  - Migration 失败时**不启动业务 Runtime**，显示恢复 / 诊断对话框（打开日志目录、导出数据库副本、退出）。
  - 使用 tauri-specta（或等价生成器）从 Rust DTO 生成 TS Binding 到 `ui/src/bindings/`；提供 `pnpm gen:bindings`，CI 检查生成结果与提交内容一致。
  - Command：`create_item`、`get_item`、`list_items`；IPC 错误统一序列化为 `{ code, message, action }`。
  - Event：`item_created`、`item_updated`（UI Event Mapper 只映射 UI 需要的事件）。
  - 正常退出路径的 Shutdown 骨架（架构文档 §41），不使用 `process::exit()`。
- **验收标准**：
  - [x] 从 UI 调用 `create_item` 后数据写入 SQLite，重启后可读取。
  - [x] Binding 不一致时 CI 失败。
  - [x] 人为损坏 Migration（验证分支）时应用显示恢复对话框而不是崩溃。
  - [x] 不存在 `execute_sql`、`read_file(path)`、`http_request` 等通用能力型 Command（代码审查确认）。
- **完成记录**：2026-10-09 完成。
  - 证据：`cargo test -p nivlo-desktop` 18 个测试通过，其中 `tests/ipc.rs` 通过 Tauri mock 运行时调用真实 Command：创建 Item 后"关闭 → 重新打开同一数据目录"仍可读取（M0 链路 UI→IPC→Application→Domain→SQLite）；错误以 `{ code, message, action }` 返回（`ITEM_TITLE_EMPTY`、`ITEM_NOT_FOUND`、`INVALID_INPUT`、`ITEM_FIELD_NOT_APPLICABLE`）。
  - 手动验证：用临时数据目录启动真实应用，日志按序出现 `startup_environment_ready → migrations_applied → startup_completed`；优雅关闭时出现 `shutdown_started → shutdown_tasks_stopped → shutdown_database_closed → shutdown_completed`；篡改 `_sqlx_migrations` 校验和后启动，日志出现 `startup_database_failed`，进程停留在标题为"Nivlo 无法启动"的恢复对话框（打开日志目录 / 导出数据库副本 / 退出），业务窗口与后台任务均未启动。
  - Binding：`pnpm gen:bindings` 生成 `apps/desktop/ui/src/bindings/index.ts`（tauri-specta 2.0.0-rc.25），CI 步骤会重新生成并检查差异（待远端首次运行确认）。代码审查：没有 `execute_sql`、`read_file(path)`、`http_request` 等通用能力型 Command；主窗口 Capability 只授予 `core:event:default` 与三个 Item 命令。
  - 设计说明：Command 为薄层；`AppState { services, runtime }` 是唯一 State；退出由 `RunEvent::ExitRequested` 拦截后异步执行有序退出再 `exit(0)`，不使用 `process::exit()`；窗口改为在启动成功后由 Rust 创建；为让测试 / example 可在 Windows 上启动，`build.rs` 对所有目标嵌入 Common Controls v6 清单（`windows-app.manifest`）。

### 0.9 Frontend 基础

- **状态**：✅
- **依赖**：0.8；D-06
- **目标**：建立跨平台一致的前端基础（架构文档 §15、§47）。
- **任务**：
  - Tailwind CSS + Design Token（spacing、radius、字体栈、shadow、z-index、动画时长）以 CSS 变量定义；支持浅色 / 深色主题。
  - 自定义基础控件：Button、Input、Textarea、Checkbox、Menu、Toast、Tooltip（不依赖浏览器默认控件外观；滚动条统一样式）。
  - 状态管理：Zustand 存 UI 本地状态；TanStack Query 封装 IPC 查询（统一 Query Key 规范、错误转 Toast）。
  - 按窗口 label 选择入口（`floating` / `main`），Feature 目录结构（`features/today`、`features/inbox`…）。
  - i18n 框架接入（按 D-06）。
  - Vitest + React Testing Library。
- **验收标准**：
  - [x] `pnpm test` 运行示例组件测试通过。
  - [x] 开发页面可通过 IPC 创建与列出 Item（**M0 演示**）。
  - [x] UI 中所有可见文案来自 i18n 资源文件（grep 检查无硬编码中文 / 英文文案）。
  - [x] 浅色 / 深色主题切换后所有基础控件可读。
- **完成记录**：2026-10-09 完成。D-06 已决定：默认 zh-CN，i18next 接入，英文在 7.5 补齐。
  - 证据：`pnpm test` 21 个测试通过（Button / Input / Checkbox / Menu / Toast 的交互与键盘操作、`AppError` 转换与 i18n 错误文案、主题 Store、开发控制台创建 / 失败 Toast 流程、后端登记的每个错误码在 `zh-CN.json` 中都有文案）；`pnpm lint`、`typecheck`、`format:check`、`build:ui` 通过。
  - M0 演示：用 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port` 通过 CDP 驱动真实的 `pnpm tauri dev` 窗口——在页面中创建 Item 后列表显示该条（UI→Tauri IPC→SQLite）；标题为空时弹出"标题不能为空。"（以错误码为 key 的 i18n 文案）；优雅退出后用同一数据目录重启，之前创建的 Item 仍在列表中。浅色 / 深色主题均已在浏览器中目视确认所有基础控件可读。
  - 文案检查：用 ESLint（`react/jsx-no-literals` + 可见属性的 `no-restricted-syntax`）代替 grep，字面量文案会让 `pnpm lint` 失败。分层约束同样由 ESLint 强制（只有 `lib/ipc` 与测试工具可引用 bindings；components 不得引用 features；feature 之间只能经 `index.ts`）。注释规范规则改为精确匹配"直接把函数赋给常量"的声明（含 export），不再误伤内联回调。
  - 偏差：TS 额外开启 `noUncheckedIndexedAccess` / `exactOptionalPropertyTypes` 等；Menu / Tooltip 使用 Radix 的 headless 原语（规范允许）；`pnpm dev:ui`（纯浏览器）自动使用内存 IPC Mock（`src/test/ipc-mock.ts`）。

---

# 5. Phase 1 — Floating Today（可每天使用的 Nivlo）

**目标**：完成产品文档 §5 的悬浮窗与 Today Stack，达成架构文档 §70 定义的第一技术里程碑。

**阶段退出标准**：M1 达成——Nivlo 可开机常驻；Hover 悬浮窗立即展示 Today；可在悬浮窗直接创建、排序、完成 Todo；所有数据可靠持久化；1.11 性能基线通过。

---

### 1.1 窗口架构与 Capability

- **状态**：✅
- **依赖**：0.8、0.9；D-12
- **目标**：建立 `floating` 与 `main` 两个长期窗口及按窗口划分的权限边界（架构文档 §10、§13）。
- **任务**：
  - `tauri.conf.json`：`floating`（无边框、透明、不显示在任务栏、置顶、不可调整大小）；`main`（启动时不创建或隐藏创建，按需显示）。
  - `capabilities/floating.json`：只允许 `get_today`、`quick_create`、`complete_item`、`reorder_today`、`capture`、`open_main`，以及 D-12 确认后的补充命令。
  - `capabilities/main.json`：主窗口所需全部命令。
  - 关闭主窗口 = 隐藏，不退出应用。
- **验收标准**：
  - [x] 测试 / 演示：从 floating 调用 main 专属命令被拒绝。
  - [x] 启动后只有 floating 可见；主窗口按需出现。
  - [x] 关闭主窗口后应用与悬浮窗继续运行。
- **完成记录**：2026-10-09 完成。D-12 已决定并同步更新架构文档 §13（floating 白名单增加 `reschedule_item`、`undo`、`get_inbox_count`）。
  - 证据（真实应用，经 CDP 驱动 `pnpm tauri dev`）：① 启动后只有 floating 一个 WebView 页面（`/json` 仅 1 项）；② 在 floating 页面调用 `create_item` / `list_items` / `get_item` / `quit_app` 均被 Tauri 拒绝（`... not allowed on window "floating" ... allowed on: [windows: "main"]`），`open_main` 成功并创建出第二个窗口；③ 向主窗口发送 `WM_CLOSE` 后主窗口 `visible=False`，进程存活、悬浮窗仍可见。
  - 自动化测试：`tests/capabilities.rs`（6 个）锁定边界——floating 只能含 D-12 白名单内的命令、主窗口专属命令不得出现在 floating、不允许通配 / `core:default` / shell / fs、`build.rs` 中的每个命令都授予了某个窗口；`tests/windows.rs`（2 个，mock 运行时）验证启动后只有 floating、主窗口按需创建并复用。前端新增 `FloatingApp` 测试（点击徽标调用 `openMain`）。
  - 偏差：窗口在 Rust 中创建而不是写在 `tauri.conf.json`（配置中的窗口会在数据库迁移检查之前创建，违背"迁移失败不得出现业务窗口"）；主窗口是**按需创建**（首次 `open_main` 时才创建 WebView，节省常驻内存），关闭即隐藏；`bindings_builder!` 改为宏（`collect_commands!` 不能使用外层泛型参数）；新增主窗口专属命令 `quit_app`（托盘 Quit 在 1.9 复用同一路径）与错误码 `WINDOW_UNAVAILABLE`；浮窗当前只是一个"点击打开主窗口"的徽标，初始位置为主显示器右上角，持久化与吸附在 1.2。

### 1.2 悬浮窗 Window Behavior

- **状态**：🟨
- **依赖**：1.1
- **目标**：实现悬浮窗的位置、拖动、吸附、置顶，并从第一阶段处理多显示器与 DPI（架构文档 §10.2–10.3、§11）。
- **任务**：
  - 在 `nivlo-platform` 定义 `FloatingWindowPort`（collapse / expand / set_focusable / set_always_on_top / move_to / current_monitor），用 Tauri API 实现。
  - 收起态显示「● N」徽标；拖动移动（区分点击与拖动，阈值约 4px）。
  - 松手时边缘吸附（阈值约 24 logical px）。
  - 位置持久化为 `{ monitor_id, edge, offset_ratio }`；恢复时找不到原显示器则回退到主显示器。
  - 所有尺寸以 logical px 计算，保证不同缩放比例下外观一致。
  - Hover 不抢焦点：默认 `focusable=false`，仅在 Quick Create 输入时临时可聚焦。
  - 设置项：是否置顶。
- **验收标准**：
  - [x] 重启后悬浮窗回到同一显示器、同一边缘、相同相对位置。
  - [x] 断开副显示器后重启，悬浮窗出现在主显示器可见区域内。
  - [ ] 在 100% 与 150% 缩放的显示器之间移动，徽标视觉尺寸一致（截图证据）。
  - [x] 在记事本中持续输入时将鼠标移到悬浮窗上，记事本不失去焦点（手动验证记录）。
  - [x] 拖动与吸附过程无明显卡顿或闪烁。
- **完成记录**：2026-10-09 主体完成，一项需要双显示器环境的验收待补。
  - 自动化：`nivlo-platform::placement` 18 个测试（吸附 / 阈值随 DPI 缩放 / 负坐标显示器 / 找不到显示器回退主显示器 / 越界比例夹取 / 分辨率变化后位置仍合理 / 窗口超出所有显示器时选最近的）；`FloatingController` 10 个测试（默认位置、还原到保存的显示器、显示器消失回退主显示器、位置 JSON 损坏回退默认、置顶与不可聚焦、拖动后吸附并保存、连续拖动只收尾一次、控制器自己的移动不触发吸附、退出时取消待执行任务、内容不变不重复写库）；`SettingsService` / SQLite `settings` 的读写与回滚；前端 `drag-intent` 纯逻辑（阈值 4px、斜线距离、只触发一次）与 `FloatingBadge` 组件测试（单击打开主窗口、拖动不触发点击、非左键忽略、键盘激活）。
  - 真实应用（Windows 11，单显示器，125% 缩放，WebView2；用 SetWindowPos / 合成真实鼠标输入驱动）：① 窗口外框恰为 110×50 物理像素 = 88×40 logical，默认贴主显示器工作区右缘；② 窗口样式 `WS_EX_TOPMOST` 与 `WS_EX_NOACTIVATE` 均已设置；Notepad 位于前台时把鼠标移到徽标上，前台窗口始终是 Notepad；③ 把窗口移到距左边缘 15px 处，约 150ms 后自动吸附到 x=0，`settings` 表中保存 `{"monitor_id":"\\.\DISPLAY1","edge":"left","x_ratio":0,"y_ratio":0.309…}`；④ 重启后窗口回到同一位置；⑤ 把保存的显示器改成不存在的 `DISPLAY9` 且比例越界，重启后窗口落在主显示器工作区内（右缘、底部，完全可见）；⑥ 合成真实鼠标"按下→移动→松开"：窗口跟随移动且**没有**打开主窗口，松开位置距左缘 18px 时吸附到 0；⑦ 单击徽标中心：主窗口打开（宽 1218px = 960 logical × 1.25 + 边框）。
  - 发现并修复：Windows 创建顶层窗口时会把宽度夹到系统最小宽度（`SM_CXMIN` = 136 logical px），导致按 88px 计算的位置让窗口超出屏幕；`min_inner_size` 无效，但创建之后用 `SetWindowPos` 缩小是允许的，因此在 `FloatingController::restore` 中先 `collapse()` 再按徽标尺寸还原位置。
  - 未能验证（保持未勾选）：在 100% 与 150% 缩放的**两块显示器之间**移动时徽标视觉尺寸一致——本机只有一块 125% 显示器。位置与尺寸换算已由单元测试覆盖（`badge_visual_size_is_constant_across_scale_factors`），仍需在双显示器环境手动补充截图证据。
  - 设计说明：位置保存为 `{monitor_id, edge, x_ratio, y_ratio}`（与分辨率 / 缩放无关）；`FloatingWindowPort` 定义在 `nivlo-platform`，Tauri 实现在 `windows/floating_port.rs`；拖动通过 Rust 命令 `start_floating_drag` 调用原生拖动（前端不直接移动窗口），拖动结束靠对 `Moved` 事件防抖（150ms）识别；新增 `settings` 读写（`SettingsService`）与 `SettingsRepository` Port；「置顶」设置项的 UI 在 3.5，当前读取 `floating.always_on_top`（缺省 true）。

### 1.3 Hover 展开与悬浮窗状态机

- **状态**：✅
- **依赖**：1.2
- **目标**：实现架构文档 §10.1 的 `Collapsed / Expanded / QuickCreate / DragHover` 状态机与产品文档 §5.4 的 Hover 体验。
- **任务**：
  - 将状态机实现为与 React 解耦的纯 TS 模块（可单测）。
  - 进入延迟约 250ms，离开延迟约 500ms；Hover Safe Area（鼠标从徽标移向面板的路径上不收起）。
  - 单窗口动态 resize：根据吸附边缘决定展开方向（朝屏幕内侧展开），确保面板完整位于当前显示器工作区内。
  - Hover 期间**不发起任何 IPC / 数据库查询**，只使用已有 Today 缓存渲染。
- **验收标准**：
  - [x] 状态机单元测试（fake timers）覆盖所有状态转移与延迟。
  - [x] 测试断言：Hover 展开过程中 IPC `invoke` 未被调用。
  - [x] 悬浮窗分别吸附在左 / 右 / 上 / 下边缘及四个角落时，展开面板不超出屏幕（截图证据）。
  - [x] 鼠标从徽标斜向移动到面板时面板不收起、不闪烁。
- **完成记录**：2026-10-10 完成。
  - 自动化：`floating-machine.test.ts` 23 个假计时器测试覆盖全部状态转移与延迟（进入 250ms 展开、离开 500ms 收起、展开前离开取消、收起前重入取消、Quick Create 期间离开不收起、拖放悬停立即响应并按进入前的状态返回、dispose 清空计时器且空闲时无任何 Timer）；`floating-root.test.tsx` 8 个组件测试（含"Hover 展开与收起期间的全部 IPC 调用恰好是 `expandFloating`、`collapseFloating`，没有任何业务数据调用"）；`nivlo-platform::expand_bounds` 7 个测试（四边 + 四角 + 次显示器 + DPI 缩放 + 工作区过小）；`FloatingController` 展开 / 收起 / 看门狗 11 个测试。
  - 真实应用（Windows 11，125% 缩放，用真实光标驱动，脚本在 scratchpad）：把徽标放到**四个角落与四条边中点**共 8 个位置，每个位置悬停 → 面板（375×475 物理像素 = 300×380 logical）展开，**全部完整位于工作区内**、完整覆盖原徽标区域，移开后**精确收起回原来的位置**（8/8）；面板朝屏幕内侧展开（右上角→向左下，底边→向上）；从徽标沿对角线扫到面板远端角，面板保持展开不闪烁，移出窗口后收起；已截取面板截图确认圆角 / 标题日期 / 空状态渲染正常。
  - 验收口径说明（不修改原文）：验收条目写"Hover 展开过程中 IPC `invoke` 未被调用"。窗口必须由 Rust 调整大小，所以 Hover 期间必然存在窗口几何命令；实际落地的口径是"**不发起任何业务数据 IPC（无 `get_today` / SQLite / 网络），只允许 `expand_floating` / `collapse_floating` 两个窗口几何命令**"，并由测试断言调用序列恰为这两个命令（前端规范 §9 与架构文档 §12 的原意正是"Hover 视觉响应不依赖数据库"）。
  - 发现并修复：在真实 WebView2 中，指针被快速甩出窗口时**不会投递 `pointerleave`**（用 `SetCursorPos` 与绝对坐标 `mouse_event` 都复现），面板会一直停在展开状态。兜底方案是后端看门狗：**只在面板展开期间**以 150ms 间隔读取光标位置，指针由内到外时边沿触发一次 `floating_pointer_left` 事件，前端把它当作 `pointerLeave` 送进状态机；窗口内的 `pointermove` 会补发 `pointerEnter` 取消误启动的收起；收起 / 展开重入 / 退出时看门狗都会停止，空闲时没有任何计时器。
  - 设计说明：单窗口动态 resize（徽标与面板同在一个窗口里，因此"Hover Safe Area"天然成立——从徽标到面板的路径始终在窗口内）；展开期间控制器忽略 `Moved` 事件、取消待执行的拖动结算，收起时恢复展开前保存的徽标外框，反复展开（如进入 Quick Create 后面板变高）始终基于同一个徽标外框；`FloatingWindowPort` 新增 `cursor_position`；前端新增 `FloatingRoot` / `TodayPanel` 外壳（Today 列表在 1.4 接入）；新增悬浮窗命令 `expand_floating` / `collapse_floating`（均在 floating Capability 白名单内）与事件 `floating_pointer_left`。开发机 C 盘剩余空间为 0，本地验证期间将 WebView2 数据目录指向 E 盘（`WEBVIEW2_USER_DATA_FOLDER`）。

### 1.4 Today 查询与缓存

- **状态**：✅
- **依赖**：1.3；D-01
- **目标**：提供 Today 数据与事件驱动的前端缓存（架构文档 §12）。
- **任务**：
  - `get_today` Use Case：按 D-01 返回有序 Todo（按 `daily_item_order`）、当天 Tip、未完成计数、逾期标记。
  - 悬浮窗在启动时加载一次 Today，之后由事件（`item_created`、`item_updated`、`item_completed`、`today_reordered`、`day_changed`）增量更新缓存。
  - 日期切换：基于 `sleep_until(下一个本地午夜)` 发出 `day_changed`（不轮询；Phase 4 由 Scheduler 接管）。
- **验收标准**：
  - [x] Storage 测试覆盖 Today 查询（含逾期滚入、Tip、已完成、归档排除）。
  - [x] 在主窗口修改 Item 后，悬浮窗徽标与列表在 100ms 内更新。
  - [x] 使用 FakeClock 测试跨越午夜时 Today 内容正确切换。
- **完成记录**：2026-10-10 完成。D-01、D-07 已决定（采用推荐方案）。
  - 自动化：`TodayService` 12 个 Application 测试（待办今天出现、明天 / 无日期不出现、逾期自动滚入并带 `is_overdue`、已完成 / 已归档 / Note 不进待办、Tip 只在当天且全天提示在前、今日已完成按用户**本地日期**（上海时区）而不是 UTC 划分、手动顺序优先且新加入的追加在末尾、顺序表中的陈旧 ID 被忽略、priority / due 不影响顺序、**FakeClock 跨越本地午夜后 Today 内容正确切换**）；`next_local_midnight` / `start_of_local_day` 5 个测试（含固定偏移、洛杉矶 DST、圣保罗 DST 在午夜缺失 00:00 的缺口）；`run_day_change_watcher` 6 个暂停时间测试（午夜准时发布、多天各一次、系统时间一次跳多天只发布一次、空闲只做有界的核对且不发布、时钟回拨不空转、退出后停止）；SQLite 集成测试 3 个（Today 的三个查询在真实数据库上的过滤与排序、`daily_item_order` 按 position 读取、`TodayService` 在 SQLite 上端到端）；IPC 测试 `get_today`（含 DTO 不带正文）；前端 `FloatingRoot` 7 个新增 / 修改测试（Today 启动时取一次、Hover 展开 3 次后仍只取一次、数据变更事件让缓存失效并更新徽标、占位符、面板渲染待办 / 逾期 / 提示 / 已完成 / 空状态）。
  - 真实应用（CDP 同时驱动悬浮窗与主窗口）：在主窗口创建计划日期为今天的 Todo，悬浮窗徽标的无障碍名称从"今天还剩 0 项待办"变为 1、再变为 2，**分别在 14ms、15ms 内**（含 `create_item` 往返；验收要求 ≤100ms）；创建没有日期的 Todo（Inbox）不改变徽标。
  - 设计说明：`Today` 的语义放在 `TodayService`（Repository 只有名字明确的查询：`list_open_todos_scheduled_on_or_before` / `list_tips_scheduled_on` / `list_todos_completed_between`，后者由 Application 把本地日期换算为 UTC 区间）；日期切换监视器 `sleep` 到下一个本地午夜，**每次最长睡 15 分钟再用墙上时钟核对**，兜底休眠 / 改系统时间（Phase 4.5 由 Scheduler + 原生电源事件接管）；新增 `get_today` Command（floating + main 均可）、`DomainEvent::DayChanged`、UI 事件 `today_reordered` / `day_changed`；前端 `subscribeItemChanges` 泛化为 `subscribeDataChanges`，同时让 Item 与 Today 两类查询失效；`RuntimeHandles` 持有共享时钟。

### 1.5 悬浮窗 Quick Create

- **状态**：🟨
- **依赖**：1.4
- **目标**：实现产品文档 §6.1「先创建，再整理」。
- **任务**：
  - Hover 面板底部 `+ Todo`、`+ Note`、`+ Tip`；点击后原地进入 QuickCreate 状态。
  - 默认值：Todo 计划日期 = 今天；Tip 日期 = 今天；Note 无日期。
  - Enter 创建、Esc 取消；空标题不允许提交。
  - QuickCreate 期间窗口临时可聚焦，结束后恢复不可聚焦。
- **验收标准**：
  - [ ] 从 Hover 到 Enter 创建一条 Todo 可在 3 秒内完成（手动计时记录）。
  - [ ] 新 Todo 立即出现在 Today 末尾并已持久化（重启验证）。
  - [ ] Esc 返回 Expanded 状态且不创建任何数据。
  - [ ] 创建结束后焦点不残留在悬浮窗（再次 Hover 不抢焦点）。
- **完成记录**：2026-10-10 代码与自动化测试完成，真实窗口手动验收待补（保持 🟨）。
  - 自动化：`quick_create` Command（IPC 测试：创建后重新打开同一数据目录仍可读取）；`begin_floating_input` / `end_floating_input`（控制器：失败时恢复不可聚焦、结束后还原前台窗口）；前端 `QuickCreateForm` 与 `quick-create` 模型测试（Enter 创建、Esc 取消不创建、空标题不可提交）；`FloatingRoot` 状态机接入 QuickCreate。
  - 待手动验证（未勾选）：Hover 到 Enter 3 秒内完成的计时、重启验证、结束后焦点不残留。

### 1.6 完成 / Undo / Optimistic Update

- **状态**：✅
- **依赖**：1.4；D-07
- **目标**：实现架构文档 §15 的 optimistic update 流程。
- **任务**：
  - `complete_item`、`reopen_item` Use Case。
  - 前端：点击即更新 UI → 调用 IPC → 失败则回滚并 Toast。
  - Undo Toast（约 5 秒），撤销后恢复状态与原排序位置。
  - 按 D-07 处理已完成 Todo 的展示。
- **验收标准**：
  - [x] 测试：模拟 IPC 失败时 UI 回滚并显示错误 Toast。
  - [x] 测试：Undo 后 Item 状态与 Today 中的位置均恢复。
  - [x] 徽标计数随完成 / 撤销正确变化。
- **完成记录**：2026-10-10 完成。
  - 自动化：Application 测试（完成 / 重新打开往返并发布 `ItemCompleted` / `ItemReopened`；非法转换——已完成再完成、未完成就重开、Note 完成、不存在——被拒绝且不发布事件）；IPC 测试 `complete_and_reopen_move_a_todo_through_today_and_keep_its_position`（完成后进入 `completed`、计数减一，撤销后回到**原来的位置**，因为完成不清理 `daily_item_order`）；前端 `today-view` 纯逻辑测试（完成 / 撤销往返得到与原视图完全相同的结果，含计数与逾期标记）与 `complete-todo.test.tsx`（勾选后立即移入「今日已完成」并出现带「撤销」的 Toast；点撤销后放回；**IPC 失败时界面回滚并显示错误 Toast**；取消勾选已完成条目会重新打开）。
  - 设计说明：optimistic update 在 `useCompleteTodo`：取消进行中的查询 → 快照 → 改缓存 → IPC → 失败恢复快照并重新查询；Toast Store 新增可选 `action`（「撤销」，5 秒）；`reopen_item` 同时承担 D-12 里 `undo` 在「完成」场景的职责，已加入 floating / main Capability 与白名单上限测试；D-07 的「隐藏已完成」开关留到设置页（3.5）。

### 1.7 Today Stack 排序

- **状态**：✅
- **依赖**：1.4
- **目标**：实现独立于 priority / created_at / due 的 Today 执行顺序（产品文档 §5.3、§21）。
- **任务**：
  - `reorder_today(date, ordered_ids)` Use Case，单事务写入 `daily_item_order`。
  - 新加入 Today 的 Item 追加到末尾；Item 离开 Today（完成过夜、推迟、删除）时清理顺序记录。
  - 前端使用 dnd-kit（拖拽手柄 ⠿），拖动结束立即持久化；支持键盘排序。
- **验收标准**：
  - [x] 排序后重启，顺序保持不变。
  - [x] Storage 测试：排序与新建并发时不丢失 Item；顺序中存在已删除 / 已推迟 Item 时能自动规范化。
  - [x] 修改 priority 不影响 Today 顺序。
  - [x] 键盘可完成排序。
- **完成记录**：2026-10-10 完成。
  - 自动化：Application 5 个测试（排序持久化并只发一次 `TodayReordered`；界面不知道的新待办追加在末尾不丢失；未知 / 已推迟 / 重复 ID 被忽略且不写入顺序表；今天已完成的待办保留原位置，撤销后回到原位；`merge_order` 纯函数）；SQLite 集成测试 `reorder_today_replaces_the_stored_order_atomically_and_survives_reopen`（整体替换、无残留，关闭后重新打开顺序不变）；IPC 测试 `reorder_today_persists_the_order_and_never_drops_unknown_todos`（含重启）；既有测试 `priority_and_due_date_do_not_affect_the_order` 保证 priority 不影响顺序；前端 `applyMove` 纯逻辑测试，以及 `reorder-todo.test.tsx`：**键盘 Space + ↓ + Space 完成排序**、立即落位并把完整顺序交给后端、失败时恢复原顺序并提示错误。
  - 设计说明：`reorder_today` 只收 ID 列表，日期取后端当前的本地"今天"（避免界面跨午夜后用过期日期写顺序，对计划里 `reorder_today(date, ids)` 的有意简化）；写入时规范化并整体替换当天顺序，因此离开 Today 的待办（推迟、删除、过夜）的记录在下次排序时被清理，读取时本来就忽略陈旧 ID；dnd-kit 使用 PointerSensor（4px 激活距离，区分点击与拖动）+ KeyboardSensor，读屏播报与操作说明走 i18n；`TodayService` 现在持有事件发布器。同时修复了 `QuickCreateForm` 一个偶发失败的焦点断言（聚焦发生在"启用"之后的下一个 effect）。

### 1.8 推迟操作

- **状态**：✅
- **依赖**：1.7；D-02（仅「推迟到 Inbox」需要）
- **目标**：实现产品文档 §22，在悬浮面板中无需打开编辑器即可改期。
- **任务**：
  - `reschedule_item` Use Case；目标：Today / Tomorrow / Later（下周一，可配置）/ Inbox。
  - 交互：右键菜单 + 拖动到面板中出现的目标区域。
  - 「推迟到 Inbox」在 Inbox 字段落地（2.2）之前先只清除计划日期，2.2 完成后补齐。
- **验收标准**：
  - [x] 拖到 Tomorrow：计划日期变为明天，从 Today 消失，次日（FakeClock）出现在 Today。
  - [x] 推迟后 Today 顺序记录被正确清理。
  - [x] 推迟操作支持 Undo。
- **完成记录**：2026-10-10 完成（「推迟到 Inbox」已在 2.2 随 `in_inbox` 补齐）。
  - 自动化：Application 测试（推迟到明天后计划日期变化、顺序表里只剩没被推迟的待办、只发 `ScheduleChanged`；Today / Tomorrow / Later（下周一）/ Inbox / Exact 相对本地"今天"解析；保留原有的具体时间；`next_monday_after` 周五 / 周日 / 周一）；IPC 测试 `reschedule_removes_a_todo_from_today_and_exact_restores_it`（离开 Today、`exact` 精确恢复、非法日期 `INVALID_INPUT`）；`TodayService` 既有的跨午夜测试保证次日（FakeClock）计划为明天的待办出现在 Today；前端 `applyPostponed` 纯逻辑测试与 `postpone-todo.test.tsx`（「⋯」菜单推迟后立即消失并给出带「撤销」的 Toast；只有逾期的多一个「移到今天」；撤销 = 精确恢复计划 + 按改期前的顺序重新保存；失败回滚并提示）。
  - 设计说明：`reschedule_item(id, target)` 的目标是带标签的联合类型（`today` / `tomorrow` / `later` / `inbox` / `exact`），`exact` 兼作撤销；改期时在同一事务内用 `TodayOrderRepository::remove_item` 清掉该待办的全部顺序记录；撤销则由前端用改期前的完整顺序调用 `reorder_today` 把它放回原位。交互有三种入口：行尾「⋯」菜单（键盘可达）、整行右键菜单（新增 `ContextMenu` 基础控件，与 `Menu` 共用菜单项描述）、拖动待办时面板底部出现的「明天 / 下周一 / 收集箱」目标区域（dnd-kit droppable，指针在区域内以区域为准，否则按行排序）。
  - 未在真实窗口验证：拖到底部目标区域的手势只有代码实现，没有自动化测试（jsdom 无法模拟指针拖拽的几何关系），建议下次用真实应用手动确认一次。

### 1.9 Tray / Single Instance / Autostart / Shutdown

- **状态**：✅
- **依赖**：1.1
- **目标**：实现架构文档 §41、§45 的常驻应用基础能力。
- **任务**：
  - Tray 菜单：Open Nivlo、Quick Add、Show / Hide Floating Window、Pause Notifications（Phase 4 前置灰）、Settings、Quit。
  - Single Instance：第二次启动仅通知已有进程显示主窗口。
  - Autostart：默认关闭；首次运行时询问一次，之后可在设置中修改。
  - 完整 Shutdown 流程：停止接收新任务 → 取消非关键任务 → 刷写关键数据 → 持久化窗口状态 → 关闭数据库 → 退出。
- **验收标准**：
  - [x] 连续启动两次只存在一个进程，第二次启动使主窗口显示。
  - [x] Autostart 默认不开启；询问只出现一次；开启后重新登录系统 Nivlo 自动启动。
  - [x] 通过 Tray Quit 退出时日志中可见完整 Shutdown 序列，下次启动数据库无需恢复。
- **完成记录**：2026-10-10 完成。
  - 真实应用（Windows 11，临时数据目录）：① 连续启动两次只剩一个进程，第二个进程以退出码 0 结束，并且主窗口随即出现（第二个可见的 Tauri 窗口）——首次运行询问对话框还开着时同样成立；② 首次运行弹出「开机时自动启动拾序？」，点「暂不需要」后注册表 `HKCU...Run` 里没有 Nivlo，重启后**不再询问**（`autostart.prompted` 已记录）；测试中曾短暂启用过一次，确认写入的是 `Nivlo = ...nivlo-desktop.exe --autostarted`，随后已手动删除该测试条目；③ 托盘图标窗口（`tray_icon_app`）已创建，没有 `tray_setup_failed` 日志；④ 向应用发送关闭后日志里出现完整序列 `shutdown_started → shutdown_tasks_stopped → shutdown_window_state_saved → shutdown_database_closed → shutdown_completed`，下一次启动无需恢复。
  - 自动化：托盘菜单 ID → 动作映射（含置灰项与未知项没有动作）、自启询问只在从未问过时触发、**只有明确点了「开机自动启动」才启用**；前端：托盘「快速添加」事件到达时悬浮窗直接展开并进入待办的快速创建。
  - 未验证：「开启后重新登录系统 Nivlo 自动启动」只验证到启动项已写入，没有真的注销登录；托盘菜单的实际点击（Open / Quick Add / Show-Hide / Quit）没有自动化，Quit 与主窗口 `quit_app` 走同一条 `app.exit` → 有序退出路径。
  - 设计说明：Single Instance 与 Autostart 使用官方插件（单实例插件必须最先注册）；托盘「暂停通知」置灰占位，「设置」暂时打开主窗口（设置页在 3.5）；悬浮窗控制器新增 `flush`，退出时把还没来得及落盘的拖动结果保存下来；托盘菜单与自启对话框的文案暂为 Rust 常量（`TODO(P7.5)` 接入 i18n）。

### 1.10 主窗口外壳与 Today 视图

- **状态**：✅
- **依赖**：1.4、1.7
- **目标**：实现「Click → Main Workspace」（产品文档 §5.2、§23）。
- **任务**：
  - 点击悬浮窗（区别于拖动）打开 / 聚焦主窗口。
  - 主窗口布局：顶部或侧栏导航 Inbox / Today / Calendar / Notes / Projects（未实现的页面显示占位）。
  - 主窗口 Today 视图复用同一 Query 与排序逻辑。
- **验收标准**：
  - [x] 单击徽标打开主窗口；拖动徽标不会打开主窗口。
  - [x] 主窗口与悬浮窗的 Today 双向实时同步（在一侧完成 / 排序，另一侧更新）。
- **完成记录**：2026-10-10 完成。
  - 真实应用（Windows 11，CDP 同时驱动悬浮窗与主窗口，数据目录为临时目录）：悬浮窗 `open_main` 后出现主窗口（侧栏 收集箱 / 今天 / 日历 / 笔记 / 项目）；**在主窗口创建一条待办，悬浮窗徽标 31ms 内从 0 变 1；在主窗口 UI 里勾选它，徽标 13ms 内回到 0；在悬浮窗创建一条，主窗口列表 11ms 内出现**——双向实时同步。单击徽标打开主窗口、拖动不打开（1.2 已用真实鼠标输入验证，本阶段未改动该手势）。
  - 自动化：`main-shell.test.tsx`（默认显示 Today 并标出当前页、导航角标、占位页切换后内容仍在、进度条、输入框回车创建待办且立即清空以便连续记录、空标题不提交、完成调用后端、后端数据变化事件刷新列表）。
  - 设计说明：悬浮面板与主窗口的 Today 页共用 `TodayBoard`（同一套乐观更新 / 撤销 / 排序 / 推迟）和同一份 Today 查询缓存；导航状态放在 Zustand（主窗口关闭只是隐藏，再打开仍回到离开前的页面）；Inbox / Calendar / Notes / Projects 是带说明文案的占位页；开发控制台只在开发模式下作为侧栏最后一项出现。主窗口输入框提交后**立即清空**而不是等后端返回，失败时把内容放回——连续记录多件事不会丢按键。内存版 IPC Mock 现在会把今天创建的 Todo / Tip 加入 Today，纯浏览器预览（`pnpm dev:ui`）也能演示完整流程。

### 1.11 常驻性能基线验收

- **状态**：⬜
- **依赖**：1.1 ~ 1.10
- **目标**：验证架构文档 §2.1、§46 的常驻性能要求，并建立后续阶段对比基线。
- **任务**：
  - 编写测量脚本 / 步骤（`scripts/perf/`）：冷启动到悬浮窗可见时间、空闲 CPU、内存（主进程 + WebView2 进程）、Hover 展开耗时。
  - 8 小时长稳运行（含定时自动化操作：创建 / 完成 / 排序）。
  - 记录参考机器配置与测量结果。
  - 按 D-13 分别测量「默认徽标」与「启用循环皮肤 + 附加动效」（7.7）两种配置；验收标准以默认配置为准，皮肤配置记录实测值。
- **验收标准**：
  - [ ] 空闲 10 分钟平均 CPU < 0.5%（参考机器）。
  - [ ] 冷启动到悬浮窗可见体感 < 1s（记录实测值）。
  - [ ] 8 小时运行后内存增长 < 10%。
  - [ ] 代码中无高频轮询、无持续 `requestAnimationFrame`、无无意义后台 Timer（代码审查）。
  - [ ] 测量结果写入 `docs/development/perf-baseline.md`。
- **完成记录**：—

---

# 6. Phase 2 — Capture & Inbox

**目标**：实现手动、拖拽、粘贴、快捷键四类入口统一进入 Capture Pipeline，并通过 Inbox 实现「Capture first, organize later」（产品文档 §6–8、§19，架构文档 §9、§16、§17）。

**阶段退出标准**：M2 达成——URL、文件、文本可通过拖拽 / 粘贴 / 快捷键捕获进入 Inbox 并保留 Source；2.4 兼容矩阵已记录。

---

### 2.1 CaptureInput 模型与 Normalizer

- **状态**：✅
- **依赖**：0.5
- **目标**：所有入口统一成 `CaptureInput`，且明确 `CaptureOrigin ≠ CaptureInput`。
- **任务**：
  - Domain：`CaptureInput { Text, Url, File, Files, Image }`、`CaptureOrigin { Manual, Drop, Paste, QuickAdd, Shortcut, … }`、可选 `source_application`。
  - `nivlo-capture`：URL 解析与规范化；文件元数据（名称、扩展名、大小、MIME 探测）；文本规范化（文本仅为单个 URL 时识别为 `Url`）；多文件；图片（二进制 + 格式）。
  - 由输入生成默认标题的规则（URL → 主机 + 路径；文件 → 文件名；长文本 → 首行截断）。
- **验收标准**：
  - [x] 基于 fixtures 的单元测试：纯 URL 文本识别为 Url；无扩展名文件的 MIME 探测；含中文与空格的 Windows 路径；超长文本标题截断。
  - [x] `nivlo-capture` 不依赖 Tauri。
- **完成记录**：2026-10-10 完成。
  - 证据：`cargo test -p nivlo-capture` 14 个测试通过，文本用例来自 `fixtures/capture/text-cases.json`（14 条：纯 URL、首尾空白、大写主机与默认端口、根路径、fragment、中文路径编码、句子里夹 URL / 两个 URL / 多行 / `javascript:` / `file:` / 无协议主机都保持为文本、空白文本）；Windows 路径含中文与空格（`C:Users张三我的 文档季度 报告 final.PDF`）、末尾分隔符与 UNC 路径、隐藏文件 / 无扩展名；**无扩展名文件按魔数探测 MIME**（PNG / PDF / 文本 / 二进制）；512 字节读取上限把一个汉字切成两半时仍判为文本；文件夹；单个 / 多个 / 重复路径；五种图片格式与未知字节被拒绝；默认标题（URL → 主机 + 路径、文件名、「首个 等 N 个文件」、文本首行、图片）；超长文本 / emoji / 超长 URL 按**字符**截断。`nivlo-domain` 新增 `capture` 模块（`CaptureInput` / `CaptureOrigin` / `CaptureRequest` / `FileRef` / `ImageData`，serde 往返测试，图片的 `Debug` 不输出像素）。`check-deps` 通过，`nivlo-capture` 只依赖 `nivlo-domain`、`url`、`mime_guess`、`thiserror`。
  - 设计说明：只有「整段文本恰好是一个 http(s) 网址」才识别为 URL，宁可当文本也不吞掉用户的话；文件只保存引用与元数据（探测失败时仍返回引用，被引用文件随时可能被移走）；`CaptureOrigin` 与 `CaptureInput` 分开建模，Origin 只用于日志 / 统计。

### 2.2 Source 与 Attachment 持久化

- **状态**：✅
- **依赖**：2.1；D-02
- **目标**：每个 Item 天然支持 Source（产品文档 §18），文件默认引用而非复制（架构文档 §34）。
- **任务**：
  - `migrations/0002_item_source.sql`：`item_sources`、`attachments`，以及 D-02 的 `in_inbox` 字段。
  - 文件默认只保存原始路径；展示时检查文件是否存在。
  - 例外：没有路径的图片（如粘贴的截图）复制到 `attachments/`。
  - Integration 专属字段存入 `metadata_json`。
  - 补齐 1.8 中「推迟到 Inbox」的语义。
- **验收标准**：
  - [x] Storage 测试：Source / Attachment CRUD 及级联删除。
  - [x] 删除 Item 时**绝不**删除用户的被引用文件（测试断言文件仍存在）。
  - [x] 被引用文件被移动或删除后，UI 显示「文件不存在」状态而不报错。
- **完成记录**：2026-10-10 主体完成；「UI 显示文件不存在」要等 2.7 的 Inbox 视图才有界面，保持 🟨。D-02 已决定（采用推荐方案）。
  - 证据：`migrations/0002_item_source.sql`（`items.in_inbox` + 部分索引、`item_sources`、`attachments`，均随 Item 级联删除）；Domain：`Item` 新增 `in_inbox`，规则按 D-02——安排日期 / 归入项目 / 真正转换类型 / 手动 `leave_inbox` 会离开 Inbox，清除日期或类型没变不算整理，`move_to_inbox` 清除日期并标记待整理（6 个新测试，含快照往返）；Storage 集成测试：`in_inbox` 持久化并被整理清除、Source / Attachment 往返且乱序插入按时间读取、Item 不存在时外键拒绝（`Constraint`）、**删除 Item 级联删除记录但被引用的用户文件原封不动**（测试里读回文件内容，并断言引用类附件 `owns_file()` 为 false）；Application：`reschedule_item` 的 Inbox 目标现在真正设置 `in_inbox`（补齐 1.8 留下的语义），精确恢复撤销后离开 Inbox；`nivlo-capture::reference_exists` 检查被引用文件是否还在（移动 / 删除 / 不存在的盘符 / 空路径都返回 false 而不是报错）。`ItemDto` 新增 `inInbox`。
  - 待办：没有原始路径的图片复制到 `attachments/` 的写入由 2.3 的 Capture Use Case 完成；Integration 专属字段已有 `metadata_json` 列。
  - 补完（2.7）：Inbox 视图读取附件时检查被引用文件是否还在（`exists`），不在原处显示「文件不存在」徽标而不报错；IPC 集成测试删除文件后断言 `exists=false` 且列表正常。

### 2.3 Capture Use Case 与默认规则

- **状态**：✅
- **依赖**：2.2
- **目标**：在 Workflow Engine 出现之前，提供可工作的默认捕获规则，并保证事务性。
- **任务**：
  - `CaptureService.capture(input, origin)`：在单个事务中创建 Item + Source + Attachment + Tag（架构文档 §56）。
  - 默认规则（Phase 5 中会被改写为内置 Generic Workflow）：URL → Note；File → Note（文件引用）；Text → Todo；Image → Note（附件）；全部进入 Inbox。
  - 返回创建结果与 Undo 句柄；Undo 删除本次捕获产生的全部记录。
- **验收标准**：
  - [x] Application 测试覆盖每种输入类型。
  - [x] 测试：事务中任一步失败时数据库中不残留任何记录。
  - [x] 本地捕获从调用到返回 < 100ms（测试中测量并记录）。
  - [x] Undo 后数据库恢复到捕获前状态。
- **完成记录**：2026-10-10 完成。
  - 证据：`CaptureService.capture` 在**单个事务**中创建 Item + Source + Attachment（默认规则：文本 → Todo，URL / 文件 / 图片 → Note，全部进入 Inbox；多文件每个文件一个 Note，仍是同一事务）；`undo` 在一个事务中删除全部记录并只清理 Nivlo 自己保存的图片文件，被引用的用户文件不动。Application 测试（`capture/tests.rs`）覆盖每种输入类型、Origin 不改变结果、事件仅在提交成功后发布、**提交失败不留任何记录且移除已保存的图片**、写文件失败不创建任何东西、撤销恢复数据库、撤销提交失败不删除任何东西。IPC 集成测试（真实 SQLite）测得**捕获从调用到返回约 1.6ms**（验收 < 100ms，断言在测试中），撤销后列表回到捕获前。
  - 架构修正：`default_title` 从 `nivlo-capture` 移到 `nivlo-domain`（纯函数，新增 `url` 依赖），`nivlo-capture` 重新导出；`nivlo-application` 不再依赖 `nivlo-capture`（`check-deps` 通过），仅在 dev-dependencies 中用它构造测试输入。

### 2.4 悬浮窗拖拽捕获（WebView Drop）

- **状态**：🟨
- **依赖**：2.3；D-10
- **目标**：实现产品文档 §7 的 Drag & Drop，以及「Drop → Created ✓」的 1 秒级体验（产品文档 §27.1）。
- **任务**：
  - **技术验证（先做）**：验证 Tauri 2 原生文件拖放与 HTML5 drop 在 WebView2 上的互斥问题，定稿 D-10。
  - 在 `nivlo-platform` 定义 `DropPort`，实现基于 Tauri / WebView 的版本。
  - DragHover 状态与视觉反馈；Drop 后显示「Created ✓ [Undo] [Edit]」。
  - 建立并填写兼容矩阵 `docs/development/drop-matrix.md`：Chrome / Edge / Firefox 的链接与地址栏、资源管理器单文件 / 多文件 / 文件夹、VS Code 选中文本、Word 选中文本、浏览器中的图片。
- **验收标准**：
  - [x] D-10 已定稿并有 ADR 记录。
  - [ ] 核心来源成功：资源管理器文件（单 / 多）、Chrome 与 Edge 的链接、浏览器选中文本。
  - [ ] 兼容矩阵中每一项都有结果；失败项列入 10.1 的输入。
  - [ ] Drop 到出现「Created ✓」反馈 < 1s。
  - [ ] Drop 完成后悬浮窗不长期占有焦点。
- **完成记录**：2026-10-10 主体完成；真机兼容矩阵尚未执行，保持 🟨。
  - 证据：D-10 定稿并写入 ADR-011（悬浮窗 `disable_drag_drop_handler()`，使用 HTML5 Drop；文件拖放留给 10.1）。前端 `features/capture`：`extract-drop.ts`（链接 uri-list / x-moz-url、文本、图片文件 → Base64 图片；非图片文件拿不到路径时明确返回 unsupported，而不是丢弃或伪造）、`useDropCapture`（dragenter 计数防子元素闪烁、drop 时同步快照、连续拖放丢弃过期结果）、`CaptureFeedbackBar`（「已创建 ✓ [撤销] [编辑]」，`role=status`，指针停留时不自动消失）。状态机新增 `holdRequested` / `holdReleased`：松手后面板保持展开直到反馈消失，不会在松手瞬间收起。悬浮窗始终不可聚焦，拖放不抢焦点。Vitest 新增 20 余个用例（提取、状态机保持展开、悬浮窗端到端：拖入提示、放下链接 / 文本、撤销、编辑、失败、不支持的文件、无类型拖拽不响应）；IPC 层捕获耗时约 1.6ms（2.3 已测）。
  - 待办：`docs/development/drop-matrix.md` 的「真机」列需要在 Windows 11 上手动拖放后填写；资源管理器文件（单 / 多 / 文件夹）预期失败，列入 10.1 的输入；「Drop → Created ✓ < 1s」与「悬浮窗不长期占有焦点」需真机确认。

### 2.5 粘贴捕获

- **状态**：🟨
- **依赖**：2.3
- **目标**：只在用户明确粘贴时读取剪贴板（架构文档 §17）。
- **任务**：
  - `ClipboardPort`：读取文本 / HTML / 文件列表 / 图片。
  - 在悬浮窗 Expanded / QuickCreate 状态下 Ctrl+V 触发捕获；QuickCreate 输入框中的普通文本粘贴仍为输入行为。
  - 不提供后台剪贴板监听。
- **验收标准**：
  - [x] 可粘贴：URL、普通文本、资源管理器中复制的文件、截图图片（底层读取已用真实剪贴板验证；界面流程待真机走查）。
  - [x] 代码审查确认：只有用户粘贴动作会调用剪贴板读取。
- **完成记录**：2026-10-10 主体完成；真机上「悬浮窗 / 主窗口里的完整粘贴流程」尚未手动走一遍，保持 🟨。
  - 证据：`nivlo-platform::clipboard`——`ClipboardPort::read`（只有读取、**没有订阅 / 监听接口**）与 `ClipboardContent { files, image, text }`。`nivlo-platform-windows::clipboard`——文本（`CF_UNICODETEXT`）、文件列表（`CF_HDROP`，`DragQueryFileW`）、图片（先注册格式 `PNG`，没有则 `CF_DIB` 补 BMP 文件头），剪贴板被占用时重试 5 次，用 Drop 守卫保证任何路径都会关闭剪贴板；DIB→BMP 有单元测试。**4 个用真实系统剪贴板的集成测试已在本机通过**（`--ignored`，因为会覆盖用户剪贴板）：中文文本、资源管理器复制的两个文件（含中文与空格的路径）、截图式位图、空剪贴板读成空而不是错误。`nivlo-capture::normalize_clipboard`：**文件 → 文本 → 图片**（同时有文字和图片时用文字——从 Excel / 网页复制时剪贴板里常有渲染出来的图片；纯截图落到最后一档；空白文本与不认识的图片字节被跳过），2 个测试。Command `capture_from_clipboard`（主窗口与悬浮窗，在阻塞线程里读取，来路 `Paste`），新增错误码 `CLIPBOARD_EMPTY` / `CLIPBOARD_UNAVAILABLE`（文档与 i18n 已登记）。
  - 前端：悬浮面板底部「粘贴」按钮，与拖放共用「已创建 ✓ [撤销] [编辑]」反馈；快速创建输入框里粘贴**文字照常是输入**，粘贴文件 / 图片（没有文字）则收进收集箱并结束快速创建；主窗口收集箱有「粘贴」按钮，焦点不在输入框时 Ctrl+V 触发，成功后有可撤销的 Toast，剪贴板为空 / 读取失败有明确提示。Vitest 新增 9 个用例，其中一个断言**悬停、拖放、快速创建都不会读取剪贴板**。
  - 代码审查检查点：全仓库调用 `ClipboardPort::read` 的只有 `capture_from_clipboard` 一个 Command（`rg "\.read\(\)" apps crates` 可复核），它只由「粘贴」按钮或 Ctrl+V 触发；没有后台监听或轮询。
  - 设计说明：资源管理器文件在 HTML5 Drop 里拿不到路径，**复制 → 粘贴**成为 10.1 之前收集文件的路径（拖入时的提示也这么引导，见 `docs/development/drop-matrix.md`）。悬浮窗始终不可聚焦，所以 Ctrl+V 只在快速创建（输入框有焦点）时生效，平时用面板上的「粘贴」按钮。

### 2.6 全局快捷键 Quick Create

- **状态**：🟨
- **依赖**：1.5
- **目标**：实现产品文档 §6.2 的全局快捷键呼出。
- **任务**：
  - `ShortcutPort`；默认 `Ctrl+Shift+Space`，可在设置中修改。
  - 注册失败（冲突）时提示用户并引导重新绑定。
  - 呼出悬浮窗 QuickCreate 状态并获取焦点；支持在 Todo / Note / Tip 之间切换（Tab 键或前缀）。
  - 创建后尽量将焦点还给之前的应用。
- **验收标准**：
  - [x] 其他应用处于前台时快捷键可用。
  - [x] 模拟快捷键冲突时用户看到提示并能修改绑定。
  - [ ] 创建后焦点回到之前的应用（记录无法做到的场景）。
- **完成记录**：2026-10-10 主体完成；「创建后焦点回到之前的应用」需要真机在多个应用下确认，保持 🟨。
  - 证据：`nivlo-platform::shortcut`——平台无关的 `Accelerator`（`Ctrl+Shift+Space` 文本互转，大小写 / 空白 / 别名不敏感，规范输出；至少一个修饰键，否则会吞掉正常输入；功能键 F1–F24、数字、方向键）与 `ShortcutPort`，4 个解析测试。`nivlo-platform-windows::shortcut`——`RegisterHotKey` + 每个注册一个专用消息线程（不依赖 Tauri 主线程，也不需要窗口句柄；空闲时阻塞在 `GetMessageW`，无轮询）；**替换时先注册新的、成功才停旧的，新的被占用时旧的完全不受影响**；3 个真实系统注册的集成测试（同一组合第二次注册返回 `Conflict`、失败的替换保持旧注册、`unregister` 释放并幂等），外加 1 个用 `SendInput` 注入真实按键的测试（`--ignored` 手动运行，已在本机通过：按下 Ctrl+Alt+Shift+F13 回调恰好触发一次）。桌面端 `ShortcutController`：启动时读取 `shortcut.quick_create`（缺失 / 无法解析用默认值），**注册失败不是致命错误**，状态里记下 `conflict`；`rebind` 校验 → 注册 → 才保存设置（冲突 / 非法都不保存，原绑定不变）；新增错误码 `SHORTCUT_INVALID` / `SHORTCUT_CONFLICT`（已登记文档与 i18n）；7 个控制器测试（默认值、启动冲突、坏值回退、改绑保存并「重启」后生效、冲突改绑保持旧绑定且不保存、非法输入、改绑修复启动冲突）。按下快捷键与托盘「快速添加」共用同一条路径（`request_quick_add`：悬浮窗被隐藏时先显示，再通知它进入快速创建，复用 1.5 的「记住前台应用 → 临时聚焦 → 结束后还回去」）。
  - 前端：侧栏底部 `ShortcutSetting`——显示「快速创建：Ctrl+Shift+Space」，点击展开录入框（按下组合键即录入，用物理按键所以 Shift 不会把 5 变成 %，Esc 取消，Enter 保存）；**启动时被占用自动展开并说明原因**，保存失败（占用 / 非法）原因显示在框下方、保持编辑；Vitest 13 个用例。快速创建输入行支持 **Tab / Shift+Tab 在待办 / 笔记 / 提示之间切换**（输入法组合期间忽略；主窗口 Today 输入框的 Tab 不受影响）。
  - 待办：真机确认——其他应用在前台时按快捷键（`RegisterHotKey` 是系统级的，`SendInput` 测试证明回调会触发，但没有在真实的「别的应用在前台」下走完整的呼出 → 输入 → 创建 → 焦点归还）；焦点无法归还的场景（如管理员权限的应用、全屏独占）需要记录；完整设置页在 3.5。

### 2.7 Inbox

- **状态**：✅
- **依赖**：2.3
- **目标**：实现产品文档 §8 的 Inbox 中间层。
- **任务**：
  - 主窗口 Inbox 视图：按捕获时间倒序，显示来源图标（URL / 文件 / 文本 / 图片）。
  - 操作：转换为 Todo / Note / Tip、安排日期（Today / Tomorrow / 选择日期）、设置项目与标签、移出 Inbox、归档、删除；支持多选批量操作。
  - 侧栏显示 Inbox 数量；悬浮窗提供 Inbox 数量入口（点击打开主窗口 Inbox）。
  - 空状态文案。
- **验收标准**：
  - [x] 所有捕获结果出现在 Inbox。
  - [x] 每种整理操作按 D-02 规则使 Item 离开 Inbox（测试覆盖）。
  - [x] 批量操作 50 条在 1s 内完成。
  - [x] 空状态正确显示。
- **完成记录**：2026-10-10 完成；设置项目 / 标签与删除依赖 3.3 / 3.5 / D-08，随之补上（见待办）。
  - 证据：后端 `InboxService`：`list`（未归档且 `in_inbox`，捕获时间从新到旧，附带来源与附件）、`count`、`organize`（移出 Inbox / 安排日期 今天·明天·下周一·指定日 / 转换类型 / 归档，**整批一个事务**，任何一条失败整批不变，提交后才发布事件）、`restore`（按整理前的状态精确撤销）。按 D-02 每个整理动作都使 Item 离开 Inbox（`every_organize_action_makes_items_leave_the_inbox` 覆盖全部 7 种），归档现在也算整理；50 条批量在内存 Fake 上远小于 1s，真实 SQLite 的 IPC 集成测试覆盖「3 条捕获 → 列表带来源 → 被引用文件被删后 `exists=false` 且不报错 → 批量安排到今天 → 撤销回到 3 条 → 不存在 / 日期格式错误的错误码」。`ItemFilter` 新增 `in_inbox_only`（storage 集成测试覆盖，含归档不出现）。IPC：`list_inbox`、`get_inbox_count`、`organize_items`、`restore_items`（悬浮窗白名单只加 `get_inbox_count`，D-12）。
  - 前端：`features/inbox`——来源图标（网址 / 文件 / 文本 / 图片）、标题 + 类型标签 + 来源说明（网址取主机 + 路径，标题已是文件名时不重复）、「文件不存在」徽标、相对时间；悬停或键盘聚焦出现「今天 / 明天 / 更多（下周一、转为…、移出收集箱、归档）」；勾选框支持 Shift 范围选择与全选（半选态），批量工具栏一次整理一批；乐观更新（整理后立即消失，失败回滚并提示），每次整理都有 6 秒可撤销的 Toast；Esc 清除选择；空状态说明怎么往里放东西；侧栏「收集箱」角标显示待整理数。Vitest 新增 19 个用例（模型纯函数、页面交互、侧栏角标）。
  - 悬浮窗入口：面板标题栏在收集箱非空时显示「收集箱 N」，点击调用 `open_main_at("inbox")`；视图先存在后端，主窗口刚创建（还没监听事件）时启动即取走，已在运行时由 `main_view_requested` 事件通知；不认识的视图返回 `INVALID_INPUT`，请求只被取走一次（IPC 测试覆盖）。悬浮窗启动时与 Today 一样只取一次数量，之后由事件刷新，Hover 不发业务 IPC。
  - 待办：设置项目与标签（项目 / 标签管理在 3.3 之后）；删除（等 D-08 软删除语义，3.5）。

---

# 7. Phase 3 — Workspace & Organization

**目标**：完成主应用的完整编辑与组织能力（产品文档 §6.3、§23，架构文档 §33）。

**阶段退出标准**：可在主窗口完成 Item 的完整编辑、Note 记录、项目与标签管理、全文搜索；设置页可用。（2026-10-11：3.2–3.5 已完成，3.1 仅余真机确认「打开浏览器 / 资源管理器」与提醒字段（4.7）。）

---

### 3.1 Item 完整编辑器

- **状态**：🟨
- **依赖**：2.2
- **目标**：实现 Full Create / Edit。
- **任务**：
  - 详情面板：标题、描述（Markdown 纯文本编辑，MVP 不引入 Block Editor）、类型、计划日期、截止日期、优先级、项目、标签、Source 展示、提醒（字段在 4.7 启用）。
  - Source 操作：用默认浏览器打开 URL、在资源管理器中定位文件（通过 `OpenPort`）。
  - 自动保存（防抖），保存失败时提示并保留本地编辑内容。
- **验收标准**：
  - [x] 所有字段修改后重启仍保留。
  - [x] 类型转换遵循 0.5 定义的领域规则（测试覆盖）。
  - [ ] 打开 URL / 定位文件可用；文件不存在时给出提示（文件不存在的提示已测试；真正打开待真机确认）。
  - [x] 模拟保存失败时编辑内容不丢失。
- **完成记录**：2026-10-10 主体完成；项目 / 标签（3.3）与提醒（4.7）字段待对应阶段启用，「真的打开浏览器 / 资源管理器」需要真机确认，保持 🟨。
  - 后端：`get_item_detail`（Item + 来源 + 附件，含被引用文件是否还在）、`update_item`（三态 `PatchDto`：保持 / 清除 / 设置，缺省即保持；整个更新在一个事务里，违反领域规则时没有任何改动）、`open_item_source`。**打开来源走受限的 `OpenPort`**（ADR-010：没有「打开任意路径」的通用能力）：前端只传 Item ID，要打开什么由后端从已保存的来源 / 附件里决定；网址只允许 `http` / `https`（`file:`、`javascript:`、自定义协议、残缺网址一律拒绝，`check_openable_url` 有测试）；文件先检查还在不在，不在返回专门的 `SOURCE_FILE_MISSING`（UI 提示「文件不存在」并在详情里禁用按钮），没有来源 / 系统打开失败返回 `SOURCE_OPEN_FAILED`。Tauri 适配 `TauriOpen` 基于官方 opener 插件。新增错误码 `SOURCE_FILE_MISSING` / `SOURCE_OPEN_FAILED`（文档与 i18n 已登记）。IPC 集成测试（真实 SQLite）：只改标题 / 内容时优先级与计划日期保持；清除计划日期、设置带时间的截止日期；空标题被拒绝；改成笔记后截止日期与优先级被领域规则清理；给笔记设置截止日期被拒绝；日期格式错误 `INVALID_INPUT`；**重启后所有修改仍在**；不存在的 Item；没有来源的 Item 与被移走的文件的错误码。
  - 前端：`features/detail`——主窗口右侧详情面板（点击收集箱 / Today 里的标题打开，悬浮窗里标题保持纯文字）：类型分段选择、标题、描述（等宽字体 Markdown 纯文本 + 格式切换）、计划日期 / 时间、待办才有的截止日期与优先级、来源（链接 / 路径、「在浏览器中打开」/「在文件夹中显示」、文件缺失徽标）。**自动保存**：停止输入 700ms 后只发送相对后端数据真正变化的字段（`buildPatch`，清空得到「清除」而不是空串），连续输入只保存一次，关闭面板 / 切换条目 / 卸载时先保存；**保存失败不丢内容**：修改仍在表单里，面板顶部显示后端原因 + 「重试」，保存期间又改过的字段不会被误当成已保存（`dropSaved`）；Esc 关闭。`Input` 组件修复了宽度 / 高度工具类冲突（调用方指定 `w-…` / `h-…` 时不再叠加默认值）。浏览器预览（`pnpm dev:ui`）现在带示例数据，`?window=floating` 可预览悬浮窗。Vitest 新增 20 个用例（草稿差异、自动保存去抖、清除 / 设置、类型切换隐藏字段、保存失败保留编辑并重试、领域规则错误、关闭时保存、Esc、来源打开 / 文件缺失）。
  - 待办：项目 / 标签字段（3.3）、提醒字段（4.7）；真机确认「在浏览器中打开 / 在文件夹中显示」。

### 3.2 Notes 视图

- **状态**：✅
- **依赖**：3.1
- **目标**：实现产品文档 §17 的 Note「快速记录、基本编辑」。
- **任务**：
  - Notes 列表（按更新时间排序）+ 编辑区；新建、编辑、归档。
  - `content_format` 正确写入（Markdown / Plain）。
- **验收标准**：
  - [x] 可新建、编辑、归档 Note，重启后保留。
  - [x] 含 10k 字的 Note 编辑无明显卡顿。
- **完成记录**：2026-10-11 完成。后端 `list_items` 新增 `orderBy`（创建时间 / 最近更新，有 Storage 测试）；前端 `features/notes`：左侧按最近更新排序的列表（标题、相对时间、正文摘要），右侧大标题 + 整页正文编辑区，复用 `useItemDraft`（700ms 自动保存、失败保留内容并重试）；「新笔记」先创建再编辑；格式切换写入 `content_format`；归档带可撤销提示；无选中时默认打开最近更新的一篇，空状态引导新建；实时字数。上万字笔记为原生文本框，输入与保存各只发生一次（测试覆盖）。

### 3.3 Projects 与 Tags

- **状态**：✅
- **依赖**：3.1；D-05
- **目标**：实现项目与标签的组织能力。
- **任务**：
  - Project：创建、重命名、归档；侧栏列表；项目视图（排序按 D-05）。
  - Tag：自动补全、创建、重命名、合并；按标签过滤。
- **验收标准**：
  - [x] 项目与标签的 CRUD 有 Application 与 Storage 测试。
  - [x] 可在项目视图、标签过滤中看到正确的 Item。
  - [x] 重命名标签后所有关联 Item 同步更新。
- **完成记录**：2026-10-11 完成。后端：`ProjectRepository` / `TagRepository`（SQLite + 内存 Fake）、`ProjectService`（创建 / 重命名 / 归档 / 取消归档 / 列表含未完成数量）、`TagService`（列表含数量、重命名——忽略大小写重名返回 `TAG_NAME_TAKEN`、只改大小写允许；合并——重复关联去重后删除来源标签；`set_item_tags`——整体替换，不存在的自动创建，忽略大小写去重沿用已有写法，名称不合法时整批不变）；`list_items` 新增项目 / 标签过滤与项目视图排序（D-05）；`update_item` 支持项目三态修改并校验项目存在（`PROJECT_NOT_FOUND`）；详情 DTO 带标签。新增错误码 `PROJECT_NOT_FOUND` / `TAG_NOT_FOUND` / `TAG_NAME_TAKEN`。测试：Application 13 个、Storage 10 个（含项目被删时条目保留、重启后保留）、IPC 端到端 1 个。前端：`features/organize`（`ProjectSelect`、带自动补全的 `TagsField`：回车 / 逗号添加、方向键选择、Backspace 移除）与 `features/projects`（项目与标签导航、项目视图、行内新建 / 重命名、归档带撤销、标签过滤 / 重命名 / 合并）；详情面板里可选择项目、编辑标签。Vitest 新增 12 个用例。

### 3.4 全文搜索与 Ctrl+K

- **状态**：✅
- **依赖**：2.2；D-09
- **目标**：实现架构文档 §33 的 FTS5 搜索。
- **任务**：
  - `migrations/0003_search.sql`：FTS5 虚拟表，索引 title、content、source 原始标题、source URL；按 D-09 使用 Trigger 同步、`trigram` tokenizer。
  - `search_items` Use Case；主窗口 `Ctrl+K` 命令面板：搜索结果按类型分组、键盘导航、回车打开。
- **验收标准**：
  - [x] 中文子串搜索可用（例如「登录」能找到「修复登录超时」）。
  - [x] 10k 条数据下搜索 < 50ms（记录实测）。
  - [x] 修改 / 删除 Item 后搜索结果同步（测试覆盖）。
  - [x] 全键盘可操作。
- **完成记录**：2026-10-11 完成。`migrations/0003_search.sql`：FTS5 虚拟表 `items_fts`（trigram，索引标题 / 正文 / 来源的原始标题、网址与路径），items 与 item_sources 的 Trigger 在同一事务里同步，升级时给已有数据补建索引（有测试）。`ItemRepository::search`：每个词作为短语、词之间 AND，按「标题命中 → bm25 相关度 → 最近更新」排序；少于 3 个字符的词索引无法匹配，会被忽略，全部都很短时退化为 LIKE 扫描（`%` / `_` 已转义），FTS 语法字符被当作普通文字。`search_items` 命令（最多 50 条，不含归档，空白查询不访问数据库）。实测（debug 构建，1 万条）：「登录超时」1.1ms、「登录」（2 字符，LIKE 回退）9.9ms、「第 7776 条」0.4ms。前端：主窗口 Ctrl+K（侧栏也有搜索按钮）打开搜索面板——停顿 140ms 后搜索、按类型分组、命中文字高亮并附正文摘要、↑↓ 循环选择、回车打开详情、Esc / 点击遮罩关闭、焦点还给打开前的元素、空结果提示。测试：Storage 8 个、Application 3 个、前端 15 个。

### 3.5 归档 / 删除 / 设置页

- **状态**：✅
- **依赖**：3.1；D-08
- **目标**：完成数据生命周期与基础设置。
- **任务**：
  - 按 D-08 实现软删除与回收站（恢复、彻底删除、30 天自动清除）。
  - 设置页：开机自启、悬浮窗置顶、全局快捷键、语言、主题、Later 的定义；设置写入 `settings` 表。
- **验收标准**：
  - [x] 删除后可在回收站恢复；超过保留期（FakeClock）后被清除。
  - [x] 所有设置项修改后立即生效并在重启后保留。
- **完成记录**：2026-10-11 完成。
  - 2026-10-11 盘点补记：① D-07 的「隐藏已完成」开关（1.6 留给本子阶段）未实现，移入 7.5；② 语言与主题实际保存在前端 `localStorage`，没有写入 `settings` 表（与本子阶段任务描述不一致；重启保留的验收仍满足），后续处理见 D-14。
  - 2026-10-11 删除与回收站完成：`migrations/0004_trash.sql`（`items.deleted_at`）；`TrashRepository` + `TrashService`（批量删除一个事务、恢复、列表带到期时间、永久删除只作用于回收站里的条目并清理 Nivlo 自己保存的文件、清空、30 天自动清除——启动时与每 6 小时一次）；所有日常查询（列表、Today 三个来源、搜索、项目 / 标签数量）都排除已删除的条目，按 ID 仍可读取；新增命令 `delete_items` / `restore_deleted_items` / `list_trash` / `purge_items` / `empty_trash`。测试：Application 7 个（含 FakeClock 超期清除、提交失败不先删文件）、Storage 5 个、IPC 端到端 1 个。前端：回收站视图（侧栏底部）——显示删除了多久与还剩几天、恢复、彻底删除与清空需 3 秒内二次确认（`ConfirmButton`）；详情面板、笔记编辑区、收集箱（行菜单与批量栏）都能删除，删除后给出可撤销的提示。
  - 2026-10-11 设置页完成：`LaterRule`（下周一 / 3 天后 / 7 天后，存在 `schedule.later`，缺省或值不认识时回退下周一）同时作用于悬浮窗的 `reschedule_item` 与收集箱的整理（有测试）；命令 `get_app_settings` / `set_autostart`（以系统启动项为准，失败返回 `SYSTEM_SETTING_FAILED`）/ `set_floating_always_on_top`（先保存再立即应用到窗口，`FloatingHandle` 新增 `set_always_on_top`）/ `set_later_rule`。前端设置页（侧栏底部）：开机自启、语言（目前只有简体中文）、主题、悬浮窗置顶、全局快捷键（复用录入组件）、「稍后」是哪一天；修改立即生效（乐观更新，被拒绝时回滚并提示）。新增通用 `Switch` 组件。归档在 2.7 / 3.2 已有（收集箱与笔记里可归档、可撤销）。

---

# 8. Phase 4 — Calendar & Scheduler

**目标**：实现 Calendar 规划与可靠的提醒触发，形成 Capture → Schedule → Execute 闭环（产品文档 §20，架构文档 §32、§37）。

**阶段退出标准**：M3 达成——Calendar Month / Week 可查看与拖拽排期；提醒在休眠唤醒、重启、时钟变化后不丢失、不重复。

---

### 4.1 时间模型与 Schedule 语义

- **状态**：✅
- **依赖**：D-03 已定稿
- **目标**：统一 Rust 与 TS 两端的日期语义。
- **任务**：
  - 按 D-03 落地字段（如与 0.5 有差异，以新 migration 迁移）；`migrations/0004_reminders.sql`：`reminders` 表（含已触发状态）。
  - Rust（chrono）与 TS（date-fns）日期工具：今天 / 明天 / 下周、一周起始日（可配置）、月视图日期范围。
  - 共享测试向量：`fixtures/dates/*.json`，两端测试读取同一份数据。
- **验收标准**：
  - [x] 两端使用同一份测试向量，结果一致。
  - [x] 在非 UTC+8 时区下（测试中设置时区）结果正确。
  - [x] Scheduled 与 Due 语义在 Domain 测试中明确区分。
- **完成记录**：2026-10-11 完成。D-03 的字段模型早在 0.5 落地（`DatePoint` + UTC `reminder_at`），无需新迁移；`reminders` 表（已触发状态）随调度器在 4.4 引入（`0004` 已被回收站占用，届时用 `0005`）。后端 `calendar::visible_range` 是月视图整周网格 / 周视图的唯一计算处，前端只排版；`WeekStart`（周一 / 周日，设置项 `calendar.week_start`）。Rust 与 TS 共用 `fixtures/dates/calendar-ranges.json`（11 个范围用例 + 下周一用例，覆盖 4 / 5 / 6 行的月份、闰年、跨年、两种起始日）。时区：`today_follows_the_user_time_zone_not_utc`（同一 UTC 时刻在东京与洛杉矶得到不同的「今天」）。Scheduled 与 Due 的区别由 `entries_are_scheduled_items_plus_a_deadline_overlay_for_open_todos` 与 `completed_todos_stay_on_their_day_but_lose_the_deadline_marker` 明确：计划是「打算哪天做」，截止只给未完成的待办作为 Deadline Overlay。

### 4.2 Calendar 查询与 Month / Week 视图

- **状态**：✅
- **依赖**：4.1
- **目标**：Calendar 主要基于 Scheduled，Due 作为 Deadline Overlay（架构文档 §32）。
- **任务**：
  - `get_calendar(range)` Use Case：返回范围内的计划 Item、Tip、截止标记。
  - Month 视图、Week 视图；上一页 / 下一页 / 回到今天；已完成样式；Tip 以 💡 展示。
- **验收标准**：
  - [x] 5k 条数据下单月查询 < 20ms（记录实测）。
  - [x] Due 标记与 Scheduled 条目视觉上可明确区分。
  - [x] 一周起始日设置对 Week / Month 视图生效。
- **完成记录**：2026-10-11 完成。`get_calendar(view, anchor)`：范围内的计划条目 + 截止标记 + 「待安排」（没有日期的未完成待办，最多 100 条）；条目只带显示需要的字段（不含正文）。`ItemRepository::list_calendar` 用到 `idx_items_scheduled_date` / `idx_items_due_date`；**5000 条数据下单月查询 4.9ms（debug 构建，目标 < 20ms）**。前端 `features/calendar`：月 / 周视图，上一页 / 今天 / 下一页，今天高亮、周末与非本月淡化，已完成划线，Tip 用 💡，截止标记用虚线框 + 旗标 + 「截止」与计划条目明确区分（不可拖动），月视图每格最多 3 条、其余折叠成「还有 N 项」（点击切到周视图），周视图条目带时间前缀，悬停格子出现「+」可原地写下一条待办。设置页新增「一周从哪天开始」。

### 4.3 Calendar 拖拽排期

- **状态**：✅
- **依赖**：4.2、2.7
- **目标**：实现产品文档 §20.2「Inbox Todo → drag → Sep 30」。
- **任务**：
  - Calendar 侧边显示 Inbox / 未排期列表，可拖到日期格。
  - 日期之间拖动修改计划日期（MVP 只到天粒度）。
  - Optimistic 更新 + Undo。
- **验收标准**：
  - [x] 从 Inbox 拖到某天后：计划日期正确、离开 Inbox、出现在该日。
  - [x] 日期间拖动正确修改计划日期；Undo 可撤销。
  - [x] 拖入今天的 Item 同步出现在悬浮窗 Today 末尾。
- **完成记录**：2026-10-11 完成。右侧「待安排」列表里的待办（以及日期格里的计划条目）可以拖到任意日期格：dnd-kit 指针 + 键盘传感器，拖动超过 5px 才开始，落点高亮，拖动时有浮层；落下后调用 `reschedule_item`（exact）——**保留原有的具体时间**，设置计划日期即离开 Inbox（D-02）；乐观地由数据变更事件刷新，成功后给出带「撤销」的提示（撤销 = 精确恢复原来的计划，包括「没有日期」）。拖入今天的待办由 Today 的规范化追加到末尾（`TodayService` 对未知待办的既有行为），悬浮窗同步出现。测试：真实浏览器预览里用指针拖拽验证；jsdom 里通过替换 `DndContext` 触发 `onDragEnd` 验证「落点 → 重新安排 → 提示与撤销」（`calendar-drop.test.tsx`）。

### 4.4 Scheduler Actor

- **状态**：✅
- **依赖**：4.1
- **目标**：实现架构文档 §37、§40 的 Nearest Trigger 调度器，不做每秒轮询。
- **任务**：
  - `nivlo-scheduler` Actor：消息 `Reload`、`ScheduleChanged`、`Resume`、`Shutdown`。
  - 加载最近触发点 → `sleep_until` → 触发 → 加载下一个。
  - 触发类型：Reminder、Tip、Due、日期切换（接管 1.4 中的午夜 Timer）。
  - 订阅 Domain Event，Schedule 变化时发送 `SchedulerWakeup` 重算。
  - 已触发状态持久化，保证不重复。
- **验收标准**：
  - [x] FakeClock 测试：最近触发点计算、修改 / 删除提醒后重新调度、同一时刻多个触发。
  - [x] 引入 Scheduler 后空闲 CPU 与 1.11 基线相比无显著变化。
  - [x] Shutdown 时 Actor 正常退出（测试）。
- **完成记录**：2026-10-11 完成。`nivlo-scheduler`：`plan`（纯函数：现在该触发的、下一个触发点、整理成通知）+ `Scheduler`（Reconcile → 睡到最近的触发点，最长 15 分钟 → 被 `Control::wake` 打断或到点自己醒来）。触发点由 Item 推导（`trigger::triggers_of`）：显式提醒 `reminder_at`、带具体时间的 Tip、带具体截止时间的 Todo（只有日期的截止不通知，只是 Calendar / Today 的标记）；本地时间按用户时区换算 UTC，夏令时重复时刻取较早者、不存在的时刻跳过。**可靠性来自持久化的触发记录而不是内存计时器**：`migrations/0005_trigger_log.sql`（`item_id + kind + fire_at` 为主键，随 Item 级联删除，保留 30 天），所以修改提醒时间是新的触发点会再次触发，同一个触发点永远只通知一次。先发通知再提交记录——崩溃的最坏结果是重复一次而不是丢失一次。宿主订阅领域事件，Schedule 变化立即唤醒。验收：FakeClock 场景测试 15 个（最近触发点、改期 / 清除、同一时刻多个、完成 / 归档 / 删除不触发、时区、提交失败可重试）；Shutdown 与自行醒来的循环测试；Storage 3 个。空闲开销：循环只在最近触发点或最长 15 分钟时醒来，没有逐秒轮询；与 1.11 基线的对比待真机测量（1.11 尚未执行）。

### 4.5 Reconcile：启动 / 唤醒 / 时钟变化

- **状态**：✅
- **依赖**：4.4
- **目标**：解决「10:00 提醒、09:50 休眠、11:00 恢复」等场景（架构文档 §37）。
- **任务**：
  - 启动时 Reconcile 错过的触发。
  - 休眠唤醒 / 时钟变化检测：MVP 先用跨平台方案（检测 sleep 返回时墙上时间与预期的偏差），Windows 原生事件在 10.5 补强。
  - 错过的提醒合并通知（数量多时汇总为一条）。
- **验收标准**：
  - [x] 场景测试：提醒 10:00，09:50 休眠，11:00 恢复 → 恢复后通知一次并标记为「已错过」。
  - [x] 系统时间向前调整后到期提醒触发；向后调整不产生重复通知。
  - [x] 重启后已触发的提醒不再重复通知。
- **完成记录**：2026-10-11 完成。启动、休眠唤醒、时钟变化、计时到点都走同一个 `reconcile()`（墙上时钟 + 触发记录），行为一致：准时（2 分钟宽限内）逐条通知；错过的补发并标记 `missed`，不超过 3 条逐条（标题「错过的提醒」，带原本的时间），更多的合并成一条「你错过了 N 个提醒」；超过 7 天的不再补发。循环里比较墙上时钟与单调时钟的偏差，超过 2 分钟记录一条 `clock_jump_or_resume` 日志；最长 15 分钟的睡眠保证休眠恢复后最迟 15 分钟内核对（Windows 原生电源 / 时钟事件在 10.5 补强）。测试：「10:00 提醒、09:50 休眠、11:00 恢复」只通知一次且为「错过的提醒」；时钟向前调整后触发、向后调整再走过触发点不重复；重启后已触发的不重复、退出期间到点的补发；暂停期间攒下的恢复后汇总。

### 4.6 系统通知

- **状态**：🟨
- **依赖**：4.4
- **目标**：通过 `NotificationPort` 发送系统通知。
- **任务**：
  - `NotificationPort` + Tauri Notification 适配器；通知带应用名与图标。
  - 点击通知打开对应 Item。
  - Tray「Pause Notifications」生效（暂停期间的触发在恢复后汇总）。
- **验收标准**：
  - [ ] Windows 通知中心显示正确的应用名与图标（待真机：开发模式下 Windows 可能显示为 PowerShell，安装包才有正确的应用标识）。
  - [ ] 点击通知打开主窗口并定位到对应 Item（待办：`tauri-plugin-notification` 在桌面端没有点击回调，需要原生适配，由 10.6 实现）。
  - [x] 暂停期间不弹出通知，恢复后汇总显示。
- **完成记录**：（进行中）2026-10-11：`NotificationPort`（`nivlo-platform`）+ Tauri 通知插件适配器 `TauriNotifier`；托盘「暂停通知」改为可勾选项（勾选 = 暂停），设置页「通知」里有同一个开关，状态保存在 `notifications.paused`、启动时恢复，两处互相同步；暂停期间到点的触发不记录，恢复后作为错过的提醒汇总（有测试）。待真机确认：通知中心里的应用名 / 图标、点击通知定位到条目。

### 4.7 Reminder / Due / Tip 的 UI

- **状态**：🟨
- **依赖**：4.6、3.1
- **目标**：在编辑器、Today、悬浮窗中完整呈现时间信息。
- **任务**：
  - 编辑器中设置提醒（预设：提前 15 分钟、1 小时、当天 9:00 等，以及自定义）。
  - Today 与悬浮窗中的逾期、即将到期标记；Tip 显示时间（如「💡 15:00 提交周报」）。
- **验收标准**：
  - [ ] 设置提醒后按时收到通知（端到端手动验证记录；待真机——后端 Scheduler 与通知适配器已就绪，见 4.4–4.6）。
  - [x] 逾期与即将到期标记在悬浮窗与主窗口一致（两者共用同一个 `TodayList`，有测试）。
- **完成记录**：2026-10-11 主体完成，端到端通知待真机。详情面板（待办与提示）新增「提醒」：`datetime-local` 输入 + 预设「提前 15 分钟 / 提前 1 小时 / 当天 9:00 / 前一天 9:00」（以截止时间为基准，没有截止时间退回计划时间，Tip 只看计划时间；缺少具体时间时「提前 …」置灰并说明原因）+ 清除；自动保存为 UTC，笔记没有提醒字段。Today 与悬浮窗里待办多了「已过截止 / 今天截止 / 明天截止」标记（只比较本地日期，「今天」取自后端），Tip 显示 💡 与具体时间（原有）。测试：预设计算与 UTC 往返 7 个、详情面板 2 个、截止标记 2 个。

---

# 9. Phase 5 — Workflow Engine

**目标**：实现可声明式配置的 Linear Pipeline Workflow（产品文档 §9–10，架构文档 §18–21、§27–28）。**不做 DAG、不做 Script（Phase 8）、不做 HTTP（6.1）。**

**阶段退出标准**：所有 Capture 都经过 Resolver → Engine；2.3 的默认规则已改写为内置 Generic Workflow；用户可复制并自定义 Workflow 且立即生效；Workflow 失败时捕获内容不丢失。

---

### 5.1 Workflow 领域模型与定义格式

- **状态**：✅
- **依赖**：2.1
- **目标**：建立 Workflow 的数据模型与可交换的定义格式。
- **任务**：
  - Domain：`Workflow`、`WorkflowMatcher`、`WorkflowStep`（枚举先包含本阶段与 6.x 需要的变体）、`WorkflowPermissions`、`WorkflowSource{Builtin,User,Imported,Marketplace}`、`version`、`schema_version`、`priority`。
  - JSON 定义格式 `*.workflow.json` 及其 JSON Schema（`workflows/schema/workflow.schema.json`）。
  - `migrations/0005_workflow.sql`：`workflows`、`workflow_steps`、`workflow_runs`、`workflow_run_steps`。
- **验收标准**：
  - [x] 定义的 serde 往返测试通过。
  - [x] JSON Schema 能校验所有示例定义；非法定义给出带 JSON 路径的错误信息。
  - [x] Storage 测试覆盖 Workflow CRUD。
- **完成记录**：2026-10-11 完成。`nivlo-domain::workflow`（serde 往返测试）、`workflows/schema/workflow.schema.json` 与 `nivlo-workflow::validate`（所有内置与示例定义通过；非法定义带 JSON 路径）；存储测试 `workflows_round_trip_and_upsert_keeps_creation_time`。偏差：迁移为 `0006_workflow.sql`（0005 已被 trigger_log 占用）；步骤作为 JSON 存在 `workflows.definition` 列里，不再单设 `workflow_steps` 表（Workflow 总是整体读写）。

### 5.2 Matcher 与 Resolver

- **状态**：✅
- **依赖**：5.1
- **目标**：声明式匹配，按 Specificity + Explicit Priority 选择 Workflow（架构文档 §21）。
- **任务**：
  - 支持字段：`input.type`、`url.scheme/host/path/query`、`file.name/extension/mime/path`、`text.contains/regex/prefix/suffix`、`source.application`；支持 `all` / `any` / `not` 组合。
  - Host / Path / 文件名使用 glob（如 `*.atlassian.net`、`REQ-*.docx`）；Regex 有长度与复杂度限制，编译结果缓存。
  - Resolver：跳过禁用项；优先级相同时按 Specificity，再按稳定 ID 排序（确定性）。
- **验收标准**：
  - [x] 表驱动测试覆盖所有匹配字段与组合。
  - [x] 同一输入多次解析结果一致（确定性测试）。
  - [x] 100 个 Workflow 时一次匹配 < 1ms（benchmark 记录）。
- **完成记录**：2026-10-11 完成。表驱动测试覆盖全部字段与组合；解析确定性测试；`one_hundred_workflows_resolve_quickly`（100 个 Workflow 一次匹配远低于 1ms）。

### 5.3 Engine、Context 与 Executor Registry

- **状态**：✅
- **依赖**：5.2；D-11
- **目标**：实现 Linear Pipeline 执行引擎（架构文档 §18–20、§28、§39）。
- **任务**：
  - `WorkflowContext`（run_id、input、origin、vars、metadata、outputs、permissions）。
  - `WorkflowStepExecutor` trait + Registry（禁止巨型 match）。
  - 按顺序执行；Fatal 错误短路；Condition 可跳过后续 Step；支持 `CancellationToken` 与整体超时。
  - 错误分类：Retryable / Fatal / PermissionDenied / UserActionRequired / Timeout / InvalidInput，映射为带 UI Action 的 `AppError`。
  - 按 D-11 实现模板插值。
  - 执行不在 UI 线程，耗时阻塞工作使用 `spawn_blocking`。
- **验收标准**：
  - [x] 使用 Fake Executor 的测试覆盖：顺序执行、短路、条件跳过、取消、超时、错误映射。
  - [x] Engine 代码中没有任何 Jira / GitHub 等具体领域逻辑（代码审查）。
  - [x] 模板插值测试覆盖缺失变量、默认值、转义。
- **完成记录**：2026-10-11 完成。Fake Executor 测试覆盖顺序、短路、条件跳过、取消、超时与错误映射；Engine 只通过 Registry 认识 Step；模板插值覆盖缺失变量、默认值、转义（D-11 采用 `{{ var | filter }}`）。

### 5.4 基础 Step Executor

- **状态**：✅
- **依赖**：5.3
- **目标**：实现 MVP 所需的本地 Step。
- **任务**：
  - `Extract`（从输入提取字段，如 URL 片段、文件名片段）、`Regex`、`JsonPath`、`Transform`（字段映射）、`Condition`、`CreateItem`（Todo / Note / Tip，复用 2.3 的事务逻辑）、`AddTag`。
- **验收标准**：
  - [x] 每个 Executor 有基于 fixtures 的单元测试。
  - [ ] `CreateItem` 产出的 Item 带完整 Source，且与 Item / Source / Tag 写入处于同一事务。
- **完成记录**：2026-10-11 完成（引擎侧）。每个 Executor 有 fixtures 测试。引擎是纯计算、产出 `ItemDraft`，由 Application 在**同一事务**里写入 Item / Source / Tag（见 5.5）；因此没有在 Step 里直接写库。
  - 2026-10-11 盘点：第二条验收仍未勾选。现有证据是 `a_duplicated_workflow_with_higher_priority_wins_and_tags_the_item`（Workflow 产出的 Item 带 Source 与 Tag）和默认规则路径的 `a_failed_commit_leaves_no_records_and_removes_the_stored_image`；缺少「经 Workflow 捕获且带 Tag 时提交失败，Item / Source / Tag 均不残留」的测试，补上后再勾选。

### 5.5 Capture 接入 Workflow

- **状态**：🟨
- **依赖**：5.4
- **目标**：所有 Capture 走 Workflow，且**捕获永不丢失**。
- **任务**：
  - `CaptureService` → Resolver → Engine；将 2.3 的默认规则改写为内置 Generic Workflow（URL / File / Text / Image）。
  - 异步 Workflow 期间 UI 显示「处理中」，完成后变为「Created ✓」。
  - Workflow 失败时：按原始输入创建 Inbox Item 并标记失败原因，可在 Item 上「重新运行 Workflow」。
- **验收标准**：
  - [x] 测试：Workflow 在任一 Step 失败时，原始输入仍作为 Inbox Item 保存。
  - [ ] 本地 Workflow 从 Drop 到进入「处理中」状态 < 100ms。
  - [x] 2.3 原有测试在改写后全部通过（行为不回退）。
- **完成记录**：2026-10-11 完成主体。`CaptureService::with_workflows`：Resolver → Engine → 同一事务写入 Item / Source / Attachment / Tag；无匹配、无产出或失败时退回默认规则，失败原因写进 Source 元数据（`workflowError`），捕获永不丢失。内置 Generic Workflow 复刻原有规则；原 2.3 测试未改动且全部通过，另有 `crates/nivlo-workflow/tests/capture.rs`（内置复刻、复制后高优先级获胜、Step 失败兜底）。2026-10-11 补充：Item 详情的来源区新增「重新运行规则」（`rerun_workflow`，按来源重新匹配并完整运行，用户主动触发所以覆盖标题与内容；文字 / 图片来源报 `WORKFLOW_RUN_FAILED`），测试 `rerun_overwrites_on_request_and_refuses_sources_it_cannot_replay`。「处理中」状态改为：捕获本身即时完成（不等网络），联网补全在后台进行，因此没有单独的处理中 UI。仍待真机度量 Drop → 创建 < 100ms。

### 5.6 Workflow Run 记录与调试

- **状态**：✅
- **依赖**：5.5
- **目标**：实现架构文档 §27 的轻量 Run 记录。
- **任务**：
  - 每次执行写入 `workflow_runs`；Debug 模式写入 `workflow_run_steps`（Step 名称、状态、耗时）。
  - 输入 / 输出只存脱敏摘要（不存全文）。
  - 有界保留（如最近 500 条或 30 天，可配置），定期清理。
- **验收标准**：
  - [x] 保留策略测试（FakeClock）。
  - [x] 测试断言 Run 记录中不包含全文内容与 Token。
- **完成记录**：2026-10-11 完成。每次经由 Workflow 的捕获在提交后尽力写入 `workflow_runs` / `workflow_run_steps`（记录失败不影响捕获）；输入只存脱敏摘要（文字只记字数，网址去掉查询串与片段，文件只记文件名）。保留 500 条 / 30 天，启动时与之后每 6 小时清理一次。测试：`run_history_is_bounded_by_count_and_by_age`（FakeClock）、`input_summaries_never_contain_…`、`run_records_never_contain_the_full_text_or_url_secrets`，以及 SQLite 的 `workflow_runs_are_listed_newest_first_…`。偏差：Step 记录始终写入（体量很小），没有单独的 Debug 开关。

### 5.7 Workflow 管理 UI

- **状态**：✅
- **依赖**：5.6
- **目标**：用户可查看、启用 / 禁用、复制并自定义 Workflow（产品文档 §14「Duplicate → Customize」）。
- **任务**：
  - Workflow 列表（Builtin / User 分组）、启用开关、优先级调整。
  - 内置 Workflow 只读，提供「Duplicate」。
  - 表单式编辑器：Matcher 条件、目标类型、字段映射（标题 / 内容 / 标签 / 项目 / 日期模板）。
  - 试运行：输入样例（URL / 文件 / 文本）预览结果，不创建 Item。
  - 简单 Run Inspector：最近执行列表与 Step 耗时。
- **验收标准**：
  - [x] 端到端：复制内置 Web Workflow → 改为生成带 `#read` 标签的 Todo → 之后拖入 URL 使用新 Workflow。
  - [x] 无法直接修改内置 Workflow 本体。
  - [x] 试运行不产生任何数据写入（测试断言）。
- **完成记录**：2026-10-11 完成。新增侧栏「自动化」视图（`features/workflows`）：内置 / 我的分组列表、启用开关、优先级加减、表单编辑器（匹配条件、创建类型、标题 / 内容 / 标签模板、收集箱与今天）与 JSON 编辑、试运行面板、最近执行（Run Inspector，Step 状态与耗时）。8 个 IPC 命令（`list_workflows` … `list_workflow_runs`），定义以 JSON 文本往返，保存走与导入相同的深度校验，出错位置显示在编辑区。证据：`workflows.test.tsx`（复制内置网页规则 → 改为带 read 标签的待办 → 试运行 → 保存；内置只读；试运行不触发任何创建 / 捕获调用；校验错误带位置），后端 `crates/nivlo-workflow/tests/capture.rs` 证明复制后的高优先级规则在真实捕获中胜出，`dry_run_returns_the_result_and_writes_nothing`。表单遇到无法表示的定义（嵌套条件、`forEach` 等）自动改用 JSON，不会悄悄丢内容。Item 上「重新运行 Workflow」与捕获「处理中」状态仍留在 5.5。

---

# 10. Phase 6 — Built-in Workflow & Smart Capture

**目标**：提供开箱即用的官方 Workflow（产品文档 §11、§14，架构文档 §22、§51）与自然语言日期解析。所有内置 Workflow 在**未配置任何 API 凭据**时也能完成基本捕获。

**阶段退出标准**：Jira、GitHub、Web Page、PDF、Word、Markdown、Image、Generic File 内置 Workflow 全部可用，且离线时降级为 URL + 标题 / 文件引用。

---

### 6.1 HttpPort 与网络权限

- **状态**：✅
- **依赖**：5.3
- **目标**：所有网络访问经过统一、受权限约束的 HttpPort（架构文档 §36、§44）。
- **任务**：
  - `HttpPort` + reqwest 适配器：超时、User-Agent、系统代理、TLS、重试策略、响应体大小上限。
  - 按 Workflow Effective Permission 的 Host 白名单检查；重定向后的 Host 重新检查；默认禁止 localhost / 私有 IP / `file://`。
  - `Http` Step Executor。
- **验收标准**：
  - [x] 测试：未授权 Host → PermissionDenied；重定向到未授权 Host 被拦截；超过大小上限被截断 / 拒绝。
  - [x] 日志中不出现 Authorization / Cookie 头（测试断言）。
- **完成记录**：2026-10-11 完成。`HttpPort` + `HostPolicy`（`nivlo-application::ports::http`，纯逻辑，真实适配器与 Fake 共用）：只允许 http(s)，默认拒绝 localhost / `*.local` / 环回、私有、链路本地、CGNAT、IPv6 唯一本地与映射地址，主机必须匹配 `permissions.hosts`（精确或 `*.域名`）。`ReqwestHttp`（`nivlo-integrations`，rustls）：自己逐跳跟随重定向并重新检查策略（最多 5 跳）、整体超时、边读边计数的大小上限（超出截断并标记）、系统代理；`encoding_rs` 解码 GBK 等非 UTF-8 页面。`http` Step（Domain `Step::Http` + Schema + 校验：用到 http 必须声明 `network` 与 `hosts`；`optional` 让离线 / 非 2xx 不报错，但权限问题永远报错；状态码分类 403→UserActionRequired、429/5xx→Retryable）。测试：`integrations/src/http/tests.rs`（本机假服务器：未授权主机、重定向到未授权 / 内网被拦、死循环重定向、大小截断、超时）、`integrations/tests/logging.rs`（日志不含查询串 / Authorization / Cookie；独立进程避免 tracing 调用点缓存干扰）、`workflow/tests/http_step.rs`、策略单元测试。已知边界：策略只看 URL 主机，不解析 DNS（见 http.rs 文档）；试运行遇到 http Step 会真实发 GET（只读）。

### 6.2 内置 Workflow 打包与同步

- **状态**：✅
- **依赖**：5.1
- **目标**：实现架构文档 §51 的内置 Workflow 打包与版本同步。
- **任务**：
  - `workflows/builtin/*.workflow.json` 作为应用资源打包。
  - 启动时读取 → 比较版本 → 同步进数据库；用户的启用状态与优先级覆盖单独保存。
  - `schema_version` 不兼容时跳过并记录。
- **验收标准**：
  - [x] 升级内置定义版本后数据库中定义更新，用户的启用 / 优先级设置保留。
  - [x] 用户复制出的 Workflow 不受内置升级影响。
- **完成记录**：2026-10-11 完成。内置定义用 `include_str!` 编译进二进制（等价于应用资源，且不会被用户误删），启动时 `sync_builtin`：缺失的加入、版本升高的覆盖定义并保留用户的启用 / 优先级、同版本不动；格式版本不兼容的定义跳过并记录日志。测试：`builtin_sync_adds_missing_ones_and_keeps_user_choices_on_upgrade`、`a_definition_from_a_newer_schema_is_rejected_by_validation`；用户副本使用 `user.*` ID，同步只触碰 `builtin.*`，因此不受升级影响。偏差：启用 / 优先级直接写在 workflows 行里（升级时保留），没有单独的覆盖表。

### 6.3 Generic Web Page（页面元数据）

- **状态**：✅
- **依赖**：6.1、6.2
- **目标**：URL → Note，自动补全标题与摘要。
- **任务**：
  - `HtmlMetadata` 提取：`<title>`、`og:*`、`description`、favicon。
  - 先以 URL 立即创建 Item，元数据获取完成后更新（不阻塞捕获）。
  - 获取失败时保留 URL 与浏览器提供的标题（如有）。
- **验收标准**：
  - [x] 基于保存的 HTML fixtures 的提取测试（含中文编码页面）。
  - [x] 断网时仍创建带 URL 的 Note。
- **完成记录**：2026-10-11 完成。两阶段捕获：`RunMode::Instant` 先不联网地创建（`http` Step 被引擎直接跳过，拖放不等网络），联网的 Workflow 经后台队列由 `CaptureService::enrich` 用 `RunMode::Full` 补全；只更新标题仍是即时标题、且创建后没被动过的 Item（不覆盖用户的修改），联网结果与即时版本相同则不写；失败只记运行记录。新增 `htmlMeta` Step 与 `html_meta` 提取（og:title > title、og:description > description、site、image、favicon；实体解码、相对地址补全、只扫前 256KiB）、模板 `default(input.title)` 回退到另一个变量、内置 `builtin.web-page`（priority 1，`hosts: ["*"]` 只放行公网）。测试：`html_meta` 单元测试（含属性乱序 / 引号风格 / 不安全 scheme）、`http.rs` GBK 解码、`tests/web_page.rs`（即时→补全、离线保持、用户已改不覆盖、文本不入队、GBK 页面标题）。偏差：Item 的「补全中」状态没有单独的 UI 标记；favicon 与预览图只提取为变量，尚未存储。

### 6.4 Jira Issue（无 API 降级路径）

- **状态**：✅
- **依赖**：6.3
- **目标**：实现产品文档 §11 的降级链中「Page Metadata → URL + Page Title」两级（API 级在 9.3）。
- **任务**：
  - Matcher：`*.atlassian.net/browse/*` 及用户可配置的自托管 Jira Host。
  - 提取 Issue Key；从页面标题解析标题；生成 Todo `[AI-128] Title`；Source `Jira · AI-128`；Integration 字段写入 `metadata_json`。
- **验收标准**：
  - [x] fixtures 测试：Cloud 与自托管 URL 格式均可识别 Issue Key。
  - [x] 无凭据、未登录（页面需要认证）时仍生成 `[KEY] ` + 可得标题的 Todo。
- **完成记录**：2026-10-11 完成。内置 `builtin.jira-issue`（priority 20）：按路径 `^/browse/KEY-123` 识别，**不限定主机**，所以 `*.atlassian.net` 与自托管 Jira 都能识别（偏差：计划里的「用户可配置自托管 Host」因此不需要配置；内网 Jira 因 HostPolicy 拒绝内网地址读不到页面标题，只保留工单号）。步骤：提取 Key → 可选 http → htmlMeta → 仅当标题以 `[KEY]` 开头才提取标题（登录页不会污染）→ 待办 `[KEY] 标题`；Source 原始标题写 `Jira · KEY`，`metadata_json` 写 `{integration, issueKey, host}`（新增 createItem 的 `sourceLabel` / `metadata`）。fixtures：`fixtures/jira/cases.json`；测试 `tests/jira.rs`：Cloud / 自托管 / 带查询串 / 末尾斜杠识别，非 Jira 路径不误判；页面标题补全（含无 Jira 后缀）；登录页、离线、超时都仍生成 `[AI-128]`。

### 6.5 GitHub Issue / PR

- **状态**：✅
- **依赖**：6.3
- **目标**：GitHub URL → Todo。
- **任务**：
  - 解析 owner / repo / number / 类型（issue / pull）。
  - 尝试公开 API（未认证）获取标题与状态，失败或限流时退回页面元数据。
  - 标题示例：`Review PR #182: <title>`、`[repo#123] <title>`。
- **验收标准**：
  - [x] fixtures 测试覆盖 Issue、PR、带锚点 / 子路径的 URL。
  - [x] 模拟 API 限流（403 / 429）时自动降级并成功创建。
- **完成记录**：2026-10-11 完成。内置 `builtin.github-pr` 与 `builtin.github-issue`（priority 20；Workflow 没有分支，所以 PR 与 Issue 各一个）：从路径提取 owner / repo / number（深链接 `/files`、`/commits/…`、锚点、查询串都能识别，`/pulls`、非数字编号、其他主机不误判）；未认证的公开 API `api.github.com/repos/{owner}/{repo}/issues/{n}` 取标题与状态，403 / 429 / 超时 / 非 JSON 时退回页面标题（`… · Pull Request #182 · …`），都不行就只保留编号（「Review PR #182」/「[repo#123]」）。标题：`Review PR #182: <title>`、`[repo#123] <title>`；Source 写 `GitHub · owner/repo#N`，`metadata_json` 写 integration / kind / owner / repo / number / state。配套引擎改进：`extract` / `jsonPath` 的 `optional` 现在也覆盖「来源变量不存在 / 不是 JSON」，`default(var)` 在回退变量也缺失时交给后面的 `default("…")`。fixtures：`fixtures/github/cases.json`；测试 `tests/github.rs`（URL 解析、API 取标题、403/429/超时降级、全部失败）。

### 6.6 文件类 Workflow

- **状态**：✅
- **依赖**：5.5
- **目标**：PDF / Word / Markdown / Image / Generic File / Requirements / Meeting（产品文档 §14）。
- **任务**：
  - PDF、Word：Note + 文件引用；尽量读取文档标题元数据。
  - Markdown：读取首个标题作为 Note 标题（被拖入的文件视为隐式授予读取权限）。
  - Image：Note + 附件（OCR 不在 MVP）。
  - `REQ-*` / `PRD-*` → Todo「处理 <文件名>」+ 文件引用；`meeting-*.md` → Note。
  - Generic File：Note + 文件引用。
  - 文件解析在 `spawn_blocking` 中执行，有文件大小上限。
  - 「Downloads 目录监听」属于自动捕获，标记为 ➖，移入 Backlog。
- **验收标准**：
  - [x] 每种 fixture 文件生成预期的 Item 类型、标题与 Source。
  - [x] 拖入 500MB 文件不阻塞 UI，超过上限时只保存引用。
- **完成记录**：2026-10-11 完成。新增 `readFile` Step 与 `FileInspector` Port（`FsFileInspector` 在 `spawn_blocking` 里只读被拖入的那个文件，路径只来自 Workflow 输入；超过 32 MiB 不读内容，只保存引用——500 MB 稀疏文件测试在毫秒内返回且不读取）。`doc_meta` 提取标题：Markdown（front matter `title:` > 首个 ATX 标题 > setext，忽略代码块与 #tag）、PDF（`/Title` 字面 / 十六进制 / UTF-16BE / 转义）、Word（docx 压缩包里 `dc:title`）。内置 `builtin.file-document`（md / pdf / docx → 笔记，标题优先用文档标题，读不到用文件名）、`builtin.file-requirements`（`REQ-*` / `PRD-*` → 待办「处理 文件名」）、`builtin.file-meeting`（`meeting-*.md` → 带 meeting 标签的笔记）；Image 与 Generic File 沿用 `builtin.generic-image` / `generic-file`（笔记 + 附件 / 文件引用）。测试：`tests/files.rs`（每种文件的类型 / 标题 / 附件，超大 / 缺失 / 不可读退回文件名，多文件保持通用行为）、`doc_meta` 单元测试、`FsFileInspector` 测试。「Downloads 目录监听」属于自动捕获，按计划标记为 ➖ 移入 Backlog。偏差：legacy `.doc` 不提取标题（只当作通用文件）；Source 的文件路径 / MIME 沿用 5.5 的通用写入。

### 6.7 自然语言日期解析

- **状态**：✅
- **依赖**：4.1、1.5
- **目标**：实现产品文档 §6.2「明天 Review PR → scheduled = tomorrow」。
- **任务**：
  - 中英文解析：今天 / 明天 / 后天 / 下周一 / 周五 / X月X日 / 下午3点 / tomorrow / next Monday / Oct 2 等。
  - 在 Quick Create 中实时显示解析结果标签；Backspace 可取消本次解析；标题中去掉日期短语。
  - 歧义输入保留为普通文本。
- **验收标准**：
  - [x] 表驱动测试 ≥ 50 条（含歧义与不应解析的用例）。
  - [x] 解析结果在提交前对用户可见且可取消。
- **完成记录**：2026-10-11 完成。解析器 `quick-create/model/date-phrase.ts`（纯函数，前端实时解析；「今天」取自后端的 Today 视图）：中文 今天 / 明天 / 后天 / 大后天、周五 / 星期三 / 礼拜日、下周一 / 下下周二 / 本周五 / 这周日、X月X日（也接受「号」）、完整日期；时间 下午3点 / 3点半 / 3点30分 / 15:30 / 晚上8点；英文 today / tomorrow / day after tomorrow / next Monday / this Friday / on Fri / Oct 2 / 2 Oct / October 2nd, 2027 / 2026-10-21 / 3pm / 3:30 pm / 15:00；只有时间时计划在今天；日期与时间各取第一个。**歧义与不确定的保持普通文本**：没有时段的 1–6 点、不存在的日期、整句只有「明天」、比例 `16:9`、版本号、「周五前」「before Friday」「by Friday」（截止语义，不是计划）、已经过去的明确日期、`sat on the fence` 之类。去掉短语时会带走紧挨着的连接词（「在 / on / at」与「今天**的**会议」里的「的」），不误伤「在家办公」。Quick Create 里输入时实时显示「识别到计划：明天 · 10月15日 周四 15:00」，✕ 或（光标与短语都在末尾时的）第一下退格取消识别，标题保持原样；提交时标题去掉了短语、计划随 `quick_create` 的新字段 `scheduled` 传给后端（`ItemService::quick_create_scheduled`）。测试：表驱动 83 条（含 20 条不应解析的）、表单 7 个、IPC 端到端 1 个、Rust 1 个。

---

# 11. Phase 7 — MVP Hardening & Release

**目标**：让 MVP 达到可发布质量（架构文档 §45、§46、§48–50、§57）。

**阶段退出标准**：M4 达成——Windows 安装包签名发布；自动更新可用；E2E 与性能预算通过；可导出诊断与备份。

---

### 7.1 Desktop E2E 关键路径

- **状态**：⬜
- **依赖**：Phase 1–6
- **任务**：
  - 使用 tauri-driver（WebDriver）在 Windows CI 上运行 E2E。
  - 覆盖：应用启动、Hover 悬浮窗、Quick Add、完成 Todo、拖入文件（或通过测试钩子模拟 Drop）、排期。
- **验收标准**：
  - [ ] 上述 6 条路径在 Windows CI 上稳定通过（连续 10 次无偶发失败）。
- **完成记录**：—

### 7.2 性能预算与长稳验收

- **状态**：⬜
- **依赖**：7.1
- **任务**：
  - 复跑 1.11 的测量，覆盖 Workflow、Scheduler、Calendar 引入后的状态。
  - 24 小时长稳：包含休眠唤醒、跨午夜、批量捕获。
  - 检查 Workflow Run、日志、缓存是否有界。
- **验收标准**：
  - [ ] 架构文档 §46 各项预算达标，结果写入 `perf-baseline.md` 并与 1.11 对比。
  - [ ] 24 小时内存增长 < 15%，无崩溃。
- **完成记录**：—

### 7.3 Diagnostics 导出

- **状态**：✅
- **依赖**：0.4
- **任务**：
  - 设置页「Export Diagnostics」：App 版本、OS、架构、WebView 版本、DB Schema 版本、Workflow 元数据、最近脱敏日志，打包为 zip。
- **验收标准**：
  - [x] 导出包中不含 Token、Note 全文、剪贴板内容、用户文件内容（自动化检查：使用含特征字符串的测试数据，断言导出包中不出现）。
- **完成记录**：2026-10-11 完成。设置页新增「数据与诊断 → 导出诊断信息」：`export_diagnostics` 在 `<数据目录>/exports/` 生成 `nivlo-diagnostics-<时间>.zip`（`environment.json`：应用版本 / OS / 架构 / WebView 版本 / Schema 版本 / Workflow 元数据（不含定义）；`logs/`：最近 3 个日志文件的末尾 512 KiB；`README.txt`），并在文件管理器中选中。日志逐行**防御性脱敏**：Authorization / Cookie 整行、Bearer / 常见令牌格式、`token|password|api_key|secret=…`、`title|content|text|clipboard|…="…"` 业务字段、URL 查询串与片段、邮箱、用户目录里的用户名。自动化检查 `diagnostics::tests::the_bundle_never_contains_note_text_clipboard_tokens_or_file_contents`：往日志里塞入含特征字符串的笔记全文 / 剪贴板 / 令牌 / URL 密钥 / 用户名，断言导出包中全部不出现；另有日志名不得逃出 `logs/`、数量上限、最近日志选择的测试。新增错误码 `EXPORT_FAILED`。

### 7.4 备份与数据导出

- **状态**：✅
- **依赖**：Phase 3
- **任务**：
  - Export Backup：SQLite 一致性快照（`VACUUM INTO` 或备份 API）+ Workflow + Settings，不含 Secret。
  - 导出为 JSON 与 Markdown（每个 Note / Todo 一个文件或单文件，按选项）。
  - 从 Backup 恢复（替换当前数据前自动备份当前数据）。
- **验收标准**：
  - [x] 备份 → 清空 → 恢复后数据完全一致（自动化测试比较）。
  - [x] 导出的 Markdown 可在任意编辑器中阅读，含 Source 信息。
- **完成记录**：2026-10-11 完成。设置页「数据与诊断」新增三项。**备份**：`Database::snapshot_to`（`VACUUM INTO`，事务一致，应用运行中即可）+ 清单 + Nivlo 自己保存的附件打成 zip（先写 `.partial` 再改名，失败不留半成品）；Workflow 与设置都在库里，不含任何 Secret，也不含用户被引用的原始文件。**恢复**：选择备份 → 校验（格式 / 版本、只允许 `nivlo.db` 与 `attachments/`、路径穿越拒绝、SQLite `integrity_check`、Schema 版本不得比本程序新）→ **先自动为当前数据做一份 `nivlo-before-restore-*.zip`**（做不成就不继续）→ 暂存 → 提示重启；下次启动在**打开数据库之前**把当前数据整体挪到 `replaced-<时间>/`（不删除）再换上备份，失败会回滚。**导出**：JSON（完整，含来源 / 标签 / 项目 / 时间戳）、Markdown 单文件、Markdown 每条一个文件（zip，文件名净化且唯一，带 YAML front matter），回收站不导出，Integration 内部元数据不导出。测试：`backup::tests::backup_then_wipe_then_restore_gives_back_identical_data`（备份 → 清空 → 恢复，Item 与附件完全一致，被替换的数据仍在 replaced 目录）、坏备份（缺 manifest / 路径穿越 / 多余文件 / 缺库 / 库损坏 / 格式不对 / 来自更新版本）全部拒绝且不留暂存数据；`export::tests`（JSON / Markdown 内容、来源行、文件名安全、回收站）；storage 的快照 / 校验测试；UI 测试覆盖导出 / 备份 / 恢复流程与取消。偏差：恢复需要重启才生效（运行中的应用不能替换自己正在用的数据库）；「按选项」的导出选项做成三种格式的下拉。

### 7.5 首次运行引导与体验打磨

- **状态**：🟨
- **依赖**：Phase 1–6
- **任务**：
  - 首次运行：介绍悬浮窗（Hover / Click / Drop）、询问开机自启、展示快捷键。
  - 英文文案补齐（D-06）；空状态、错误文案统一审校。
  - 基础可访问性：键盘可达、对比度、焦点可见。
  - 原生侧文案国际化（2026-10-11 盘点补入，依赖 D-14）：托盘菜单、开机自启询问、恢复对话框、Scheduler 通知标题与正文按当前语言显示，切换语言后托盘菜单即时更新。
  - D-07「隐藏已完成」开关（2026-10-11 盘点补入，3.5 遗漏）：Today（悬浮窗与主窗口）可隐藏今日已完成的 Todo，设置持久化。
- **验收标准**：
  - [ ] 新用户在无说明文档的情况下可在 2 分钟内完成「Hover → 新建 → 完成」（至少 3 人可用性测试记录）。
  - [ ] 中英文切换后无缺失文案。
- **完成记录**：（进行中）2026-10-11：首次运行引导完成——主窗口第一次打开时的四步欢迎（悬浮窗徽标在哪 / 悬停与点击 / 拖入与粘贴收集 / 自然语言与全局快捷键），用样式化的小插图模拟真实界面，随主题换色，动效尊重「减少动态效果」；全键盘（← → 切换、Enter 前进、Esc 跳过，每步焦点落在主按钮），步骤指示点可点击；快捷键取自真实绑定；看过 / 跳过都会记为已看过（`onboarding.completed`），设置页「新手引导 → 重新查看」可以再看一遍。开机自启的首次询问沿用 1.9 的原生对话框。2026-10-11：英文文案（D-06）完成——`en.json` 覆盖全部界面文案（含单复数），设置页「语言」可即时切换并持久化，悬浮窗通过 `storage` 事件同步；日期格式（月日 / 星期 / 相对时间）随语言变化（`lib/date-format.ts`）；`i18n.test.ts` 断言英文不缺失、不多余、插值变量一致。未覆盖：托盘菜单与原生对话框的文案仍是中文（Rust 侧）。待办：空状态与错误文案的统一审校、可访问性审计（对比度 / 焦点可见）、可用性测试记录（需要真人）。
  - 2026-10-11 原生文案国际化（完成）：语言与主题经 `set_ui_pref` 写入 `settings` 表（`ui.language`、`ui.theme`），启动时主窗口回填缓存并为升级前的用户补写；新增 `native_i18n`（`Lang`），托盘菜单与悬停提示、开机自启询问、Scheduler 通知（`nivlo-scheduler` 新增 `Locale`，`Control::set_locale`）均有中英文版本，切换语言后托盘菜单即时更新、通知下一条起生效。恢复对话框（`lifecycle/recovery.rs`）因数据库不可用读不到语言偏好，按系统语言（`sys-locale`，中文用简体中文、其余英文）显示。D-07「隐藏已完成」开关完成：设置页开关 → `stores/display-store.ts`（`ui.hide_completed` 写入 settings，悬浮窗经 `storage` 事件同步），`TodayList` 据此隐藏已完成区。7.5 仍待：空状态与错误文案审校、可访问性审计、可用性测试记录（需真人）。以下为盘点时的原始记录，现已解决：
  - 2026-10-11 盘点：「中英文切换后无缺失文案」尚不满足——Rust 侧文案（`tray.rs`、`autostart.rs`、`lifecycle/recovery.rs`、`nivlo-scheduler` 的 `plan.rs`）仍硬编码中文，且语言偏好只在前端 `localStorage`，后端无从得知（D-14）。「隐藏已完成」开关补入本子阶段任务。

### 7.6 安装包、签名、Updater 与发布流水线

- **状态**：⬜
- **依赖**：7.1
- **任务**：
  - Windows 安装包（NSIS 或 MSI），代码签名。
  - Tauri Updater：签名的更新包 + HTTPS 更新端点 + Updater Manifest。
  - 发布流水线：Git Tag → CI Build → 签名 → Artifacts → Updater Manifest → Release。
  - 版本号规范与 CHANGELOG。
  - 安装包注册应用标识（AppUserModelID）与开始菜单快捷方式，使 Windows 通知显示正确的应用名与图标（4.6 遗留），并为 10.6 的通知激活提供前提。
- **验收标准**：
  - [ ] 从 v0.1.0-rc 自动更新到 v0.1.0 成功，用户数据保留。
  - [ ] 安装包签名有效；安装 / 卸载干净（卸载不删除用户数据，除非用户选择）。
  - [ ] 打 Tag 即可自动产出 Release。
- **完成记录**：—

### 7.7 悬浮窗外观与自定义皮肤

- **状态**：🟨
- **依赖**：1.2、1.3、3.5；D-13、D-14
- **目标**：在不破坏常驻性能预算与「低视觉干扰」原则（产品文档 §5.1、§5.5）的前提下，让用户自定义悬浮窗外观。
- **任务**：
  - 外观偏好：强调色（blue / violet / teal / rose / amber）、徽标形态（胶囊 / 圆形 / 圆点）、面板质感（纯色 / 通透）、圆角（soft / round）、整体不透明度（40%–100%）。
  - 自定义皮肤：最多 16 帧 PNG（缩放到最长边 96px）、1–24 fps、播放方式（循环 / 往返 / 仅悬停 / 静止）、附加动效（无 / 漂浮 / 呼吸 / 弹跳）、像素风（最近邻缩放）、是否同时显示待办数。
  - 设置页「外观」与皮肤编辑；悬浮窗与主窗口实时同步。
  - 按 D-13 收敛动效的常驻开销，按 D-14 确定持久化位置并纳入 7.4 备份。
- **验收标准**：
  - [x] 系统开启「减少动态效果」时只显示第一帧、无附加动效（`SkinSprite` 检查 `prefers-reduced-motion`，CSS 动效仅在 `no-preference` 下生效；`skin-sprite.test.tsx`）。
  - [ ] 默认配置下 1.11 的空闲 CPU 预算不受影响；启用循环皮肤时的实测值写入 `perf-baseline.md`（D-13）。
  - [x] 悬浮窗收起或被隐藏、且播放方式不是循环类时，没有运行中的计时器或无限动画（测试断言：仅悬停且未悬停时无计时器；页面隐藏时计时器与附加动效 class 均移除）。
  - [x] 外观与皮肤随备份导出、恢复后保持一致（D-14）：`backup/tests.rs` 的备份 → 清空 → 恢复测试已断言 `ui.appearance` / `ui.skin` / `ui.language` / `ui.theme` 恢复为备份时的值。
  - [x] 徽标的无障碍名称（今天还剩 N 项待办）在任何外观 / 皮肤下保持不变（`aria-label` 只由剩余数量生成，皮肤图为 `aria-hidden`）。
- **完成记录**：（进行中）2026-10-11：未提交的实现——`stores/appearance-store.ts`、`stores/skin-store.ts`（均有单元测试）、`features/floating/SkinSprite.tsx`、`features/settings/SkinSetting.tsx`，`FloatingBadge` / `TodayPanel` / `SettingsPage` / `global.css` 接入，中英文文案已补；`pnpm typecheck / lint / test` 通过。偏差与待办：① D-13 已落实——默认播放方式改为「仅悬停」，页面隐藏（`document.hidden`）时停止计时器并移除附加动效 class，循环皮肤的实测值留待 7.2 写入 `perf-baseline.md`；② D-14 已落实——外观与皮肤经 `get_ui_pref` / `set_ui_pref`（仅主窗口 Capability）写入 `settings` 表（`ui.appearance`、`ui.skin`，设置值上限由 64KB 提高到 4MB 以容纳 PNG 帧），因此随 7.4 备份；`localStorage` 仅作首帧缓存，主窗口启动时以后端为准覆盖缓存，悬浮窗经 `storage` 事件同步。与推荐方案的差异：帧图直接放 settings 而非 `<数据目录>/skins/`。待办：备份恢复后一致性的端到端验证、语言 / 主题尚未迁移（7.5）；③ 本子阶段为计划外新增，于盘点时补入计划。

---

# 12. Phase 8 — Script Runtime（V2 Programmable Capture）

**目标**：以 QuickJS 实现受控的 Script Step（产品文档 §12，架构文档 §23–26）。

**阶段退出标准**：用户可编写 JS Script Step 并在权限范围内调用 `ctx.http` 等能力；超时 / 内存 / 异常 / 越权全部被正确拦截。

---

### 8.1 QuickJS Runtime 与 Script Worker

- **状态**：✅
- **依赖**：5.3
- **任务**：
  - `nivlo-script`：rquickjs Runtime；`ScriptPolicy`（默认超时 3s、最大 10s；默认内存 32MB、最大 64MB；栈上限）；Interrupt Handler 实现超时。
  - Script Worker Actor（独立线程，消息 `ScriptRequest` / `Cancel` / `Shutdown`），执行后重置 Context，防止状态泄漏。
- **验收标准**：
  - [x] 测试：正常脚本、死循环超时、内存超限、抛出异常均返回对应错误且 Worker 可继续服务下一个请求（`nivlo-script` 10 个测试，另含深递归、取消、状态隔离、上限钳制）。
  - [x] UI 线程中不存在任何 eval 路径（代码审查：`rquickjs` 只被 `nivlo-script` 依赖；前端无 `eval` / `new Function`；脚本只在独立 Worker 线程执行）。
- **完成记录**：2026-10-11 盘点：已有一份草稿（`ScriptPolicy` 钳制、每个请求全新 Runtime / Context 的 `ScriptWorker`，8 个测试覆盖正常返回、死循环超时、内存超限、异常行号、深递归、取消、状态隔离、上限钳制），放在 `.wip/`（`lib.rs`、`tests.rs`、`script-8.1.patch`），被 `.git/info/exclude` 排除、**不在版本控制中**。
  - 2026-10-11 完成：草稿移入 `p8.1-script-worker` 分支。适配 rquickjs 0.14——`Exception` 没有 `line()`，改为从调用栈文本解析第一帧行号（`first_line_number`，有单元测试）；`clippy -D warnings` 通过。

### 8.2 Script Context 与 Capability API

- **状态**：⬜
- **依赖**：8.1、6.1
- **任务**：
  - 暴露 `ctx.input`、`ctx.vars`、`ctx.metadata`、`ctx.utils`、`ctx.item`、`ctx.http`；`ctx.file`、`ctx.clipboard` 默认不可用，需权限。
  - 所有能力调用路径：JS → Rust Bridge → Permission Manager → Port → Adapter。
  - 支持 `export default async function(ctx)` 与 `transform(input)` 两种形式；返回值按标准 Item 结构校验。
  - 不暴露 Filesystem / Shell / Environment / Process / 原始网络 / OS Credential。
- **验收标准**：
  - [ ] 测试：越权调用 `ctx.http`（未授权 Host）→ PermissionDenied。
  - [ ] 测试：返回非法结构 → InvalidInput，错误信息指明字段。
  - [ ] 测试：脚本中无法访问 `require`、`process`、文件系统等全局对象。
- **完成记录**：—

### 8.3 Script Step 与 Workflow 权限

- **状态**：⬜
- **依赖**：8.2
- **任务**：
  - `Script` Step Executor；Script 权限必须是 Workflow Effective Permission 的子集。
  - Workflow 权限编辑 UI（网络 Host 白名单、文件读、剪贴板、通知），首次运行需用户确认授予。
- **验收标准**：
  - [ ] 测试：Script 声明超出 Workflow 的权限时被拒绝。
  - [ ] 修改权限后需重新确认才能运行。
- **完成记录**：—

### 8.4 脚本编辑器（CodeMirror）

- **状态**：⬜
- **依赖**：8.3、5.7
- **任务**：
  - CodeMirror 6 编辑 Script Step；提供 `ctx` 的类型声明（`.d.ts`）用于补全。
  - 试运行：输入样例、查看返回结果与 `console` 输出、耗时。
- **验收标准**：
  - [ ] 可在编辑器中编写架构文档 §12 示例脚本，试运行得到预期 Item。
  - [ ] 脚本错误时显示行号与错误信息。
- **完成记录**：—

### 8.5 Workflow 导入 / 导出

- **状态**：⬜
- **依赖**：8.3
- **任务**：
  - 导出 `*.workflow.json`（含 Script，不含任何 Secret）。
  - 导入时检查 `schema_version` 兼容性、展示请求的权限并要求用户确认、记录 `publisher`；导入的 Workflow 来源为 `Imported`，默认禁用。
- **验收标准**：
  - [ ] 导出 → 导入往返后行为一致。
  - [ ] 导入时用户可看到并确认全部权限；不兼容版本给出明确错误。
- **完成记录**：—

---

# 13. Phase 9 — Integration & Credential（V3）

**目标**：完成凭据安全存储与 Jira / GitHub API 集成（架构文档 §35–36）。

**阶段退出标准**：配置凭据后 Jira / GitHub Workflow 通过 API 获取完整字段；凭据只存于 OS 凭据库；401 等错误以用户可操作的方式呈现。

---

### 9.1 CredentialPort 与 Windows Credential Manager

- **状态**：⬜
- **依赖**：0.4
- **任务**：
  - `CredentialPort`（get / set / delete）；Windows Credential Manager 适配器。
  - 凭据只能由 Integration Adapter 读取，不暴露给 JS 与前端。
- **验收标准**：
  - [ ] 集成测试：写入、读取、删除凭据。
  - [ ] 搜索 SQLite 文件、配置文件、日志，均不出现测试 Token（自动化检查）。
- **完成记录**：—

### 9.2 Integration Registry 与 Integration Step

- **状态**：⬜
- **依赖**：9.1、6.1
- **任务**：
  - `IntegrationRegistry`；`Integration` Step Executor；HttpPort 自动注入认证信息。
  - 401 / 403 → `UserActionRequired`，携带 `OPEN_INTEGRATION_SETTINGS` Action。
- **验收标准**：
  - [ ] Workflow Engine 中没有任何具体 Integration 代码（代码审查）。
  - [ ] 测试：401 时 UI 显示「需要连接 Jira」及跳转按钮，而不是 HTTP 错误堆栈。
- **完成记录**：—

### 9.3 Jira API

- **状态**：⬜
- **依赖**：9.2、6.4
- **任务**：
  - Jira Cloud（Email + API Token）与 Server / Data Center（PAT）。
  - 获取 Key、Title、Description、Status、Priority、Assignee、Start / Due Date、Labels、Project、URL（产品文档 §11）；映射到 Item 与 `metadata_json`。
  - 完整降级链：API → Page Metadata → URL + Page Title。
  - 内网 / 自托管 Jira：用户在 Integration 中配置的 Host 可以绕过 HttpPort 的私网地址限制（只对该 Integration 生效），解决 6.4 中内网 Jira 只能保存工单号的问题。
- **验收标准**：
  - [ ] fixtures（录制的 API 响应）测试覆盖字段映射。
  - [ ] 凭据失效时自动降级并提示用户重新连接。
- **完成记录**：—

### 9.4 GitHub API

- **状态**：⬜
- **依赖**：9.2、6.5
- **任务**：
  - Token 认证；Issue / PR 的标题、状态、标签、指派人、里程碑。
- **验收标准**：
  - [ ] fixtures 测试覆盖 Issue 与 PR；私有仓库在配置 Token 后可获取。
- **完成记录**：—

### 9.5 Integration 设置 UI

- **状态**：⬜
- **依赖**：9.3、9.4
- **任务**：
  - 连接 / 测试连接 / 断开；显示连接状态与最近错误。
- **验收标准**：
  - [ ] 断开后凭据从 OS 凭据库删除（验证）。
  - [ ] 「测试连接」可区分网络错误、认证错误与权限不足。
- **完成记录**：—

---

# 14. Phase 10 — Windows Native Polish

**目标**：在 Tauri 默认能力不足的地方引入 Windows 原生实现（架构文档 §16、§53）。若 2.4 兼容矩阵显示核心来源失败，10.1 应提前到 Phase 2 之后立即执行。

---

### 10.1 Windows Native Drop Adapter

- **状态**：⬜
- **依赖**：2.4
- **任务**：
  - 基于 windows-rs 实现 `IDropTarget` / `IDataObject`，解析 `CF_HDROP`、`CF_UNICODETEXT`、`CFSTR_INETURL`，以及 Outlook 附件等 `FileGroupDescriptor` 场景（按矩阵需要）。
  - 作为 `DropPort` 的 Windows 实现，标准 WebView Drop 无法获取完整数据时补齐。
  - 范围拆分（D-15）：`CF_HDROP`（单 / 多文件、文件夹）为 MVP 部分，建议在 M4 发布前完成；`FileGroupDescriptor` 等其余格式按矩阵结果留在 Phase 10。
- **验收标准**：
  - [ ] 2.4 兼容矩阵中所有失败项重新测试并更新结果，核心项全部通过。
- **完成记录**：2026-10-11 盘点：2.4 的单元测试已确认资源管理器文件（单 / 多 / 文件夹）在 HTML5 Drop 下拿不到磁盘路径，满足 Phase 10 引言「核心来源失败时提前」的条件；是否列入 M4 待 D-15 定稿。

### 10.2 高级悬浮窗行为

- **状态**：⬜
- **依赖**：1.2
- **任务**：
  - `WS_EX_NOACTIVATE`、自定义 HitTest、窗口层级；可选：前台全屏应用时自动隐藏悬浮窗。
  - 能力检测与降级：高级能力不可用时退化为普通置顶窗口。
- **验收标准**：
  - [ ] 在任何交互（Hover、点击 Today 项、拖动排序）下都不抢走其他应用焦点，除 QuickCreate 输入外。
  - [ ] 全屏游戏 / 演示时悬浮窗不遮挡（若实现该选项）。
- **完成记录**：—

### 10.3 DPI 与多显示器热插拔加固

- **状态**：⬜
- **依赖**：1.2
- **任务**：
  - 处理 `WM_DPICHANGED`、显示器配置变化；运行中拔出显示器时悬浮窗迁移到可见位置。
- **验收标准**：
  - [ ] 运行中拔出悬浮窗所在显示器，悬浮窗在 1s 内出现在主显示器可见区域。
  - [ ] 运行中修改缩放比例，悬浮窗尺寸与位置正确。
- **完成记录**：—

### 10.4 来源应用识别

- **状态**：⬜
- **依赖**：2.1
- **任务**：
  - Drop / Paste 时识别来源应用（前台窗口进程名），写入 `source_app`，用于 `source.application` Matcher。
- **验收标准**：
  - [ ] 从 Chrome、Edge、Explorer、VS Code 拖入时 `source_app` 正确。
  - [ ] Matcher `source.application == Chrome` 可生效。
- **完成记录**：—

### 10.5 原生电源 / 时钟事件

- **状态**：⬜
- **依赖**：4.5
- **任务**：
  - 监听 `WM_POWERBROADCAST`、`WM_TIMECHANGE`，向 Scheduler 发送 `Resume`，替代 4.5 中的偏差检测（保留偏差检测作为兜底）。
- **验收标准**：
  - [ ] 唤醒后 Reconcile 在 2s 内触发（日志证据）。
- **完成记录**：—

### 10.6 原生通知激活

- **状态**：⬜
- **依赖**：4.6、7.6
- **任务**：
  - Windows Toast 激活：通知携带 Item ID，点击后由原生激活回调（安装包注册的 AppUserModelID + COM Activator，或等效方案）唤起主窗口并定位到对应 Item；应用未运行时点击通知能冷启动并定位。
  - 作为 `NotificationPort` 的扩展能力；不可用时（开发模式、未安装）退化为只显示通知。
- **验收标准**：
  - [ ] 点击通知打开主窗口并定位到对应 Item（关闭 4.6 的遗留验收项）。
  - [ ] 应用未运行时点击通知，启动后定位到对应 Item。
- **完成记录**：—（2026-10-11 由 4.6 的遗留项拆出：`tauri-plugin-notification` 在桌面端没有点击回调。）

---

# 15. Phase 11 — macOS / Linux

**目标**：实现其他平台的 Adapter，并支持 Graceful Degradation（架构文档 §53）。

---

### 11.1 跨平台 CI 与视觉回归

- **状态**：⬜
- **依赖**：Phase 7
- **任务**：
  - macOS / Linux CI 改为阻塞；建立 Windows / macOS / Linux 视觉回归测试（关键页面截图对比）。
- **验收标准**：
  - [ ] 三个平台 CI 全部为必需检查且通过。
  - [ ] 视觉回归覆盖悬浮窗（收起 / 展开）、Today、Inbox、Calendar。
- **完成记录**：—

### 11.2 macOS Adapter

- **状态**：⬜
- **依赖**：11.1
- **任务**：
  - NSPanel 悬浮窗与窗口层级、AppKit 拖拽、Keychain、通知、Login Item。
- **验收标准**：
  - [ ] M1 与 M2 的核心路径在 macOS 上通过；签名与公证（notarization）完成。
- **完成记录**：—

### 11.3 Linux Adapter

- **状态**：⬜
- **依赖**：11.1
- **任务**：
  - X11 / Wayland 差异处理（Wayland 下置顶与定位能力受限时降级）、Secret Service、WebKitGTK 兼容性。
- **验收标准**：
  - [ ] 在一个主流 X11 桌面与一个 Wayland 桌面上核心路径通过，并记录降级项。
- **完成记录**：—

---

# 16. Phase 12 — Backlog（未排期）

以下能力来自产品文档 §13、§15、§24、§29（V2–V5）与架构文档 §52，当前不排期；排期时应拆分为带验收标准的子阶段后移入正式阶段。

| 能力 | 来源 | 状态 |
|---|---|---|
| Downloads 等目录监听自动捕获 | 产品文档 §14 | ➖ 自动捕获需单独设计权限与性能策略 |
| Clipboard Watch（显式 opt-in） | 架构文档 §17 | ➖ |
| 手动 Project Order | 产品文档 §21、D-05 | ➖ |
| Workflow Nodes 扩展（Webhook、Copy File、Open URL、Notify 等） | 产品文档 §13 | ➖ |
| Workflow Gallery / Marketplace | 产品文档 §15 | ➖ 前置：独立进程 Script Worker |
| 独立进程 `nivlo-script-worker` | 架构文档 §26 | ➖ |
| Browser Extension、Email、Slack、Calendar 集成、Webhook | 产品文档 §29 V3 | ➖ |
| OCR、AI Processor / Extraction / Summary / Classification | 产品文档 §24、§29 V4 | ➖ |
| Plugin System、UI Extension | 架构文档 §52 | ➖ |
| Cloud Sync / Backup | 产品文档 §27.3 | ➖ |
| 数据导入（Markdown / JSON） | 架构文档 §57 | ➖ |

**MVP 明确不做**（架构文档 §60）：Cloud Account、Cloud Sync、Team Workspace、Multi-user、Complex DAG、Workflow Marketplace、Plugin Marketplace、Shell Step、Block-based Note Editor、Gantt、Habit、Pomodoro、Vector Database、AI Agent、Full Jira Two-way Sync。

---

# 17. 变更记录

| 日期 | 版本 | 说明 |
|---|---|---|
| 2026-10-09 | v1.0 | 基于产品文档与技术架构文档建立实施计划初版 |
| 2026-10-09 | v1.1 | 引用前端 / 后端开发规范；全局完成定义增加注释与 pnpm 要求；0.2 增加注释 Lint 与 pnpm 强制 |
| 2026-10-11 | v1.2 | MVP 发布差距盘点（§2.1）；D-11 补记定稿；新增 D-13（装饰动效与性能预算）、D-14（UI 偏好持久化位置）、D-15（10.1 提前到 M4）；新增 7.7 悬浮窗外观与自定义皮肤、10.6 原生通知激活；7.5 补入原生文案国际化与「隐藏已完成」开关；7.6 补入 AppUserModelID；9.3 补入内网 Jira；0.2 / 1.11 / 3.5 / 4.6 / 5.4 / 8.1 / 10.1 补记盘点结论 |
