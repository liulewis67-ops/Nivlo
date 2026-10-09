//! `nivlo-domain`：纯领域模型与业务规则（Item、Project、Tag、Schedule、Workflow、CaptureInput、Domain Event）。纯同步、无 IO。
//!
//! 禁止依赖：`tauri`、`sqlx`、`reqwest`、`rquickjs`、`windows`、`tokio`（运行时相关）（参见后端规范 §3.1）。
