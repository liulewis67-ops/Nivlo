//! `nivlo-script`：QuickJS 脚本运行时、上下文桥接与资源限制（实施计划 Phase 8）。
//!
//! * [`ScriptPolicy`]：超时（默认 3s，最大 10s）、内存（默认 32 MiB，最大 64 MiB）、栈上限；
//! * [`ScriptWorker`]：独立线程里的 Actor，一次只跑一个脚本；**每个请求都用全新的 Runtime / Context**，
//!   所以脚本之间不可能共享状态；超时、内存超限、异常、取消都只让这一次请求失败，Worker 继续服务下一个；
//! * 脚本只能看到注入的 `ctx`（JSON）——没有 `require`、`process`、文件系统、网络，
//!   这些能力（8.2）将来也只能通过显式的 Bridge 暴露。
//!
//! 调用方（UI 线程 / Tokio 任务）只拿到 [`ScriptHandle`]，通过消息与 Worker 通信，
//! 代码库里没有任何在调用线程上 `eval` 的路径。
//!
//! 禁止依赖：`tauri`、其他 Adapter 的内部实现（参见后端规范 §3.1）。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex, PoisonError};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use rquickjs::{CatchResultExt, CaughtError, Context, Runtime};
use tokio::sync::oneshot;

/// 默认超时。
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(3);

/// 超时上限。
pub const MAX_TIMEOUT: Duration = Duration::from_secs(10);

/// 默认内存上限。
pub const DEFAULT_MEMORY_BYTES: usize = 32 * 1024 * 1024;

/// 内存上限的上限。
pub const MAX_MEMORY_BYTES: usize = 64 * 1024 * 1024;

/// 默认栈上限。
pub const DEFAULT_STACK_BYTES: usize = 512 * 1024;

/// 脚本的资源策略。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScriptPolicy {
    /// 超时。
    pub timeout: Duration,
    /// 内存上限（字节）。
    pub memory_bytes: usize,
    /// 栈上限（字节）。
    pub stack_bytes: usize,
}

impl Default for ScriptPolicy {
    /// 默认：3 秒、32 MiB、512 KiB 栈。
    fn default() -> Self {
        Self {
            timeout: DEFAULT_TIMEOUT,
            memory_bytes: DEFAULT_MEMORY_BYTES,
            stack_bytes: DEFAULT_STACK_BYTES,
        }
    }
}

impl ScriptPolicy {
    /// 把请求的策略限制在上限之内（Workflow 作者不能要求超过上限的资源）。
    #[must_use]
    pub fn clamped(self) -> Self {
        Self {
            timeout: self.timeout.min(MAX_TIMEOUT),
            memory_bytes: self.memory_bytes.min(MAX_MEMORY_BYTES),
            stack_bytes: self.stack_bytes.clamp(64 * 1024, 4 * 1024 * 1024),
        }
    }
}

/// 脚本运行失败。
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ScriptError {
    /// 超过时间上限。
    #[error("脚本运行超时")]
    Timeout,
    /// 超过内存上限。
    #[error("脚本占用的内存超过上限")]
    OutOfMemory,
    /// 被取消。
    #[error("脚本已取消")]
    Cancelled,
    /// 脚本抛出了异常（语法错误、运行时错误）。
    #[error("脚本出错：{message}")]
    Exception {
        /// 错误信息。
        message: String,
        /// 出错的行号（从 1 开始；取不到为 `None`）。
        line: Option<u32>,
    },
    /// 返回值不能序列化为 JSON。
    #[error("脚本的返回值无法转换为 JSON")]
    BadResult,
    /// Worker 已经停止。
    #[error("脚本运行器已停止")]
    WorkerGone,
}

/// 一次脚本运行请求。
#[derive(Debug, Clone)]
pub struct ScriptRequest {
    /// 脚本源码。最后一个表达式的值就是结果。
    pub source: String,
    /// 注入为全局 \`ctx\` 的 JSON。
    pub context_json: String,
    /// 资源策略（会被限制在上限内）。
    pub policy: ScriptPolicy,
}

/// 脚本的结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScriptOutput {
    /// 返回值的 JSON 文本；脚本返回 \`undefined\` 时为 \`null\`。
    pub result_json: String,
    /// 实际耗时。
    pub elapsed: Duration,
}

/// 发给 Worker 的消息。
enum Message {
    /// 运行一个脚本。
    Run(
        ScriptRequest,
        oneshot::Sender<Result<ScriptOutput, ScriptError>>,
    ),
    /// 停止 Worker。
    Shutdown,
}

/// 与 Worker 通信的句柄；可以克隆，跨线程使用。
#[derive(Clone)]
pub struct ScriptHandle {
    /// 消息通道。
    sender: Sender<Message>,
    /// 取消标志：Worker 在每次运行开始时清零，解释器的中断回调里检查。
    cancel: Arc<AtomicBool>,
}

impl ScriptHandle {
    /// 运行脚本并等待结果。脚本在 Worker 线程里执行，调用方（可以是 UI 线程）不会被阻塞。
    ///
    /// # Errors
    ///
    /// 见 [\`ScriptError\`]。
    pub async fn run(&self, request: ScriptRequest) -> Result<ScriptOutput, ScriptError> {
        let (reply, response) = oneshot::channel();
        self.sender
            .send(Message::Run(request, reply))
            .map_err(|_| ScriptError::WorkerGone)?;
        response.await.map_err(|_| ScriptError::WorkerGone)?
    }

    /// 取消正在运行的脚本（没有在运行时无效果）。
    pub fn cancel(&self) {
        self.cancel.store(true, Ordering::SeqCst);
    }
}

/// Script Worker：独立线程里的 Actor。
pub struct ScriptWorker {
    /// 句柄。
    handle: ScriptHandle,
    /// 线程。
    thread: Mutex<Option<JoinHandle<()>>>,
}

impl ScriptWorker {
    /// 启动 Worker 线程。
    #[must_use]
    pub fn spawn() -> Self {
        let (sender, receiver) = channel();
        let cancel = Arc::new(AtomicBool::new(false));
        let worker_cancel = cancel.clone();
        let thread = std::thread::Builder::new()
            .name("nivlo-script-worker".to_owned())
            .spawn(move || serve(&receiver, &worker_cancel))
            .ok();
        Self {
            handle: ScriptHandle { sender, cancel },
            thread: Mutex::new(thread),
        }
    }

    /// 通信句柄。
    #[must_use]
    pub fn handle(&self) -> ScriptHandle {
        self.handle.clone()
    }

    /// 停止 Worker 并等待线程结束。
    pub fn shutdown(&self) {
        let _ = self.handle.sender.send(Message::Shutdown);
        self.handle.cancel();
        if let Some(thread) = self
            .thread
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take()
        {
            let _ = thread.join();
        }
    }
}

impl Drop for ScriptWorker {
    /// 丢弃时停止线程，避免泄漏。
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// Worker 主循环。
fn serve(receiver: &Receiver<Message>, cancel: &Arc<AtomicBool>) {
    while let Ok(message) = receiver.recv() {
        match message {
            Message::Shutdown => return,
            Message::Run(request, reply) => {
                cancel.store(false, Ordering::SeqCst);
                let outcome = execute(&request, cancel);
                // 调用方已经不等了（取消 / 丢弃）：忽略发送失败。
                let _ = reply.send(outcome);
            }
        }
    }
}

/// 运行一个脚本（每次都是全新的 Runtime 与 Context）。
fn execute(request: &ScriptRequest, cancel: &Arc<AtomicBool>) -> Result<ScriptOutput, ScriptError> {
    let policy = request.policy.clamped();
    let started = Instant::now();
    let deadline = started + policy.timeout;
    let timed_out = Arc::new(AtomicBool::new(false));

    let runtime = Runtime::new().map_err(|e| ScriptError::Exception {
        message: e.to_string(),
        line: None,
    })?;
    runtime.set_memory_limit(policy.memory_bytes);
    runtime.set_max_stack_size(policy.stack_bytes);
    {
        let cancel = cancel.clone();
        let timed_out = timed_out.clone();
        runtime.set_interrupt_handler(Some(Box::new(move || {
            if cancel.load(Ordering::SeqCst) {
                return true;
            }
            if Instant::now() >= deadline {
                timed_out.store(true, Ordering::SeqCst);
                return true;
            }
            false
        })));
    }
    let context = Context::full(&runtime).map_err(|e| ScriptError::Exception {
        message: e.to_string(),
        line: None,
    })?;

    let outcome: Result<String, ScriptError> = context.with(|ctx| {
        // 注入 ctx；之后求值脚本，把最后一个表达式的值序列化为 JSON。
        let globals = ctx.globals();
        let json_parse: rquickjs::Function = ctx
            .eval("JSON.parse")
            .catch(&ctx)
            .map_err(|e| classify(&e, &timed_out, cancel))?;
        let parsed: rquickjs::Value = json_parse
            .call((request.context_json.as_str(),))
            .catch(&ctx)
            .map_err(|e| classify(&e, &timed_out, cancel))?;
        globals
            .set("ctx", parsed)
            .map_err(|e| ScriptError::Exception {
                message: e.to_string(),
                line: None,
            })?;
        let value: rquickjs::Value = ctx
            .eval(request.source.as_bytes())
            .catch(&ctx)
            .map_err(|e| classify(&e, &timed_out, cancel))?;
        let stringify: rquickjs::Function = ctx
            .eval("(v) => v === undefined ? 'null' : JSON.stringify(v)")
            .catch(&ctx)
            .map_err(|e| classify(&e, &timed_out, cancel))?;
        let text: Option<String> = stringify
            .call((value,))
            .catch(&ctx)
            .map_err(|e| classify(&e, &timed_out, cancel))?;
        text.ok_or(ScriptError::BadResult)
    });
    drop(context);
    drop(runtime);
    outcome.map(|result_json| ScriptOutput {
        result_json,
        elapsed: started.elapsed(),
    })
}

/// 从 QuickJS 的调用栈文本里取第一帧的行号（形如 `at <eval> (script.js:3:9)` 或 `at f (script.js:3)`）。
fn first_line_number(stack: &str) -> Option<u32> {
    let frame = stack.lines().find(|line| line.contains(':'))?;
    let inner = frame.trim_end().trim_end_matches(')');
    let mut parts = inner.rsplit(':');
    let last = parts.next()?;
    // 末尾可能是「行:列」，也可能只有「行」。
    let candidate = match parts.next() {
        Some(prev) if prev.chars().all(|c| c.is_ascii_digit()) && !prev.is_empty() => prev,
        _ => last,
    };
    candidate.parse::<u32>().ok().filter(|line| *line > 0)
}

/// 把引擎的错误归类。
fn classify(error: &CaughtError<'_>, timed_out: &AtomicBool, cancel: &AtomicBool) -> ScriptError {
    if timed_out.load(Ordering::SeqCst) {
        return ScriptError::Timeout;
    }
    if cancel.load(Ordering::SeqCst) {
        return ScriptError::Cancelled;
    }
    match error {
        CaughtError::Exception(exception) => {
            let message = exception.message().unwrap_or_default();
            if message.to_ascii_lowercase().contains("out of memory") {
                return ScriptError::OutOfMemory;
            }
            ScriptError::Exception {
                message,
                line: exception.stack().as_deref().and_then(first_line_number),
            }
        }
        CaughtError::Value(value) => ScriptError::Exception {
            message: format!("{value:?}"),
            line: None,
        },
        CaughtError::Error(error) => {
            let text = error.to_string();
            if text.to_ascii_lowercase().contains("memory") {
                ScriptError::OutOfMemory
            } else {
                ScriptError::Exception {
                    message: text,
                    line: None,
                }
            }
        }
    }
}

#[cfg(test)]
mod tests;
