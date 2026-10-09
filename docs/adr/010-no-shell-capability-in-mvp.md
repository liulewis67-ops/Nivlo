# ADR-010 No Shell Capability in MVP

- 状态：Accepted
- 日期：2026-10-09
- 相关文档：架构文档 §44、§60；后端规范 §9.3

## 背景

Shell 执行能力会让脚本、Workflow 或被注入的内容获得任意代码执行权限，风险与收益不匹配。

## 决策

MVP 不提供任何 Shell / 进程执行能力：Tauri Capability 不启用 shell 插件，IPC 不提供通用能力型 Command（如 `execute_sql`、`read_file(path)`、`http_request`），Script 也不暴露该能力。需要打开链接 / 定位文件时只通过受限的 `OpenPort`。

## 后果

- 好处：显著缩小攻击面；权限模型易于审计。
- 代价 / 风险：部分高级自动化场景无法实现，需在后续版本以显式授权重新评估。
- 替代方案：提供受权限控制的 Shell 能力（MVP 不做）。
