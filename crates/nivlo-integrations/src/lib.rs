//! `nivlo-integrations`：外部系统协议适配（Jira、GitHub、Web），包含认证、REST API、DTO 与映射。
//!
//! 禁止依赖：`tauri`、其他 Adapter 的内部实现（参见后端规范 §3.1）。

pub mod github;
pub mod http;
pub mod jira;

pub use github::GithubIntegration;
pub use http::ReqwestHttp;
pub use jira::JiraIntegration;
