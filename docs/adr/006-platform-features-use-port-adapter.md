# ADR-006 Platform Features Use Port/Adapter

- 状态：Accepted
- 日期：2026-10-09
- 相关文档：架构文档 §7.9、§10.3、§53；后端规范 §3、§4.4

## 背景

窗口、拖放、剪贴板、凭据、通知、快捷键、自启动等能力在各平台实现不同，且 Windows 需要原生增强。

## 决策

`asterjot-platform` 为每个能力定义独立的小 trait（`WindowPort`、`DropPort`、`ClipboardPort`、`CredentialPort`、`NotificationPort`、`ShortcutPort`、`AutostartPort`、`OpenPort`），不做拥有几十个方法的 God Trait；平台 crate 用 `cfg(target_os)` 隔离；能力不足时返回明确的 `Unsupported` 或降级，而不是 panic。

## 后果

- 好处：Application 层与平台无关；可用 Fake 实现测试；平台增强可以逐步替换默认实现。
- 代价 / 风险：需要为每个 Port 维护兼容矩阵。
- 替代方案：在业务代码中直接使用 `#[cfg]` 分支（散落且难测试）。
