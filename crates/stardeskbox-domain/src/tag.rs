//! Tag：Item 的自由标签。

use serde::{Deserialize, Serialize};

use crate::error::DomainError;
use crate::id::TagId;

/// 标签名允许的最大字符数。
pub const MAX_TAG_NAME_CHARS: usize = 50;

/// 实体种类，用于错误信息。
const KIND: &str = "标签";

/// 已校验的标签名：去除首尾空白，不含控制字符。
///
/// 标签名在存储层按大小写不敏感去重；比较键由 [`TagName::key`] 给出。
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct TagName(String);

impl TagName {
    /// 校验并创建标签名，同时去除首尾空白。
    ///
    /// # Errors
    ///
    /// * [`DomainError::EmptyName`] - 去除空白后为空，或包含控制字符。
    /// * [`DomainError::NameTooLong`] - 超过 [`MAX_TAG_NAME_CHARS`]。
    pub fn new(raw: &str) -> Result<Self, DomainError> {
        let trimmed = raw.trim();
        // 控制字符（换行、制表等）在标签列表和过滤条件里没有合理含义，直接按空名处理。
        if trimmed.is_empty() || trimmed.chars().any(char::is_control) {
            return Err(DomainError::EmptyName { kind: KIND });
        }
        if trimmed.chars().count() > MAX_TAG_NAME_CHARS {
            return Err(DomainError::NameTooLong {
                kind: KIND,
                max: MAX_TAG_NAME_CHARS,
            });
        }
        Ok(Self(trimmed.to_owned()))
    }

    /// 返回展示用的名称文本（保留用户输入的大小写）。
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// 返回用于去重与过滤的比较键（小写）。
    pub fn key(&self) -> String {
        self.0.to_lowercase()
    }
}

impl TryFrom<String> for TagName {
    type Error = DomainError;

    /// 反序列化入口，保证外部数据也经过校验。
    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::new(&value)
    }
}

impl From<TagName> for String {
    /// 序列化出口。
    fn from(value: TagName) -> Self {
        value.0
    }
}

/// 标签。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Tag {
    /// 标签 ID。
    pub id: TagId,
    /// 标签名。
    pub name: TagName,
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use uuid::Uuid;

    use super::*;

    #[test]
    fn name_rules() {
        assert_eq!(TagName::new("  工作 ").unwrap().as_str(), "工作");
        assert!(TagName::new("").is_err());
        assert!(TagName::new("a\nb").is_err());
        assert!(matches!(
            TagName::new(&"a".repeat(MAX_TAG_NAME_CHARS + 1)),
            Err(DomainError::NameTooLong { .. })
        ));
    }

    #[test]
    fn key_is_case_insensitive() {
        assert_eq!(
            TagName::new("Jira").unwrap().key(),
            TagName::new("jira").unwrap().key()
        );
        assert_eq!(TagName::new("Jira").unwrap().as_str(), "Jira");
    }

    #[test]
    fn serde_round_trip() {
        let tag = Tag {
            id: TagId::from_uuid(Uuid::from_u128(2)),
            name: TagName::new("工作").unwrap(),
        };
        let json = serde_json::to_string(&tag).unwrap();
        assert_eq!(serde_json::from_str::<Tag>(&json).unwrap(), tag);
    }
}
