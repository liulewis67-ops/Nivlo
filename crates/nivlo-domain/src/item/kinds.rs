//! Item 的类型、状态、优先级与内容格式枚举。

use std::str::FromStr;

use serde::{Deserialize, Serialize};

use crate::error::DomainError;

/// 为"字符串 <-> 枚举"的持久化编码实现 `FromStr`，与各枚举的 `as_str` 互为逆操作。
macro_rules! impl_from_str {
    ($ty:ident { $($text:literal => $variant:ident),+ $(,)? }) => {
        impl FromStr for $ty {
            type Err = DomainError;

            /// 解析持久化使用的稳定字符串；未知取值视为数据不一致。
            fn from_str(s: &str) -> Result<Self, Self::Err> {
                match s {
                    $($text => Ok(Self::$variant),)+
                    other => Err(DomainError::InvalidSnapshot(format!(
                        "未知的 {} 取值：{other}",
                        stringify!($ty)
                    ))),
                }
            }
        }
    };
}

/// Item 的类型（架构文档 §8.1）。
///
/// * `Todo` = 我要做
/// * `Note` = 我要记住
/// * `Tip`  = 某个时间我要知道
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ItemType {
    /// 待办：可完成，拥有截止日期、优先级与提醒。
    Todo,
    /// 笔记：用于记录信息、想法、网页与文件引用，没有完成语义。
    Note,
    /// 提示：具有时间属性的轻量信息；可以勾掉（看过 / 处理过），但不是必须。
    Tip,
}

impl ItemType {
    /// 该类型是否可以被完成：Todo 与 Tip 可以（Tip 勾掉表示今天已经处理过）；Note 没有完成语义。
    pub fn is_completable(self) -> bool {
        matches!(self, Self::Todo | Self::Tip)
    }

    /// 该类型是否拥有截止日期（产品文档 §17：只有 Todo）。
    pub fn supports_due(self) -> bool {
        matches!(self, Self::Todo)
    }

    /// 该类型是否拥有优先级（只有 Todo）。
    pub fn supports_priority(self) -> bool {
        matches!(self, Self::Todo)
    }

    /// 该类型是否可以设置提醒。Todo 与 Tip 可以（Tip 需要"在某个时间让我知道"）。
    pub fn supports_reminder(self) -> bool {
        matches!(self, Self::Todo | Self::Tip)
    }

    /// 返回持久化使用的稳定字符串。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Todo => "todo",
            Self::Note => "note",
            Self::Tip => "tip",
        }
    }
}

/// Item 的完成状态。只有 Todo 会进入 [`ItemStatus::Done`]。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ItemStatus {
    /// 未完成（Note 与 Tip 永远处于该状态）。
    Open,
    /// 已完成。
    Done,
}

impl ItemStatus {
    /// 返回持久化使用的稳定字符串。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::Done => "done",
        }
    }
}

/// Todo 的优先级。
///
/// 优先级**不影响** Today 的执行顺序（产品文档 §5.3、§21），顺序由独立的 Today Order 决定。
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Default, Serialize, Deserialize,
)]
#[serde(rename_all = "snake_case")]
pub enum Priority {
    /// 未设置优先级。
    #[default]
    None,
    /// 低。
    Low,
    /// 中。
    Medium,
    /// 高。
    High,
}

impl Priority {
    /// 返回持久化使用的稳定字符串。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
        }
    }
}

/// 内容（描述 / 正文）的格式。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContentFormat {
    /// 纯文本。
    #[default]
    Plain,
    /// Markdown 文本（MVP 以纯文本方式编辑，不引入 Block Editor）。
    Markdown,
}

impl ContentFormat {
    /// 返回持久化使用的稳定字符串。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Plain => "plain",
            Self::Markdown => "markdown",
        }
    }
}

impl_from_str!(ItemType { "todo" => Todo, "note" => Note, "tip" => Tip });
impl_from_str!(ItemStatus { "open" => Open, "done" => Done });
impl_from_str!(Priority { "none" => None, "low" => Low, "medium" => Medium, "high" => High });
impl_from_str!(ContentFormat { "plain" => Plain, "markdown" => Markdown });

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn as_str_and_from_str_are_inverse() {
        for v in [ItemType::Todo, ItemType::Note, ItemType::Tip] {
            assert_eq!(v.as_str().parse::<ItemType>().unwrap(), v);
        }
        for v in [ItemStatus::Open, ItemStatus::Done] {
            assert_eq!(v.as_str().parse::<ItemStatus>().unwrap(), v);
        }
        for v in [
            Priority::None,
            Priority::Low,
            Priority::Medium,
            Priority::High,
        ] {
            assert_eq!(v.as_str().parse::<Priority>().unwrap(), v);
        }
        for v in [ContentFormat::Plain, ContentFormat::Markdown] {
            assert_eq!(v.as_str().parse::<ContentFormat>().unwrap(), v);
        }
    }

    #[test]
    fn unknown_text_is_rejected() {
        assert!(matches!(
            "urgent".parse::<Priority>(),
            Err(DomainError::InvalidSnapshot(_))
        ));
        assert!("".parse::<ItemType>().is_err());
    }

    #[test]
    fn todo_and_tip_are_completable_but_not_note() {
        assert!(ItemType::Todo.is_completable() && ItemType::Tip.is_completable());
        assert!(!ItemType::Note.is_completable());
    }
}
