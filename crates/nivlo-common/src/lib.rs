//! `nivlo-common`：跨层共享的基础设施（日志、路径、时钟、ID、Secret），与平台无关。
//!
//! 禁止依赖：任何 `nivlo-*` 业务 crate、`tauri`、`sqlx`、`reqwest`、`rquickjs`、`windows`（参见后端规范 §3.1）。
