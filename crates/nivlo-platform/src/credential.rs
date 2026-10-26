//! 凭据存取（`CredentialPort`，实施计划 9.1）。
//!
//! Token / 密码这类秘密**只存在于操作系统的凭据库**（Windows Credential Manager 等），
//! 不进 SQLite、不进配置文件、不进日志，也不暴露给 JS 脚本与前端：
//!
//! * [`Secret`] 的 `Debug` 输出是 `Secret(***)`，没有 `Display` / `Serialize`，不会被 `{:?}` 或序列化意外带出；
//! * 只有 Integration Adapter 通过 [`CredentialPort`] 读取，没有任何 IPC Command 返回凭据内容。

use std::collections::HashMap;
use std::sync::{Mutex, PoisonError};

use crate::error::PlatformError;

/// 一个秘密值（Token、密码）。
///
/// 故意不实现 `Display`、`Serialize`，`Debug` 也只输出占位——日志里不可能出现它的内容。
#[derive(Clone, PartialEq, Eq)]
pub struct Secret(String);

impl Secret {
    /// 包装一个秘密值。
    #[must_use]
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    /// 读出内容。只应在真正要用它的地方（构造认证请求头等）调用，调用点就是审计点。
    #[must_use]
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl From<Secret> for nivlo_common::secret::Secret<String> {
    /// 交给 HTTP 端口等只认通用包装的地方；内容始终留在包装里，不经过明文变量。
    fn from(value: Secret) -> Self {
        Self::new(value.0)
    }
}

impl std::fmt::Debug for Secret {
    /// 只输出占位，绝不输出内容。
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Secret(***)")
    }
}

/// 凭据的标识：哪个集成的哪个账号（如 `jira` + `https://jira.example.com`）。
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct CredentialKey {
    /// 集成名（小写字母、数字、`-`、`_`、`.`）。
    integration: String,
    /// 账号 / 站点标识（非空、不含控制字符）。
    account: String,
}

impl CredentialKey {
    /// 创建并校验标识。
    ///
    /// # Errors
    ///
    /// 集成名或账号为空、过长或含有不允许的字符时返回 [`PlatformError::Failed`]。
    pub fn new(integration: &str, account: &str) -> Result<Self, PlatformError> {
        let integration_ok = !integration.is_empty()
            && integration.len() <= 40
            && integration.chars().all(|c| {
                c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '-' | '_' | '.')
            });
        let account_ok = !account.trim().is_empty()
            && account.len() <= 200
            && !account.chars().any(char::is_control);
        if integration_ok && account_ok {
            Ok(Self {
                integration: integration.to_owned(),
                account: account.to_owned(),
            })
        } else {
            Err(PlatformError::Failed("凭据标识不合法".to_owned()))
        }
    }

    /// 在系统凭据库里使用的目标名：`Nivlo/<集成>/<账号>`，与其他应用的凭据互不冲突。
    #[must_use]
    pub fn target_name(&self) -> String {
        format!("Nivlo/{}/{}", self.integration, self.account)
    }
}

/// 读写系统凭据库。
pub trait CredentialPort: Send + Sync {
    /// 读取凭据；没存过返回 `None`。
    ///
    /// # Errors
    ///
    /// 系统凭据库不可用或读取失败时返回 [`PlatformError`]。
    fn get(&self, key: &CredentialKey) -> Result<Option<Secret>, PlatformError>;

    /// 保存（覆盖）凭据。
    ///
    /// # Errors
    ///
    /// 系统凭据库不可用或写入失败时返回 [`PlatformError`]。
    fn set(&self, key: &CredentialKey, secret: &Secret) -> Result<(), PlatformError>;

    /// 删除凭据；本来就不存在也算成功。
    ///
    /// # Errors
    ///
    /// 系统凭据库不可用或删除失败时返回 [`PlatformError`]。
    fn delete(&self, key: &CredentialKey) -> Result<(), PlatformError>;
}

/// 内存版凭据库：测试用，也是没有系统凭据库的平台上的降级（进程退出即丢失，不落盘）。
#[derive(Debug, Default)]
pub struct MemoryCredentials {
    /// 目标名 → 秘密。
    entries: Mutex<HashMap<String, Secret>>,
}

impl MemoryCredentials {
    /// 创建空的内存凭据库。
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }
}

impl CredentialPort for MemoryCredentials {
    /// 读取。
    fn get(&self, key: &CredentialKey) -> Result<Option<Secret>, PlatformError> {
        let entries = self.entries.lock().unwrap_or_else(PoisonError::into_inner);
        Ok(entries.get(&key.target_name()).cloned())
    }

    /// 保存。
    fn set(&self, key: &CredentialKey, secret: &Secret) -> Result<(), PlatformError> {
        self.entries
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(key.target_name(), secret.clone());
        Ok(())
    }

    /// 删除。
    fn delete(&self, key: &CredentialKey) -> Result<(), PlatformError> {
        self.entries
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(&key.target_name());
        Ok(())
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn secrets_never_show_up_in_debug_output() {
        let secret = Secret::new("ghp_supersecret");
        assert_eq!(format!("{secret:?}"), "Secret(***)");
        let key = CredentialKey::new("github", "me").unwrap();
        let store = MemoryCredentials::new();
        store.set(&key, &secret).unwrap();
        assert!(!format!("{store:?}").contains("supersecret"));
    }

    #[test]
    fn keys_are_validated_and_namespaced() {
        assert_eq!(
            CredentialKey::new("jira", "https://jira.example.com")
                .map(|k| k.target_name())
                .ok()
                .as_deref(),
            Some("Nivlo/jira/https://jira.example.com")
        );
        for (integration, account) in [
            ("", "a"),
            ("Jira", "a"),
            ("jira", ""),
            ("jira", "a\nb"),
            ("ji ra", "a"),
        ] {
            assert!(
                CredentialKey::new(integration, account).is_err(),
                "{integration}/{account}"
            );
        }
    }

    #[test]
    fn memory_store_round_trips() {
        let store = MemoryCredentials::new();
        let key = CredentialKey::new("jira", "site").unwrap();
        assert_eq!(store.get(&key), Ok(None));
        store.set(&key, &Secret::new("t1")).unwrap();
        store.set(&key, &Secret::new("t2")).unwrap();
        assert_eq!(
            store.get(&key).ok().flatten().as_ref().map(Secret::expose),
            Some("t2")
        );
        store.delete(&key).unwrap();
        store.delete(&key).unwrap();
        assert_eq!(store.get(&key), Ok(None));
    }
}
