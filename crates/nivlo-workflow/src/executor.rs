//! Step Executor：每种 Step 一个实现，通过 [`ExecutorRegistry`] 注册与查找（实施计划 5.3、5.4）。
//!
//! Engine 不认识任何具体的 Step——没有巨型 `match`，新增一种 Step（Phase 6 的 HTTP、Phase 8 的脚本）
//! 只需要实现 [`StepExecutor`] 并注册。本阶段的 Executor 都是纯计算：只读写 [`RunContext`] 里的变量与草稿，
//! 不碰数据库、网络、文件系统，因此「试运行」天然没有任何副作用。

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use chrono::NaiveDate;
use nivlo_domain::capture::FileRef;
use nivlo_domain::item::{ItemType, Priority};
use nivlo_domain::workflow::{ForEach, Op, Step};

use crate::facts::put_file;
use crate::glob::glob_match;
use crate::jsonpath;
use crate::pattern::RegexCache;
use crate::template::{self, TemplateError};

/// Step 失败的分类（实施计划 5.3），决定界面怎么提示、能不能重试。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ErrorKind {
    /// 暂时性错误（网络抖动等），重试可能成功。
    Retryable,
    /// 确定性错误，重试没有意义。
    Fatal,
    /// 缺少权限（Workflow 没有声明需要的能力）。
    PermissionDenied,
    /// 需要用户做点什么（登录、授权）。
    UserActionRequired,
    /// 超时。
    Timeout,
    /// 输入不符合 Workflow 的预期（提取不到、模板变量缺失……）。
    InvalidInput,
}

/// 一个 Step 的失败。
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct StepError {
    /// 分类。
    pub kind: ErrorKind,
    /// 面向用户的说明（不含敏感内容全文）。
    pub message: String,
}

impl StepError {
    /// 输入不符合预期。
    pub fn invalid(message: impl Into<String>) -> Self {
        Self {
            kind: ErrorKind::InvalidInput,
            message: message.into(),
        }
    }

    /// 确定性的失败。
    pub fn fatal(message: impl Into<String>) -> Self {
        Self {
            kind: ErrorKind::Fatal,
            message: message.into(),
        }
    }
}

impl From<TemplateError> for StepError {
    /// 模板问题都是 Workflow 与输入对不上：归为 `InvalidInput`。
    fn from(error: TemplateError) -> Self {
        Self::invalid(error.to_string())
    }
}

/// Workflow 产出的一条待创建的 Item（尚未落库）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ItemDraft {
    /// 类型。
    pub item_type: ItemType,
    /// 标题（已去除首尾空白，非空）。
    pub title: String,
    /// 内容。
    pub content: Option<String>,
    /// 是否放进 Inbox。
    pub in_inbox: bool,
    /// 标签名（已去重，保留先出现的写法）。
    pub tags: Vec<String>,
    /// 优先级。
    pub priority: Option<Priority>,
    /// 计划日期。
    pub scheduled: Option<NaiveDate>,
    /// 是否挂上输入里的文件 / 图片作为附件。
    pub attach: bool,
    /// 对应输入里的第几个文件（`forEach: files` 时）；其余为 `None`。
    pub file_index: Option<usize>,
}

/// 一次运行中 Step 之间共享的状态。
pub struct RunContext<'a> {
    /// 变量表：`input.*`、`url.*`、`file.*`、`vars.*`……
    pub scope: HashMap<String, String>,
    /// 到目前为止产出的草稿。
    pub drafts: Vec<ItemDraft>,
    /// 用 `addTag` 加的标签（最后会套用到全部草稿）。
    pub tags: Vec<String>,
    /// 输入里的文件（`forEach: files` 用）。
    pub files: Vec<FileRef>,
    /// 正则缓存。
    pub regexes: &'a RegexCache,
    /// 条件不满足后置为 `true`：后续 Step 被跳过。
    pub stopped: bool,
}

impl RunContext<'_> {
    /// 渲染一个模板。
    ///
    /// # Errors
    ///
    /// 语法错误或变量缺失。
    pub fn render(&self, source: &str) -> Result<String, StepError> {
        render_in(&self.scope, source)
    }

    /// 取一个值：先当变量名查，查不到再当模板渲染（含 `{{`）；都不行就是变量缺失。
    ///
    /// # Errors
    ///
    /// 变量缺失或模板错误。
    pub fn resolve(&self, from: &str) -> Result<String, StepError> {
        if let Some(value) = self.scope.get(from) {
            return Ok(value.clone());
        }
        if from.contains("{{") {
            return self.render(from);
        }
        Err(StepError::invalid(format!("变量 {from} 不存在")))
    }
}

/// 在给定变量表里渲染模板。
fn render_in(scope: &HashMap<String, String>, source: &str) -> Result<String, StepError> {
    Ok(template::render(source, &|path| scope.get(path).cloned())?)
}

/// 一种 Step 的执行器。
#[async_trait]
pub trait StepExecutor: Send + Sync {
    /// 处理哪种 Step（与 [`step_kind`] 对应）。
    fn kind(&self) -> &'static str;

    /// 执行。
    ///
    /// # Errors
    ///
    /// 失败时返回带分类的 [`StepError`]。
    async fn execute(&self, step: &Step, ctx: &mut RunContext<'_>) -> Result<(), StepError>;
}

/// 一个 Step 的种类名（`type` 字段）。
#[must_use]
pub fn step_kind(step: &Step) -> &'static str {
    match step {
        Step::Extract { .. } => "extract",
        Step::Regex { .. } => "regex",
        Step::JsonPath { .. } => "jsonPath",
        Step::Transform { .. } => "transform",
        Step::Condition { .. } => "condition",
        Step::CreateItem { .. } => "createItem",
        Step::AddTag { .. } => "addTag",
    }
}

/// Executor 注册表。
#[derive(Default)]
pub struct ExecutorRegistry {
    /// 种类 → 执行器。
    map: HashMap<&'static str, Arc<dyn StepExecutor>>,
}

impl ExecutorRegistry {
    /// 空注册表。
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// 注册（同一种类后注册的覆盖先注册的）。
    pub fn register(&mut self, executor: Arc<dyn StepExecutor>) {
        self.map.insert(executor.kind(), executor);
    }

    /// 查找。
    #[must_use]
    pub fn get(&self, kind: &str) -> Option<&Arc<dyn StepExecutor>> {
        self.map.get(kind)
    }

    /// 注册了本阶段的全部标准 Executor。
    #[must_use]
    pub fn standard() -> Self {
        let mut registry = Self::new();
        registry.register(Arc::new(ExtractExecutor));
        registry.register(Arc::new(RegexExecutor));
        registry.register(Arc::new(JsonPathExecutor));
        registry.register(Arc::new(TransformExecutor));
        registry.register(Arc::new(ConditionExecutor));
        registry.register(Arc::new(CreateItemExecutor));
        registry.register(Arc::new(AddTagExecutor));
        registry
    }
}

/// 变量名对应的完整键（`vars.` 前缀）。
fn var_key(name: &str) -> String {
    format!("vars.{name}")
}

/// 收到了不属于自己的 Step：Registry 配置有误，是程序错误而不是用户输入问题。
fn wrong_step(kind: &str) -> StepError {
    StepError::fatal(format!("Executor 收到了不属于它的 Step（{kind}）"))
}

/// `extract`：用正则提取一个捕获组。
struct ExtractExecutor;

#[async_trait]
impl StepExecutor for ExtractExecutor {
    /// 种类。
    fn kind(&self) -> &'static str {
        "extract"
    }

    /// 提取；没匹配到且不是 `optional` 时失败。
    async fn execute(&self, step: &Step, ctx: &mut RunContext<'_>) -> Result<(), StepError> {
        let Step::Extract {
            from,
            pattern,
            group,
            into,
            optional,
        } = step
        else {
            return Err(wrong_step(step_kind(step)));
        };
        let source = ctx.resolve(from)?;
        let regex = ctx
            .regexes
            .get(pattern)
            .map_err(|e| StepError::fatal(e.to_string()))?;
        let found = regex
            .captures(&source)
            .and_then(|caps| caps.get(*group))
            .map(|m| m.as_str().to_owned());
        match found {
            Some(value) => {
                ctx.scope.insert(var_key(into), value);
                Ok(())
            }
            None if *optional => Ok(()),
            None => Err(StepError::invalid(format!("没有从 {from} 里提取到内容"))),
        }
    }
}

/// `regex`：正则替换。
struct RegexExecutor;

#[async_trait]
impl StepExecutor for RegexExecutor {
    /// 种类。
    fn kind(&self) -> &'static str {
        "regex"
    }

    /// 替换并存进变量。
    async fn execute(&self, step: &Step, ctx: &mut RunContext<'_>) -> Result<(), StepError> {
        let Step::Regex {
            from,
            pattern,
            replacement,
            into,
        } = step
        else {
            return Err(wrong_step(step_kind(step)));
        };
        let source = ctx.resolve(from)?;
        let regex = ctx
            .regexes
            .get(pattern)
            .map_err(|e| StepError::fatal(e.to_string()))?;
        let replaced = regex
            .replace_all(&source, replacement.as_str())
            .into_owned();
        ctx.scope.insert(var_key(into), replaced);
        Ok(())
    }
}

/// `jsonPath`：从 JSON 文本里取值。
struct JsonPathExecutor;

#[async_trait]
impl StepExecutor for JsonPathExecutor {
    /// 种类。
    fn kind(&self) -> &'static str {
        "jsonPath"
    }

    /// 取值；取不到且不是 `optional` 时失败。
    async fn execute(&self, step: &Step, ctx: &mut RunContext<'_>) -> Result<(), StepError> {
        let Step::JsonPath {
            from,
            path,
            into,
            optional,
        } = step
        else {
            return Err(wrong_step(step_kind(step)));
        };
        let source = ctx.resolve(from)?;
        match jsonpath::extract(&source, path).map_err(|e| StepError::invalid(e.to_string()))? {
            Some(value) => {
                ctx.scope.insert(var_key(into), value);
                Ok(())
            }
            None if *optional => Ok(()),
            None => Err(StepError::invalid(format!("{path} 没有取到值"))),
        }
    }
}

/// `transform`：批量设置变量。
struct TransformExecutor;

#[async_trait]
impl StepExecutor for TransformExecutor {
    /// 种类。
    fn kind(&self) -> &'static str {
        "transform"
    }

    /// 按名称顺序渲染并设置变量（同一个 Step 里的变量互相看不到，后面的 Step 才能用）。
    async fn execute(&self, step: &Step, ctx: &mut RunContext<'_>) -> Result<(), StepError> {
        let Step::Transform { set } = step else {
            return Err(wrong_step(step_kind(step)));
        };
        let mut rendered = Vec::with_capacity(set.len());
        for (name, source) in set {
            rendered.push((var_key(name), ctx.render(source)?));
        }
        ctx.scope.extend(rendered);
        Ok(())
    }
}

/// 一个值是否满足 `op value`（给 `condition` Step 用；Matcher 里有对应的实现用于输入字段）。
fn value_satisfies(op: Op, actual: Option<&str>, expected: &str, regexes: &RegexCache) -> bool {
    let Some(actual) = actual else {
        return false;
    };
    let (a, e) = (actual.to_lowercase(), expected.to_lowercase());
    match op {
        Op::Exists => !actual.is_empty(),
        Op::Equals => a == e,
        Op::Contains => a.contains(&e),
        Op::StartsWith => a.starts_with(&e),
        Op::EndsWith => a.ends_with(&e),
        Op::Glob => glob_match(expected, actual),
        Op::Regex => regexes.get(expected).is_ok_and(|r| r.is_match(actual)),
    }
}

/// `condition`：不满足就停止后续 Step。
struct ConditionExecutor;

#[async_trait]
impl StepExecutor for ConditionExecutor {
    /// 种类。
    fn kind(&self) -> &'static str {
        "condition"
    }

    /// 求值；不满足时置 `stopped`。
    async fn execute(&self, step: &Step, ctx: &mut RunContext<'_>) -> Result<(), StepError> {
        let Step::Condition { var, op, value, .. } = step else {
            return Err(wrong_step(step_kind(step)));
        };
        let actual = ctx.scope.get(var).cloned();
        let expected = match value {
            Some(template) => ctx.render(template)?,
            None => String::new(),
        };
        if !value_satisfies(*op, actual.as_deref(), &expected, ctx.regexes) {
            ctx.stopped = true;
        }
        Ok(())
    }
}

/// 把渲染出的标签整理成一个非空标签名。
fn clean_tag(raw: &str) -> Option<String> {
    let tag = raw.trim().trim_start_matches('#').trim();
    (!tag.is_empty()).then(|| tag.to_owned())
}

/// 往标签列表里加一个（忽略大小写去重，保留先出现的写法）。
pub(crate) fn push_tag(tags: &mut Vec<String>, tag: String) {
    if !tags.iter().any(|t| t.to_lowercase() == tag.to_lowercase()) {
        tags.push(tag);
    }
}

/// `createItem`：产出一条（或每个文件一条）待创建的 Item。
struct CreateItemExecutor;

impl CreateItemExecutor {
    /// 用给定变量表渲染出一条草稿。
    #[allow(clippy::too_many_arguments)]
    fn draft(
        scope: &HashMap<String, String>,
        item_type: ItemType,
        title: &str,
        content: Option<&String>,
        in_inbox: bool,
        tags: &[String],
        priority: Option<Priority>,
        scheduled: Option<&String>,
        attach: bool,
        file_index: Option<usize>,
    ) -> Result<ItemDraft, StepError> {
        let title = render_in(scope, title)?.trim().to_owned();
        if title.is_empty() {
            return Err(StepError::invalid("标题渲染出来是空的"));
        }
        let content = match content {
            Some(template) => {
                let text = render_in(scope, template)?;
                (!text.trim().is_empty()).then_some(text)
            }
            None => None,
        };
        let mut rendered_tags = Vec::new();
        for tag in tags {
            if let Some(tag) = clean_tag(&render_in(scope, tag)?) {
                push_tag(&mut rendered_tags, tag);
            }
        }
        if priority.is_some_and(|p| p != Priority::None) && item_type != ItemType::Todo {
            return Err(StepError::invalid("只有待办可以设置优先级"));
        }
        let scheduled = match scheduled {
            Some(template) => {
                let text = render_in(scope, template)?;
                let text = text.trim();
                if text.is_empty() {
                    None
                } else {
                    Some(NaiveDate::parse_from_str(text, "%Y-%m-%d").map_err(|_| {
                        StepError::invalid(format!("计划日期「{text}」不是 YYYY-MM-DD"))
                    })?)
                }
            }
            None => None,
        };
        Ok(ItemDraft {
            item_type,
            title,
            content,
            in_inbox,
            tags: rendered_tags,
            priority,
            scheduled,
            attach,
            file_index,
        })
    }
}

#[async_trait]
impl StepExecutor for CreateItemExecutor {
    /// 种类。
    fn kind(&self) -> &'static str {
        "createItem"
    }

    /// 渲染并产出草稿。
    async fn execute(&self, step: &Step, ctx: &mut RunContext<'_>) -> Result<(), StepError> {
        let Step::CreateItem {
            item_type,
            title,
            content,
            in_inbox,
            tags,
            priority,
            scheduled,
            attach,
            for_each,
        } = step
        else {
            return Err(wrong_step(step_kind(step)));
        };
        match for_each {
            None => {
                let draft = Self::draft(
                    &ctx.scope,
                    *item_type,
                    title,
                    content.as_ref(),
                    *in_inbox,
                    tags,
                    *priority,
                    scheduled.as_ref(),
                    *attach,
                    None,
                )?;
                ctx.drafts.push(draft);
            }
            Some(ForEach::Files) => {
                if ctx.files.is_empty() {
                    return Err(StepError::invalid("forEach: files 需要文件输入"));
                }
                let files = ctx.files.clone();
                for (index, file) in files.iter().enumerate() {
                    let mut scope = ctx.scope.clone();
                    put_file(&mut scope, file);
                    let draft = Self::draft(
                        &scope,
                        *item_type,
                        title,
                        content.as_ref(),
                        *in_inbox,
                        tags,
                        *priority,
                        scheduled.as_ref(),
                        *attach,
                        Some(index),
                    )?;
                    ctx.drafts.push(draft);
                }
            }
        }
        Ok(())
    }
}

/// `addTag`：给本次运行创建的全部 Item 加标签。
struct AddTagExecutor;

#[async_trait]
impl StepExecutor for AddTagExecutor {
    /// 种类。
    fn kind(&self) -> &'static str {
        "addTag"
    }

    /// 渲染标签并记下，最后由 Engine 套用到全部草稿。
    async fn execute(&self, step: &Step, ctx: &mut RunContext<'_>) -> Result<(), StepError> {
        let Step::AddTag { tag } = step else {
            return Err(wrong_step(step_kind(step)));
        };
        if let Some(tag) = clean_tag(&ctx.render(tag)?) {
            push_tag(&mut ctx.tags, tag);
        }
        Ok(())
    }
}
