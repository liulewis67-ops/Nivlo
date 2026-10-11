//! `ReqwestHttp` 的测试：用本机的假服务器验证权限、重定向、大小上限、超时与日志。

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::time::Duration;

use nivlo_application::ports::http::{HostPolicy, HttpError, HttpPort, HttpRequest};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use super::ReqwestHttp;

/// 启动一个假服务器，按请求路径返回固定的响应；返回 `host:port`。
async fn serve() -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let port = addr.port();
    tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else {
                return;
            };
            tokio::spawn(async move {
                let mut buffer = vec![0_u8; 4096];
                let n = socket.read(&mut buffer).await.unwrap_or(0);
                let head = String::from_utf8_lossy(&buffer[..n]).into_owned();
                let path = head
                    .split_whitespace()
                    .nth(1)
                    .unwrap_or("/")
                    .split('?')
                    .next()
                    .unwrap_or("/")
                    .to_owned();
                // 把收到的 Authorization 头放进响应体，方便测试断言它有没有被带上。
                let auth = head
                    .lines()
                    .find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("authorization")
                            .then(|| value.trim().to_owned())
                    })
                    .unwrap_or_else(|| "(none)".to_owned());
                let response = match path.as_str() {
                    "/echo-auth" => ok("text/plain", auth.as_bytes()),
                    "/redirect-same-origin" => redirect("/echo-auth"),
                    "/redirect-other-host" => {
                        redirect(&format!("http://localhost:{port}/echo-auth"))
                    }
                    "/hello" => ok("text/plain; charset=utf-8", "你好".as_bytes()),
                    "/redirect-in" => redirect("/hello"),
                    "/redirect-out" => redirect("http://evil.example/steal"),
                    "/redirect-private" => redirect("http://10.0.0.1/admin"),
                    "/loop" => redirect("/loop"),
                    "/big" => ok("application/octet-stream", &vec![b'x'; 100_000]),
                    "/slow" => {
                        tokio::time::sleep(Duration::from_secs(5)).await;
                        ok("text/plain", b"late")
                    }
                    _ => {
                        b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                            .to_vec()
                    }
                };
                let _ = socket.write_all(&response).await;
                let _ = socket.shutdown().await;
            });
        }
    });
    addr.to_string()
}

/// 200 响应。
fn ok(content_type: &str, body: &[u8]) -> Vec<u8> {
    let mut out = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    )
    .into_bytes();
    out.extend_from_slice(body);
    out
}

/// 302 响应。
fn redirect(to: &str) -> Vec<u8> {
    format!(
        "HTTP/1.1 302 Found\r\nLocation: {to}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    )
    .into_bytes()
}

/// 只放行本机假服务器的策略。
fn local_policy() -> HostPolicy {
    HostPolicy::new(["127.0.0.1"]).allowing_private_network_for_tests()
}

#[tokio::test]
async fn fetches_text_from_an_allowed_host() {
    let addr = serve().await;
    let http = ReqwestHttp::new().unwrap();
    let response = http
        .get(
            &HttpRequest::get(format!("http://{addr}/hello")),
            &local_policy(),
        )
        .await
        .unwrap();
    assert!(response.is_success());
    assert_eq!(response.text(), "你好");
    assert!(!response.truncated);
}

#[tokio::test]
async fn an_unlisted_host_is_denied_without_any_connection() {
    let http = ReqwestHttp::new().unwrap();
    let error = http
        .get(
            &HttpRequest::get("https://example.org/"),
            &HostPolicy::new(["github.com"]),
        )
        .await
        .unwrap_err();
    assert!(
        matches!(error, HttpError::PermissionDenied { .. }),
        "{error:?}"
    );
}

#[tokio::test]
async fn production_policy_refuses_the_loopback_server_even_when_listed() {
    let addr = serve().await;
    let http = ReqwestHttp::new().unwrap();
    let error = http
        .get(
            &HttpRequest::get(format!("http://{addr}/hello")),
            &HostPolicy::new(["127.0.0.1"]),
        )
        .await
        .unwrap_err();
    assert!(matches!(error, HttpError::PermissionDenied { .. }));
}

#[tokio::test]
async fn redirects_within_allowed_hosts_are_followed() {
    let addr = serve().await;
    let http = ReqwestHttp::new().unwrap();
    let response = http
        .get(
            &HttpRequest::get(format!("http://{addr}/redirect-in")),
            &local_policy(),
        )
        .await
        .unwrap();
    assert_eq!(response.text(), "你好");
    assert!(response.final_url.ends_with("/hello"));
}

#[tokio::test]
async fn a_redirect_to_an_unauthorised_or_private_host_is_blocked() {
    let addr = serve().await;
    let http = ReqwestHttp::new().unwrap();
    for path in ["/redirect-out", "/redirect-private"] {
        let error = http
            .get(
                &HttpRequest::get(format!("http://{addr}{path}")),
                &local_policy(),
            )
            .await
            .unwrap_err();
        assert!(
            matches!(error, HttpError::PermissionDenied { .. }),
            "{path}: {error:?}"
        );
    }
}

#[tokio::test]
async fn endless_redirects_stop() {
    let addr = serve().await;
    let http = ReqwestHttp::new().unwrap();
    let error = http
        .get(
            &HttpRequest::get(format!("http://{addr}/loop")),
            &local_policy(),
        )
        .await
        .unwrap_err();
    assert_eq!(error, HttpError::TooManyRedirects);
}

#[tokio::test]
async fn bodies_over_the_limit_are_truncated_not_buffered() {
    let addr = serve().await;
    let http = ReqwestHttp::new().unwrap();
    let mut request = HttpRequest::get(format!("http://{addr}/big"));
    request.max_bytes = 1000;
    let response = http.get(&request, &local_policy()).await.unwrap();
    assert_eq!(response.body.len(), 1000);
    assert!(response.truncated);
}

#[tokio::test]
async fn a_slow_server_times_out() {
    let addr = serve().await;
    let http = ReqwestHttp::new().unwrap();
    let mut request = HttpRequest::get(format!("http://{addr}/slow"));
    request.timeout = Duration::from_millis(150);
    let error = http.get(&request, &local_policy()).await.unwrap_err();
    assert_eq!(error, HttpError::Timeout);
}

#[tokio::test]
async fn auth_headers_are_sent_to_the_original_origin_only() {
    use nivlo_platform::credential::Secret;

    let addr = serve().await;
    let http = ReqwestHttp::new().unwrap();
    let policy = HostPolicy::new(["127.0.0.1", "localhost"]).allowing_private_network_for_tests();
    let request = |path: &str| {
        HttpRequest::get(format!("http://{addr}{path}"))
            .with_header("Authorization", Secret::new("Bearer t0k3n"))
    };

    // 直接请求、同源重定向：带上。
    let direct = http.get(&request("/echo-auth"), &policy).await.unwrap();
    assert_eq!(direct.text(), "Bearer t0k3n");
    let same = http
        .get(&request("/redirect-same-origin"), &policy)
        .await
        .unwrap();
    assert_eq!(same.text(), "Bearer t0k3n");

    // 重定向到另一个主机名（即使是同一台机器、同一个端口）：不带。
    let cross = http
        .get(&request("/redirect-other-host"), &policy)
        .await
        .unwrap();
    assert_eq!(cross.text(), "(none)");

    // Debug 输出里没有请求头的值。
    let debug = format!("{:?}", request("/x"));
    assert!(!debug.contains("t0k3n"), "{debug}");
}
