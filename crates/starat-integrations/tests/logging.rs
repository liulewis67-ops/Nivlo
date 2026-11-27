//! 日志里不出现查询串（可能带 token）与凭据头。单独成一个测试文件（单独的进程），
//! 避免其他测试线程干扰 tracing 的调用点缓存。

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, missing_docs)]

use std::sync::{Arc, Mutex};

use starat_application::ports::http::{HostPolicy, HttpPort, HttpRequest};
use starat_integrations::ReqwestHttp;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

/// 把日志写进内存的 Writer。
#[derive(Clone, Default)]
struct Captured(Arc<Mutex<Vec<u8>>>);

impl std::io::Write for Captured {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[tokio::test]
async fn logs_never_contain_query_strings_or_credential_headers() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut buffer = vec![0_u8; 4096];
        let _ = socket.read(&mut buffer).await;
        let _ = socket
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
            .await;
    });

    let captured = Captured::default();
    let sink = captured.clone();
    let subscriber = tracing_subscriber::fmt()
        .with_max_level(tracing::Level::TRACE)
        .with_writer(move || sink.clone())
        .finish();
    let _guard = tracing::subscriber::set_default(subscriber);

    let http = ReqwestHttp::new().unwrap();
    let policy = HostPolicy::new(["127.0.0.1"]).allowing_private_network_for_tests();
    let url = format!("http://{addr}/path?token=SECRET123&api_key=KEY456");
    http.get(&HttpRequest::get(url), &policy).await.unwrap();

    let logs = String::from_utf8(captured.0.lock().unwrap().clone()).unwrap();
    assert!(logs.contains("http_response"), "应当有日志：{logs}");
    for forbidden in ["SECRET123", "KEY456", "uthorization", "ookie", "token="] {
        assert!(!logs.contains(forbidden), "日志泄露了 {forbidden}：{logs}");
    }
}
