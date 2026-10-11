//! `readFile` Step：读取输入里那个被拖入的文件，提取文档标题（实施计划 6.6）。
//!
//! 安全边界：路径只来自 `file.path`（Workflow 输入），Step 没有「指定路径」的参数；
//! 大小上限与阻塞线程池由 [`FileInspector`] 实现负责。

use std::sync::Arc;

use async_trait::async_trait;
use nivlo_application::ports::inspect::{FileInspector, InspectError};
use nivlo_domain::workflow::Step;

use crate::doc_meta::{DocKind, title_of};
use crate::executor::{RunContext, StepError, StepExecutor, step_kind};

/// `readFile` 的执行器。
pub struct ReadFileExecutor {
    /// 文件检查 Port。
    port: Arc<dyn FileInspector>,
}

impl ReadFileExecutor {
    /// 创建执行器。
    #[must_use]
    pub fn new(port: Arc<dyn FileInspector>) -> Self {
        Self { port }
    }
}

/// 把结果变量写进作用域。
fn put(ctx: &mut RunContext<'_>, into: &str, title: &str, kind: &str, size: u64) {
    ctx.scope
        .insert(format!("vars.{into}_title"), title.to_owned());
    ctx.scope
        .insert(format!("vars.{into}_kind"), kind.to_owned());
    ctx.scope
        .insert(format!("vars.{into}_size"), size.to_string());
}

#[async_trait]
impl StepExecutor for ReadFileExecutor {
    /// 种类。
    fn kind(&self) -> &'static str {
        "readFile"
    }

    /// 读取并提取标题。
    async fn execute(&self, step: &Step, ctx: &mut RunContext<'_>) -> Result<(), StepError> {
        let Step::ReadFile { into, optional } = step else {
            return Err(StepError::fatal(format!(
                "Executor 收到了不属于它的 Step（{}）",
                step_kind(step)
            )));
        };
        // 只处理「恰好一个文件」的输入（多个文件各自没有独立的变量作用域）。
        let single =
            ctx.files.len() == 1 && ctx.scope.get("input.type").map(String::as_str) == Some("file");
        let (Some(path), true) = (ctx.scope.get("file.path").cloned(), single) else {
            if *optional {
                put(ctx, into, "", "other", 0);
                return Ok(());
            }
            return Err(StepError::invalid("readFile 需要恰好一个文件作为输入"));
        };
        let kind =
            DocKind::from_extension(ctx.scope.get("file.extension").map_or("", String::as_str));
        match self.port.sample(&path).await {
            Ok(sample) => {
                let title = sample
                    .content
                    .as_deref()
                    .and_then(|bytes| title_of(kind, bytes))
                    .unwrap_or_default();
                put(ctx, into, &title, kind.as_str(), sample.size);
                Ok(())
            }
            Err(error) if *optional => {
                tracing::debug!(event = "read_file_skipped", reason = %error, "可选的 readFile 被跳过");
                put(ctx, into, "", kind.as_str(), 0);
                Ok(())
            }
            Err(InspectError::Missing) => Err(StepError::invalid("文件已经不在原来的位置了")),
            Err(error) => Err(StepError::fatal(error.to_string())),
        }
    }
}
