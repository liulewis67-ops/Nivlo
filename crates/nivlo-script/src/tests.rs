//! Script Worker 的测试：正常 / 超时 / 内存超限 / 异常 / 取消，且 Worker 在每次失败后继续服务。

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::time::Duration;

use super::{
    MAX_MEMORY_BYTES, MAX_TIMEOUT, ScriptError, ScriptPolicy, ScriptRequest, ScriptWorker,
};

fn request(source: &str) -> ScriptRequest {
    ScriptRequest {
        source: source.to_owned(),
        context_json: r#"{"input":{"text":"你好"},"vars":{"n":2}}"#.to_owned(),
        policy: ScriptPolicy::default(),
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
