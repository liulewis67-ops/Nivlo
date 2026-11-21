//! Source：Item 的来源。
//!
//! 任务不是凭空产生，而是保留它来自哪里（产品文档 §18）。本模块只定义领域结构，
//! 持久化在实施计划 2.2 完成。Integration 专属信息放进 `metadata_json`，
//! 避免把 Jira / GitHub 的字段污染通用结构（架构文档 §31.2）。

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::id::{ItemId, SourceId};

/// 来源类型，如 `"jira"`、`"github"`、`"web"`、`"file"`。
///
/// 使用字符串而非枚举：内置 Workflow 与用户 Workflow 都可以引入新的来源类型，
/// 不应每次新增都修改领域模型。
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct SourceType(String);

impl SourceType {
    /// 手动创建（没有外部来源）。
    pub const MANUAL: &'static str = "manual";
    /// 网页 / URL。
    pub const WEB: &'static str = "web";
    /// 文件引用。
    pub const FILE: &'static str = "file";
    /// 选中或粘贴的文本。
    pub const TEXT: &'static str = "text";
    /// 从系统剪贴板导入的消息或文字。
    pub const CLIPBOARD: &'static str = "clipboard";
    /// 从前台应用当前选区导入的文字。
    pub const SELECTION: &'static str = "selection";
    /// 图片（如截图）。
    pub const IMAGE: &'static str = "image";

    /// 创建来源类型；会被规范化为去除首尾空白的小写。
    pub fn new(raw: &str) -> Self {
        Self(raw.trim().to_lowercase())
    }

    /// 返回类型字符串。
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Item 的来源记录。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Source {
    /// 来源 ID。
    pub id: SourceId,
    /// 所属 Item。
    pub item_id: ItemId,
    /// 来源类型。
    pub source_type: SourceType,
    /// 来源应用，如 `"Chrome"`、`"VS Code"`；无法识别时为 `None`。
    pub source_app: Option<String>,
    /// 来源 URL。
    pub source_url: Option<String>,
    /// 来源文件路径（文件引用，不复制文件）。
    pub source_path: Option<String>,
    /// 原始标题（如网页标题、Jira Issue 标题）。
    pub original_title: Option<String>,
    /// Integration 专属信息，序列化后的 JSON 文本。
    pub metadata_json: Option<String>,
    /// 捕获时间。
    pub captured_at: DateTime<Utc>,
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use chrono::TimeZone;
    use uuid::Uuid;

    use super::*;

    #[test]
    fn source_type_is_normalized() {
        assert_eq!(SourceType::new("  Jira ").as_str(), "jira");
        assert_eq!(SourceType::new(SourceType::WEB).as_str(), "web");
    }

    #[test]
    fn serde_round_trip() {
        let source = Source {
            id: SourceId::from_uuid(Uuid::from_u128(3)),
            item_id: ItemId::from_uuid(Uuid::from_u128(1)),
            source_type: SourceType::new("jira"),
            source_app: Some("Chrome".to_owned()),
            source_url: Some("https://example.atlassian.net/browse/ABC-1".to_owned()),
            source_path: None,
            original_title: Some("ABC-1 Fix login".to_owned()),
            metadata_json: Some("{\"key\":\"ABC-1\"}".to_owned()),
            captured_at: Utc.with_ymd_and_hms(2026, 10, 9, 8, 0, 0).unwrap(),
        };
        let json = serde_json::to_string(&source).unwrap();
        assert_eq!(serde_json::from_str::<Source>(&json).unwrap(), source);
    }
}
