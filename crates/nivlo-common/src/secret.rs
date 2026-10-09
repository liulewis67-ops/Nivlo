//! 敏感值包装。
//!
//! `Secret<T>` 的 `Debug` / `Display` 一律输出 `***`，且**不实现 `Serialize`**，
//! 因此即使被误放进日志字段、错误信息或 IPC DTO，也不会泄漏明文（架构文档 §35、§44）。
//! 读取明文必须显式调用 [`Secret::expose`]，便于在代码审查中定位。

use std::fmt;

use serde::Deserialize;

/// 包装一个不得出现在日志、序列化输出或错误信息中的敏感值。
#[derive(Clone, Deserialize)]
#[serde(transparent)]
pub struct Secret<T>(T);

impl<T> Secret<T> {
    /// 包装一个敏感值。
    pub fn new(value: T) -> Self {
        Self(value)
    }

    /// 显式读取明文。
    ///
    /// 调用点应当只把明文交给真正需要它的外部系统（如凭据库、HTTP 认证头），
    /// 不得再写入日志。
    pub fn expose(&self) -> &T {
        &self.0
    }

    /// 消费包装并取出明文。
    pub fn into_inner(self) -> T {
        self.0
    }
}

impl<T> fmt::Debug for Secret<T> {
    /// 固定输出 `***`，不泄漏内部值。
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("***")
    }
}

impl<T> fmt::Display for Secret<T> {
    /// 固定输出 `***`，不泄漏内部值。
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("***")
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use std::io;
    use std::sync::{Arc, Mutex};

    use tracing_subscriber::fmt::MakeWriter;

    use super::*;

    /// 把日志写入内存缓冲区，便于断言输出内容。
    #[derive(Clone, Default)]
    struct BufWriter(Arc<Mutex<Vec<u8>>>);

    impl io::Write for BufWriter {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    impl<'a> MakeWriter<'a> for BufWriter {
        type Writer = BufWriter;

        fn make_writer(&'a self) -> Self::Writer {
            self.clone()
        }
    }

    #[test]
    fn debug_and_display_are_masked() {
        let secret = Secret::new("hunter2".to_string());
        assert_eq!(format!("{secret:?}"), "***");
        assert_eq!(format!("{secret}"), "***");
        assert_eq!(format!("{:?}", Some(&secret)), "Some(***)");
    }

    #[test]
    fn tracing_fields_are_masked() {
        let buf = BufWriter::default();
        let subscriber = tracing_subscriber::fmt()
            .with_writer(buf.clone())
            .with_ansi(false)
            .finish();
        let secret = Secret::new("hunter2".to_string());
        tracing::subscriber::with_default(subscriber, || {
            tracing::info!(as_debug = ?secret, as_display = %secret, "login");
        });
        let output = String::from_utf8(buf.0.lock().unwrap().clone()).unwrap();
        assert!(output.contains("***"), "输出: {output}");
        assert!(!output.contains("hunter2"), "输出: {output}");
    }

    #[test]
    fn expose_returns_plaintext() {
        let secret = Secret::new(42_u32);
        assert_eq!(*secret.expose(), 42);
        assert_eq!(secret.into_inner(), 42);
    }

    #[test]
    fn deserializes_transparently() {
        let secret: Secret<String> = serde_json::from_str("\"abc\"").unwrap();
        assert_eq!(secret.expose(), "abc");
    }
}
