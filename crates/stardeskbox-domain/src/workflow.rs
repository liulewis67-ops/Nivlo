//! Workflow 的领域模型与定义格式（实施计划 5.1、架构文档 §18–21）。
//!
//! Workflow 是一条**声明式的线性管道**：一个 [`Matcher`] 决定它适用于哪些捕获输入，
//! 一串 [`Step`] 依次把输入变成要创建的 Item。没有分支图（不做 DAG）、没有脚本、没有网络
//! （后两者在 Phase 6 / 8 通过权限与 Port 引入）。
//!
//! 定义可以序列化为 `*.workflow.json`（`schemaVersion` 标记格式版本）供导入 / 导出 / 复制；
//! 本模块只含数据与结构性校验——正则是否合法、模板变量是否存在这类需要运行时库的检查，
//! 由 `stardeskbox-workflow` 完成。

use std::collections::BTreeMap;
use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize};

use crate::item::{ItemType, Priority};

/// 当前的定义格式版本。
pub const WORKFLOW_SCHEMA_VERSION: u32 = 1;

/// 一个 Workflow 最多有多少个 Step。
pub const MAX_WORKFLOW_STEPS: usize = 32;

/// 名称允许的最大字符数。
pub const MAX_WORKFLOW_NAME_CHARS: usize = 100;

/// ID 允许的最大字符数。
pub const MAX_WORKFLOW_ID_CHARS: usize = 64;

/// Workflow 定义不合法。
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum WorkflowError {
    /// ID 不合法（只允许小写字母、数字、点、连字符与下划线）。
    #[error("Workflow ID 不合法：{0}")]
    InvalidId(String),
    /// 名称为空或过长。
    #[error("Workflow 名称不能为空，且不超过 {MAX_WORKFLOW_NAME_CHARS} 个字符")]
    InvalidName,
    /// Step 数量超过上限。
    #[error("Workflow 最多 {MAX_WORKFLOW_STEPS} 个 Step，实际 {0} 个")]
    TooManySteps(usize),
    /// integration Step 的集成标识不合法。
    #[error("integration Step 的集成标识不合法：{0}")]
    InvalidIntegration(String),
    /// script Step 的源码为空。
    #[error("script Step 的源码不能为空")]
    EmptyScript,
    /// script Step 要访问的主机超出了 Workflow 声明的权限。
    #[error("script Step 要访问 {0}，但 Workflow 的 permissions 没有声明它")]
    ScriptExceedsPermissions(String),
    /// 用了 `http` Step，却没有声明 `permissions.network` 与允许访问的主机。
    #[error("http Step 需要在 permissions 里声明 network: true 和允许访问的 hosts")]
    NetworkNotDeclared,
    /// 没有任何 CreateItem Step：这样的 Workflow 什么都不会创建。
    #[error("Workflow 至少需要一个 createItem Step")]
    NoCreateItem,
    /// 条件缺少必需的 `value`。
    #[error("条件 {field} {op} 需要 value")]
    MissingValue {
        /// 字段名。
        field: String,
        /// 运算符。
        op: String,
    },
    /// 字段名不认识。
    #[error("不认识的匹配字段：{0}")]
    UnknownField(String),
    /// 变量名不合法。
    #[error("变量名不合法：{0}")]
    InvalidVariable(String),
    /// 格式版本高于当前程序能理解的版本。
    #[error("定义格式版本 {found} 高于当前支持的 {supported}，请升级StarDeskBox")]
    UnsupportedSchema {
        /// 文件里的版本。
        found: u32,
        /// 当前支持的版本。
        supported: u32,
    },
}

/// Workflow 的 ID：可读的 slug（`builtin.generic-url`、`user.read-later`），而不是 UUID，
/// 这样导出的定义文件和日志都能直接看懂。
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct WorkflowId(String);

impl WorkflowId {
    /// 校验并创建 ID。
    ///
    /// # Errors
    ///
    /// 空、过长或含有不允许的字符时返回 [`WorkflowError::InvalidId`]。
    pub fn new(raw: &str) -> Result<Self, WorkflowError> {
        let ok = !raw.is_empty()
            && raw.chars().count() <= MAX_WORKFLOW_ID_CHARS
            && raw.chars().all(|c| {
                c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '-' | '_')
            });
        if ok {
            Ok(Self(raw.to_owned()))
        } else {
            Err(WorkflowError::InvalidId(raw.to_owned()))
        }
    }

    /// ID 文本。
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for WorkflowId {
    /// 输出 ID 文本。
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl TryFrom<String> for WorkflowId {
    type Error = WorkflowError;

    /// 反序列化入口，保证外部数据也经过校验。
    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::new(&value)
    }
}

impl From<WorkflowId> for String {
    /// 序列化出口。
    fn from(value: WorkflowId) -> Self {
        value.0
    }
}

/// Workflow 的来源。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WorkflowSource {
    /// 随应用发布的内置 Workflow：只读，只能复制。
    Builtin,
    /// 用户自己创建（或复制）的。
    #[default]
    User,
    /// 从文件导入的。
    Imported,
    /// 来自 Marketplace（预留）。
    Marketplace,
}

/// 匹配字段：Matcher 条件读取输入的哪一部分。
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum Field {
    /// 输入种类：`text` / `url` / `file` / `files` / `image`。
    InputType,
    /// URL 的协议（`https`）。
    UrlScheme,
    /// URL 的主机（`github.com`）。
    UrlHost,
    /// URL 的路径（`/browse/REQ-1`）。
    UrlPath,
    /// URL 的某个查询参数。
    UrlQuery(String),
    /// 文件名（含扩展名）。
    FileName,
    /// 小写扩展名（不含点）。
    FileExtension,
    /// 文件的 MIME 类型。
    FileMime,
    /// 文件的完整路径。
    FilePath,
    /// 文本内容。
    Text,
    /// 来源应用（捕获时的前台应用）。
    SourceApplication,
}

impl fmt::Display for Field {
    /// 输出 JSON 里的字段名。
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InputType => f.write_str("input.type"),
            Self::UrlScheme => f.write_str("url.scheme"),
            Self::UrlHost => f.write_str("url.host"),
            Self::UrlPath => f.write_str("url.path"),
            Self::UrlQuery(key) => write!(f, "url.query.{key}"),
            Self::FileName => f.write_str("file.name"),
            Self::FileExtension => f.write_str("file.extension"),
            Self::FileMime => f.write_str("file.mime"),
            Self::FilePath => f.write_str("file.path"),
            Self::Text => f.write_str("text"),
            Self::SourceApplication => f.write_str("source.application"),
        }
    }
}

impl FromStr for Field {
    type Err = WorkflowError;

    /// 解析 JSON 里的字段名。
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "input.type" => Ok(Self::InputType),
            "url.scheme" => Ok(Self::UrlScheme),
            "url.host" => Ok(Self::UrlHost),
            "url.path" => Ok(Self::UrlPath),
            "file.name" => Ok(Self::FileName),
            "file.extension" => Ok(Self::FileExtension),
            "file.mime" => Ok(Self::FileMime),
            "file.path" => Ok(Self::FilePath),
            "text" => Ok(Self::Text),
            "source.application" => Ok(Self::SourceApplication),
            other => match other.strip_prefix("url.query.") {
                Some(key) if !key.is_empty() => Ok(Self::UrlQuery(key.to_owned())),
                _ => Err(WorkflowError::UnknownField(other.to_owned())),
            },
        }
    }
}

impl Serialize for Field {
    /// 序列化为字段名字符串。
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_str(self)
    }
}

impl<'de> Deserialize<'de> for Field {
    /// 从字段名字符串反序列化。
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let text = String::deserialize(deserializer)?;
        text.parse().map_err(serde::de::Error::custom)
    }
}

/// 比较运算符。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Op {
    /// 相等（忽略大小写）。
    Equals,
    /// 包含子串（忽略大小写）。
    Contains,
    /// 以……开头（忽略大小写）。
    StartsWith,
    /// 以……结尾（忽略大小写）。
    EndsWith,
    /// 通配（`*` 任意多个字符、`?` 一个字符，忽略大小写）。
    Glob,
    /// 正则（长度与复杂度有限制）。
    Regex,
    /// 字段存在（有值）。
    Exists,
}

impl Op {
    /// 运算符名称（用于错误信息）。
    pub fn name(self) -> &'static str {
        match self {
            Self::Equals => "equals",
            Self::Contains => "contains",
            Self::StartsWith => "startsWith",
            Self::EndsWith => "endsWith",
            Self::Glob => "glob",
            Self::Regex => "regex",
            Self::Exists => "exists",
        }
    }
}

/// 一个匹配条件：字段 + 运算符 + 值。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Condition {
    /// 读取哪个字段。
    pub field: Field,
    /// 怎么比较。
    pub op: Op,
    /// 比较的值；`exists` 不需要。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
}

/// 匹配器：叶子条件，或 `all`（与）/ `any`（或）/ `not`（非）的组合。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Matcher {
    /// 全部满足。
    All {
        /// 子匹配器。
        all: Vec<Matcher>,
    },
    /// 任一满足。
    Any {
        /// 子匹配器。
        any: Vec<Matcher>,
    },
    /// 不满足。
    Not {
        /// 被取反的匹配器。
        not: Box<Matcher>,
    },
    /// 叶子条件。
    Leaf(Condition),
}

/// `createItem` 对每个文件各创建一条时使用。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ForEach {
    /// 输入里的每一个文件各创建一条（单个文件当作只有一个）。
    Files,
}

/// 条件 Step 不满足时的行为。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Otherwise {
    /// 停止后续 Step（已经产生的结果保留）。
    #[default]
    Stop,
}

/// 一个 Step。Step 之间只通过变量传递数据；变量名不含点之外的特殊字符。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Step {
    /// 用正则从某个值里提取一个捕获组，存进变量。
    Extract {
        /// 来源：变量 / 输入字段名，或模板。
        from: String,
        /// 正则。
        pattern: String,
        /// 捕获组序号，缺省为 1。
        #[serde(default = "default_group")]
        group: usize,
        /// 结果存进哪个变量（`vars.<into>`）。
        into: String,
        /// 没匹配到时是否继续（缺省为否：视为错误）。
        #[serde(default)]
        optional: bool,
    },
    /// 用正则替换，结果存进变量。
    Regex {
        /// 来源。
        from: String,
        /// 正则。
        pattern: String,
        /// 替换文本（支持 `$1` 引用捕获组）。
        replacement: String,
        /// 结果变量。
        into: String,
    },
    /// 用简化的 JSONPath（`$.a.b[0]`）从 JSON 文本里取值。
    JsonPath {
        /// 来源（JSON 文本）。
        from: String,
        /// 路径。
        path: String,
        /// 结果变量。
        into: String,
        /// 没取到时是否继续。
        #[serde(default)]
        optional: bool,
    },
    /// 批量设置变量：每个值是一个模板。
    Transform {
        /// 变量名 → 模板。
        set: BTreeMap<String, String>,
    },
    /// 条件：不满足就停止后续 Step。
    Condition {
        /// 读取哪个值（变量或输入字段名）。
        var: String,
        /// 比较方式。
        op: Op,
        /// 比较的值（模板）；`exists` 不需要。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        value: Option<String>,
        /// 不满足时怎么办。
        #[serde(default)]
        otherwise: Otherwise,
    },
    /// 发一个 GET 请求，响应正文存进 `vars.<into>`（最终地址存进 `vars.<into>_url`）。
    ///
    /// 只能访问 `permissions.hosts` 声明过的主机（重定向后的主机也要检查）；
    /// `optional` 为真时，网络失败 / 超时 / 非 2xx 不算错误，Step 直接跳过（离线时仍能创建 Item）。
    Http {
        /// 地址模板。
        url: String,
        /// 响应正文存进哪个变量。
        into: String,
        /// 请求失败时是否继续（权限不足不算在内：那是配置错误）。
        #[serde(default)]
        optional: bool,
        /// 正文最多下载多少字节（超出的部分不下载）；不填用默认的 2 MiB。
        /// 只需要网页 `<head>` 里的元数据时设小一些，省流量也更快。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        max_bytes: Option<u32>,
    },
    /// 读取**输入里被拖入的文件**（只读，只读取标题需要的那一小部分），提取文档标题，
    /// 存进 `vars.<into>_title`（Markdown 首个标题、PDF / Office / EPUB 的标题属性、HTML 标题、
    /// 纯文本首行；没有是空串）、`_kind`（markdown / pdf / docx / pptx / xlsx / opendocument / epub /
    /// html / text / other）、`_size`（字节）。
    ///
    /// 被拖入的文件视为隐式授予读取权限：只能读这些文件，不能指定别的路径。
    /// 只在云端的占位文件不读（读了会触发下载）。多个文件时逐个读取：`forEach: files` 渲染每个文件时
    /// 用它自己的结果，公共变量取第一个文件的结果。输入不是文件（或读取失败）时，
    /// `optional` 为真则字段为空，否则报错。
    ReadFile {
        /// 结果变量前缀。
        into: String,
        /// 读取失败 / 输入不是文件时是否继续。
        #[serde(default)]
        optional: bool,
    },
    /// 从 HTML 里提取页面元数据，存进 `vars.<into>_title`、`_description`、`_site`、`_image`、`_icon`
    /// （没有的是空串，配合 `default` 过滤器使用）。
    ///
    /// `optional` 为真时，来源变量不存在（比如网络被跳过）不算错误，全部字段为空。
    HtmlMeta {
        /// 来源：存着 HTML 的变量名或模板。
        from: String,
        /// 结果变量前缀。
        into: String,
        /// 解析相对地址用的基准（缺省取 `vars.<from>_url`，没有就留空不解析）。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        base: Option<String>,
        /// 来源缺失时是否继续。
        #[serde(default)]
        optional: bool,
    },
    /// 创建一条 Item。
    CreateItem {
        /// 类型。
        item_type: ItemType,
        /// 标题模板。
        title: String,
        /// 内容模板。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        content: Option<String>,
        /// 是否放进 Inbox 等待整理（缺省是）。
        #[serde(default = "default_true")]
        in_inbox: bool,
        /// 标签模板。
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        tags: Vec<String>,
        /// 优先级（仅待办有效）。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        priority: Option<Priority>,
        /// 计划日期模板，渲染结果必须是 `YYYY-MM-DD`。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        scheduled: Option<String>,
        /// 是否把输入里的文件 / 图片作为附件挂上（缺省是）。
        #[serde(default = "default_true")]
        attach: bool,
        /// 对每个文件各创建一条。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        for_each: Option<ForEach>,
        /// 来源的显示名模板（如 `Jira · AI-128`），写进 Source 的原始标题。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        source_label: Option<String>,
        /// Integration 专属信息（键 → 模板），渲染后以 JSON 写进 Source 的 `metadata_json`。
        #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
        metadata: BTreeMap<String, String>,
    },
    /// 调用一个已注册的第三方集成（Jira、GitHub……），返回的字段存进 `vars.<into>_<字段>`。
    ///
    /// 凭据由集成适配器从系统凭据库读取并附在请求上，Workflow 与脚本都拿不到；
    /// 只能访问 `permissions.hosts` 声明过的主机。没有连接 / 凭据被拒绝时，
    /// 用户会看到「需要连接 X」和跳转到集成设置的按钮。`optional` 为真时，连不上或没授权不算错误。
    Integration {
        /// 集成标识（如 `jira`）。
        integration: String,
        /// 操作名（如 `issue`）。
        operation: String,
        /// 参数：名称 → 模板。
        #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
        params: BTreeMap<String, String>,
        /// 结果变量前缀。
        into: String,
        /// 连不上 / 没授权时是否继续。
        #[serde(default)]
        optional: bool,
    },
    /// 运行一段 JavaScript（QuickJS 沙箱），返回值按标准 Item 结构直接产出一条 Item 草稿。
    ///
    /// 脚本看到的 `ctx.input` 是输入字段、`ctx.vars` 是已有变量；除此之外只能使用 `hosts` 声明的网络主机，
    /// 且 `hosts` 必须是 `permissions.hosts` 的子集。权限（含脚本本身）变化后需要用户重新确认才会运行。
    Script {
        /// 脚本源码：`export default async function (ctx) { ... }` 或 `function transform(input) { ... }`。
        source: String,
        /// 脚本要访问的主机（`ctx.http`），必须是 Workflow `permissions.hosts` 的子集。
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        hosts: Vec<String>,
    },
    /// 给本次运行创建的全部 Item 加一个标签。
    AddTag {
        /// 标签模板。
        tag: String,
    },
}

/// 捕获组序号的缺省值。
fn default_group() -> usize {
    1
}

/// 布尔字段的缺省值 `true`。
fn default_true() -> bool {
    true
}

/// Workflow 声明需要的能力。缺省全部为 `false`——最小权限（架构文档 §21）。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Permissions {
    /// 是否需要访问网络（经 HttpPort）。
    #[serde(default)]
    pub network: bool,
    /// 允许访问的主机：精确主机名或 `*.example.com`。不在列表里的一律拒绝。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub hosts: Vec<String>,
}

/// 一个 Workflow。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Workflow {
    /// 定义格式版本。
    pub schema_version: u32,
    /// ID。
    pub id: WorkflowId,
    /// 名称。
    pub name: String,
    /// 说明。
    #[serde(default)]
    pub description: String,
    /// 定义自身的版本（内置 Workflow 升级时递增）。
    #[serde(default = "default_version")]
    pub version: u32,
    /// 优先级，大的先匹配；相同时看 Specificity。
    #[serde(default)]
    pub priority: i32,
    /// 是否启用。
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// 来源。
    #[serde(default)]
    pub source: WorkflowSource,
    /// 匹配器。
    pub matcher: Matcher,
    /// Step 列表，按顺序执行。
    pub steps: Vec<Step>,
    /// 声明的权限。
    #[serde(default)]
    pub permissions: Permissions,
    /// 发布者（导入的 Workflow 记录它来自谁；自己写的可以留空）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub publisher: Option<String>,
}

/// 版本号的缺省值。
fn default_version() -> u32 {
    1
}

/// 变量名是否合法：字母 / 数字 / 下划线，不以数字开头，不超过 40 个字符。
fn valid_variable(name: &str) -> bool {
    let mut chars = name.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphabetic() || c == '_')
        && name.chars().count() <= 40
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

impl Matcher {
    /// 递归校验：`exists` 之外的运算符必须有 `value`。
    ///
    /// # Errors
    ///
    /// 缺少 `value` 时返回 [`WorkflowError::MissingValue`]。
    pub fn validate(&self) -> Result<(), WorkflowError> {
        match self {
            Self::All { all } => all.iter().try_for_each(Self::validate),
            Self::Any { any } => any.iter().try_for_each(Self::validate),
            Self::Not { not } => not.validate(),
            Self::Leaf(condition) => {
                if condition.op != Op::Exists && condition.value.is_none() {
                    return Err(WorkflowError::MissingValue {
                        field: condition.field.to_string(),
                        op: condition.op.name().to_owned(),
                    });
                }
                Ok(())
            }
        }
    }
}

impl Workflow {
    /// 是否有 `http` Step——有的话捕获时先做不联网的即时版本，联网的部分在后台补全。
    #[must_use]
    pub fn uses_network(&self) -> bool {
        self.steps.iter().any(|step| match step {
            Step::Http { .. } => true,
            Step::Script { hosts, .. } => !hosts.is_empty(),
            _ => false,
        })
    }

    /// 结构性校验（正则语法、模板变量由 `stardeskbox-workflow` 检查）。
    ///
    /// # Errors
    ///
    /// 名称不合法、Step 过多、没有 `createItem`、条件缺 `value`、变量名不合法、
    /// 格式版本高于当前支持的版本时返回对应错误。
    pub fn validate(&self) -> Result<(), WorkflowError> {
        if self.schema_version > WORKFLOW_SCHEMA_VERSION {
            return Err(WorkflowError::UnsupportedSchema {
                found: self.schema_version,
                supported: WORKFLOW_SCHEMA_VERSION,
            });
        }
        let name = self.name.trim();
        if name.is_empty() || name.chars().count() > MAX_WORKFLOW_NAME_CHARS {
            return Err(WorkflowError::InvalidName);
        }
        if self.steps.len() > MAX_WORKFLOW_STEPS {
            return Err(WorkflowError::TooManySteps(self.steps.len()));
        }
        if !self
            .steps
            .iter()
            .any(|step| matches!(step, Step::CreateItem { .. } | Step::Script { .. }))
        {
            return Err(WorkflowError::NoCreateItem);
        }
        self.matcher.validate()?;
        for step in &self.steps {
            match step {
                Step::Extract { into, .. }
                | Step::Regex { into, .. }
                | Step::JsonPath { into, .. } => {
                    if !valid_variable(into) {
                        return Err(WorkflowError::InvalidVariable(into.clone()));
                    }
                }
                Step::Transform { set } => {
                    if let Some(bad) = set.keys().find(|key| !valid_variable(key)) {
                        return Err(WorkflowError::InvalidVariable(bad.clone()));
                    }
                }
                Step::Condition { op, value, var, .. } => {
                    if *op != Op::Exists && value.is_none() {
                        return Err(WorkflowError::MissingValue {
                            field: var.clone(),
                            op: op.name().to_owned(),
                        });
                    }
                }
                Step::ReadFile { into, .. } | Step::HtmlMeta { into, .. } => {
                    if !valid_variable(into) {
                        return Err(WorkflowError::InvalidVariable(into.clone()));
                    }
                }
                Step::Http { into, .. } => {
                    if !valid_variable(into) {
                        return Err(WorkflowError::InvalidVariable(into.clone()));
                    }
                    if !self.permissions.network || self.permissions.hosts.is_empty() {
                        return Err(WorkflowError::NetworkNotDeclared);
                    }
                }
                Step::Integration {
                    integration, into, ..
                } => {
                    if !valid_variable(into) {
                        return Err(WorkflowError::InvalidVariable(into.clone()));
                    }
                    if integration.is_empty()
                        || !integration.chars().all(|c| {
                            c.is_ascii_lowercase()
                                || c.is_ascii_digit()
                                || matches!(c, '-' | '_' | '.')
                        })
                    {
                        return Err(WorkflowError::InvalidIntegration(integration.clone()));
                    }
                    if !self.permissions.network || self.permissions.hosts.is_empty() {
                        return Err(WorkflowError::NetworkNotDeclared);
                    }
                }
                Step::Script { source, hosts } => {
                    if source.trim().is_empty() {
                        return Err(WorkflowError::EmptyScript);
                    }
                    for host in hosts {
                        let declared = self.permissions.network
                            && self
                                .permissions
                                .hosts
                                .iter()
                                .any(|allowed| allowed.eq_ignore_ascii_case(host));
                        if !declared {
                            return Err(WorkflowError::ScriptExceedsPermissions(host.clone()));
                        }
                    }
                }
                Step::CreateItem { .. } | Step::AddTag { .. } => {}
            }
        }
        Ok(())
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    /// 一个最小的合法定义（JSON）。
    const MINIMAL: &str = r##"{
        "schemaVersion": 1,
        "id": "user.read-later",
        "name": "稍后读",
        "matcher": { "field": "input.type", "op": "equals", "value": "url" },
        "steps": [
            { "type": "createItem", "itemType": "todo", "title": "读：{{ url.host }}", "tags": ["read"] }
        ]
    }"##;

    #[test]
    fn a_minimal_definition_parses_with_defaults() {
        let workflow: Workflow = serde_json::from_str(MINIMAL).unwrap();
        assert_eq!(workflow.id.as_str(), "user.read-later");
        assert!(workflow.enabled);
        assert_eq!(workflow.priority, 0);
        assert_eq!(workflow.version, 1);
        assert_eq!(workflow.source, WorkflowSource::User);
        assert!(!workflow.permissions.network);
        assert!(matches!(
            &workflow.steps[0],
            Step::CreateItem {
                in_inbox: true,
                attach: true,
                ..
            }
        ));
        workflow.validate().unwrap();
    }

    #[test]
    fn serde_round_trip_preserves_everything() {
        let source = r##"{
            "schemaVersion": 1, "id": "builtin.demo", "name": "演示", "description": "说明",
            "version": 3, "priority": 10, "enabled": false, "source": "builtin",
            "matcher": { "all": [
                { "field": "url.host", "op": "glob", "value": "*.atlassian.net" },
                { "not": { "any": [
                    { "field": "url.path", "op": "startsWith", "value": "/wiki" },
                    { "field": "url.query.draft", "op": "exists" }
                ] } }
            ] },
            "steps": [
                { "type": "extract", "from": "url.path", "pattern": "/browse/([A-Z]+-\\d+)", "into": "issue" },
                { "type": "regex", "from": "text", "pattern": "\\s+", "replacement": " ", "into": "clean" },
                { "type": "jsonPath", "from": "vars.meta", "path": "$.title", "into": "title", "optional": true },
                { "type": "transform", "set": { "label": "{{ vars.issue | upper }}" } },
                { "type": "condition", "var": "vars.issue", "op": "exists" },
                { "type": "createItem", "itemType": "todo", "title": "{{ vars.label }}", "content": "{{ input.url }}",
                  "inInbox": false, "tags": ["jira"], "priority": "high", "scheduled": "{{ now.date }}",
                  "attach": false, "forEach": "files" },
                { "type": "addTag", "tag": "work" }
            ],
            "permissions": { "network": true }
        }"##;
        let workflow: Workflow = serde_json::from_str(source).unwrap();
        let again: Workflow =
            serde_json::from_str(&serde_json::to_string(&workflow).unwrap()).unwrap();
        assert_eq!(workflow, again);
        assert_eq!(workflow.source, WorkflowSource::Builtin);
        assert!(!workflow.enabled);
        workflow.validate().unwrap();
    }

    #[test]
    fn fields_round_trip_through_their_names() {
        for name in [
            "input.type",
            "url.scheme",
            "url.host",
            "url.path",
            "url.query.draft",
            "file.name",
            "file.extension",
            "file.mime",
            "file.path",
            "text",
            "source.application",
        ] {
            assert_eq!(name.parse::<Field>().unwrap().to_string(), name);
        }
        assert!(matches!(
            "url.query.".parse::<Field>(),
            Err(WorkflowError::UnknownField(_))
        ));
        assert!("nope".parse::<Field>().is_err());
    }

    #[test]
    fn unknown_keys_and_bad_ids_are_rejected_by_the_parser() {
        let extra = MINIMAL.replace("\"name\"", "\"surprise\": 1, \"name\"");
        assert!(serde_json::from_str::<Workflow>(&extra).is_err());
        let bad_id = MINIMAL.replace("user.read-later", "User Read Later");
        assert!(serde_json::from_str::<Workflow>(&bad_id).is_err());
        assert!(WorkflowId::new("").is_err());
        assert!(WorkflowId::new(&"a".repeat(65)).is_err());
        assert!(WorkflowId::new("ok.id-1_x").is_ok());
    }

    #[test]
    fn validation_catches_structural_problems() {
        let mut workflow: Workflow = serde_json::from_str(MINIMAL).unwrap();

        workflow.name = "  ".into();
        assert_eq!(workflow.validate(), Err(WorkflowError::InvalidName));
        workflow.name = "ok".into();

        let create = workflow.steps[0].clone();
        workflow.steps = vec![Step::AddTag { tag: "x".into() }];
        assert_eq!(workflow.validate(), Err(WorkflowError::NoCreateItem));

        workflow.steps = vec![create.clone(); MAX_WORKFLOW_STEPS + 1];
        assert!(matches!(
            workflow.validate(),
            Err(WorkflowError::TooManySteps(_))
        ));

        workflow.steps = vec![
            Step::Extract {
                from: "text".into(),
                pattern: "x".into(),
                group: 1,
                into: "1bad".into(),
                optional: false,
            },
            create,
        ];
        assert!(matches!(
            workflow.validate(),
            Err(WorkflowError::InvalidVariable(_))
        ));
    }

    #[test]
    fn conditions_other_than_exists_need_a_value() {
        let workflow = r#"{
            "schemaVersion": 1, "id": "x", "name": "x",
            "matcher": { "field": "text", "op": "contains" },
            "steps": [ { "type": "createItem", "itemType": "note", "title": "t" } ]
        }"#;
        let parsed: Workflow = serde_json::from_str(workflow).unwrap();
        assert!(matches!(
            parsed.validate(),
            Err(WorkflowError::MissingValue { .. })
        ));
    }

    #[test]
    fn newer_schema_versions_are_refused() {
        let newer = MINIMAL.replace("\"schemaVersion\": 1", "\"schemaVersion\": 99");
        let parsed: Workflow = serde_json::from_str(&newer).unwrap();
        assert!(matches!(
            parsed.validate(),
            Err(WorkflowError::UnsupportedSchema { found: 99, .. })
        ));
    }
}
