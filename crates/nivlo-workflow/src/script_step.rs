//! `script` Step：在 QuickJS 沙箱里运行用户脚本，返回值按 Item 结构产出一条草稿（实施计划 8.3）。
//!
//! 权限分三层，缺一不可：
//!
//! 1. 定义校验：脚本声明的 `hosts` 必须是 Workflow `permissions.hosts` 的子集（`Workflow::validate`）；
//! 2. 用户确认：脚本的「指纹」（源码 + 声明的主机 + Workflow 的网络权限）必须已被用户授予，
//!    任何一项变化都会让指纹改变，从而需要重新确认才能运行；
//! 3. 运行时：脚本的每次 `ctx.http` 调用再经 [`HostPolicy`] 检查（含重定向）。

use std::collections::BTreeMap;
use std::sync::Arc;

use async_trait::async_trait;
use nivlo_application::ports::http::{HostPolicy, HttpPort, HttpRequest};
use nivlo_domain::item::ItemType;
use nivlo_domain::workflow::{Permissions, Step};
use nivlo_script::{
    HostHttpReply, ScriptError, ScriptHandle, ScriptHost, ScriptMode, ScriptPermissions,
    ScriptPolicy, ScriptRequest,
};
use sha2::{Digest, Sha256};

use crate::executor::{ErrorKind, ItemDraft, RunContext, StepError, StepExecutor, step_kind};

/// 用户是否已经确认过某个脚本的权限。
#[async_trait]
pub trait ScriptGrants: Send + Sync {
    /// 指纹对应的权限是否已被授予。
    async fn is_granted(&self, fingerprint: &str) -> bool;
}

/// 脚本权限的指纹：源码、声明的主机、Workflow 的网络权限任何一项变化，指纹都会变。
#[must_use]
pub fn script_fingerprint(permissions: &Permissions, source: &str, hosts: &[String]) -> String {
    let mut declared: Vec<String> = hosts.iter().map(|h| h.to_ascii_lowercase()).collect();
    declared.sort();
    declared.dedup();
    let mut allowed: Vec<String> = permissions
        .hosts
        .iter()
        .map(|h| h.to_ascii_lowercase())
        .collect();
    allowed.sort();
    allowed.dedup();
    let mut hasher = Sha256::new();
    // 用长度前缀拼接，避免「ab」+「c」与「a」+「bc」得到同一个摘要。
    for part in [
        permissions.network.to_string(),
        allowed.join(","),
        declared.join(","),
        source.to_owned(),
    ] {
        hasher.update(part.len().to_le_bytes());
        hasher.update(part.as_bytes());
    }
    hasher
        .finalize()
        .iter()
        .fold(String::new(), |mut acc, byte| {
            acc.push_str(&format!("{byte:02x}"));
            acc
        })
}

/// 把 `ctx.http` 转交给异步 [`HttpPort`] 的宿主；Worker 线程同步等待结果。
struct PortHost {
    /// 网络 Port。
    port: Arc<dyn HttpPort>,
    /// Workflow 声明的主机，用来检查请求与每一次重定向。
    policy: HostPolicy,
    /// 异步运行时句柄：Worker 是普通线程，需要它来驱动 Port。
    runtime: tokio::runtime::Handle,
}

impl std::fmt::Debug for PortHost {
    /// 只输出类型名：Port 与策略不需要出现在日志里。
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PortHost").finish_non_exhaustive()
    }
}

impl ScriptHost for PortHost {
    /// 经 Port 发 GET，非 2xx 也如实返回状态码，由脚本决定怎么处理。
    fn http_get(&self, url: &str) -> Result<HostHttpReply, String> {
        let request = HttpRequest::get(url);
        match self.runtime.block_on(self.port.get(&request, &self.policy)) {
            Ok(response) => Ok(HostHttpReply {
                status: response.status,
                body: String::from_utf8_lossy(&response.body).into_owned(),
            }),
            Err(error) => Err(error.to_string()),
        }
    }
}

/// `script` 的执行器。
pub struct ScriptExecutor {
    /// Script Worker 的句柄。
    worker: ScriptHandle,
    /// 网络 Port（没有时 `ctx.http` 不可用）。
    http: Option<Arc<dyn HttpPort>>,
    /// 用户授权记录。
    grants: Arc<dyn ScriptGrants>,
}

impl ScriptExecutor {
    /// 创建执行器。
    #[must_use]
    pub fn new(
        worker: ScriptHandle,
        http: Option<Arc<dyn HttpPort>>,
        grants: Arc<dyn ScriptGrants>,
    ) -> Self {
        Self {
            worker,
            http,
            grants,
        }
    }
}

/// 脚本错误 → Step 错误分类。
fn step_error(error: &ScriptError) -> StepError {
    let kind = match error {
        ScriptError::Timeout => ErrorKind::Timeout,
        ScriptError::PermissionDenied { .. } => ErrorKind::PermissionDenied,
        ScriptError::InvalidInput { .. } | ScriptError::BadResult => ErrorKind::InvalidInput,
        ScriptError::OutOfMemory
        | ScriptError::Cancelled
        | ScriptError::Exception { .. }
        | ScriptError::WorkerGone => ErrorKind::Fatal,
    };
    StepError {
        kind,
        message: error.to_string(),
    }
}

/// 取出变量表里某个前缀下的条目，组成 JSON 对象文本（键去掉前缀）。
fn scope_object(
    scope: &std::collections::HashMap<String, String>,
    prefix: &str,
) -> BTreeMap<String, String> {
    scope
        .iter()
        .filter_map(|(key, value)| {
            key.strip_prefix(prefix)
                .map(|name| (name.to_owned(), value.clone()))
        })
        .collect()
}

/// 脚本返回的 Item 结构 → 草稿（结构已由 `validate_item_result` 校验过）。
fn draft_from(result_json: &str) -> Result<ItemDraft, StepError> {
    let value: serde_json::Value = serde_json::from_str(result_json)
        .map_err(|_| StepError::invalid("脚本的返回值无法解析"))?;
    let title = value
        .get("title")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .ok_or_else(|| StepError::invalid("脚本没有返回 title"))?
        .to_owned();
    let item_type = match value.get("type").and_then(serde_json::Value::as_str) {
        Some("todo") => ItemType::Todo,
        Some("tip") => ItemType::Tip,
        _ => ItemType::Note,
    };
    let content = value
        .get("notes")
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned)
        .filter(|n| !n.is_empty());
    let mut tags: Vec<String> = Vec::new();
    if let Some(list) = value.get("tags").and_then(serde_json::Value::as_array) {
        for tag in list.iter().filter_map(serde_json::Value::as_str) {
            let tag = tag.trim();
            if !tag.is_empty() && !tags.iter().any(|t| t.eq_ignore_ascii_case(tag)) {
                tags.push(tag.to_owned());
            }
        }
    }
    Ok(ItemDraft {
        item_type,
        title,
        content,
        in_inbox: true,
        tags,
        priority: None,
        scheduled: None,
        attach: true,
        file_index: None,
        source_label: None,
        metadata: BTreeMap::new(),
    })
}

#[async_trait]
impl StepExecutor for ScriptExecutor {
    /// 种类。
    fn kind(&self) -> &'static str {
        "script"
    }

    /// 校验授权 → 在沙箱里运行 → 把返回的 Item 结构加入草稿。
    async fn execute(&self, step: &Step, ctx: &mut RunContext<'_>) -> Result<(), StepError> {
        let Step::Script { source, hosts } = step else {
            return Err(StepError::fatal(format!(
                "Executor 收到了不属于它的 Step（{}）",
                step_kind(step)
            )));
        };
        // 需要联网的脚本不参加即时运行（与 http Step 一致），稍后在后台完整运行。
        if !ctx.network && !hosts.is_empty() {
            return Ok(());
        }
        // 防御：即使定义校验被绕过，也不允许脚本超出 Workflow 声明的权限。
        let within_permissions = hosts.iter().all(|host| {
            ctx.permissions.network
                && ctx
                    .permissions
                    .hosts
                    .iter()
                    .any(|allowed| allowed.eq_ignore_ascii_case(host))
        });
        if !within_permissions {
            return Err(StepError {
                kind: ErrorKind::PermissionDenied,
                message: "脚本声明的权限超出了 Workflow 的权限".to_owned(),
            });
        }
        let fingerprint = script_fingerprint(ctx.permissions, source, hosts);
        if !self.grants.is_granted(&fingerprint).await {
            return Err(StepError {
                kind: ErrorKind::UserActionRequired,
                message: "脚本需要先在 Workflow 设置里确认它的权限".to_owned(),
            });
        }

        let context_json = serde_json::json!({
            "input": scope_object(&ctx.scope, "input."),
            "vars": scope_object(&ctx.scope, "vars."),
            "metadata": scope_object(&ctx.scope, "url."),
            "item": {},
        })
        .to_string();
        let host: Option<Arc<dyn ScriptHost>> = match (&self.http, hosts.is_empty()) {
            (Some(port), false) => Some(Arc::new(PortHost {
                port: port.clone(),
                policy: HostPolicy::new(&ctx.permissions.hosts),
                runtime: tokio::runtime::Handle::current(),
            })),
            _ => None,
        };
        let request = ScriptRequest {
            source: source.clone(),
            context_json,
            policy: ScriptPolicy::default(),
            mode: ScriptMode::Step,
            permissions: ScriptPermissions {
                http_hosts: hosts.clone(),
            },
            host,
        };
        let output = self
            .worker
            .run(request)
            .await
            .map_err(|error| step_error(&error))?;
        ctx.drafts.push(draft_from(&output.result_json)?);
        Ok(())
    }
}
