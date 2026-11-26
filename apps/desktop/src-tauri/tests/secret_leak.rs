//! 凭据不落盘的自动化检查（实施计划 9.1）：写入一个带特征的测试 Token 之后，
//! 搜索数据目录里的每个文件（SQLite 主文件 / WAL、日志、配置……），都不能出现它。
//!
//! 后续 Integration 相关的流程（9.2 之后）应当扩展这里的操作序列，让这份检查持续覆盖新代码。

#![allow(
    missing_docs,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::missing_docs_in_private_items
)]

use std::path::Path;

use stardeskbox_common::paths::AppPaths;
use stardeskbox_desktop_lib::lifecycle::startup::{build_app_state, open_database};
use stardeskbox_platform::credential::{CredentialKey, CredentialPort, MemoryCredentials, Secret};

/// 带特征的测试 Token：足够独特，不会和普通数据碰撞。
const CANARY: &str = "stardeskbox-canary-token-7f3a9c1e5b2d4086";

/// 当前平台的凭据库：Windows 用真实的 Credential Manager，其他平台用内存版。
fn credential_store() -> Box<dyn CredentialPort> {
    #[cfg(target_os = "windows")]
    {
        Box::new(stardeskbox_platform_windows::credential::WindowsCredentials::new())
    }
    #[cfg(not(target_os = "windows"))]
    {
        Box::new(stardeskbox_platform::credential::MemoryCredentials::new())
    }
}

/// 递归收集目录下的全部文件。
fn files_under(dir: &Path, out: &mut Vec<std::path::PathBuf>) {
    for entry in std::fs::read_dir(dir).unwrap().flatten() {
        let path = entry.path();
        if path.is_dir() {
            files_under(&path, out);
        } else {
            out.push(path);
        }
    }
}

/// 文件内容里是否含有（原样或 UTF-16 编码的）Token。
fn contains_canary(bytes: &[u8]) -> bool {
    let utf8 = CANARY.as_bytes();
    let utf16: Vec<u8> = CANARY.encode_utf16().flat_map(u16::to_le_bytes).collect();
    [utf8, utf16.as_slice()]
        .iter()
        .any(|needle| bytes.windows(needle.len()).any(|window| window == *needle))
}

#[tokio::test]
async fn a_stored_token_never_shows_up_in_the_database_logs_or_config() {
    let dir = tempfile::tempdir().unwrap();
    let paths = AppPaths::from_root(dir.path().join("StarDeskBox"));
    paths.ensure_dirs().unwrap();
    let database = open_database(&paths).await.unwrap();
    let state = build_app_state(database, paths.attachments_dir(), None);

    let store = credential_store();
    let key = CredentialKey::new(
        "stardeskbox-test",
        &format!("leak-test-{}", std::process::id()),
    )
    .unwrap();
    let secret = Secret::new(CANARY);
    store.set(&key, &secret).unwrap();

    // 日志：即使有人不小心用 `{:?}` 打印凭据或标识，也不能带出内容。
    let log_file = std::fs::File::create(paths.logs_dir().join("test.log")).unwrap();
    let subscriber = tracing_subscriber::fmt()
        .with_writer(std::sync::Mutex::new(log_file))
        .with_ansi(false)
        .finish();
    tracing::subscriber::with_default(subscriber, || {
        tracing::info!(?secret, ?key, "saved credential for integration");
    });

    // 数据库：正常的业务写入（设置里只保存「已连接」之类的非秘密元数据）。
    state
        .services
        .settings
        .set("integration.jira.connected", "true")
        .await
        .unwrap();

    // 经过连接管理的完整流程（真实的 SQLite 设置表 + 内存凭据库，避免动用开发机上的真实凭据）：
    // 秘密只进凭据库，设置表里只有元数据。
    {
        use stardeskbox_application::ports::integration::IntegrationRegistry;
        let canary_store = std::sync::Arc::new(MemoryCredentials::new());
        let mut registry = IntegrationRegistry::new();
        registry.register(std::sync::Arc::new(
            stardeskbox_integrations::GithubIntegration::new(canary_store.clone()),
        ));
        let service = stardeskbox_desktop_lib::integration_service::IntegrationService::new(
            state.services.settings.clone(),
            canary_store.clone(),
            std::sync::Arc::new(registry),
            None,
            state.runtime.clock.clone(),
        );
        service.connect("github", "", CANARY).await.unwrap();
        let github = CredentialKey::new("github", "github.com").unwrap();
        assert_eq!(
            canary_store
                .get(&github)
                .unwrap()
                .as_ref()
                .map(Secret::expose),
            Some(CANARY)
        );
        assert_eq!(service.list().await.unwrap().len(), 1);
    }

    // 凭据确实在系统凭据库里，只是不在数据目录里。
    assert_eq!(
        store.get(&key).unwrap().as_ref().map(Secret::expose),
        Some(CANARY)
    );
    store.delete(&key).unwrap();

    // 关闭数据库（刷写 WAL）后检查整个数据目录。
    state.runtime.database().close().await;
    let mut files = Vec::new();
    files_under(dir.path(), &mut files);
    assert!(
        files
            .iter()
            .any(|f| f.extension().is_some_and(|e| e == "log")),
        "测试应当产生日志文件"
    );
    assert!(
        files
            .iter()
            .any(|f| f.to_string_lossy().contains("stardeskbox.db"))
    );
    for file in files {
        let bytes = std::fs::read(&file).unwrap();
        assert!(!contains_canary(&bytes), "{} 含有 Token", file.display());
    }
}
