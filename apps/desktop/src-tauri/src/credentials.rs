//! 系统凭据库的选择：Windows 用 Credential Manager，其他平台（适配器在 Phase 11 实现）
//! 暂时退回只存在于内存的实现——重启后需要重新连接，但绝不会把凭据写到磁盘上。

use std::sync::Arc;

use nivlo_platform::credential::CredentialPort;

/// 当前平台的凭据库。
#[must_use]
pub fn system_credentials() -> Arc<dyn CredentialPort> {
    #[cfg(target_os = "windows")]
    {
        Arc::new(nivlo_platform_windows::credential::WindowsCredentials::new())
    }
    #[cfg(not(target_os = "windows"))]
    {
        Arc::new(nivlo_platform::credential::MemoryCredentials::new())
    }
}
