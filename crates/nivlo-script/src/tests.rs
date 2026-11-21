//! Script Worker 的测试：正常 / 超时 / 内存超限 / 异常 / 取消，且 Worker 在每次失败后继续服务。

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::Arc;
use std::time::Duration;

use super::{
    HostHttpReply, MAX_MEMORY_BYTES, MAX_TIMEOUT, ScriptError, ScriptHost, ScriptMode,
    ScriptPermissions, ScriptPolicy, ScriptRequest, ScriptWorker,
};

fn request(source: &str) -> ScriptRequest {
    ScriptRequest {
        source: source.to_owned(),
        context_json: r#"{"input":{"text":"你好"},"vars":{"n":2}}"#.to_owned(),
        policy: ScriptPolicy::default(),
        mode: ScriptMode::Expression,
        permissions: ScriptPermissions::default(),
        host: None,
    }
}

fn quick(source: &str) -> ScriptRequest {
    let mut r = request(source);
    r.policy.timeout = Duration::from_millis(200);
    r
}

#[tokio::test]
async fn a_normal_script_returns_json_and_can_read_ctx() {
    let worker = ScriptWorker::spawn();
    let out = worker
        .handle()
        .run(request(
            r#"({ title: ctx.input.text + "!", n: ctx.vars.n * 2 })"#,
        ))
        .await
        .unwrap();
    assert_eq!(out.result_json, r#"{"title":"你好!","n":4}"#);
    // undefined → null。
    let out = worker.handle().run(request("undefined")).await.unwrap();
    assert_eq!(out.result_json, "null");
}

#[tokio::test]
async fn an_infinite_loop_times_out_and_the_worker_keeps_serving() {
    let worker = ScriptWorker::spawn();
    let handle = worker.handle();
    let started = std::time::Instant::now();
    assert_eq!(
        handle.run(quick("while (true) {}")).await,
        Err(ScriptError::Timeout)
    );
    assert!(started.elapsed() < Duration::from_secs(2));
    assert_eq!(handle.run(request("1 + 1")).await.unwrap().result_json, "2");
}

#[tokio::test]
async fn exceeding_the_memory_limit_fails_and_the_worker_keeps_serving() {
    let worker = ScriptWorker::spawn();
    let handle = worker.handle();
    let mut hungry = request("const a = []; while (true) { a.push('x'.repeat(100000)); }");
    hungry.policy.memory_bytes = 4 * 1024 * 1024;
    hungry.policy.timeout = Duration::from_secs(5);
    assert_eq!(handle.run(hungry).await, Err(ScriptError::OutOfMemory));
    assert_eq!(
        handle.run(request("'ok'")).await.unwrap().result_json,
        r#""ok""#
    );
}

#[tokio::test]
async fn exceptions_report_the_message_and_line_and_the_worker_keeps_serving() {
    let worker = ScriptWorker::spawn();
    let handle = worker.handle();
    let error = handle
        .run(request("let a = 1;\nlet b = 2;\nthrow new Error('boom');"))
        .await
        .unwrap_err();
    match error {
        ScriptError::Exception { message, line } => {
            assert!(message.contains("boom"), "{message}");
            assert_eq!(line, Some(3));
        }
        other => panic!("{other:?}"),
    }
    assert!(matches!(
        handle.run(request("let = ;")).await,
        Err(ScriptError::Exception { .. })
    ));
    assert_eq!(handle.run(request("3")).await.unwrap().result_json, "3");
}

#[tokio::test]
async fn deep_recursion_is_a_catchable_error_not_a_crash() {
    let worker = ScriptWorker::spawn();
    let handle = worker.handle();
    let error = handle
        .run(request("function f() { return f() + 1; } f()"))
        .await
        .unwrap_err();
    assert!(matches!(error, ScriptError::Exception { .. }), "{error:?}");
    assert_eq!(handle.run(request("1")).await.unwrap().result_json, "1");
}

#[tokio::test]
async fn cancel_stops_a_running_script() {
    let worker = ScriptWorker::spawn();
    let handle = worker.handle();
    let mut long = request("while (true) {}");
    long.policy.timeout = Duration::from_secs(10);
    let runner = tokio::spawn({
        let handle = handle.clone();
        async move { handle.run(long).await }
    });
    tokio::time::sleep(Duration::from_millis(100)).await;
    handle.cancel();
    assert_eq!(runner.await.unwrap(), Err(ScriptError::Cancelled));
    assert_eq!(handle.run(request("5")).await.unwrap().result_json, "5");
}

#[tokio::test]
async fn state_never_leaks_between_runs() {
    let worker = ScriptWorker::spawn();
    let handle = worker.handle();
    handle
        .run(request("globalThis.leak = 42; 0"))
        .await
        .unwrap();
    let out = handle.run(request("typeof globalThis.leak")).await.unwrap();
    assert_eq!(out.result_json, r#""undefined""#);
}

#[test]
fn requested_limits_are_clamped_to_the_maximums() {
    let greedy = ScriptPolicy {
        timeout: Duration::from_secs(600),
        memory_bytes: 10 * MAX_MEMORY_BYTES,
        stack_bytes: usize::MAX,
    }
    .clamped();
    assert_eq!(greedy.timeout, MAX_TIMEOUT);
    assert_eq!(greedy.memory_bytes, MAX_MEMORY_BYTES);
    assert!(greedy.stack_bytes <= 4 * 1024 * 1024);
}

#[tokio::test]
async fn after_shutdown_requests_fail_cleanly() {
    let worker = ScriptWorker::spawn();
    let handle = worker.handle();
    worker.shutdown();
    assert_eq!(handle.run(request("1")).await, Err(ScriptError::WorkerGone));
}

#[test]
fn line_numbers_are_read_from_stack_frames() {
    use super::first_line_number;
    assert_eq!(
        first_line_number("    at <eval> (script.js:3:9)\n"),
        Some(3)
    );
    assert_eq!(first_line_number("    at f (script.js:12)"), Some(12));
    assert_eq!(first_line_number("no frames here"), None);
    assert_eq!(first_line_number(""), None);
}

/// 记录调用的假宿主。
#[derive(Debug)]
struct FakeHost;

impl ScriptHost for FakeHost {
    fn http_get(&self, url: &str) -> Result<HostHttpReply, String> {
        Ok(HostHttpReply {
            status: 200,
            body: format!("body of {url}"),
        })
    }
}

fn step(source: &str, hosts: &[&str]) -> ScriptRequest {
    let mut r = request(source);
    r.mode = ScriptMode::Step;
    r.permissions = ScriptPermissions {
        http_hosts: hosts.iter().map(|h| (*h).to_owned()).collect(),
    };
    r.host = Some(Arc::new(FakeHost));
    r
}

#[tokio::test]
async fn both_entry_forms_work_and_async_is_awaited() {
    let worker = ScriptWorker::spawn();
    let out = worker
        .handle()
        .run(step(
            "export default async function (ctx) { const x = await Promise.resolve(ctx.vars.n); return { title: ctx.input.text + x, tags: ['a'] }; }",
            &[],
        ))
        .await
        .unwrap();
    assert_eq!(out.result_json, r#"{"title":"你好2","tags":["a"]}"#);
    let out = worker
        .handle()
        .run(step(
            "function transform(input) { return { title: input.text.toUpperCase() + '  !  '.trim() }; }",
            &[],
        ))
        .await
        .unwrap();
    assert_eq!(out.result_json, r#"{"title":"你好!"}"#);
}

#[tokio::test]
async fn http_to_an_authorized_host_works_and_others_are_denied() {
    let worker = ScriptWorker::spawn();
    let code = "export default async function (ctx) { const r = ctx.http.get('https://api.example.com/x?y=1'); return { title: r.body }; }";
    let out = worker
        .handle()
        .run(step(code, &["API.example.com"]))
        .await
        .unwrap();
    assert_eq!(
        out.result_json,
        r#"{"title":"body of https://api.example.com/x?y=1"}"#
    );
    for url in [
        "https://evil.test/",
        "https://api.example.com.evil.test/",
        "https://api.example.com@evil.test/",
        "ftp://api.example.com/",
    ] {
        let source = format!(
            "export default function (ctx) {{ ctx.http.get('{url}'); return {{ title: 'x' }}; }}"
        );
        let error = worker
            .handle()
            .run(step(&source, &["api.example.com"]))
            .await
            .unwrap_err();
        assert!(
            matches!(error, ScriptError::PermissionDenied { .. }),
            "{url} -> {error:?}"
        );
    }
    // 脚本把越权异常吞掉再失败，仍然按越权报告。
    let swallowed = "export default function (ctx) { try { ctx.http.get('https://evil.test/'); } catch (e) {} throw new Error('boom'); }";
    let error = worker.handle().run(step(swallowed, &[])).await.unwrap_err();
    assert!(matches!(error, ScriptError::PermissionDenied { .. }));
}

#[tokio::test]
async fn invalid_results_name_the_field() {
    let worker = ScriptWorker::spawn();
    for (source, field) in [
        ("export default () => 42", "(root)"),
        ("export default () => ({})", "title"),
        ("export default () => ({ title: '  ' })", "title"),
        ("export default () => ({ title: 'a', tags: [1] })", "tags"),
        ("export default () => ({ title: 'a', type: 'x' })", "type"),
        ("export default () => ({ title: 'a', notes: 5 })", "notes"),
    ] {
        let error = worker.handle().run(step(source, &[])).await.unwrap_err();
        match error {
            ScriptError::InvalidInput { field: got, .. } => assert_eq!(got, field, "{source}"),
            other => panic!("{source}: {other:?}"),
        }
    }
}

#[tokio::test]
async fn dangerous_globals_are_absent() {
    let worker = ScriptWorker::spawn();
    let source = "export default function (ctx) { \
        const names = ['require', 'process', 'fs', 'std', 'os', 'fetch', 'XMLHttpRequest', 'Deno', 'Bun', 'module']; \
        return { title: names.filter((n) => typeof globalThis[n] !== 'undefined').join(',') || 'none', \
                 notes: typeof ctx.file + ',' + typeof ctx.clipboard }; }";
    let out = worker.handle().run(step(source, &[])).await.unwrap();
    assert_eq!(
        out.result_json,
        r#"{"title":"none","notes":"undefined,undefined"}"#
    );
}

#[tokio::test]
async fn missing_entry_is_an_exception_and_infinite_loops_still_time_out() {
    let worker = ScriptWorker::spawn();
    let error = worker
        .handle()
        .run(step("const a = 1;", &[]))
        .await
        .unwrap_err();
    assert!(matches!(error, ScriptError::Exception { .. }));
    let mut looping = step("export default function () { while (true) {} }", &[]);
    looping.policy.timeout = Duration::from_millis(150);
    assert_eq!(
        worker.handle().run(looping).await.unwrap_err(),
        ScriptError::Timeout
    );
}

#[tokio::test]
async fn console_output_is_collected_with_limits_and_transform_gets_the_input() {
    let worker = ScriptWorker::spawn();
    let source = "export default function transform(input) { \
        console.log('hello', input.text, { a: 1 }); console.warn('careful'); \
        for (let i = 0; i < 500; i++) console.log('x'.repeat(5000)); \
        return { title: input.text, content: 'body', tags: ['a'] }; }";
    let out = worker.handle().run(step(source, &[])).await.unwrap();
    assert_eq!(
        out.result_json,
        r#"{"title":"你好","content":"body","tags":["a"]}"#
    );
    assert_eq!(out.logs.len(), 100);
    assert_eq!(out.logs[0], r#"hello 你好 {"a":1}"#);
    assert_eq!(out.logs[1], "careful");
    assert_eq!(out.logs[2].chars().count(), 1000);
}

#[tokio::test]
async fn content_must_be_a_string() {
    let worker = ScriptWorker::spawn();
    let error = worker
        .handle()
        .run(step(
            "export default () => ({ title: 'a', content: 5 })",
            &[],
        ))
        .await
        .unwrap_err();
    match error {
        ScriptError::InvalidInput { field, .. } => assert_eq!(field, "content"),
        other => panic!("{other:?}"),
    }
}
