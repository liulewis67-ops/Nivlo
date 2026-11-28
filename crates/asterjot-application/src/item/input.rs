//! Item Use Case 的输入 DTO。

use asterjot_domain::id::ProjectId;
use asterjot_domain::item::{ContentFormat, DatePoint, ItemType, Priority};
use chrono::{DateTime, Utc};

/// 对可清除字段的三态修改。
///
/// 普通的 `Option<T>` 无法区分"不修改"与"清除"，因此单独定义。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum Patch<T> {
    /// 保持原值。
    #[default]
    Keep,
    /// 清除字段。
    Clear,
    /// 设置为新值。
    Set(T),
}

impl<T> Patch<T> {
    /// 是否会修改字段。
    pub fn is_change(&self) -> bool {
        !matches!(self, Self::Keep)
    }

    /// 结合当前值计算修改后的值。
    pub fn apply(self, current: Option<T>) -> Option<T> {
        match self {
            Self::Keep => current,
            Self::Clear => None,
            Self::Set(value) => Some(value),
        }
    }
}

/// 更新 Item 的输入；所有字段默认"不修改"。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct UpdateItemInput {
    /// 转换类型；会按领域规则清理新类型不再适用的字段。
    pub item_type: Option<ItemType>,
    /// 新标题。
    pub title: Option<String>,
    /// 简述的修改。
    pub brief: Patch<String>,
    /// 内容的修改。
    pub content: Patch<String>,
    /// 新的内容格式。
    pub content_format: Option<ContentFormat>,
    /// 新的优先级。
    pub priority: Option<Priority>,
    /// 计划日期的修改。
    pub scheduled: Patch<DatePoint>,
    /// 截止日期的修改。
    pub due: Patch<DatePoint>,
    /// 提醒时间点的修改。
    pub reminder_at: Patch<DateTime<Utc>>,
    /// 所属项目的修改。
    pub project_id: Patch<ProjectId>,
}

impl UpdateItemInput {
    /// 是否没有任何修改。
    pub fn is_empty(&self) -> bool {
        self.item_type.is_none()
            && self.title.is_none()
            && !self.brief.is_change()
            && !self.content.is_change()
            && self.content_format.is_none()
            && self.priority.is_none()
            && !self.scheduled.is_change()
            && !self.due.is_change()
            && !self.reminder_at.is_change()
            && !self.project_id.is_change()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn patch_apply_semantics() {
        assert_eq!(Patch::Keep.apply(Some(1)), Some(1));
        assert_eq!(Patch::<i32>::Clear.apply(Some(1)), None);
        assert_eq!(Patch::Set(2).apply(Some(1)), Some(2));
        assert_eq!(Patch::Set(2).apply(None), Some(2));
    }

    #[test]
    fn default_update_is_empty() {
        assert!(UpdateItemInput::default().is_empty());
        let input = UpdateItemInput {
            title: Some("x".into()),
            ..UpdateItemInput::default()
        };
        assert!(!input.is_empty());
    }
}
