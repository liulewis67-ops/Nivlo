//! Script Step 的运行方式与 Capability API（实施计划 8.2）。
//!
//! 脚本有两种写法：
//!
//! * `export default async function (ctx) { ... }`；
//! * `function transform(input) { ... }`（等价于把 `ctx.input` 作为参数）。
//!
//! 脚本只能看到 `ctx`：`input`、`vars`、`metadata`、`item`、`utils`、`http`。
//! `ctx.http` 的每次调用都走「JS → Bridge → 权限检查 → [`ScriptHost`]」；
//! `ctx.file` / `ctx.clipboard` 默认不存在，没有授权时脚本拿到的是 `undefined`。
//! 返回值必须符合标准 Item 结构，否则以 `InvalidInput` 失败并指明字段。

use std::sync::{Arc, Mutex, PoisonError};

use rquickjs::promise::MaybePromise;
use rquickjs::{Ctx, Exception, Function, Object, Value};

use crate::ScriptError;

/// 脚本被授予的权限（必须是 Workflow 有效权限的子集，见 8.3）。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ScriptPermissions {
    /// 允许 `ctx.http` 访问的主机（精确匹配，不区分大小写）。
    pub http_hosts: Vec<String>,
}

/// `ctx.http` 的响应。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostHttpReply {
    /// HTTP 状态码。
    pub status: u16,
    /// 响应正文（文本）。
    pub body: String,
}

/// 宿主提供的能力。Worker 线程同步调用它，实现方负责把调用转交给异步的 Port。
pub trait ScriptHost: Send + Sync + std::fmt::Debug {
    /// 发起 GET 请求。权限已经由 Bridge 检查过。
    ///
    /// # Errors
    ///
    /// 返回面向用户的错误文本。
    fn http_get(&self, url: &str) -> Result<HostHttpReply, String>;
}

/// Bridge 的共享状态：记录第一次越权，让它即使被脚本吞掉异常也能被归类。
#[derive(Debug, Default)]
pub(crate) struct BridgeState {
    /// 越权信息（`PermissionDenied`）。
    denied: Mutex<Option<String>>,
    /// 脚本的 `console` 输出（行数与长度都有上限）。
    logs: Mutex<Vec<String>>,
}

/// `console` 输出最多保留的行数。
const MAX_LOG_LINES: usize = 100;

/// 每行 `console` 输出最多保留的字符数。
const MAX_LOG_CHARS: usize = 1000;

impl BridgeState {
    /// 取出已记录的越权信息。
    pub(crate) fn denied(&self) -> Option<String> {
        self.denied
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    /// 取出 `console` 输出。
    pub(crate) fn take_logs(&self) -> Vec<String> {
        std::mem::take(&mut *self.logs.lock().unwrap_or_else(PoisonError::into_inner))
    }

    /// 追加一行 `console` 输出；超过上限的行与字符被丢弃。
    fn log(&self, line: &str) {
        let mut logs = self.logs.lock().unwrap_or_else(PoisonError::into_inner);
        if logs.len() < MAX_LOG_LINES {
            logs.push(line.chars().take(MAX_LOG_CHARS).collect());
        }
    }

    /// 记录越权（只保留第一次）。
    fn deny(&self, message: &str) {
        let mut slot = self.denied.lock().unwrap_or_else(PoisonError::into_inner);
        if slot.is_none() {
            *slot = Some(message.to_owned());
        }
    }
}

/// 从 URL 里取出主机名（小写）；不是 http(s) URL 时返回 `None`。
fn host_of(url: &str) -> Option<String> {
    let rest = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))?;
    let authority = rest.split(['/', '?', '#']).next()?;
    // 带 `@` 的 URL 常被用来伪装主机，按最后一个 `@` 之后的部分算，再去掉端口。
    let host_port = authority.rsplit('@').next()?;
    let host = host_port.split(':').next()?;
    if host.is_empty() {
        None
    } else {
        Some(host.to_ascii_lowercase())
    }
}

/// 该 URL 的主机是否在授权列表里。
fn http_allowed(permissions: &ScriptPermissions, url: &str) -> Result<(), String> {
    let host = host_of(url).ok_or_else(|| format!("不是有效的 http(s) 地址：{url}"))?;
    if permissions
        .http_hosts
        .iter()
        .any(|allowed| allowed.eq_ignore_ascii_case(&host))
    {
        Ok(())
    } else {
        Err(format!("脚本没有访问 {host} 的权限"))
    }
}

/// 注入 `ctx.http` 与 `ctx.utils`。
fn install_capabilities<'js>(
    js: &Ctx<'js>,
    ctx_object: &Object<'js>,
    permissions: &ScriptPermissions,
    host: Option<&Arc<dyn ScriptHost>>,
    state: &Arc<BridgeState>,
) -> rquickjs::Result<()> {
    let http = Object::new(js.clone())?;
    let permissions = permissions.clone();
    let host = host.cloned();
    let deny_state = state.clone();
    http.set(
        "get",
        Function::new(js.clone(), move |js: Ctx<'js>, url: String| {
            if let Err(message) = http_allowed(&permissions, &url) {
                deny_state.deny(&message);
                return Err(Exception::throw_message(
                    &js,
                    &format!("PermissionDenied: {message}"),
                ));
            }
            let Some(host) = host.as_ref() else {
                return Err(Exception::throw_message(&js, "ctx.http 在当前环境不可用"));
            };
            match host.http_get(&url) {
                Ok(reply) => {
                    let object = Object::new(js.clone())?;
                    object.set("status", i32::from(reply.status))?;
                    object.set("body", reply.body)?;
                    Ok(object)
                }
                Err(message) => Err(Exception::throw_message(&js, &message)),
            }
        })?,
    )?;
    ctx_object.set("http", http)?;

    let utils: Value = js.eval(
        "({ trim: (s) => String(s ?? '').trim(), \
           truncate: (s, n) => { const t = String(s ?? ''); return t.length > n ? t.slice(0, n) : t; } })",
    )?;
    ctx_object.set("utils", utils)?;

    // console：JS 侧负责把参数格式化成一行文本，Rust 侧只负责限量收集。
    let sink = state.clone();
    let push = Function::new(js.clone(), move |line: String| sink.log(&line))?;
    let install: Function = js.eval(
        "(push) => { \
           const fmt = (a) => { \
             if (typeof a === 'string') return a; \
             try { const t = JSON.stringify(a); return t === undefined ? String(a) : t; } \
             catch (e) { return String(a); } }; \
           const write = (...args) => push(args.map(fmt).join(' ')); \
           globalThis.console = { log: write, info: write, warn: write, error: write, debug: write }; }",
    )?;
    install.call::<_, ()>((push,))?;
    Ok(())
}

/// 把 `export default ...` 改写成对全局的赋值（脚本模式不支持 `export`）。
fn rewrite_entry(source: &str) -> String {
    source.replacen("export default", "globalThis.__asterjot_entry =", 1)
}

/// 运行一个 Script Step：求值源码、找到入口、调用、等待结果、序列化。
pub(crate) fn run_step<'js>(
    js: &Ctx<'js>,
    source: &str,
    context_json: &str,
    permissions: &ScriptPermissions,
    host: Option<&Arc<dyn ScriptHost>>,
    state: &Arc<BridgeState>,
) -> rquickjs::Result<String> {
    let parse: Function = js.eval("JSON.parse")?;
    let ctx_value: Value = parse.call((context_json,))?;
    let ctx_object = ctx_value
        .as_object()
        .cloned()
        .ok_or_else(|| Exception::throw_message(js, "ctx 必须是对象"))?;
    // 脚本不应读到宿主没有授予的能力，这两个先显式清掉。
    ctx_object.remove("file")?;
    ctx_object.remove("clipboard")?;
    install_capabilities(js, &ctx_object, permissions, host, state)?;

    js.eval::<(), _>(rewrite_entry(source).into_bytes())?;
    let globals = js.globals();
    let entry: Value = globals.get("__asterjot_entry")?;
    let result: Value = if let Some(function) = entry.as_function() {
        // `export default function transform(input)` 约定参数是输入；其余入口接收完整的 ctx。
        let name: String = function.get("name").unwrap_or_default();
        if name == "transform" {
            let input: Value = ctx_object.get("input")?;
            function.call((input,))?
        } else {
            function.call((ctx_object,))?
        }
    } else {
        let transform: Value = globals.get("transform")?;
        let Some(function) = transform.as_function() else {
            return Err(Exception::throw_message(
                js,
                "脚本需要 `export default function (ctx)` 或 `function transform(input)`",
            ));
        };
        let input: Value = ctx_object.get("input")?;
        function.call((input,))?
    };
    // 异步函数返回 Promise：把待处理的任务跑完再取结果。
    let settled: Value = MaybePromise::from_value(result).finish()?;
    let stringify: Function = js.eval("(v) => v === undefined ? 'null' : JSON.stringify(v)")?;
    let text: Option<String> = stringify.call((settled,))?;
    text.ok_or_else(|| Exception::throw_message(js, "返回值无法转换为 JSON"))
}

/// 校验脚本的返回值是标准 Item 结构：`title` 为非空字符串；
/// 可选 `notes` 或 `content`（字符串，二者等价）、`type`（`todo` / `note` / `tip`）、`tags`（字符串数组）。
///
/// # Errors
///
/// 结构不合法时返回 [`ScriptError::InvalidInput`]，指明出问题的字段。
pub fn validate_item_result(result_json: &str) -> Result<(), ScriptError> {
    let invalid = |field: &str, message: &str| ScriptError::InvalidInput {
        field: field.to_owned(),
        message: message.to_owned(),
    };
    let value: serde_json::Value =
        serde_json::from_str(result_json).map_err(|_| ScriptError::BadResult)?;
    let object = value
        .as_object()
        .ok_or_else(|| invalid("(root)", "返回值必须是对象"))?;
    match object.get("title") {
        Some(serde_json::Value::String(title)) if !title.trim().is_empty() => {}
        Some(_) => return Err(invalid("title", "必须是非空字符串")),
        None => return Err(invalid("title", "缺少必填字段")),
    }
    for field in ["notes", "content"] {
        if let Some(text) = object.get(field)
            && !text.is_string()
            && !text.is_null()
        {
            return Err(invalid(field, "必须是字符串"));
        }
    }
    if let Some(kind) = object.get("type")
        && !matches!(kind.as_str(), Some("todo" | "note" | "tip"))
    {
        return Err(invalid("type", "必须是 todo、note 或 tip"));
    }
    if let Some(tags) = object.get("tags") {
        let ok = tags
            .as_array()
            .is_some_and(|list| list.iter().all(serde_json::Value::is_string));
        if !ok {
            return Err(invalid("tags", "必须是字符串数组"));
        }
    }
    Ok(())
}
