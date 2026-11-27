//! `starat-workflow`：Workflow 的 Matcher、Resolver、Engine、Step Executor 与定义校验
//! （实施计划 Phase 5，架构文档 §18–21、§27–28）。
//!
//! * [`matcher`] / [`resolver`]：声明式匹配，按 priority → Specificity → ID 选出唯一的 Workflow；
//! * [`template`]：最小的 `{{ var | filter }}` 模板（D-11）；
//! * [`executor`] / [`engine`]：线性管道的执行——Step 通过 Registry 注册，Engine 不认识任何具体 Step；
//! * [`validate`]：保存 / 导入时的深度校验（JSON Schema、正则、模板语法与变量引用）；
//! * [`builtin`]：随应用发布的内置 Workflow。
//!
//! 引擎是**纯计算**：产出待创建的 [`executor::ItemDraft`]，不写库、不碰网络与文件系统，
//! 所以「试运行」不可能有副作用。网络等能力在 Phase 6 通过 Port 与权限引入。
//!
//! 禁止依赖：`tauri`、其他 Adapter 的内部实现（通过 Port 访问网络等能力）（参见后端规范 §3.1）。

pub mod adapter;
pub mod builtin;
pub mod doc_meta;
pub mod engine;
pub mod executor;
pub mod facts;
pub mod file_step;
pub mod glob;
pub mod html_meta;
pub mod http_step;
pub mod integration_step;
pub mod jsonpath;
pub mod matcher;
pub mod pattern;
pub mod resolver;
pub mod script_step;
pub mod template;
pub mod validate;

pub use adapter::WorkflowEngineAdapter;
pub use engine::{Engine, RunFailure, RunOptions, RunReport, StepRecord, StepStatus};
pub use executor::{ErrorKind, ExecutorRegistry, ItemDraft, StepError, StepExecutor};
pub use facts::InputFacts;
pub use pattern::RegexCache;
pub use resolver::resolve;
