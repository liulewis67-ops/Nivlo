//! 随应用发布的内置 Workflow（实施计划 5.5、6.2）。
//!
//! 定义文件在仓库的 `workflows/builtin/`，编译时嵌入二进制。内置 Workflow 只读，用户只能「复制」后修改副本；
//! 它们刻意复刻了 2.3 的默认规则（文字 → 待办、网址 → 笔记、文件 → 笔记、图片 → 笔记，全部进收集箱），
//! 所以 Capture 改走 Workflow 之后行为不变。

use nivlo_domain::workflow::{Workflow, WorkflowSource};

/// 内嵌的内置定义（文件名 → JSON）。
const DEFINITIONS: &[(&str, &str)] = &[
    (
        "generic-text",
        include_str!("../../../workflows/builtin/generic-text.workflow.json"),
    ),
    (
        "generic-url",
        include_str!("../../../workflows/builtin/generic-url.workflow.json"),
    ),
    (
        "generic-file",
        include_str!("../../../workflows/builtin/generic-file.workflow.json"),
    ),
    (
        "generic-image",
        include_str!("../../../workflows/builtin/generic-image.workflow.json"),
    ),
];

/// 全部内置 Workflow（来源强制为 `Builtin`）。
///
/// 内嵌的定义由测试保证合法；万一某个损坏，跳过它并记录日志，而不是让应用启动失败——
/// Capture 仍有兜底的默认规则。
#[must_use]
pub fn builtin_workflows() -> Vec<Workflow> {
    DEFINITIONS
        .iter()
        .filter_map(|(name, json)| match serde_json::from_str::<Workflow>(json) {
            Ok(mut workflow) => {
                workflow.source = WorkflowSource::Builtin;
                Some(workflow)
            }
            Err(error) => {
                tracing::error!(event = "builtin_workflow_invalid", name, %error, "内置 Workflow 解析失败");
                None
            }
        })
        .collect()
}
