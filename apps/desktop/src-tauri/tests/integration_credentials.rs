//! 断开集成之后，凭据真的从操作系统凭据库里消失（实施计划 9.5 的验证项）。
//!
//! 在 Windows 上使用真实的 Credential Manager，目标名是 `AsterJot/asterjot-test/github.com`，不会碰到用户真正的集成凭据。

#![cfg(target_os = "windows")]
#![allow(
    missing_docs,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::missing_docs_in_private_items
)]

use std::sync::Arc;

use asterjot_application::ports::integration::{
    Integration, IntegrationCall, IntegrationContext, IntegrationError, IntegrationOutput,
    IntegrationRegistry,
};
use asterjot_common::paths::AppPaths;
use asterjot_desktop_lib::integration_service::IntegrationService;
use asterjot_desktop_lib::lifecycle::startup::{build_app_state, open_database};
use asterjot_platform::credential::{CredentialKey, CredentialPort};
use asterjot_platform_windows::credential::WindowsCredentials;
use async_trait::async_trait;

/// 只用来占位的集成。
struct TestIntegration;

#[async_trait]
impl Integration for TestIntegration {
    fn id(&self) -> &'static str {
        "asterjot-test"
    }

    fn display_name(&self) -> &'static str {
        "Test"
    }

    async fn call(
        &self,
        _call: &IntegrationCall,
        _ctx: &IntegrationContext<'_>,
    ) -> Result<IntegrationOutput, IntegrationError> {
        Ok(IntegrationOutput::new())
    }
}

#[tokio::test]
async fn disconnecting_removes_the_credential_from_the_windows_credential_manager() {
    let dir = tempfile::tempdir().unwrap();
    let paths = AppPaths::from_root(dir.path().join("AsterJot"));
    paths.ensure_dirs().unwrap();
    let database = open_database(&paths).await.unwrap();
    let state = build_app_state(database, paths.attachments_dir(), None);

    let store = Arc::new(WindowsCredentials::new());
    let mut registry = IntegrationRegistry::new();
    registry.register(Arc::new(TestIntegration));
    let service = IntegrationService::new(
        state.services.settings.clone(),
        store.clone(),
        Arc::new(registry),
        None,
        state.runtime.clock.clone(),
    );
    let key = CredentialKey::new("asterjot-test", "github.com").unwrap();
    // 无论测试成败，都把测试凭据清掉。
    struct Cleanup(Arc<WindowsCredentials>, CredentialKey);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            let _ = self.0.delete(&self.1);
        }
    }
    let _cleanup = Cleanup(store.clone(), key.clone());

    service
        .connect("asterjot-test", "", "windows-vault-secret")
        .await
        .unwrap();
    assert_eq!(
        store.get(&key).unwrap().unwrap().expose(),
        "windows-vault-secret"
    );

    service
        .disconnect("asterjot-test", "github.com")
        .await
        .unwrap();
    assert!(
        store.get(&key).unwrap().is_none(),
        "凭据应当已从系统凭据库删除"
    );
    assert!(service.list().await.unwrap().is_empty());
    state.runtime.database().close().await;
}
