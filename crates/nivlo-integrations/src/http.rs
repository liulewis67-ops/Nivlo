//! 基于 reqwest 的 [`HttpPort`] 适配器（实施计划 6.1）。
//!
//! * 重定向由我们自己逐跳跟随（reqwest 的自动重定向关闭），每一跳都重新过 [`HostPolicy`]；
//! * 响应体边读边计数，超过上限就停止并标记 `truncated`，不会把几百 MB 读进内存；
//! * 整个请求（含重定向）共用一个超时；
//! * 使用系统代理（reqwest 默认读取环境 / 系统代理设置）与 rustls 的系统证书校验；
//! * **日志里只记录主机与状态码**，不记录完整 URL（查询串里可能有 token）、也不记录任何请求 / 响应头
//!   （Authorization / Cookie 等）。

use std::time::{Duration, Instant};

use async_trait::async_trait;
use nivlo_application::ports::http::{HostPolicy, HttpError, HttpPort, HttpRequest, HttpResponse};
use reqwest::header::{CONTENT_TYPE, LOCATION};
use reqwest::redirect::Policy;
use url::Url;

/// 最多跟随几次重定向。
const MAX_REDIRECTS: u8 = 5;

/// 请求头里的 User-Agent。
const USER_AGENT: &str = concat!("Nivlo/", env!("CARGO_PKG_VERSION"));

/// reqwest 实现的 [`HttpPort`]。
#[derive(Clone)]
pub struct ReqwestHttp {
    /// 共享的客户端（连接池、代理配置）。
    client: reqwest::Client,
}

impl ReqwestHttp {
    /// 创建适配器。
    ///
    /// # Errors
    ///
    /// TLS 后端无法初始化时返回 [`HttpError::Network`]。
    pub fn new() -> Result<Self, HttpError> {
        let client = reqwest::Client::builder()
            .user_agent(USER_AGENT)
            .redirect(Policy::none())
            .connect_timeout(Duration::from_secs(5))
            .build()
            .map_err(|e| HttpError::Network(e.to_string()))?;
        Ok(Self { client })
    }
}

/// 把 reqwest 的错误归类（不把含 URL 的原始消息带出去）。
fn classify(error: &reqwest::Error) -> HttpError {
    if error.is_timeout() {
        HttpError::Timeout
    } else if error.is_connect() {
        HttpError::Network("无法连接".to_owned())
    } else {
        HttpError::Network("请求失败".to_owned())
    }
}

#[async_trait]
impl HttpPort for ReqwestHttp {
    async fn get(
        &self,
        request: &HttpRequest,
        policy: &HostPolicy,
    ) -> Result<HttpResponse, HttpError> {
        let deadline = Instant::now() + request.timeout;
        let mut current = policy.check(&request.url)?;
        for _ in 0..=MAX_REDIRECTS {
            let remaining = deadline
                .checked_duration_since(Instant::now())
                .ok_or(HttpError::Timeout)?;
            let response = self
                .client
                .get(current.clone())
                .timeout(remaining)
                .send()
                .await
                .map_err(|e| classify(&e))?;
            let status = response.status();
            tracing::debug!(
                event = "http_response",
                host = current.host_str().unwrap_or(""),
                status = status.as_u16(),
                "收到响应"
            );
            if status.is_redirection() {
                let Some(location) = response
                    .headers()
                    .get(LOCATION)
                    .and_then(|v| v.to_str().ok())
                else {
                    return Err(HttpError::Network("重定向缺少目标地址".to_owned()));
                };
                let next = current
                    .join(location)
                    .map_err(|e| HttpError::InvalidUrl(e.to_string()))?;
                // 重定向到哪里都要重新检查：公开页面不能把我们引到内网或未授权的主机。
                policy.check_url(&next)?;
                current = next;
                continue;
            }
            return read_body(response, &current, request.max_bytes, deadline).await;
        }
        Err(HttpError::TooManyRedirects)
    }
}

/// 读取响应体，最多 `max_bytes` 字节。
async fn read_body(
    mut response: reqwest::Response,
    url: &Url,
    max_bytes: usize,
    deadline: Instant,
) -> Result<HttpResponse, HttpError> {
    let status = response.status().as_u16();
    let content_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    let mut body: Vec<u8> = Vec::new();
    let mut truncated = false;
    loop {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .ok_or(HttpError::Timeout)?;
        let chunk = tokio::time::timeout(remaining, response.chunk())
            .await
            .map_err(|_| HttpError::Timeout)?
            .map_err(|e| classify(&e))?;
        let Some(chunk) = chunk else { break };
        let room = max_bytes - body.len();
        if chunk.len() > room {
            body.extend_from_slice(&chunk[..room]);
            truncated = true;
            break;
        }
        body.extend_from_slice(&chunk);
    }
    Ok(HttpResponse {
        status,
        final_url: url.to_string(),
        content_type,
        body,
        truncated,
    })
}

#[cfg(test)]
mod tests;
