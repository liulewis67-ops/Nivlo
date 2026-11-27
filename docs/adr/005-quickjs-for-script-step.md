# ADR-005 QuickJS for Script Step

- 状态：Accepted
- 日期：2026-10-09
- 相关文档：架构文档 §23–26；实施计划 Phase 8

## 背景

用户需要在 Workflow 中做自定义转换，但脚本必须受控：无任意文件、网络、Shell 访问，并有时间与内存上限。

## 决策

Script Step 使用嵌入式 QuickJS（`rquickjs`），仅暴露 Capability API（受 Workflow Permission 约束），并设置执行时间 / 内存 / 调用次数限制。脚本运行时封装在 `starat-script` 内，未来可替换为独立进程的 Script Worker 而不影响 Workflow Engine。该能力属于 V2，不在 MVP 内。

## 后果

- 好处：体积小、启动快、沙箱边界清晰。
- 代价 / 风险：生态与 Node 不同，不能使用 npm 包；需要持续维护资源限制与权限桥。
- 替代方案：V8（体积大）、WASM（开发体验差）、Lua（用户熟悉度低）。
