//! `SettingsService`：业务设置的读写。
//!
//! 设置是键值对，值为字符串（通常是 JSON）。窗口位置、置顶、快捷键等都放在这里，
//! 存储在 SQLite 的 `settings` 表中，因此和其他业务数据一样是事务性的。
//! 具体某个设置的结构由使用它的模块定义和解析，本服务只负责存取。

use std::sync::Arc;

use nivlo_common::clock::Clock;

use crate::error::{AppError, ErrorCode};
use crate::ports::UnitOfWork;

/// 已登记的设置 key。新增设置时在这里集中定义，避免魔法字符串散落各处。
pub mod keys {
    /// 悬浮窗的持久化位置（JSON，见 `nivlo_platform::placement::Placement`）。
    pub const FLOATING_PLACEMENT: &str = "floating.placement";
    /// 悬浮窗是否置顶（`"true"` / `"false"`），缺省为 `true`。
    pub const FLOATING_ALWAYS_ON_TOP: &str = "floating.always_on_top";
}

/// 设置 key 允许的最大长度。
const MAX_KEY_LEN: usize = 100;

/// 设置值允许的最大字节数，防止误把大块数据塞进设置表。
const MAX_VALUE_BYTES: usize = 64 * 1024;

/// 设置的 Use Case。
#[derive(Clone)]
pub struct SettingsService {
    /// 事务工厂。
    uow: Arc<dyn UnitOfWork>,
    /// 时钟，用于记录更新时间。
    clock: Arc<dyn Clock>,
}

/// 校验 key：非空、只含小写字母 / 数字 / 点 / 下划线，且不超长。
fn validate_key(key: &str) -> Result<(), AppError> {
    let valid = !key.is_empty()
        && key.len() <= MAX_KEY_LEN
        && key
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '_');
    if valid {
        Ok(())
    } else {
        Err(AppError::new(
            ErrorCode::InvalidInput,
            format!("无效的设置 key：{key:?}"),
        ))
    }
}

impl SettingsService {
    /// 创建服务。
    pub fn new(uow: Arc<dyn UnitOfWork>, clock: Arc<dyn Clock>) -> Self {
        Self { uow, clock }
    }

    /// 读取一个设置；不存在时返回 `None`。
    ///
    /// # Errors
    ///
    /// * [`ErrorCode::InvalidInput`] - key 格式不合法。
    /// * 存储错误。
    pub async fn get(&self, key: &str) -> Result<Option<String>, AppError> {
        validate_key(key)?;
        let mut tx = self.uow.begin().await?;
        Ok(tx.settings().get(key).await?)
    }

    /// 写入（覆盖）一个设置。
    ///
    /// # Errors
    ///
    /// * [`ErrorCode::InvalidInput`] - key 格式不合法，或值超过 64 KiB。
    /// * 存储错误，事务已回滚。
    pub async fn set(&self, key: &str, value: &str) -> Result<(), AppError> {
        validate_key(key)?;
        if value.len() > MAX_VALUE_BYTES {
            return Err(AppError::new(
                ErrorCode::InvalidInput,
                format!("设置 {key} 的值过大：{} 字节", value.len()),
            ));
        }
        let now = self.clock.now_utc();
        let mut tx = self.uow.begin().await?;
        tx.settings().set(key, value, now).await?;
        tx.commit().await?;
        Ok(())
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use chrono::{TimeZone, Utc};
    use nivlo_common::clock::FakeClock;

    use super::*;
    use crate::testing::FakeUnitOfWork;

    /// 构造服务与可观察的内存数据库。
    fn service() -> (SettingsService, FakeUnitOfWork) {
        let uow = FakeUnitOfWork::new();
        let clock = FakeClock::at_utc(Utc.with_ymd_and_hms(2026, 10, 9, 8, 0, 0).unwrap());
        (
            SettingsService::new(Arc::new(uow.clone()), Arc::new(clock)),
            uow,
        )
    }

    #[tokio::test]
    async fn missing_setting_is_none_and_written_setting_is_readable() {
        let (service, uow) = service();
        assert_eq!(service.get(keys::FLOATING_PLACEMENT).await.unwrap(), None);

        service
            .set(keys::FLOATING_PLACEMENT, "{\"a\":1}")
            .await
            .unwrap();
        assert_eq!(
            service
                .get(keys::FLOATING_PLACEMENT)
                .await
                .unwrap()
                .as_deref(),
            Some("{\"a\":1}")
        );
        assert_eq!(
            uow.committed_setting(keys::FLOATING_PLACEMENT).as_deref(),
            Some("{\"a\":1}")
        );
    }

    #[tokio::test]
    async fn setting_is_overwritten() {
        let (service, _) = service();
        service
            .set(keys::FLOATING_ALWAYS_ON_TOP, "true")
            .await
            .unwrap();
        service
            .set(keys::FLOATING_ALWAYS_ON_TOP, "false")
            .await
            .unwrap();
        assert_eq!(
            service
                .get(keys::FLOATING_ALWAYS_ON_TOP)
                .await
                .unwrap()
                .as_deref(),
            Some("false")
        );
    }

    #[tokio::test]
    async fn invalid_keys_and_oversized_values_are_rejected() {
        let (service, uow) = service();
        for key in ["", "Has Upper", "with space", &"a".repeat(MAX_KEY_LEN + 1)] {
            assert_eq!(
                service.set(key, "v").await.unwrap_err().code,
                ErrorCode::InvalidInput
            );
            assert_eq!(
                service.get(key).await.unwrap_err().code,
                ErrorCode::InvalidInput
            );
        }
        let huge = "x".repeat(MAX_VALUE_BYTES + 1);
        assert_eq!(
            service.set("ok.key", &huge).await.unwrap_err().code,
            ErrorCode::InvalidInput
        );
        assert_eq!(uow.committed_setting("ok.key"), None);
    }

    #[tokio::test]
    async fn failed_commit_does_not_change_the_setting() {
        let (service, uow) = service();
        service.set("a.b", "old").await.unwrap();
        uow.fail_next_commit();
        assert_eq!(
            service.set("a.b", "new").await.unwrap_err().code,
            ErrorCode::StorageUnavailable
        );
        assert_eq!(service.get("a.b").await.unwrap().as_deref(), Some("old"));
    }
}
