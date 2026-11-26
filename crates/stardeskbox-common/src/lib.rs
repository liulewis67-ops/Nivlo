//! `stardeskbox-common`：跨层共享的基础设施（日志、路径、时钟、ID、Secret），与平台无关。
//!
//! 主要导出：
//! - [`paths::AppPaths`]：应用数据目录布局（架构文档 §29）。
//! - [`logging`]：`tracing` 日志初始化与按天滚动（架构文档 §42）。
//! - [`secret::Secret`]：不会被日志 / 序列化泄漏的敏感值包装。
//! - [`clock::Clock`]：可注入的时钟，业务代码不得直接读取系统时间。
//! - [`id`]：UUIDv7 生成（实施计划 D-04）。
//! - [`text`]：文本文件的编码识别（UTF-8 / UTF-16 / GBK）。
//!
//! 禁止依赖：任何 `stardeskbox-*` 业务 crate、`tauri`、`sqlx`、`reqwest`、`rquickjs`、`windows`
//! （参见后端规范 §3.1）。

pub mod clock;
pub mod id;
pub mod logging;
pub mod paths;
pub mod secret;
pub mod text;
