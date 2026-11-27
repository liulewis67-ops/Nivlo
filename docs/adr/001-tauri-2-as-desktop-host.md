# ADR-001 Tauri 2 as Desktop Host

- 状态：Accepted
- 日期：2026-10-09
- 相关文档：架构文档 §3.1、§13；实施计划 0.1、0.8

## 背景

StarAt 是长期常驻的桌面应用（悬浮窗 + 主窗口），要求低内存、低 CPU、快速唤起（架构文档 §2.1），并要覆盖 Windows / macOS / Linux。

## 决策

使用 Tauri 2 作为桌面宿主：Rust 后端 + 系统 WebView 承载 React UI。窗口、托盘、通知、全局快捷键等通过 Tauri 插件与 Platform Adapter 使用；IPC 权限使用 Tauri Capability 按窗口划分。

## 后果

- 好处：包体与常驻内存显著小于 Electron；Rust 核心与宿主同进程；Capability 提供按窗口的最小权限。
- 代价 / 风险：各平台 WebView 差异（WebView2 / WKWebView / WebKitGTK）需要通过 Design Token 与自绘控件抑制；WebView 拖拽能力受限（实施计划 D-10）。
- 替代方案：Electron（体积与内存不满足常驻目标）；原生 UI（跨平台成本过高）。
