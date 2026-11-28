//! Project：Item 的容器。
//!
//! MVP 中 Project 视图按优先级 → 计划日期 → 创建时间排序（实施计划 D-05），
//! 手动的 Project Order 推迟到 MVP 之后，因此这里不含排序字段。

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::error::DomainError;
use crate::id::ProjectId;

/// 名称允许的最大字符数。
pub const MAX_PROJECT_NAME_CHARS: usize = 100;

/// 实体种类，用于错误信息。
const KIND: &str = "项目";

/// 已校验的 Project 名称。
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct ProjectName(String);

impl ProjectName {
    /// 校验并创建名称，同时去除首尾空白。
    ///
    /// # Errors
    ///
    /// * [`DomainError::EmptyName`] - 去除空白后为空。
    /// * [`DomainError::NameTooLong`] - 超过 [`MAX_PROJECT_NAME_CHARS`]。
    pub fn new(raw: &str) -> Result<Self, DomainError> {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return Err(DomainError::EmptyName { kind: KIND });
        }
        if trimmed.chars().count() > MAX_PROJECT_NAME_CHARS {
            return Err(DomainError::NameTooLong {
                kind: KIND,
                max: MAX_PROJECT_NAME_CHARS,
            });
        }
        Ok(Self(trimmed.to_owned()))
    }

    /// 返回名称文本。
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<String> for ProjectName {
    type Error = DomainError;

    /// 反序列化入口，保证外部数据也经过校验。
    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::new(&value)
    }
}

impl From<ProjectName> for String {
    /// 序列化出口。
    fn from(value: ProjectName) -> Self {
        value.0
    }
}

/// 项目。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Project {
    /// 项目 ID。
    pub id: ProjectId,
    /// 项目名称。
    pub name: ProjectName,
    /// 创建时间。
    pub created_at: DateTime<Utc>,
    /// 归档时间；归档的项目不再出现在侧栏。
    pub archived_at: Option<DateTime<Utc>>,
}

impl Project {
    /// 创建新项目。
    ///
    /// # Errors
    ///
    /// 名称不合法时返回 [`DomainError::EmptyName`] 或 [`DomainError::NameTooLong`]。
    pub fn create(id: ProjectId, name: &str, now: DateTime<Utc>) -> Result<Self, DomainError> {
        Ok(Self {
            id,
            name: ProjectName::new(name)?,
            created_at: now,
            archived_at: None,
        })
    }

    /// 重命名项目。
    ///
    /// # Errors
    ///
    /// 名称不合法时返回错误，项目不变。
    pub fn rename(&mut self, name: &str) -> Result<(), DomainError> {
        self.name = ProjectName::new(name)?;
        Ok(())
    }

    /// 归档项目。
    ///
    /// # Errors
    ///
    /// 已归档时返回 [`DomainError::AlreadyArchived`]。
    pub fn archive(&mut self, now: DateTime<Utc>) -> Result<(), DomainError> {
        if self.archived_at.is_some() {
            return Err(DomainError::AlreadyArchived);
        }
        self.archived_at = Some(now);
        Ok(())
    }

    /// 取消归档。
    ///
    /// # Errors
    ///
    /// 未归档时返回 [`DomainError::NotArchived`]。
    pub fn unarchive(&mut self) -> Result<(), DomainError> {
        if self.archived_at.take().is_none() {
            return Err(DomainError::NotArchived);
        }
        Ok(())
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use chrono::TimeZone;
    use uuid::Uuid;

    use super::*;

    /// 测试用项目。
    fn project() -> Project {
        let now = Utc.with_ymd_and_hms(2026, 10, 9, 8, 0, 0).unwrap();
        Project::create(ProjectId::from_uuid(Uuid::from_u128(1)), " 支付重构 ", now).unwrap()
    }

    #[test]
    fn name_is_trimmed_and_validated() {
        assert_eq!(project().name.as_str(), "支付重构");
        assert_eq!(
            ProjectName::new(" "),
            Err(DomainError::EmptyName { kind: "项目" })
        );
        assert!(matches!(
            ProjectName::new(&"a".repeat(MAX_PROJECT_NAME_CHARS + 1)),
            Err(DomainError::NameTooLong { .. })
        ));
    }

    #[test]
    fn rename_failure_keeps_old_name() {
        let mut p = project();
        assert!(p.rename("").is_err());
        assert_eq!(p.name.as_str(), "支付重构");
        p.rename("结算").unwrap();
        assert_eq!(p.name.as_str(), "结算");
    }

    #[test]
    fn archive_cycle() {
        let mut p = project();
        let now = Utc.with_ymd_and_hms(2026, 10, 10, 8, 0, 0).unwrap();
        p.archive(now).unwrap();
        assert_eq!(p.archive(now), Err(DomainError::AlreadyArchived));
        p.unarchive().unwrap();
        assert_eq!(p.unarchive(), Err(DomainError::NotArchived));
    }

    #[test]
    fn serde_round_trip() {
        let p = project();
        let json = serde_json::to_string(&p).unwrap();
        assert_eq!(serde_json::from_str::<Project>(&json).unwrap(), p);
        assert!(serde_json::from_str::<ProjectName>("\"  \"").is_err());
    }
}
