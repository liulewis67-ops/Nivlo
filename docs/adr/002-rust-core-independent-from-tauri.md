# ADR-002 Rust Core Independent from Tauri

- 状态：Accepted
- 日期：2026-10-09
- 相关文档：架构文档 §5、§7、§63；后端规范 §3

## 背景

业务规则、Use Case、存储与调度如果与 Tauri 耦合，将无法脱离 GUI 测试，也无法在宿主替换时复用。

## 决策

`asterjot-domain` 与 `asterjot-application` 不依赖 Tauri、SQLx、reqwest、rquickjs、windows；Adapter crate 实现 Application 定义的 Port；只有 `src-tauri` 作为 Composition Root 依赖所有 crate。依赖方向由 `scripts/check-deps` 在 CI 中强制。

## 后果

- 好处：核心逻辑可用 Fake Repository / FakeClock 做纯测试；宿主与存储可替换。
- 代价 / 风险：需要维护 Port 与 DTO 映射，样板代码增多。
- 替代方案：把业务写在 Tauri Command 中（测试困难、边界模糊）。
