//! 领域错误。

use crate::item::ItemType;

/// 违反领域规则时返回的错误。
///
/// 这些错误都是"调用方给了不合法的输入或状态"，不涉及 IO；
/// Application 层会把它们映射为稳定的 `AppError` 错误码。
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum DomainError {
    /// 标题去除首尾空白后为空。
    #[error("标题不能为空")]
    EmptyTitle,
    /// 标题超过长度上限。
    #[error("标题过长：最多 {max} 个字符")]
    TitleTooLong {
        /// 允许的最大字符数。
        max: usize,
    },
    /// 内容超过长度上限。
    #[error("内容过长：最多 {max} 个字符")]
    ContentTooLong {
        /// 允许的最大字符数。
        max: usize,
    },
    /// 简述超过长度上限。
    #[error("简述过长：最多 {max} 个字符")]
    BriefTooLong {
        /// 允许的最大字符数。
        max: usize,
    },
    /// Project / Tag 等名称去除首尾空白后为空。
    #[error("{kind}名称不能为空")]
    EmptyName {
        /// 名称所属的实体种类，如 `"项目"`、`"标签"`。
        kind: &'static str,
    },
    /// Project / Tag 等名称超过长度上限。
    #[error("{kind}名称过长：最多 {max} 个字符")]
    NameTooLong {
        /// 名称所属的实体种类。
        kind: &'static str,
        /// 允许的最大字符数。
        max: usize,
    },
    /// 该类型的 Item 不能被完成（Note）。
    #[error("{item_type:?} 不能被完成")]
    NotCompletable {
        /// 被拒绝的 Item 类型。
        item_type: ItemType,
    },
    /// Item 已经处于完成状态。
    #[error("Item 已经完成")]
    AlreadyCompleted,
    /// Item 尚未完成，无法重新打开。
    #[error("Item 尚未完成")]
    NotCompleted,
    /// Item 已经归档。
    #[error("Item 已经归档")]
    AlreadyArchived,
    /// Item 尚未归档，无法取消归档。
    #[error("Item 尚未归档")]
    NotArchived,
    /// 归档的 Item 需要先取消归档才能完成或重新打开。
    #[error("Item 已归档，请先取消归档")]
    Archived,
    /// 该字段不适用于此类型的 Item。
    #[error("字段 {field} 不适用于 {item_type:?}")]
    FieldNotApplicable {
        /// 字段名。
        field: &'static str,
        /// Item 类型。
        item_type: ItemType,
    },
    /// 从持久化数据重建对象时发现数据自相矛盾。
    #[error("数据不一致：{0}")]
    InvalidSnapshot(String),
}
