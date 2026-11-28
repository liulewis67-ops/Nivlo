//! 脚本权限的用户确认记录（实施计划 8.3）。
//!
//! 授权按脚本「指纹」保存在 `settings` 表（`script.grant.<指纹>`）。指纹由脚本源码、声明的主机和
//! Workflow 的网络权限共同决定，所以脚本或权限任何一处变化都需要重新确认。

use asterjot_application::error::AppError;
use asterjot_application::settings::SettingsService;
use asterjot_domain::workflow::{Step, Workflow};
use asterjot_workflow::script_step::{ScriptGrants, script_fingerprint};
use async_trait::async_trait;

/// 授权记录的 key 前缀。
const PREFIX: &str = "script.grant.";

/// 基于 `settings` 表的授权记录。
#[derive(Clone)]
pub struct SettingsScriptGrants {
    /// 设置服务。
    settings: SettingsService,
}

impl SettingsScriptGrants {
    /// 创建。
    #[must_use]
    pub fn new(settings: SettingsService) -> Self {
        Self { settings }
    }

    /// 授予一个 Workflow 里全部 script Step 当前的权限。
    ///
    /// # Errors
    ///
    /// 存储失败时返回错误。
    pub async fn grant_workflow(&self, workflow: &Workflow) -> Result<(), AppError> {
        for fingerprint in workflow_fingerprints(workflow) {
            self.settings
                .set(&format!("{PREFIX}{fingerprint}"), "true")
                .await?;
        }
        Ok(())
    }

    /// 该 Workflow 的全部脚本权限是否都已确认（没有脚本时为 `true`）。
    pub async fn is_workflow_granted(&self, workflow: &Workflow) -> bool {
        for fingerprint in workflow_fingerprints(workflow) {
            if !self.is_granted(&fingerprint).await {
                return false;
            }
        }
        true
    }
}

/// Workflow 里每个**需要确认**的 script Step 的指纹：只有声明了主机（要联网）的脚本才需要确认。
#[must_use]
pub fn workflow_fingerprints(workflow: &Workflow) -> Vec<String> {
    workflow
        .steps
        .iter()
        .filter_map(|step| match step {
            Step::Script { source, hosts } if !hosts.is_empty() => {
                Some(script_fingerprint(&workflow.permissions, source, hosts))
            }
            _ => None,
        })
        .collect()
}

#[async_trait]
impl ScriptGrants for SettingsScriptGrants {
    /// 读取授权；读取失败按「未授权」处理（宁可多问一次）。
    async fn is_granted(&self, fingerprint: &str) -> bool {
        matches!(
            self.settings.get(&format!("{PREFIX}{fingerprint}")).await,
            Ok(Some(value)) if value == "true"
        )
    }
}
