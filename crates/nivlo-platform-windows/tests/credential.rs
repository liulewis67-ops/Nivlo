//! Windows Credential Manager 适配器的集成测试：写入、覆盖、读取、删除（实施计划 9.1）。
//!
//! 会真的写入当前用户的凭据库，目标名带随机后缀，结束时无论成功与否都会删除。

#![cfg(target_os = "windows")]
#![allow(clippy::unwrap_used, clippy::expect_used, missing_docs)]

use nivlo_platform::credential::{CredentialKey, CredentialPort, Secret};
use nivlo_platform_windows::credential::WindowsCredentials;

/// 测试结束时删除凭据，保证失败也不留垃圾。
struct Cleanup<'a>(&'a WindowsCredentials, &'a CredentialKey);

impl Drop for Cleanup<'_> {
    fn drop(&mut self) {
        let _ = self.0.delete(self.1);
    }
}

fn unique_key() -> CredentialKey {
    let suffix = std::process::id();
    CredentialKey::new("nivlo-test", &format!("credential-test-{suffix}")).unwrap()
}

#[test]
fn write_overwrite_read_and_delete() {
    let store = WindowsCredentials::new();
    let key = unique_key();
    let _cleanup = Cleanup(&store, &key);

    assert_eq!(store.get(&key).unwrap(), None);

    store.set(&key, &Secret::new("first-token-例")).unwrap();
    assert_eq!(
        store.get(&key).unwrap().as_ref().map(Secret::expose),
        Some("first-token-例")
    );

    store.set(&key, &Secret::new("second-token")).unwrap();
    assert_eq!(
        store.get(&key).unwrap().as_ref().map(Secret::expose),
        Some("second-token")
    );

    store.delete(&key).unwrap();
    assert_eq!(store.get(&key).unwrap(), None);
    // 重复删除不报错。
    store.delete(&key).unwrap();
}

#[test]
fn oversized_secrets_are_rejected_without_writing() {
    let store = WindowsCredentials::new();
    let key = unique_key();
    let _cleanup = Cleanup(&store, &key);
    assert!(store.set(&key, &Secret::new("x".repeat(5000))).is_err());
    assert_eq!(store.get(&key).unwrap(), None);
}
