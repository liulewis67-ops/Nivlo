//! 网络访问 Port（实施计划 6.1，架构文档 §36、§44）。
//!
//! 所有网络访问都经过 [`HttpPort`]，并且每个请求都带着一份 [`HostPolicy`]——来自 Workflow 声明的
//! `permissions.hosts`。策略本身是纯逻辑，写在这里，所以真实适配器与 Fake 共用同一套判定：
//!
//! * 只允许 `http` / `https`（`file://`、`ftp://` 等一律拒绝）；
//! * 默认拒绝 `localhost`、`*.localhost`、`*.local`、环回 / 私有 / 链路本地 / 未指定的 IP 字面量；
//! * 主机必须匹配白名单（精确主机名或 `*.example.com`）；白名单为空就是全部拒绝；
//! * 重定向的每一跳都要重新检查（适配器负责逐跳调用 [`HostPolicy::check`]）。
//!
//! 已知边界：策略只看 URL 里的主机，不解析 DNS；一个解析到内网地址的公网域名不会在这里被拦下。
//! 白名单里的主机是用户 / Workflow 作者明确信任的，这个风险随信任一起接受。

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::time::Duration;

use async_trait::async_trait;
use starat_common::secret::Secret;
use url::Url;

/// 请求被拒绝或失败的原因。
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum HttpError {
    /// 策略不允许访问（未授权的主机、内网地址、不支持的协议）。
    #[error("不允许访问 {host}：{reason}")]
    PermissionDenied {
        /// 被拒绝的主机（或地址）。
        host: String,
        /// 原因。
        reason: String,
    },
    /// 地址不合法。
    #[error("地址不合法：{0}")]
    InvalidUrl(String),
    /// 超时。
    #[error("请求超时")]
    Timeout,
    /// 响应体超过上限（适配器按上限截断时不返回这个错误，见 [`HttpResponse::truncated`]）。
    #[error("响应体太大")]
    TooLarge,
    /// 网络错误（连接失败、TLS、DNS……）。
    #[error("网络请求失败：{0}")]
    Network(String),
    /// 重定向太多。
    #[error("重定向次数过多")]
    TooManyRedirects,
}

/// 一次 GET 请求。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpRequest {
    /// 地址。
    pub url: String,
    /// 响应体最多读取多少字节；超出的部分丢弃并标记 `truncated`。
    pub max_bytes: usize,
    /// 整个请求（含重定向）的超时。
    pub timeout: Duration,
    /// 附加的请求头（如认证信息）。值是 [`Secret`]：`Debug` 输出会被遮蔽，日志里不会出现；
    /// 适配器只会把它们发给**最初的那个来源**，重定向到别处时丢弃。
    pub headers: Vec<(String, Secret<String>)>,
}

impl HttpRequest {
    /// 默认的响应体上限：2 MiB（页面元数据与 API JSON 足够）。
    pub const DEFAULT_MAX_BYTES: usize = 2 * 1024 * 1024;

    /// 默认超时：8 秒。
    pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(8);

    /// 用默认上限与超时创建请求。
    #[must_use]
    pub fn get(url: impl Into<String>) -> Self {
        Self {
            url: url.into(),
            max_bytes: Self::DEFAULT_MAX_BYTES,
            timeout: Self::DEFAULT_TIMEOUT,
            headers: Vec::new(),
        }
    }

    /// 追加一个请求头。
    #[must_use]
    pub fn with_header(
        mut self,
        name: impl Into<String>,
        value: impl Into<Secret<String>>,
    ) -> Self {
        self.headers.push((name.into(), value.into()));
        self
    }
}

/// 响应。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpResponse {
    /// 状态码。
    pub status: u16,
    /// 跟随重定向之后的最终地址。
    pub final_url: String,
    /// `Content-Type`（原样）。
    pub content_type: Option<String>,
    /// 响应体（最多 `max_bytes`）。
    pub body: Vec<u8>,
    /// 响应体是否被截断。
    pub truncated: bool,
}

impl HttpResponse {
    /// 状态码是否是 2xx。
    #[must_use]
    pub fn is_success(&self) -> bool {
        (200..300).contains(&self.status)
    }

    /// 按 `Content-Type` 里的 charset（缺省 UTF-8）把响应体解码成文本；解码不了的字节用替换字符。
    #[must_use]
    pub fn text(&self) -> String {
        let charset = self
            .content_type
            .as_deref()
            .and_then(|ct| {
                ct.split(';')
                    .filter_map(|part| part.trim().strip_prefix("charset="))
                    .next()
            })
            .map(|c| c.trim_matches('"').to_ascii_lowercase());
        decode_text(&self.body, charset.as_deref())
    }
}

/// 把字节按给定字符集解码为文本：没有声明时按 `<meta charset>` 嗅探，再不行就是 UTF-8；
/// 解码不了的字节用替换字符。支持 `encoding_rs` 认识的全部标签（`gbk`、`gb2312`、`big5`、`shift_jis`……），
/// 中文站点常见的非 UTF-8 页面因此不会变成乱码。
#[must_use]
pub fn decode_text(bytes: &[u8], charset: Option<&str>) -> String {
    let declared = charset
        .map(str::to_owned)
        .or_else(|| sniff_meta_charset(bytes));
    let encoding = declared
        .as_deref()
        .and_then(|label| encoding_rs::Encoding::for_label(label.as_bytes()))
        .unwrap_or(encoding_rs::UTF_8);
    encoding.decode(bytes).0.into_owned()
}

/// 在前 2 KiB 里找 `<meta charset=...>` / `content="...charset=..."`。
fn sniff_meta_charset(bytes: &[u8]) -> Option<String> {
    let head = String::from_utf8_lossy(&bytes[..bytes.len().min(2048)]).to_ascii_lowercase();
    let at = head.find("charset=")?;
    let rest = head[at + "charset=".len()..].trim_start_matches(['"', '\x27']);
    let name: String = rest
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect();
    (!name.is_empty()).then_some(name)
}

/// 访问策略：允许哪些主机。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct HostPolicy {
    /// 允许的主机模式（小写）：精确主机名，或 `*.example.com`。
    allowed: Vec<String>,
    /// 是否放行环回 / 私有地址——**只给测试用**（连本机的假服务器）。
    allow_private: bool,
    /// 用户在 Integration 里亲自配置过的主机（如内网 Jira）：只有它们可以绕过私网地址限制，
    /// 其他主机（包括重定向的目标）仍然被拒绝。
    private_ok: Vec<String>,
}

impl HostPolicy {
    /// 由白名单创建策略。
    #[must_use]
    pub fn new<I, S>(hosts: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        Self {
            allowed: hosts
                .into_iter()
                .map(|h| h.as_ref().trim().to_ascii_lowercase())
                .filter(|h| !h.is_empty())
                .collect(),
            allow_private: false,
            private_ok: Vec::new(),
        }
    }

    /// 放行环回 / 私有地址。**只能用于测试**：生产路径永远不调用它。
    #[must_use]
    pub fn allowing_private_network_for_tests(mut self) -> Self {
        self.allow_private = true;
        self
    }

    /// 允许访问这些**用户亲自配置过**的内网 / 自托管主机（只对它们放行私网限制）。
    ///
    /// 只应该由 Integration 适配器对「用户已连接的主机」调用，不能用 Workflow 里声明的主机。
    #[must_use]
    pub fn with_configured_private_hosts<I, S>(mut self, hosts: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        self.private_ok.extend(
            hosts
                .into_iter()
                .map(|h| h.as_ref().trim().to_ascii_lowercase())
                .filter(|h| !h.is_empty()),
        );
        self
    }

    /// 检查一个地址能不能访问。
    ///
    /// # Errors
    ///
    /// [`HttpError::InvalidUrl`]（解析失败 / 没有主机）或 [`HttpError::PermissionDenied`]。
    pub fn check(&self, url: &str) -> Result<Url, HttpError> {
        let parsed = Url::parse(url).map_err(|e| HttpError::InvalidUrl(e.to_string()))?;
        self.check_url(&parsed)?;
        Ok(parsed)
    }

    /// 检查已经解析的地址（重定向的每一跳都调用）。
    ///
    /// # Errors
    ///
    /// [`HttpError::PermissionDenied`] 或 [`HttpError::InvalidUrl`]。
    pub fn check_url(&self, url: &Url) -> Result<(), HttpError> {
        let denied = |host: &str, reason: &str| HttpError::PermissionDenied {
            host: host.to_owned(),
            reason: reason.to_owned(),
        };
        if !matches!(url.scheme(), "http" | "https") {
            return Err(denied(url.scheme(), "只支持 http 和 https"));
        }
        let host = url
            .host_str()
            .ok_or_else(|| HttpError::InvalidUrl("缺少主机".to_owned()))?
            .trim_matches(['[', ']'])
            .to_ascii_lowercase();
        if !self.allow_private && is_private_host(&host) && !self.private_ok.contains(&host) {
            return Err(denied(&host, "不允许访问本机或内网地址"));
        }
        if self
            .allowed
            .iter()
            .any(|pattern| host_matches(pattern, &host))
        {
            Ok(())
        } else {
            Err(denied(
                &host,
                "这个主机没有在 Workflow 的 permissions.hosts 里声明",
            ))
        }
    }
}

/// `*` 匹配任何公网主机（内网地址仍然被拒绝）；`*.example.com` 匹配子域名（不含 `example.com` 本身）；
/// 否则必须完全相同。
fn host_matches(pattern: &str, host: &str) -> bool {
    if pattern == "*" {
        return true;
    }
    match pattern.strip_prefix("*.") {
        Some(suffix) => host.len() > suffix.len() + 1 && host.ends_with(&format!(".{suffix}")),
        None => pattern == host,
    }
}

/// 是不是本机 / 内网主机。
fn is_private_host(host: &str) -> bool {
    if host == "localhost" || host.ends_with(".localhost") || host.ends_with(".local") {
        return true;
    }
    match host.parse::<IpAddr>() {
        Ok(IpAddr::V4(ip)) => is_private_v4(ip),
        Ok(IpAddr::V6(ip)) => is_private_v6(ip),
        Err(_) => false,
    }
}

/// IPv4：环回、私有、链路本地、未指定、广播、CGNAT。
fn is_private_v4(ip: Ipv4Addr) -> bool {
    let [a, b, ..] = ip.octets();
    ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        || ip.is_unspecified()
        || ip.is_broadcast()
        || (a == 100 && (64..128).contains(&b))
}

/// IPv6：环回、未指定、唯一本地（fc00::/7）、链路本地（fe80::/10）、IPv4 映射到内网。
fn is_private_v6(ip: Ipv6Addr) -> bool {
    if let Some(v4) = ip.to_ipv4_mapped() {
        return is_private_v4(v4);
    }
    let first = ip.segments()[0];
    ip.is_loopback()
        || ip.is_unspecified()
        || (first & 0xfe00) == 0xfc00
        || (first & 0xffc0) == 0xfe80
}

/// 网络访问 Port。
#[async_trait]
pub trait HttpPort: Send + Sync {
    /// 发一个 GET 请求，按 `policy` 检查首个地址与每一次重定向。
    ///
    /// # Errors
    ///
    /// 见 [`HttpError`]。
    async fn get(
        &self,
        request: &HttpRequest,
        policy: &HostPolicy,
    ) -> Result<HttpResponse, HttpError>;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy() -> HostPolicy {
        HostPolicy::new(["github.com", "*.atlassian.net", "API.example.com"])
    }

    #[test]
    fn only_declared_hosts_are_allowed_and_wildcards_match_subdomains_only() {
        let p = policy();
        assert!(p.check("https://github.com/a/b").is_ok());
        assert!(p.check("https://GitHub.com/a/b").is_ok());
        assert!(p.check("https://acme.atlassian.net/browse/X-1").is_ok());
        assert!(p.check("https://api.example.com/").is_ok());
        for bad in [
            "https://atlassian.net/",
            "https://evilgithub.com/",
            "https://github.com.evil.io/",
            "https://example.com/",
        ] {
            assert!(
                matches!(p.check(bad), Err(HttpError::PermissionDenied { .. })),
                "{bad}"
            );
        }
    }

    #[test]
    fn an_empty_allow_list_denies_everything() {
        assert!(matches!(
            HostPolicy::default().check("https://github.com/"),
            Err(HttpError::PermissionDenied { .. })
        ));
    }

    #[test]
    fn a_bare_star_allows_any_public_host_but_never_the_private_network() {
        let p = HostPolicy::new(["*"]);
        assert!(p.check("https://anything.example.org/x").is_ok());
        assert!(p.check("http://192.168.0.1/").is_err());
        assert!(p.check("http://localhost:3000/").is_err());
    }

    #[test]
    fn schemes_other_than_http_are_denied() {
        let p = HostPolicy::new(["*"]);
        for url in [
            "file:///etc/passwd",
            "ftp://github.com/x",
            "data:text/plain,hi",
        ] {
            assert!(p.check(url).is_err(), "{url}");
        }
    }

    #[test]
    fn localhost_and_private_addresses_are_denied_even_if_allow_listed() {
        let p = HostPolicy::new([
            "localhost",
            "127.0.0.1",
            "10.0.0.5",
            "192.168.1.1",
            "169.254.169.254",
            "[::1]",
            "printer.local",
            "100.64.0.1",
            "172.16.0.1",
            "0.0.0.0",
            "::ffff:10.0.0.1",
            "fd00::1",
            "fe80::1",
        ]);
        for url in [
            "http://localhost/",
            "http://app.localhost/",
            "http://127.0.0.1:8080/",
            "http://10.0.0.5/",
            "http://192.168.1.1/",
            "http://169.254.169.254/latest/meta-data",
            "http://[::1]/",
            "http://printer.local/",
            "http://100.64.0.1/",
            "http://172.16.0.1/",
            "http://0.0.0.0/",
            "http://[::ffff:10.0.0.1]/",
            "http://[fd00::1]/",
            "http://[fe80::1]/",
        ] {
            assert!(
                matches!(p.check(url), Err(HttpError::PermissionDenied { .. })),
                "{url}"
            );
        }
    }

    #[test]
    fn tests_can_opt_in_to_loopback_but_not_to_unlisted_hosts() {
        let p = HostPolicy::new(["127.0.0.1"]).allowing_private_network_for_tests();
        assert!(p.check("http://127.0.0.1:9000/").is_ok());
        assert!(p.check("http://127.0.0.2:9000/").is_err());
    }

    #[test]
    fn invalid_urls_are_reported_as_such() {
        assert!(matches!(
            policy().check("not a url"),
            Err(HttpError::InvalidUrl(_))
        ));
    }

    #[test]
    fn response_text_honours_the_declared_charset_and_replaces_bad_bytes() {
        let response = HttpResponse {
            status: 200,
            final_url: "https://x/".into(),
            content_type: Some("text/html; charset=utf-8".into()),
            body: "你好".as_bytes().to_vec(),
            truncated: false,
        };
        assert_eq!(response.text(), "你好");
        let broken = HttpResponse {
            body: vec![b'a', 0xff, b'b'],
            ..response
        };
        assert_eq!(broken.text(), "a\u{fffd}b");
    }
}

#[cfg(test)]
mod charset_tests {
    use super::*;

    #[test]
    fn gbk_pages_are_decoded_from_the_header_or_the_meta_tag() {
        // “你好” 的 GBK 编码。
        let gbk = [0xC4, 0xE3, 0xBA, 0xC3];
        assert_eq!(decode_text(&gbk, Some("gbk")), "你好");
        let mut page = b"<html><head><meta charset=\"gb2312\"></head><body>".to_vec();
        page.extend_from_slice(&gbk);
        assert!(decode_text(&page, None).ends_with("你好"));
        // 没有声明就是 UTF-8。
        assert_eq!(decode_text("你好".as_bytes(), None), "你好");
    }
}
