//! 应用层统一错误 `AppError`（架构文档 §43）。
//!
//! 各层定义自己的错误（`DomainError`、`StorageError`…），Application 把它们统一为
//! [`AppError`]：一个**稳定的大写错误码** + 面向用户的消息 + 可选的 UI 动作。
//! 前端只依赖错误码做分支，不解析消息文本。所有错误码都登记在
//! `docs/development/error-codes.md`，由测试保证文档与代码同步。

use nivlo_domain::error::DomainError;

use crate::ports::StorageError;

/// 稳定的错误码。新增变体时必须同步更新 `docs/development/error-codes.md`。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ErrorCode {
    /// 通用的输入不合法。
    InvalidInput,
    /// Item 不存在。
    ItemNotFound,
    /// 标题为空。
    ItemTitleEmpty,
    /// 标题过长。
    ItemTitleTooLong,
    /// 内容过长。
    ItemContentTooLong,
    /// 该类型的 Item 不能完成。
    ItemNotCompletable,
    /// Item 已经完成。
    ItemAlreadyCompleted,
    /// Item 尚未完成。
    ItemNotCompleted,
    /// Item 已经归档。
    ItemAlreadyArchived,
    /// Item 尚未归档。
    ItemNotArchived,
    /// Item 已归档，操作被拒绝。
    ItemArchived,
    /// 字段不适用于该类型的 Item。
    ItemFieldNotApplicable,
    /// 名称为空（项目、标签等）。
    NameEmpty,
    /// 名称过长（项目、标签等）。
    NameTooLong,
    /// 持久化数据自相矛盾。
    DataInconsistent,
    /// 违反数据库约束。
    StorageConstraint,
    /// 数据库不可用。
    StorageUnavailable,
    /// 存储的数据已损坏。
    StorageCorrupt,
    /// 数据库迁移失败。
    StorageMigrationFailed,
    /// 宿主窗口无法创建或显示。
    WindowUnavailable,
}

impl ErrorCode {
    /// 全部错误码，用于文档同步测试。
    pub const ALL: &'static [ErrorCode] = &[
        Self::InvalidInput,
        Self::ItemNotFound,
        Self::ItemTitleEmpty,
        Self::ItemTitleTooLong,
        Self::ItemContentTooLong,
        Self::ItemNotCompletable,
        Self::ItemAlreadyCompleted,
        Self::ItemNotCompleted,
        Self::ItemAlreadyArchived,
        Self::ItemNotArchived,
        Self::ItemArchived,
        Self::ItemFieldNotApplicable,
        Self::NameEmpty,
        Self::NameTooLong,
        Self::DataInconsistent,
        Self::StorageConstraint,
        Self::StorageUnavailable,
        Self::StorageCorrupt,
        Self::StorageMigrationFailed,
        Self::WindowUnavailable,
    ];

    /// 返回稳定的大写错误码字符串（会出现在 IPC 响应中，不得随意修改）。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::InvalidInput => "INVALID_INPUT",
            Self::ItemNotFound => "ITEM_NOT_FOUND",
            Self::ItemTitleEmpty => "ITEM_TITLE_EMPTY",
            Self::ItemTitleTooLong => "ITEM_TITLE_TOO_LONG",
            Self::ItemContentTooLong => "ITEM_CONTENT_TOO_LONG",
            Self::ItemNotCompletable => "ITEM_NOT_COMPLETABLE",
            Self::ItemAlreadyCompleted => "ITEM_ALREADY_COMPLETED",
            Self::ItemNotCompleted => "ITEM_NOT_COMPLETED",
            Self::ItemAlreadyArchived => "ITEM_ALREADY_ARCHIVED",
            Self::ItemNotArchived => "ITEM_NOT_ARCHIVED",
            Self::ItemArchived => "ITEM_ARCHIVED",
            Self::ItemFieldNotApplicable => "ITEM_FIELD_NOT_APPLICABLE",
            Self::NameEmpty => "NAME_EMPTY",
            Self::NameTooLong => "NAME_TOO_LONG",
            Self::DataInconsistent => "DATA_INCONSISTENT",
            Self::StorageConstraint => "STORAGE_CONSTRAINT",
            Self::StorageUnavailable => "STORAGE_UNAVAILABLE",
            Self::StorageCorrupt => "STORAGE_CORRUPT",
            Self::StorageMigrationFailed => "STORAGE_MIGRATION_FAILED",
            Self::WindowUnavailable => "WINDOW_UNAVAILABLE",
        }
    }
}

/// 可恢复错误附带的 UI 动作，前端据此展示"去处理"按钮。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ErrorAction {
    /// 打开日志目录 / 导出诊断信息。
    OpenDiagnostics,
}

impl ErrorAction {
    /// 返回稳定的大写动作标识。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::OpenDiagnostics => "OPEN_DIAGNOSTICS",
        }
    }
}

/// Application 层对外（IPC）统一的错误。
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{}: {message}", .code.as_str())]
pub struct AppError {
    /// 稳定的错误码，前端据此分支。
    pub code: ErrorCode,
    /// 面向用户 / 日志的说明，不保证稳定，也不得包含敏感信息。
    pub message: String,
    /// 可恢复错误附带的 UI 动作。
    pub action: Option<ErrorAction>,
}

impl AppError {
    /// 创建一个没有 UI 动作的错误。
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            action: None,
        }
    }

    /// 创建"Item 不存在"错误。
    pub fn item_not_found(id: impl std::fmt::Display) -> Self {
        Self::new(ErrorCode::ItemNotFound, format!("Item {id} 不存在"))
    }
}

impl From<DomainError> for AppError {
    /// 把领域规则错误映射为稳定错误码。
    fn from(error: DomainError) -> Self {
        let code = match &error {
            DomainError::EmptyTitle => ErrorCode::ItemTitleEmpty,
            DomainError::TitleTooLong { .. } => ErrorCode::ItemTitleTooLong,
            DomainError::ContentTooLong { .. } => ErrorCode::ItemContentTooLong,
            DomainError::EmptyName { .. } => ErrorCode::NameEmpty,
            DomainError::NameTooLong { .. } => ErrorCode::NameTooLong,
            DomainError::NotCompletable { .. } => ErrorCode::ItemNotCompletable,
            DomainError::AlreadyCompleted => ErrorCode::ItemAlreadyCompleted,
            DomainError::NotCompleted => ErrorCode::ItemNotCompleted,
            DomainError::AlreadyArchived => ErrorCode::ItemAlreadyArchived,
            DomainError::NotArchived => ErrorCode::ItemNotArchived,
            DomainError::Archived => ErrorCode::ItemArchived,
            DomainError::FieldNotApplicable { .. } => ErrorCode::ItemFieldNotApplicable,
            DomainError::InvalidSnapshot(_) => ErrorCode::DataInconsistent,
        };
        Self::new(code, error.to_string())
    }
}

impl From<StorageError> for AppError {
    /// 把存储错误映射为稳定错误码；需要排查的错误附带"打开诊断"动作。
    fn from(error: StorageError) -> Self {
        let (code, action) = match &error {
            StorageError::NotFound { entity: "item", .. } => (ErrorCode::ItemNotFound, None),
            StorageError::NotFound { .. } => (ErrorCode::InvalidInput, None),
            StorageError::Constraint(_) => (ErrorCode::StorageConstraint, None),
            StorageError::Unavailable(_) => (
                ErrorCode::StorageUnavailable,
                Some(ErrorAction::OpenDiagnostics),
            ),
            StorageError::Corrupt(_) => (
                ErrorCode::StorageCorrupt,
                Some(ErrorAction::OpenDiagnostics),
            ),
            StorageError::Migration(_) => (
                ErrorCode::StorageMigrationFailed,
                Some(ErrorAction::OpenDiagnostics),
            ),
        };
        Self {
            code,
            message: error.to_string(),
            action,
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use std::collections::HashSet;

    use super::*;

    #[test]
    fn every_error_code_is_registered_in_the_docs() {
        let docs = include_str!("../../../docs/development/error-codes.md");
        for code in ErrorCode::ALL {
            assert!(
                docs.contains(&format!("`{}`", code.as_str())),
                "错误码 {} 未登记到 docs/development/error-codes.md",
                code.as_str()
            );
        }
    }

    #[test]
    fn error_codes_are_unique_uppercase_identifiers() {
        let mut seen = HashSet::new();
        for code in ErrorCode::ALL {
            let text = code.as_str();
            assert!(
                text.chars().all(|c| c.is_ascii_uppercase() || c == '_'),
                "{text}"
            );
            assert!(seen.insert(text), "重复的错误码 {text}");
        }
    }

    #[test]
    fn domain_errors_map_to_codes() {
        let err = AppError::from(DomainError::EmptyTitle);
        assert_eq!(err.code, ErrorCode::ItemTitleEmpty);
        assert!(err.action.is_none());
    }

    #[test]
    fn storage_errors_that_need_investigation_carry_an_action() {
        let err = AppError::from(StorageError::Corrupt("x".into()));
        assert_eq!(err.code, ErrorCode::StorageCorrupt);
        assert_eq!(err.action, Some(ErrorAction::OpenDiagnostics));

        let missing = AppError::from(StorageError::NotFound {
            entity: "item",
            id: "1".into(),
        });
        assert_eq!(missing.code, ErrorCode::ItemNotFound);
    }

    #[test]
    fn display_includes_the_code() {
        assert!(
            AppError::item_not_found("abc")
                .to_string()
                .starts_with("ITEM_NOT_FOUND")
        );
    }
}
